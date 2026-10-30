import {isDeepStrictEqual} from 'node:util';
import {computerCommand,validateComputerCommand,validateComputerCommandResult} from '../../../../services/scheduler/src/computer-command.mjs';

/** Connect the durable operation queue to shared admission and the existing
 * authenticated node transport. This adapter owns neither disks nor shutdown:
 * uncertain transport outcomes retain their reservations and operation IDs.
 */
export class ManagedComputerRuntime {
  #repository;#capacity;#router;#timeout;#media;#transfer;
  constructor({repository,capacity,nodeRouter,timeoutMilliseconds,mediaRepository=null,mediaTransfer=null}) {
    if(typeof repository?.get!=='function'||typeof capacity?.acquireRun!=='function'
      ||typeof nodeRouter?.executeComputerCommand!=='function'
      ||!Number.isSafeInteger(timeoutMilliseconds)||timeoutMilliseconds<=0)throw TypeError('Computer runtime dependencies required');
    this.#repository=repository;this.#capacity=capacity;this.#router=nodeRouter;this.#timeout=timeoutMilliseconds;
    this.#media=mediaRepository;this.#transfer=mediaTransfer;
  }
  async execute({operation,payload,signal}) {
    signal?.throwIfAborted();
    const expected=computerCommand(operation);
    if(!isDeepStrictEqual(payload,expected)||operation.computerId!==expected.computerId
      ||operation.ownerId!==expected.ownerId||operation.generation!==expected.generation)throw Error('computer_operation_mismatch');
    const computer=await this.#repository.get(operation.ownerId,operation.computerId);
    const current={...computer,computerId:computer.id};
    if(operation.action==='installation') {
      if(!['stopped','running'].includes(computer.state)||Object.keys(operation.command).filter(k=>k!=='installation').some(key=>
        !isDeepStrictEqual(current[key],operation.command[key])))throw Error('computer_operation_mismatch');
      const state=await this.#repository.getInstallation(computer.ownerId,computer.id);
      if(state?.operationId!==operation.id||state.revision!==expected.installation.revision||state.desiredMediaId!==expected.installation.mediaId)
        throw Error('computer_operation_mismatch');
      let stream;
      try{
        if(expected.installation.action==='mount') {
          if(!this.#media||!this.#transfer)throw Error('computer_installation_unavailable');
          const media=await this.#media.get(computer.ownerId,expected.installation.mediaId);
          if(media.state!=='ready'||media.digest!==expected.installation.digest||media.size!==expected.installation.size)throw Error('computer_media_not_ready');
          stream=await this.#transfer.openReady(media,{signal});
        }
        const result=await this.#router.executeComputerInstallation({nodeId:computer.nodeId,payload:expected,chunks:stream?.chunks,signal,correlationId:operation.id});
        signal?.throwIfAborted();return validateComputerCommandResult('installation',expected,result);
      }finally{await stream?.chunks.return?.();}
    }
    const requiredState={create:'creating',start:'starting',shutdown:'stopping',delete:'deleting'}[operation.action];
    if(!requiredState||computer.state!==requiredState||Object.keys(operation.command).filter(k=>k!=='installation').some(key=>
      !isDeepStrictEqual(current[key],operation.command[key])))throw Error('computer_operation_mismatch');
    signal?.throwIfAborted();
    let dispatch=expected;
    if(operation.action==='start') {
      // A thrown admission/transport error remains uncertain. The capacity
      // transaction may separately prove this exact run was never allocated.
      const reservation=await this.#capacity.acquireRun({computer,operation});
      signal?.throwIfAborted();
      if(reservation?.id!==computer.run.id||reservation.computer_id!==computer.id||Number(reservation.generation)!==computer.generation
        ||reservation.node_id!==computer.nodeId||reservation.owner_id!==computer.ownerId)throw Error('computer_reservation_mismatch');
      if(reservation.state==='rejected'&&reservation.noSideEffects===true&&reservation.errorCode==='computer_capacity_unavailable') {
        const identity=Object.fromEntries(['computerId','ownerId','nodeId','volumeId','firmwareId','tpmId','operationId','generation'].map(k=>[k,expected[k]]));
        return validateComputerCommandResult('start',expected,{...identity,rejected:true,noSideEffects:true,errorCode:reservation.errorCode});
      }
      if(reservation.state!=='active')throw Error('computer_reservation_mismatch');
      dispatch=validateComputerCommand('start',{...expected,allocation:{memoryBytes:Number(reservation.memory_bytes),
        cpuIds:typeof reservation.cpu_ids==='string'?JSON.parse(reservation.cpu_ids):reservation.cpu_ids}});
    }
    signal?.throwIfAborted();
    const result=await this.#router.executeComputerCommand({nodeId:computer.nodeId,action:operation.action,
      payload:dispatch,correlationId:operation.id,timeoutMilliseconds:this.#timeout});
    signal?.throwIfAborted();
    return validateComputerCommandResult(operation.action,expected,result);
  }
}
