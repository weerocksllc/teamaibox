/** Explicit video-only source. Creating/opening a page never requests a camera.
 * Signalling uses the existing authenticated phone API supplied by the caller.
 * This controller is not enabled in the published UI until Android acceptance.
 */
export class PhoneBrowserCapture {
  #devices;#Peer;#capabilities;#exchange;#revoke;#state;#sourceId;#peer;#stream;
  #epoch=0;#abort;#removers=[];#phase='off';#revokePending=new Set();#connectionTimer;
  #permissions;#releasePermission;
  constructor({mediaDevices=globalThis.navigator?.mediaDevices,PeerConnection=globalThis.RTCPeerConnection,
    permissions=globalThis.navigator?.permissions,videoCapabilities=()=>globalThis.RTCRtpSender.getCapabilities('video'),exchange,revoke,onState=()=>{}}){
    if(typeof exchange!=='function'||typeof revoke!=='function')throw TypeError('camera_transport_required');
    this.#devices=mediaDevices;this.#Peer=PeerConnection;this.#capabilities=videoCapabilities;
    this.#exchange=exchange;this.#revoke=revoke;this.#state=onState;
    this.#permissions=permissions;
  }
  #set(value){this.#phase=value;this.#state(value);}
  get state(){return this.#phase;}
  get stream(){return this.#stream??null;}
  bindPage(page=globalThis.window){
    const leave=()=>{void this.stop();};page.addEventListener('pagehide',leave);
    const remove=()=>page.removeEventListener('pagehide',leave);this.#removers.push(remove);return remove;
  }
  async #gather(peer,signal){
    if(peer.iceGatheringState==='complete')return;
    await new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',change);signal.removeEventListener('abort',abort);};
      const change=()=>{if(peer.iceGatheringState==='complete'){cleanup();resolve();}};
      const abort=()=>{cleanup();reject(Error('camera_stopped'));};
      const timer=setTimeout(()=>{cleanup();reject(Error('camera_connection_timeout'));},5000);
      peer.addEventListener('icegatheringstatechange',change);signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();else change();
    });
  }
  async start(sourceId,{deviceId}={}){
    if(this.#phase!=='off')throw Error('camera_already_started');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sourceId))throw Error('camera_source_invalid');
    if(!this.#devices?.getUserMedia||typeof this.#Peer!=='function')throw Error('camera_browser_unsupported');
    if(deviceId!==undefined&&(typeof deviceId!=='string'||deviceId.length>512||!deviceId))throw Error('camera_device_invalid');
    const epoch=++this.#epoch,active=()=>epoch===this.#epoch;
    this.#sourceId=sourceId;this.#abort=new AbortController();const signal=this.#abort.signal;
    const current=()=>{if(!active()||signal.aborted)throw Error('camera_stopped');};
    this.#set('requesting');
    try{
      const stream=await this.#devices.getUserMedia({audio:false,video:{width:{ideal:640,max:1280},height:{ideal:480,max:960},frameRate:{ideal:15,max:15},...(deviceId?{deviceId:{exact:deviceId}}:{})}});
      // Closing while the permission prompt is open must not leave a camera
      // running if the user later accepts that obsolete prompt.
      if(!active()){for(const track of stream.getTracks())track.stop();throw Error('camera_stopped');}
      this.#stream=stream;
      const videos=stream.getVideoTracks();
      if(videos.length!==1||stream.getAudioTracks().length!==0||videos[0].readyState!=='live')throw Error('camera_video_only_required');
      const track=videos[0];track.addEventListener('ended',()=>{if(active())void this.stop();},{once:true});
      // Track-ended and permission-change are independent shutdown signals.
      // Observe both; this read-only query never opens a camera.
      // Browsers without a camera Permissions descriptor retain the ended path.
      let permission;
      try{permission=await this.#permissions?.query({name:'camera'});}catch{}
      current();
      if(permission&&typeof permission.addEventListener==='function'){
        const changed=()=>{if(active()&&permission.state!=='granted')void this.stop();};
        permission.addEventListener('change',changed);
        this.#releasePermission=()=>permission.removeEventListener('change',changed);
        if(permission.state!=='granted')throw Object.assign(Error('camera_permission_denied'),{name:'NotAllowedError'});
      }
      const peer=new this.#Peer({iceServers:[],bundlePolicy:'max-bundle'});this.#peer=peer;
      const transceiver=peer.addTransceiver(track,{direction:'sendonly',streams:[stream]});
      const codecs=this.#capabilities()?.codecs?.filter(value=>value.mimeType.toLowerCase()==='video/vp8');
      if(!codecs?.length||typeof transceiver.setCodecPreferences!=='function')throw Error('camera_codec_unsupported');
      transceiver.setCodecPreferences(codecs);
      peer.onconnectionstatechange=()=>{
        if(!active())return;
        if(peer.connectionState==='connected'){clearTimeout(this.#connectionTimer);this.#connectionTimer=null;this.#set('sending');}
        else if(['disconnected','failed','closed'].includes(peer.connectionState))void this.stop();
      };
      peer.ontrack=event=>{event.track.stop();if(active())void this.stop();};
      peer.ondatachannel=event=>{event.channel.close();if(active())void this.stop();};
      this.#set('connecting');
      // A signalling answer is not proof that media connected. Do not keep a
      // physical camera on indefinitely behind a stalled ICE negotiation.
      this.#connectionTimer=setTimeout(()=>{if(active()&&this.#phase==='connecting')void this.stop();},15000);
      const offer=await peer.createOffer();current();await peer.setLocalDescription(offer);current();
      await this.#gather(peer,signal);current();
      const answer=await this.#exchange({sourceId,offerSdp:peer.localDescription.sdp,signal});current();
      if(answer?.sourceId!==sourceId||typeof answer.answerSdp!=='string'||answer.answerSdp.length>65536)throw Error('camera_response_invalid');
      await peer.setRemoteDescription({type:'answer',sdp:answer.answerSdp});current();
      return {sourceId};
    }catch(error){
      if(active())await this.stop();
      // The caller translates a fixed error name; it must not log browser
      // device labels, SDP or original permission/error messages.
      throw Error(error?.name==='NotAllowedError'?'camera_permission_denied':error?.name==='NotFoundError'?'camera_device_missing':
        ['camera_stopped','camera_video_only_required','camera_codec_unsupported','camera_connection_timeout','camera_response_invalid'].includes(error?.message)?error.message:'camera_connection_failed');
    }
  }
  async #closeRemote(sourceId){
    if(!sourceId||this.#revokePending.has(sourceId))return;
    this.#revokePending.add(sourceId);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
    try{await this.#revoke({sourceId,signal:controller.signal});}
    catch{/* Runtime's independent short lease must expire even if offline. */}
    finally{clearTimeout(timer);this.#revokePending.delete(sourceId);}
  }
  async stop(){
    clearTimeout(this.#connectionTimer);this.#connectionTimer=null;
    this.#releasePermission?.();this.#releasePermission=null;
    ++this.#epoch;this.#abort?.abort();this.#abort=null;
    const sourceId=this.#sourceId;this.#sourceId=null;
    // Stop local capture immediately, before any network acknowledgement.
    const stream=this.#stream;this.#stream=null;
    for(const track of stream?.getTracks()??[])track.stop();
    const peer=this.#peer;this.#peer=null;if(peer){peer.onconnectionstatechange=null;peer.close();}
    this.#set('off');await this.#closeRemote(sourceId);
  }
  async dispose(){for(const remove of this.#removers.splice(0))remove();await this.stop();}
}
