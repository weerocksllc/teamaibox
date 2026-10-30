import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {request} from 'node:https';
import {connect} from 'node:tls';
import {execFileSync} from 'node:child_process';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWebBoundary} from '../server/web-boundary.mjs';

test('DHCP identity refresh supports HTTP and WebSocket without accepting foreign origins or restarting web', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appliance-identity-'));
  const cert = join(root, 'web.crt'), key = join(root, 'web.key');
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({origin:req.headers.origin,host:req.headers['x-forwarded-host']}));
  });
  upstream.on('upgrade', (req, socket) => socket.end(
    `HTTP/1.1 101 Switching Protocols\r\nX-Observed-Origin: ${req.headers.origin}\r\n\r\n`));
  await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
  const generate = name => execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes',
    '-keyout',key,'-out',cert,'-days','2','-subj','/CN='+name,
    '-addext','basicConstraints=critical,CA:FALSE','-addext','subjectAltName=DNS:'+name], {stdio:'ignore'});
  generate('before.test');
  await writeFile(join(root,'index.html'),'address change fixture');
  // Reserve a port since boundary configuration intentionally disallows port 0.
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0,'127.0.0.1',resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const boundary = await createWebBoundary({environment:{WEB_MODE:'release',WEB_HOST:'127.0.0.1',
    WEB_PORT:String(port),WEB_PUBLIC_ORIGIN:`https://internal-original.test:${port}`,
    WEB_AUTO_LOCAL_ADDRESS:'true',WEB_TLS_CERT_FILE:cert,WEB_TLS_KEY_FILE:key,WEB_STATIC_ROOT:root,
    PLATFORM_API_ORIGIN:`http://127.0.0.1:${upstream.address().port}`}});
  await boundary.listen();
  const send = async (host, origin, extra={}) => new Promise(async (resolve,reject) => {
    const req=request({hostname:'127.0.0.1',port,servername:host,ca:await readFile(cert),
      method:'POST',path:'/api/login',headers:{host:`${host}:${port}`,origin,...extra}}, res=>{
        let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
      });req.on('error',reject);req.end();
  });
  try {
    const before=await send('before.test',`https://before.test:${port}`);
    assert.equal(before.status,200);
    assert.equal(before.body.origin,`https://internal-original.test:${port}`);
    generate('after.test');
    await boundary.reloadTls();
    assert.equal(boundary.server.listening,true);
    assert.equal((await send('after.test',`https://after.test:${port}`)).status,200);
    assert.equal((await send('after.test','https://attacker.test',{'x-forwarded-host':`after.test:${port}`})).status,403);
    assert.equal((await send('after.test','null')).status,403);
    assert.equal((await send('after.test',`https://after.test:${port}`,{host:`attacker.test:${port}`})).status,421);
    assert.equal((await send('after.test',`https://before.test:${port}`,{host:`before.test:${port}`})).status,421);
    const ws = async origin => new Promise(async(resolve,reject)=>{
      const socket=connect({host:'127.0.0.1',port,servername:'after.test',ca:await readFile(cert)},()=>{
        socket.write(`GET /ws HTTP/1.1\r\nHost: after.test:${port}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });let result='';socket.on('data',c=>result+=c);socket.on('end',()=>resolve(result));socket.on('error',reject);
    });
    assert.match(await ws(`https://after.test:${port}`),/101 Switching Protocols/);
    assert.match(await ws(`https://after.test:${port}`),/x-observed-origin: https:\/\/internal-original.test/i);
    assert.match(await ws('https://attacker.test'),/403 Forbidden/);
  } finally {
    await boundary.close();await new Promise(resolve=>upstream.close(resolve));
    await rm(root,{recursive:true,force:true});
  }
});
