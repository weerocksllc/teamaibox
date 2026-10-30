// Playback permission is separate from receiving WebRTC packets. A connected
// peer can receive audio while the browser leaves this element paused.
export function createPhoneAudio({audio,button,status,translate,MediaStreamImpl=globalThis.MediaStream}) {
  let epoch=0,blocked=false,failed=false,waiting=false;
  const tracks=new Map();
  function snapshot() {
    const live=[...tracks.keys()].filter(track=>track.readyState!=='ended');
    const muted=audio.muted||audio.volume===0;
    const state=!tracks.size?'none':!live.length?'ended':failed?'failed':
      audio.paused?(blocked?'blocked':'paused'):muted?'muted':
      waiting||audio.readyState<2||live.every(track=>track.muted)?'waiting':'playing';
    return {state,paused:audio.paused,muted,readyState:audio.readyState,liveTracks:live.length};
  }
  function refresh() {
    const value=snapshot();
    status.hidden=value.state==='none';status.textContent=translate('audio_'+value.state);
    button.hidden=!['blocked','paused','failed'].includes(value.state);
    return value;
  }
  function play() {
    if(!snapshot().liveTracks)return Promise.resolve();
    const current=epoch;failed=false;
    // Must run synchronously in the user's click/key event when autoplay was
    // denied. No timer, browser-policy bypass, or Android restart is needed.
    let pending;
    try {pending=audio.play();} catch(error) {pending=Promise.reject(error);}
    return Promise.resolve(pending).then(()=>{
      if(current!==epoch)return;
      blocked=false;waiting=false;refresh();
    },error=>{
      if(current!==epoch)return;
      blocked=error?.name==='NotAllowedError';failed=!blocked&&error?.name!=='AbortError';refresh();
    });
  }
  for(const event of ['playing','pause','waiting','volumechange','error'])audio.addEventListener(event,()=>{
    if(event==='playing'){waiting=false;blocked=false;failed=false;}
    if(event==='waiting')waiting=true;
    if(event==='error')failed=true;
    refresh();
  });
  button.addEventListener('click',()=>void play());
  return {
    snapshot,refresh,
    attach(track) {
      if(track.kind!=='audio'||tracks.has(track))return;
      const changed=()=>refresh();tracks.set(track,changed);
      for(const event of ['mute','unmute','ended'])track.addEventListener(event,changed);
      const stream=audio.srcObject??new MediaStreamImpl();stream.addTrack(track);audio.srcObject=stream;
      refresh();void play();
    },
    activate(event) {
      if(event?.isTrusted && audio.paused && snapshot().liveTracks)void play();
    },
    reset() {
      epoch++;
      for(const [track,changed] of tracks)for(const event of ['mute','unmute','ended'])track.removeEventListener(event,changed);
      tracks.clear();audio.pause();audio.srcObject=null;blocked=false;failed=false;waiting=false;refresh();
    },
  };
}
