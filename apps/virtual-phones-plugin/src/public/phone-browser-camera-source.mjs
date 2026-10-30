import {PhoneBrowserCapture} from './phone-browser-capture.mjs';

/** Bind explicit local capture to the current phone and a short page lease.
 * No background capture, retry loop, device persistence or microphone access.
 */
export class PhoneBrowserCameraSource {
  #json;#phone;#capture;#active=null;#onState;#onError;#schedule;#cancel;#page;#leave;
  constructor({phone,json,onState=()=>{},onError=()=>{},captureOptions={},
    Capture=PhoneBrowserCapture,schedule=(fn,ms)=>globalThis.setTimeout(fn,ms),cancel=id=>globalThis.clearTimeout(id),page=globalThis.window}){
    if(!/^[0-9a-f-]{36}$/i.test(phone?.id??'')||!Number.isSafeInteger(phone.generation)||phone.generation<1||typeof json!=='function')
      throw TypeError('camera_phone_invalid');
    this.#phone={id:phone.id,generation:phone.generation};this.#json=json;this.#onState=onState;this.#onError=onError;
    this.#schedule=schedule;this.#cancel=cancel;this.#page=page;
    this.#capture=new Capture({...captureOptions,exchange:input=>this.#exchange(input),revoke:input=>this.#revoke(input),
      onState:value=>{if(value==='off')this.#clear();this.#onState(value);}});
    this.#leave=()=>{void this.stop();};
    page?.addEventListener('pagehide',this.#leave);page?.addEventListener('offline',this.#leave);
  }
  get state(){return this.#capture.state;}
  get stream(){return this.#capture.stream;}
  get sourceId(){return this.#active?.sourceId??null;}
  #root(){return '/api/v1/virtual-phones/'+this.#phone.id+'/camera';}
  #clear(){const active=this.#active;if(active){this.#cancel(active.timer);active.abort.abort();}this.#active=null;}
  async #remove(sourceId,signal){
    return this.#json(this.#root(),{method:'DELETE',signal,
      body:{expectedGeneration:this.#phone.generation,sourceId}});
  }
  async #revoke({sourceId,signal}){await this.#remove(sourceId,signal);}
  async #heartbeat(active){
    if(active!==this.#active)return;
    try{
      const result=await this.#json(this.#root()+'/browser/heartbeat',{method:'POST',
        signal:AbortSignal.any([active.abort.signal,AbortSignal.timeout(1500)]),
        body:{expectedGeneration:this.#phone.generation,sourceId:active.sourceId}});
      if(active!==this.#active)return;
      if(result?.sourceId!==active.sourceId||result.expiresInMilliseconds!==4000)throw Error('camera_response_invalid');
      // Never overlap heartbeat requests or automatically restart lost capture.
      active.timer=this.#schedule(()=>void this.#heartbeat(active),1000);
    }catch{
      if(active===this.#active){void this.stop();this.#onError('camera_connection_lost');}
    }
  }
  async #exchange({sourceId,offerSdp,signal}){
    const active=this.#active;if(!active||active.sourceId!==sourceId)throw Error('camera_stopped');
    const bound=AbortSignal.any([signal,active.abort.signal,AbortSignal.timeout(20000)]);
    try{
      const value=await this.#json(this.#root(),{method:'POST',signal:bound,
        body:{expectedGeneration:this.#phone.generation,requestId:sourceId,source:{kind:'browser',continueWithoutViewer:false}}});
      bound.throwIfAborted();
      if(active!==this.#active||value?.phoneId!==this.#phone.id||value.generation!==this.#phone.generation
        ||value.sourceId!==sourceId||value.sourceKind!=='browser'||value.state!=='active')throw Error('camera_response_invalid');
      void this.#heartbeat(active);
      const answer=await this.#json(this.#root()+'/browser/offer',{method:'POST',signal:bound,
        body:{expectedGeneration:this.#phone.generation,sourceId,offerSdp}});
      bound.throwIfAborted();if(active!==this.#active)throw Error('camera_stopped');return answer;
    }catch(error){
      // An open can commit just as the browser aborts. Revoke this exact source
      // after the request settles too; it cannot stop a replacement source.
      await this.#remove(sourceId,AbortSignal.timeout(2000)).catch(()=>{});throw error;
    }
  }
  async start({deviceId}={}){
    if(this.#active||this.state!=='off')throw Error('camera_already_started');
    const active={sourceId:crypto.randomUUID(),abort:new AbortController(),timer:null};this.#active=active;
    try{return await this.#capture.start(active.sourceId,{deviceId});}
    catch(error){if(this.#active===active)this.#clear();throw error;}
  }
  stop(){this.#clear();return this.#capture.stop();}
  async dispose(){this.#page?.removeEventListener('pagehide',this.#leave);this.#page?.removeEventListener('offline',this.#leave);await this.stop();}
}
