export function phoneDiagnosticNumber(value) {
  if(value===null||value===undefined)return '—';
  if(typeof value!=='number')return String(value);
  // Never render a small, positive energy measurement as a literal zero.
  return value!==0&&Math.abs(value)<0.001?value.toExponential(3):String(Math.round(value*1000)/1000);
}
export function createPhoneDiagnostics({element,getSession,getPlayback=()=>null,translate}) {
  let timer=null,sequence=0;
  const output=element.querySelector('dl'),stamp=element.querySelector('time');
  const fields=['width','height','framesPerSecond','framesDecoded','framesDropped','packetsLost','jitterBufferMs','decodeMs',
    'packetsReceived','totalSamplesReceived','totalAudioEnergy','totalSamplesDuration','concealedSamples','messagesSent','state'];
  function row(name,value){const key=document.createElement('dt'),detail=document.createElement('dd');key.textContent=name;
    detail.textContent=phoneDiagnosticNumber(value);output.append(key,detail);}
  async function sample(){
    const current=sequence,session=getSession();let stats=null;
    try{stats=await session?.statistics();}catch{}
    if(current!==sequence||element.hidden)return;
    output.replaceChildren();stamp.textContent=new Date().toLocaleTimeString();
    row(translate('statsRtt'),stats?.roundTripMs);
    const playback=getPlayback();
    if(playback){row(translate('statsPlayback'),translate('audio_'+playback.state));
      for(const field of ['paused','muted','readyState','liveTracks'])row(translate('statsPlayback_'+field),playback[field]);}
    for(const section of ['video','audio','input'])for(const field of fields){
      if(stats?.[section]&&field in stats[section])row(translate('stats_'+section)+' · '+translate('stats_'+field),stats[section][field]);
    }
    timer=setTimeout(()=>void sample(),1000);
  }
  function close(){sequence++;clearTimeout(timer);timer=null;element.hidden=true;output.replaceChildren();stamp.textContent='';}
  return {close,toggle(){if(!element.hidden)return close();element.hidden=false;sequence++;void sample();}};
}
