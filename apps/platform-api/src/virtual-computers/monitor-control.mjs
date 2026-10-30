import {computerError} from './lifecycle.mjs';
export const instruction=(...args)=>args.map(v=>`${Array.from(String(v)).length}.${v}`).join(',')+';';

// A bounded incremental parser: never decide permission by looking for a key
// substring in an arbitrary websocket frame (frames may split instructions).
export class MonitorInput {
  #buffer=''; #keys=new Set(); #mouse=null;
  receive(bytes,canControl){
    this.#buffer+=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(this.#buffer.length>65536)throw Error('Monitor instruction too large');
    let output='';
    while(this.#buffer){
      let offset=0,args=[],complete=false;
      while(offset<this.#buffer.length){
        const dot=this.#buffer.indexOf('.',offset);if(dot<0)break;
        const size=this.#buffer.slice(offset,dot);if(!/^\d{1,6}$/.test(size))throw Error('Invalid monitor instruction');
        const length=Number(size),remaining=Array.from(this.#buffer.slice(dot+1));
        if(length>65536)throw Error('Monitor element too large');
        if(remaining.length<=length)break;
        const value=remaining.slice(0,length).join(''),separator=remaining[length];
        if(separator!==','&&separator!==';')throw Error('Invalid monitor separator');
        args.push(value);offset=dot+1+value.length+1;
        if(separator===';'){complete=true;break;}
      }
      if(!complete)break;
      this.#buffer=this.#buffer.slice(offset);
      const [op,...a]=args;
      if(['sync','ack','nop','disconnect'].includes(op)){output+=instruction(...args);continue;}
      if(!canControl())continue;
      if(op==='key'&&a.length===2&&/^\d{1,10}$/.test(a[0])&&['0','1'].includes(a[1])){
        if(a[1]==='1')this.#keys.add(a[0]);else this.#keys.delete(a[0]);output+=instruction(...args);
      }else if(op==='mouse'&&a.length===3&&a.slice(0,2).every(v=>/^-?\d{1,10}$/.test(v))&&/^\d{1,2}$/.test(a[2])&&Number(a[2])<=31){
        this.#mouse=[a[0],a[1],a[2]];output+=instruction(...args);
      }
      // Clipboard, files, argv, streams and display resize are not monitor input.
    }
    return output;
  }
  release(){
    let result=[...this.#keys].map(key=>instruction('key',key,0)).join('');this.#keys.clear();
    if(this.#mouse&&this.#mouse[2]!=='0')result+=instruction('mouse',this.#mouse[0],this.#mouse[1],0);
    this.#mouse=null;this.#buffer='';return result;
  }
}

export class MonitorRooms {
  #rooms=new Map();
  room(id){let r=this.#rooms.get(id);if(!r){r={members:new Map(),controller:null,shared:false};this.#rooms.set(id,r);}return r;}
  join(c){const r=this.room(c.computerId);r.members.set(c.viewerId,c);if(!r.controller&&c.role!=='view')r.controller=c.viewerId;}
  leave(c){const r=this.#rooms.get(c.computerId);if(!r)return;r.members.delete(c.viewerId);
    if(r.controller===c.viewerId)r.controller=[...r.members.values()].find(m=>m.role==='owner')?.viewerId??null;
    if(!r.members.size)this.#rooms.delete(c.computerId);}
  allowed(c){const r=this.#rooms.get(c.computerId);return !!r&&r.members.has(c.viewerId)&&c.role!=='view'&&(r.shared||r.controller===c.viewerId);}
  snapshot(id,context,viewerId,role){const r=this.#rooms.get(id),self=r?.members.get(viewerId);
    const mine=self?.sessionId===context.sessionId&&self?.identityId===context.identityId?self:null;
    return {role,viewerId:mine?.viewerId??null,mode:r?.shared?'shared':'exclusive',canControl:!!mine&&this.allowed(mine),
      controller:r?.controller??null,participants:[...(r?.members.values()??[])].map(c=>({viewerId:c.viewerId,identityId:c.identityId,
        name:c.name,role:c.role,controlling:this.allowed(c),self:c===mine}))};}
  action(id,context,body){
    const r=this.#rooms.get(id),self=r?.members.get(body?.viewerId);
    if(!self||self.identityId!==context.identityId||self.sessionId!==context.sessionId)computerError('computer_permission_required',403);
    if(!body||Object.keys(body).some(k=>!['viewerId','action','targetViewerId'].includes(k)))computerError('computer_input_invalid',400);
    const owner=self.role==='owner',controls=r.controller===self.viewerId;
    if(body.action==='claim'){
      if(self.role==='view'||(!owner&&r.controller&&r.controller!==self.viewerId))computerError('computer_control_busy',409);
      r.controller=self.viewerId;
    }else if(body.action==='handoff'){
      const target=r.members.get(body.targetViewerId);
      if((!owner&&!controls)||!target||target.role==='view')computerError('computer_permission_required',403);
      r.shared=false;r.controller=target.viewerId;
    }else if(body.action==='release'){
      if(!controls)computerError('computer_permission_required',403);r.controller=null;
    }else if(['shared','exclusive','reclaim'].includes(body.action)){
      if(!owner)computerError('computer_permission_required',403);
      r.shared=body.action==='shared';r.controller=self.viewerId;
    }else computerError('computer_input_invalid',400);
    for(const member of r.members.values())if(!this.allowed(member))member.releaseInput();
    return this.snapshot(id,context,self.viewerId,self.role);
  }
  updateGrant(id,identityId,permission){const r=this.#rooms.get(id);if(!r)return;
    for(const c of [...r.members.values()])if(c.identityId===identityId){
      if(permission===null)c.close();else{c.role=permission;if(permission==='view'){c.releaseInput();if(r.controller===c.viewerId)r.controller=null;}}
    }
  }
}
