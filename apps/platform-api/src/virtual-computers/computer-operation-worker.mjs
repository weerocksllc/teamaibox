import {computerCommand,validateComputerCommandResult} from '../../../../services/scheduler/src/computer-command.mjs';

/** One in-process consumer of the durable PostgreSQL queue. Multiple API
 * processes may run this consumer: claimNext/renew/complete fence database
 * writes, while the node replays the same operation/run instead of a new VM.
 * A disconnected transport never frees capacity or reports a stopped guest.
 */
export class ComputerOperationWorker {
  #repository; #runtime; #release; #leaseMs; #active=null; #controller=null;
  #timer=null; #stopped=true; #pollMs; #epoch=0; #followup;
  constructor({repository,runtime,releaseResources,leaseMs,pollMs,followup=null}) {
    if(!['claimNext','renew','complete','retry'].every(k=>typeof repository?.[k]==='function')
      ||typeof runtime?.execute!=='function'||typeof releaseResources!=='function'
      ||!Number.isSafeInteger(leaseMs)||leaseMs<3||!Number.isSafeInteger(pollMs)||pollMs<1) {
      throw TypeError('Computer operation worker requires persistent claims and resource accounting');
    }
    this.#repository=repository;this.#runtime=runtime;this.#release=releaseResources;
    this.#leaseMs=leaseMs;this.#pollMs=pollMs;this.#followup=followup;
  }
  runOnce() {
    // Avoid overlapping consumers inside one instance. Other processes are
    // coordinated by PostgreSQL, not this promise.
    if(this.#active)return this.#active;
    this.#active=this.#run().finally(()=>{this.#active=null;});
    return this.#active;
  }
  async #run() {
    const epoch=this.#epoch;
    await this.#followup?.();
    if(epoch!==this.#epoch)return {processed:0};
    const op=await this.#repository.claimNext({leaseMs:this.#leaseMs});
    if(!op)return {processed:0};
    if(epoch!==this.#epoch)return {processed:1,operationId:op.id,state:'retrying'};
    const controller=new AbortController();this.#controller=controller;
    let heartbeat,renewing=false;
    const abort=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('computer_claim_lost')),{once:true}));
    const renew=async()=>{
      if(renewing||controller.signal.aborted)return;
      renewing=true;
      try {if(!await this.#repository.renew(op,{leaseMs:this.#leaseMs}))controller.abort();}
      catch {controller.abort();}
      finally {renewing=false;}
    };
    heartbeat=setInterval(renew,Math.floor(this.#leaseMs/3));
    try {
      const payload=computerCommand(op);
      const value=await Promise.race([abort,this.#runtime.execute({operation:op,payload,signal:controller.signal})]);
      if(controller.signal.aborted)throw Error('computer_claim_lost');
      // Do not let an adapter's malformed/mismatched response reach persistence.
      const result=validateComputerCommandResult(op.action,payload,value);
      const completed=await this.#repository.complete(op,result,{releaseResources:this.#release});
      return {processed:1,operationId:op.id,state:completed.state};
    } catch {
      // The repository stores only this fixed error category. Never retain
      // provider errors, command arguments, URLs, guest passwords or tokens.
      if(!controller.signal.aborted)await this.#repository.retry(op);
      return {processed:1,operationId:op.id,state:'retrying'};
    } finally {
      clearInterval(heartbeat);this.#controller=null;
    }
  }
  start() {
    if(!this.#stopped)return;
    this.#stopped=false;
    const poll=async()=>{
      try {await this.runOnce();} catch { /* DB outage: retry after the configured interval. */ }
      finally {if(!this.#stopped)this.#timer=setTimeout(poll,this.#pollMs);}
    };
    this.#timer=setTimeout(poll,0);
  }
  async stop() {
    this.#epoch++;this.#stopped=true;clearTimeout(this.#timer);this.#timer=null;
    this.#controller?.abort();
    // Stopping this consumer never stops Windows or releases its reservation.
    await this.#active;
  }
}
