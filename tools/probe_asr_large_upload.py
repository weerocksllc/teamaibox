"""Synthetic large WAV protocol check. No user recording or network egress."""
import hashlib,http.client,json,math,os,struct,tempfile,time
from pathlib import Path

def request(path,source,fields):
    boundary='teamaibox-asr-resource-probe'
    before=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="resource.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode()
    after=b'\r\n'
    for key,value in fields.items():after+=(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n').encode()
    after+=(f'--{boundary}--\r\n').encode()
    c=http.client.HTTPConnection('127.0.0.1',8080,timeout=120)
    try:
        c.putrequest('POST',path);c.putheader('Content-Type','multipart/form-data; boundary='+boundary)
        c.putheader('Content-Length',len(before)+source.stat().st_size+len(after));c.endheaders();c.send(before)
        with source.open('rb') as f:
            while chunk:=f.read(256*1024):c.send(chunk)
        c.send(after);res=c.getresponse();value=json.loads(res.read());assert res.status==200,(res.status,value)
        return value
    finally:c.close()

def main():
    fd,name=tempfile.mkstemp(prefix='asr-resource-probe-',suffix='.wav',dir='/tmp');source=Path(name)
    r={'passed':False,'modelLoaded':True,'syntheticOnly':True,'cleanup':False}
    try:
        # RIFF permits an uninterpreted JUNK chunk. This exercises >64 MiB
        # transport while only asking the actual model to decode 2s of silence.
        padding=70*1024*1024;pcm=bytes(16000*2*2)
        with os.fdopen(fd,'wb') as f:
            f.write(b'RIFF'+struct.pack('<I',4+24+8+len(pcm)+8+padding)+b'WAVE')
            f.write(b'fmt '+struct.pack('<IHHIIHH',16,1,1,16000,32000,2,16))
            f.write(b'data'+struct.pack('<I',len(pcm))+pcm+b'JUNK'+struct.pack('<I',padding))
            for _ in range(70):f.write(bytes(1024*1024))
        r['inputBytes']=source.stat().st_size
        start=time.monotonic();facts=request('/v1/audio/metadata',source,{})
        assert abs(facts['duration']-2)<0.1,facts;r['metadata']=facts
        transcript=request('/v1/audio/transcriptions',source,{'model':os.environ.get('ASR_MODEL_ALIAS','whisper-small-ct2-int8'),'response_format':'verbose_json','language':'en'})
        assert isinstance(transcript['text'],str) and isinstance(transcript['segments'],list)
        assert abs(transcript['duration']-2)<0.1
        r.update(passed=True,durationSeconds=transcript['duration'],segmentCount=len(transcript['segments']),elapsedMilliseconds=round((time.monotonic()-start)*1000))
    finally:
        source.unlink(missing_ok=True)
        r['cleanup']=not source.exists() and not list(Path('/tmp').glob('teamaibox-realtime-asr-*'))
        print(json.dumps(r))
if __name__=='__main__':main()
