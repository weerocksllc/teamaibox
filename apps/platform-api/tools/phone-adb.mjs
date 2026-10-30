#!/usr/bin/env node
import {createServer} from "node:net";
import {once} from "node:events";
import {fileURLToPath} from "node:url";
import {realpathSync} from "node:fs";
import WebSocket,{createWebSocketStream} from "ws";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function phoneAdbURL({origin,phoneId,grantId}) {
  const url=new URL(origin);
  if(url.protocol!=="https:" || url.username || url.password || url.pathname!=="/" || url.search || url.hash || !UUID.test(phoneId??"") || !UUID.test(grantId??""))throw Error("Invalid phone connection");
  url.protocol="wss:";url.pathname=`/api/v1/virtual-phones/${phoneId}/connections/${grantId}/adb`;return url.href;
}

/** Standard adb connects only to the returned loopback port. One CLI handles
 * one granted phone and one adb transport, never a LAN bind or arbitrary target.
 */
export async function startPhoneAdbRelay({origin,phoneId,grantId,token,onClosed=()=>{}}) {
  const url=phoneAdbURL({origin,phoneId,grantId});
  if(!/^[A-Za-z0-9_-]{43}$/.test(token??""))throw Error("Invalid one-time ticket");
  const ws=new WebSocket(url,{followRedirects:false,handshakeTimeout:5000,perMessageDeflate:false,maxPayload:65536});
  let local=null,bridge=null,server=null,closed=false,claimed=false,ready=false;
  const close=()=>{if(closed)return;closed=true;clearTimeout(unclaimed);server?.close();local?.destroy();bridge?.destroy();ws.terminate();onClosed();};
  const unclaimed=setTimeout(close,60_000);unclaimed.unref();
  ws.on("error",close);ws.on("close",close);
  try {
    await once(ws,"open");
    const acknowledgement=once(ws,"message");
    ws.send(JSON.stringify({type:"phone.authenticate",token}));token=null;
    const [bytes,binary]=await Promise.race([acknowledgement,new Promise((_,reject)=>{
      const timer=setTimeout(()=>reject(Error("Phone authentication timeout")),5000);timer.unref();ws.once("close",()=>clearTimeout(timer));acknowledgement.finally(()=>clearTimeout(timer)).catch(()=>{});
    })]);
    if(binary || bytes.length>128 || JSON.parse(bytes.toString()).type!=="phone.adb.ready" || closed)throw Error("Phone authentication failed");
    bridge=createWebSocketStream(ws,{highWaterMark:65536});bridge.on("error",close);bridge.on("close",close);
    server=createServer(socket=>{
      if(claimed || closed){socket.destroy();return;}
      claimed=true;clearTimeout(unclaimed);server.close();local=socket;
      local.on("error",close);local.on("close",close);
      local.pipe(bridge);bridge.pipe(local);ws.resume();
    });
    server.on("error",close);
    await new Promise((accept,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",accept);});
    if(closed)throw Error("Phone connection closed");ready=true;
    return {port:server.address().port,close};
  } finally {if(!ready)close();}
}

async function readTicket() {
  process.stderr.write("粘贴网页的一次连接码（不显示输入），然后回车： ");
  const input=process.stdin,raw=Boolean(input.isTTY && input.setRawMode);
  if(raw)input.setRawMode(true);input.resume();
  try {return await new Promise((accept,reject)=>{
    let value="";
    const done=(error)=>{input.off("data",data);input.off("end",end);input.pause();error?reject(error):accept(value);};
    const end=()=>done(Error("Missing ticket"));
    const data=chunk=>{
      for(const char of chunk.toString("utf8")) {
        if(char==="\r" || char==="\n"){done();return;}
        if(char==="\x03"){done(Error("Cancelled"));return;}
        if(char==="\x7f" || char==="\b")value=value.slice(0,-1);
        else value+=char;
        if(value.length>43){done(Error("Invalid ticket"));return;}
      }
    };input.on("data",data);input.once("end",end);
  });} finally {if(raw)input.setRawMode(false);process.stderr.write("\n");}
}

async function main() {
  const args=Object.fromEntries(process.argv.slice(2).map(value=>{
    const match=/^--(origin|phone|grant)=(.+)$/.exec(value);if(!match)throw Error("Use --origin=https://box --phone=ID --grant=ID");return [match[1],match[2]];
  }));
  if(Object.keys(args).length!==3 || process.argv.length!==5)throw Error("Use --origin=https://box --phone=ID --grant=ID");
  phoneAdbURL({origin:args.origin,phoneId:args.phone,grantId:args.grant});
  const token=await readTicket();
  const relay=await startPhoneAdbRelay({origin:args.origin,phoneId:args.phone,grantId:args.grant,token,onClosed:()=>process.stderr.write("手机调试连接已关闭。\n")});
  process.stdout.write(`请在另一终端执行：adb connect 127.0.0.1:${relay.port}\n`);
  process.stdout.write("仅连接此手机；网页退出登录、关闭调试或授权到期后会断开。按 Ctrl+C 结束。\n");
  process.once("SIGINT",relay.close);process.once("SIGTERM",relay.close);
}
if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{
  process.stderr.write("连接失败。请检查盒子证书是否受信任，并在网页重新开启 ADB 获取新连接码。\n");process.exitCode=1;
});
