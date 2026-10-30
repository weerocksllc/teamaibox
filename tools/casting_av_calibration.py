"""Generated calibration clip and local, frame-bounded optical/acoustic analysis.

No production receiver changes. Recordings remain local; only timing/brightness
and energy aggregates are retained by analysis. Camera A/V bias is NOT assumed
to be calibrated. A generated-file self-test is never physical acceptance.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import wave

import numpy as np

FPS, RATE, DURATION = 30, 48000, 22
PULSES = list(range(2, 21, 2))


def command(args, timeout=120):
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout).stdout


def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return 'sha256:' + h.hexdigest()


def write_json_new(path, value):
    with path.open('x') as f:
        json.dump(value, f, indent=2)


def digit(frame, x, y, number, scale=1):
    # Seven-segment frame number: no font/dependency downloads.
    enabled = ('abcdef','bc','abdeg','abcdg','bcfg','acdfg','acdefg','abc','abcdefg','abcdfg')[number]
    rectangles = {'a':(4,0,20,4),'b':(24,4,4,20),'c':(24,28,4,20),
                  'd':(4,48,20,4),'e':(0,28,4,20),'f':(0,4,4,20),'g':(4,24,20,4)}
    for key in enabled:
        dx,dy,w,h=rectangles[key]
        frame[y+dy*scale:y+(dy+h)*scale, x+dx*scale:x+(dx+w)*scale]=220


def generate(path):
    if path.exists() or path.with_suffix('.json').exists():
        raise ValueError('output_already_exists')
    path.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg=shutil.which('ffmpeg')
    if not ffmpeg: raise ValueError('existing_ffmpeg_required')
    with tempfile.TemporaryDirectory(prefix='teamaibox-av-generated-') as scratch:
        wav=Path(scratch)/'generated.wav'
        signal=np.zeros(DURATION*RATE,dtype=np.float64)
        n=int(.1*RATE); t=np.arange(n)/RATE
        envelope=np.minimum(1,np.minimum(t/.002,(.1-t)/.002))
        tone=.15*np.sin(2*np.pi*1000*t)*envelope
        for second in PULSES: signal[second*RATE:second*RATE+n]=tone
        pcm=np.repeat((signal*32767).astype('<i2')[:,None],2,axis=1)
        with wave.open(str(wav),'wb') as w:
            w.setnchannels(2);w.setsampwidth(2);w.setframerate(RATE);w.writeframes(pcm.tobytes())
        args=[ffmpeg,'-hide_banner','-loglevel','error','-n','-f','rawvideo','-pixel_format','gray',
              '-video_size','640x360','-framerate',str(FPS),'-i','pipe:0','-i',str(wav),
              '-vf','scale=1920:1080:flags=neighbor,format=yuv420p','-c:v','libx264','-threads','2',
              '-preset','veryfast','-crf','18','-bf','0','-g','30','-c:a','aac','-b:a','192k',
              '-ar',str(RATE),'-movflags','+faststart','-t',str(DURATION),str(path)]
        p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        try:
            for index in range(DURATION*FPS):
                frame=np.full((360,640),24,dtype=np.uint8)
                # Large clean optical region; frame counter does not overlap it.
                flash=any(second*FPS<=index<second*FPS+3 for second in PULSES)
                frame[90:270,96:544]=235 if flash else 36
                for offset,number in enumerate(f'{index:04d}'):
                    digit(frame,250+offset*36,15,int(number))
                frame[320:330,32:32+int(576*index/(DURATION*FPS))]=130
                p.stdin.write(frame.tobytes())
            p.stdin.close();p.stdin=None
            _,error=p.communicate(timeout=90)
            if p.returncode: raise RuntimeError(error.decode()[:200])
        finally:
            if p.poll() is None: p.kill();p.wait()
    value={'kind':'generated-calibration-clip','clipSha256':sha(path),'width':1920,'height':1080,
           'fps':FPS,'sampleRate':RATE,'durationSeconds':DURATION,'pulseSeconds':PULSES,
           'pulseDurationMs':100,'frequencyHz':1000,'opticalRoi':[288,270,1344,540],
           'sourceEventOffsetMs':0,'physicalAcceptance':False}
    write_json_new(path.with_suffix('.json'),value)
    return value


def rising_events(times, values, *, contrast=30, refractory=.8):
    times=np.asarray(times,dtype=float);values=np.asarray(values,dtype=float)
    if len(times)!=len(values) or len(times)<3 or not np.all(np.diff(times)>0):
        raise ValueError('invalid_or_nonmonotonic_timestamps')
    low,high=np.percentile(values,[10,99])
    if high-low<contrast: raise ValueError('insufficient_marker_contrast')
    threshold=low+.5*(high-low)
    events=[];last=-math.inf
    for i in range(1,len(values)):
        if values[i-1]<threshold<=values[i] and times[i]-last>=refractory:
            events.append({'lo':float(times[i-1]),'hi':float(times[i]),'estimate':float((times[i-1]+times[i])/2)})
            last=times[i]
    return events


def match_events(source, target, *, min_offset=-.25, max_offset=1.0):
    if len(source)<5 or len(source)!=len(target): raise ValueError('need_at_least_five_equal_count_pulses')
    # All pulses must match in order; do not cherry-pick successful ones.
    differences=[]
    for a,b in zip(source,target):
        value=b['estimate']-a['estimate']
        if not min_offset<=value<=max_offset: raise ValueError('pulse_alignment_or_latency_out_of_range')
        differences.append({'estimateMs':value*1000,'lowerMs':(b['lo']-a['hi'])*1000,'upperMs':(b['hi']-a['lo'])*1000})
    values=[x['estimateMs'] for x in differences]
    return {'count':len(values),'medianMs':float(np.median(values)),
            'p95Ms':float(np.percentile(values,95)),'minMs':min(values),'maxMs':max(values),
            'measurementBracketMaxWidthMs':max(x['upperMs']-x['lowerMs'] for x in differences),
            'perPulse':differences}


def metadata(path):
    raw=command(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)])
    v=json.loads(raw);video=next(s for s in v['streams'] if s['codec_type']=='video')
    if float(v['format']['duration'])>90 or video['width']*video['height']>4096*2160:
        raise ValueError('recording_exceeds_analysis_bounds')
    return v,video


def optical(path,roi):
    _,video=metadata(path)
    x,y,w,h=roi
    if min(x,y)<0 or min(w,h)<16 or x+w>video['width'] or y+h>video['height']:
        raise ValueError('roi_out_of_unrotated_frame')
    timestamps=json.loads(command(['ffprobe','-v','error','-select_streams','v:0','-show_frames',
        '-show_entries','frame=best_effort_timestamp_time','-of','json',str(path)]))['frames']
    times=[float(f['best_effort_timestamp_time']) for f in timestamps]
    raw=command(['ffmpeg','-v','error','-threads','2','-noautorotate','-i',str(path),
        '-map','0:v:0','-filter_threads','1','-vf',f'crop={w}:{h}:{x}:{y},scale=16:16,format=gray',
        '-fps_mode','passthrough','-f','rawvideo','-pix_fmt','gray','pipe:1'])
    if len(raw)!=len(times)*256:raise ValueError('decoded_frame_count_changed')
    values=np.frombuffer(raw,np.uint8).reshape(-1,256).mean(axis=1)
    return rising_events(times,values),{'frameCount':len(times),'medianFrameMs':float(np.median(np.diff(times))*1000)}


def acoustic(path):
    first=json.loads(command(['ffprobe','-v','error','-select_streams','a:0','-show_frames',
        '-read_intervals','%+#8','-show_entries','frame=best_effort_timestamp_time','-of','json',str(path)]))['frames']
    if not first: raise ValueError('audio_timestamps_missing')
    start=float(first[0]['best_effort_timestamp_time'])
    raw=command(['ffmpeg','-v','error','-threads','2','-i',str(path),'-map','0:a:0','-vn','-ac','1',
        '-ar',str(RATE),'-af','highpass=f=800,lowpass=f=1200','-f','f32le','pipe:1'])
    samples=np.frombuffer(raw,'<f4');window=48  # 1 ms aggregate, not false sub-frame precision.
    samples=samples[:len(samples)//window*window].reshape(-1,window)
    values=np.sqrt(np.mean(samples*samples,axis=1))
    times=start+np.arange(len(values))*.001
    return rising_events(times,values,contrast=.005)


def analyze(path,source_roi,display_roi,*,generated=False):
    source,source_stats=optical(path,source_roi);display,display_stats=optical(path,display_roi)
    sound=acoustic(path)
    glass=match_events(source,display,min_offset=-.05,max_offset=1.0)
    av=match_events(display,sound,min_offset=-.5,max_offset=.5)
    result={'recordingSha256':sha(path),'generatedFileSelfTest':generated,'physicalAcceptance':False,
       'sourceVideo':source_stats,'displayVideo':display_stats,
       'sourceToDisplay':glass,'soundMinusDisplay':av,
       'signConvention':'positive soundMinusDisplay means audio is late',
       'cameraAvBiasCalibrated':False,'speakerToMicrophoneDistanceCorrected':False,
       'limitations':['Frame brackets exclude unknown camera audio/video bias and sound travel time.',
                     'Generated-file results do not measure any receiver, display or speaker.']}
    if generated:
        reference=json.loads(path.with_suffix('.json').read_text())
        if reference['kind']!='generated-calibration-clip' or reference['clipSha256']!=sha(path):
            raise ValueError('reference_manifest_invalid')
        expected=reference['pulseSeconds']
        if len(expected)!=len(source) or len(expected)!=len(sound):raise ValueError('reference_pulses_missing')
        # In a generated source file each bright frame begins exactly at its
        # frame PTS; unlike a camera sample there is no unknown exposure phase.
        if any(abs(e['hi']-s)>.00001 for e,s in zip(source,expected)):
            raise ValueError('reference_video_marker_misaligned')
        audio_offsets=[{'lowerMs':(e['lo']-s)*1000,'upperMs':(e['hi']-s)*1000}
                       for e,s in zip(sound,expected)]
        if any(abs(o['lowerMs'])>2 or abs(o['upperMs'])>2 for o in audio_offsets):
            raise ValueError('reference_audio_marker_misaligned')
        result['referenceCheck']={'passed':True,'pulseCount':len(expected),
                                  'audioMarkerOffsetBoundsMs':audio_offsets}
    return result


def roi(value):
    result=[int(v) for v in value.split(',')]
    if len(result)!=4:raise ValueError('roi_requires_x_y_width_height')
    return result


def main():
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='mode',required=True)
    g=sub.add_parser('generate');g.add_argument('--output',type=Path,required=True)
    a=sub.add_parser('analyze');a.add_argument('--recording',type=Path,required=True)
    a.add_argument('--source-roi',type=roi,required=True);a.add_argument('--display-roi',type=roi,required=True)
    a.add_argument('--output',type=Path,required=True);a.add_argument('--generated-self-test',action='store_true')
    args=p.parse_args()
    if args.mode=='generate':v=generate(args.output)
    else:
        if args.output.exists():raise ValueError('output_already_exists')
        v=analyze(args.recording,args.source_roi,args.display_roi,generated=args.generated_self_test)
        write_json_new(args.output,v)
    print(json.dumps(v))

if __name__=='__main__':main()
