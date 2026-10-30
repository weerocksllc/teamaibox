import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function dynamicSandboxIdentity(ownerIdentityId) {
  if (!UUID.test(ownerIdentityId ?? '')) throw new Error('agent_owner_invalid');
  const key = createHash('sha256').update(ownerIdentityId).digest('hex').slice(0,32);
  return {ownerIdentityId,key,name:`teamaibox-agent-${key}`,sandboxKey:`sandbox.${key}`,origin:`http://teamaibox-agent-${key}:4097`};
}

// Runtime and storage remain adapters so lifecycle races can be tested without
// Docker or user data. A workspace is never deleted by idle/disable/stop.
export class DynamicSandboxController {
  constructor({identities,runtime,storage,clock=Date.now,idleMilliseconds=20*60*1000}) {
    this.identities=identities;this.runtime=runtime;this.storage=storage;this.clock=clock;
    this.idleMilliseconds=idleMilliseconds;this.locks=new Map();
  }
  async exclusive(id,operation) {
    const previous=this.locks.get(id) ?? Promise.resolve();
    const next=previous.catch(()=>{}).then(operation);this.locks.set(id,next);
    try{return await next;}finally{if(this.locks.get(id)===next)this.locks.delete(id);}
  }
  async ensure(ownerIdentityId) {
    const identity=dynamicSandboxIdentity(ownerIdentityId);
    return this.exclusive(ownerIdentityId,async()=>{
      if (!await this.identities.active(ownerIdentityId)) throw new Error('agent_owner_inactive');
      const value=await this.storage.prepare(identity);
      let current=await this.runtime.inspect(identity);
      if (current) this.runtime.assertOwned(identity,current);
      if (!current?.running) {
        await this.runtime.admit(identity);
        await this.storage.credentials(identity);
        current=await this.runtime.start(identity,current);
      }
      await this.runtime.healthy(identity,current);
      if (!await this.identities.active(ownerIdentityId)) {
        await this.runtime.stop(identity,current);throw new Error('agent_owner_inactive');
      }
      await this.storage.touch(identity,this.clock());
      return {...identity,token:value.token};
    });
  }
  async reconcile() {
    for (const identity of await this.storage.list()) {
      await this.exclusive(identity.ownerIdentityId,async()=>{
        const current=await this.runtime.inspect(identity);
        if (!current) return;
        this.runtime.assertOwned(identity,current);
        if (!current.running) return;
        const active=await this.identities.active(identity.ownerIdentityId);
        const busy=active && await this.identities.busy(identity.ownerIdentityId);
        if (!active || (!busy && this.clock()-identity.lastUsedAt>=this.idleMilliseconds)) {
          await this.runtime.stop(identity,current);return;
        }
        await this.storage.credentials(identity);
      });
    }
  }
}
