import {useEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient} from './native-client';
import {nativeText} from './native-copy';
import {decodeTerminalFrame} from './native-terminal-protocol';

export function NativeTerminal({client,id,directory,locale,onError,api='/pty'}:{client:NativeClient;id:string;directory:string;locale:Locale;onError:(error:unknown)=>void;api?:'/pty'|'/api/pty'}) {
  const host=useRef<HTMLDivElement>(null);
  const reconnect=useRef<()=>void>(()=>{});
  const [connected,setConnected]=useState(false);
  useEffect(()=>{
    const terminal=new Terminal({cursorBlink:true,fontSize:13,scrollback:5000,convertEol:false,allowProposedApi:false});
    const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(host.current!);
    let socket:WebSocket|undefined,cursor:number|undefined,disposed=false,connecting=false;
    let resizeTimer:ReturnType<typeof setTimeout>|undefined;
    const syncSize=()=>{
      if(disposed)return;
      fit.fit();clearTimeout(resizeTimer);
      resizeTimer=setTimeout(()=>void client.request(`${api}/${encodeURIComponent(id)}`,{method:'PUT',directory,body:{size:{rows:terminal.rows,cols:terminal.cols}}}).catch(onError),150);
    };
    const connect=async()=>{
      if(disposed||connecting)return;connecting=true;setConnected(false);
      socket?.close();
      try{
        const token=await client.request<{ticket:string}|{data:{ticket:string}}>(`${api}/${encodeURIComponent(id)}/connect-token`,{method:'POST',directory});
        const {ticket}='data' in token?token.data:token;
        if(disposed)return;
        const current=client.terminal(id,ticket,directory,cursor,api);socket=current;
        current.onopen=()=>{if(disposed||socket!==current)return;setConnected(true);syncSize();terminal.focus();};
        current.onclose=()=>{if(!disposed&&socket===current)setConnected(false);};
        current.onerror=()=>{if(!disposed&&socket===current)setConnected(false);};
        current.onmessage=event=>{
          if(disposed||socket!==current)return;
          try{
            const frame=decodeTerminalFrame(event.data);
            if(frame.cursor!==undefined)cursor=frame.cursor;
            if(frame.text!==undefined){terminal.write(frame.text);if(cursor!==undefined)cursor+=frame.text.length;}
          }catch(error){current.close();onError(error);}
        };
      }catch(error){if(!disposed)onError(error);}finally{connecting=false;}
    };
    reconnect.current=()=>void connect();
    const input=terminal.onData(data=>{if(socket?.readyState===WebSocket.OPEN)socket.send(data);});
    const observer=new ResizeObserver(syncSize);observer.observe(host.current!);
    void connect();
    return()=>{disposed=true;clearTimeout(resizeTimer);observer.disconnect();input.dispose();socket?.close();terminal.dispose();reconnect.current=()=>{};};
  },[client,id,directory,onError,api]);
  return <div className="native-terminal-panel" dir="ltr"><Button variant="secondary" disabled={connected} onClick={()=>reconnect.current()}>{nativeText(locale,'reconnect')}</Button><div className="native-terminal" ref={host} aria-label={nativeText(locale,'terminal')}/></div>;
}
