// Numeric, content-free subset of https://www.w3.org/TR/webrtc-stats/.
// Missing browser counters are unknown, never zero. RTT is not end-to-end latency.
const number=value=>Number.isFinite(value)&&value>=0?value:null;
const average=(total,count)=>number(total)!==null&&number(count)>0?1000*total/count:null;
export function phoneStatistics(report) {
  const result={video:null,audio:null,roundTripMs:null,input:null};
  const rows=[...report.values()];
  for(const value of rows){
    if(value.type==='inbound-rtp' && value.kind==='video')result.video={
      width:number(value.frameWidth),height:number(value.frameHeight),framesPerSecond:number(value.framesPerSecond),
      framesDecoded:number(value.framesDecoded),framesDropped:number(value.framesDropped),
      packetsLost:number(value.packetsLost),jitterBufferMs:average(value.jitterBufferDelay,value.jitterBufferEmittedCount),
      decodeMs:average(value.totalDecodeTime,value.framesDecoded)};
    if(value.type==='inbound-rtp' && value.kind==='audio')result.audio={
      packetsReceived:number(value.packetsReceived),totalSamplesReceived:number(value.totalSamplesReceived),
      totalAudioEnergy:number(value.totalAudioEnergy),totalSamplesDuration:number(value.totalSamplesDuration),
      concealedSamples:number(value.concealedSamples),jitterBufferMs:average(value.jitterBufferDelay,value.jitterBufferEmittedCount)};
    if(value.type==='transport' && value.selectedCandidatePairId){
      const pair=report.get(value.selectedCandidatePairId);
      if(pair?.type==='candidate-pair'&&pair.state==='succeeded'&&number(pair.currentRoundTripTime)!==null)
        result.roundTripMs=pair.currentRoundTripTime*1000;
    }
    if(value.type==='data-channel'&&value.label==='input-channel')result.input={
      state:['connecting','open','closing','closed'].includes(value.state)?value.state:'unknown',messagesSent:number(value.messagesSent)};
  }
  return result;
}
