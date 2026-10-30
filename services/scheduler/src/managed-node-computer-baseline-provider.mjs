import {PlatformError} from '../../../packages/observability/src/index.mjs';

// The signed local Agent supplies installed profiles and actual observations.
// No extra query reconstructs speculative shared commitments.
export class ManagedNodeComputerBaselineProvider {
  #router;
  constructor({nodeAgentRouter}) {
    if(typeof nodeAgentRouter?.readComputerBaseline!=='function') throw TypeError('Computer baseline routing required');
    this.#router=nodeAgentRouter;
  }
  async read({nodeId,nodeGeneration,poolId}) {
    const value=await this.#router.readComputerBaseline({nodeId,nodeGeneration,correlationId:'computer-runtime-observation'});
    if(value?.nodeId!==nodeId || value.nodeGeneration!==nodeGeneration || value.poolId!==poolId) {
      throw new PlatformError('computer_capacity_unavailable','本机状态已变化，请稍后重试。',{status:409,retryable:true});
    }
    return structuredClone(value);
  }
}
