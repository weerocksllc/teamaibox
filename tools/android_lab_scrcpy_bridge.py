#!/usr/bin/env python3
"""Single-phone evaluation bridge, private VM + SSH only; not a product service.

Protocol pinned to Genymobile scrcpy v4.1 doc/develop.md and control serializer.
Only synthetic content is used. No arbitrary shell/ADB endpoint is exposed.
"""
import asyncio
import json
from pathlib import Path
import socket
import struct
import subprocess

SERVER_SHA='deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae'

def control_message(message):
    kind=message.get('type')
    if kind=='touch':
        x,y,w,h=(int(message[k]) for k in ('x','y','width','height'))
        action=int(message['action'])
        if action not in (0,1,2) or not 0<=x<w<=4096 or not 0<=y<h<=4096:raise ValueError('invalid touch')
        return struct.pack('>BBQiiHHHII',2,action,0,x,y,w,h,0 if action==1 else 65535,0,0)
    if kind=='text':
        data=message['text'].encode('utf-8')
        if len(data)>300:raise ValueError('text limit')
        return b'\x01'+struct.pack('>I',len(data))+data
    if kind=='key':
        code=int(message['keycode']);action=int(message['action'])
        if not 0<=code<=300 or action not in (0,1):raise ValueError('invalid key')
        return struct.pack('>BBIII',0,action,code,0,0)
    raise ValueError('unsupported control')

def media_header(raw):
    if len(raw)!=12:raise ValueError('header length')
    if raw[0]&128:
        flags,width,height=struct.unpack('>III',raw)
        if not 0<width<=4096 or not 0<height<=4096:raise ValueError('invalid dimensions')
        return {'session':True,'width':width,'height':height}
    pts,length=struct.unpack('>QI',raw)
    if length>8*1024*1024:raise ValueError('media size limit')
    return {'session':False,'length':length,'config':bool(pts&(1<<62)),
            'key':bool(pts&(1<<61)),'pts':pts&((1<<61)-1)}

async def main():
    from aiohttp import web, WSMsgType
    import hashlib
    if socket.gethostname()!='android-lab':raise RuntimeError('private lab VM required')
    base=Path('/home/lab/android-browser-lab')
    jar=base/'scrcpy-server-v4.1'
    if hashlib.sha256(jar.read_bytes()).hexdigest()!=SERVER_SHA:raise RuntimeError('scrcpy artifact mismatch')
    subprocess.run(['adb','push',str(jar),'/data/local/tmp/android-lab-scrcpy.jar'],check=True)
    subprocess.run(['adb','reverse','tcp:8128','tcp:8128'],check=True)
    busy=False
    sessions=0
    async def websocket(request):
        nonlocal busy,sessions
        # SSH exposes only localhost; reject cross-origin browser control.
        if request.headers.get('Origin') not in ('http://127.0.0.1:8128','http://localhost:8128'):
            raise web.HTTPForbidden()
        if busy:raise web.HTTPConflict(text='one lab viewer at a time')
        busy=True;sessions+=1
        ws=web.WebSocketResponse(max_msg_size=2048,heartbeat=20)
        await ws.prepare(request)
        writers=[];tasks=[];proc=None
        stats={'session':sessions,'videoPackets':0,'audioPackets':0,'controls':0}
        log=(base/('scrcpy-session-'+str(sessions)+'.log')).open('x')
        try:
            subprocess.run(['adb','forward','tcp:27183','localabstract:scrcpy'],check=True)
            proc=await asyncio.create_subprocess_exec('adb','shell','-n',
              'CLASSPATH=/data/local/tmp/android-lab-scrcpy.jar','app_process','/',
              'com.genymobile.scrcpy.Server','4.1','tunnel_forward=true','send_device_meta=false',
              'send_dummy_byte=false','video_codec=h264','audio_codec=raw','max_fps=30',
              'video_bit_rate=2000000','clipboard_autosync=false','stay_awake=true','log_level=debug',
              stdout=log,stderr=log)
            await asyncio.sleep(2)
            streams=[]
            for _ in range(3):
                reader,writer=await asyncio.wait_for(asyncio.open_connection('127.0.0.1',27183),10)
                streams.append(reader);writers.append(writer)
            async def media(channel,reader):
                codec=await asyncio.wait_for(reader.readexactly(4),30)
                await ws.send_json({'channel':channel,'codecHex':codec.hex()})
                if int.from_bytes(codec,'big') in (0,1):return
                while True:
                    raw=await reader.readexactly(12);header=media_header(raw)
                    if header['session']:
                        await ws.send_json({'channel':channel,**header});continue
                    body=await reader.readexactly(header['length'])
                    await asyncio.wait_for(ws.send_bytes(bytes([channel])+raw+body),5)
                    stats['videoPackets' if channel==0 else 'audioPackets']+=1
            async def controls():
                async for msg in ws:
                    if msg.type==WSMsgType.TEXT:
                        writers[2].write(control_message(json.loads(msg.data)))
                        await writers[2].drain();stats['controls']+=1
                return
            async def drain_device_messages():
                # Clipboard autosync disabled; don't store device content.
                while await streams[2].read(4096):pass
            tasks=[asyncio.create_task(media(0,streams[0])),asyncio.create_task(media(1,streams[1])),
                   asyncio.create_task(controls()),asyncio.create_task(drain_device_messages())]
            done,_=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            for task in done:task.result()
        except Exception as exc:
            stats['error']=type(exc).__name__+': '+str(exc)[:300]
            if not ws.closed:await ws.send_json({'error':stats['error']})
        finally:
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            for writer in writers:writer.close()
            if proc and proc.returncode is None:
                try:await asyncio.wait_for(proc.wait(),5)
                except asyncio.TimeoutError:proc.terminate();await proc.wait()
            subprocess.run(['adb','forward','--remove','tcp:27183'],capture_output=True)
            log.close();busy=False
            with (base/('bridge-session-'+str(sessions)+'.json')).open('x') as out:json.dump(stats,out,indent=2)
            await ws.close()
        return ws
    async def viewer(request):return web.FileResponse(base/'viewer.html')
    async def fixture(request):return web.FileResponse(base/'fixture.html')
    app=web.Application();app.router.add_get('/',viewer);app.router.add_get('/fixture',fixture);app.router.add_get('/ws',websocket)
    runner=web.AppRunner(app);await runner.setup();await web.TCPSite(runner,'127.0.0.1',8128).start()
    print('ANDROID_LAB_BROWSER_READY',flush=True)
    try:await asyncio.sleep(900)
    finally:await runner.cleanup()

if __name__=='__main__':asyncio.run(main())
