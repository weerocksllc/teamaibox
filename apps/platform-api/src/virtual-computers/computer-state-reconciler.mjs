import {randomUUID} from 'node:crypto';
import {computerCommand,validateComputerCommandResult} from '../../../../services/scheduler/src/computer-command.mjs';

// Read the actual installed run, not a cached start response. Neither a network
// error nor a missing container is proof that it is safe to release resources.
export class ComputerStateReconciler {
  #repository;#router;#poll;#timer=null;#active=null;#stopped=true;#epoch=0;#cursor=null;
  constructor({repository,nodeRouter,pollMs=5000}){
    if(!repository?.reconciliationCandidates||!repository?.observeRun||!nodeRouter?.executeComputerCommand
      ||!Number.isSafeInteger(pollMs)||pollMs<1)throw TypeError('Computer reconciliation dependencies required');
    this.#repository=repository;this.#router=nodeRouter;this.#poll=pollMs;
  }
  runOnce(){
    if(this.#active)return this.#active;
    this.#active=this.#run().finally(()=>{this.#active=null;});return this.#active;
  }
  async #run(){
    const epoch=this.#epoch,rows=await this.#repository.reconciliationCandidates(this.#cursor);
    this.#cursor=rows.length===20?rows.at(-1).id:null;
    if(epoch!==this.#epoch)return;
    // A small batch bounds control traffic, not the number of owned computers.
    for(let offset=0;offset<rows.length;offset+=4){
      if(epoch!==this.#epoch)return;
      await Promise.all(rows.slice(offset,offset+4).map(async c=>{
        const op={id:randomUUID(),action:'inspect',command:{...c,computerId:c.id}};
        const payload=computerCommand(op);let result=null;
        try{
          result=validateComputerCommandResult('inspect',payload,await this.#router.executeComputerCommand({nodeId:c.nodeId,action:'inspect',payload,
            correlationId:op.id,timeoutMilliseconds:10000}));
          if(result.rejected)result=null;
        }catch{/* Keep reservations; only report temporary unavailability. */}
        if(epoch===this.#epoch)await this.#repository.observeRun(c,result);
      }));
    }
  }
  start(){
    if(!this.#stopped)return;this.#stopped=false;
    const tick=async()=>{try{await this.runOnce();}catch{/* Database outage: retry without guessing state. */}
      finally{if(!this.#stopped)this.#timer=setTimeout(tick,this.#poll);}};
    this.#timer=setTimeout(tick,0);
  }
  async stop(){this.#stopped=true;this.#epoch++;clearTimeout(this.#timer);this.#timer=null;await this.#active;}
}
