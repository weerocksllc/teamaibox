// Bounded API test harness around the same bundled relay downloaded by users.
// One-time ticket comes through stdin; output contains no credentials.
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {startPhoneAdbRelay} from '../apps/virtual-phones-plugin/src/public/phone-adb-cli.mjs';
const input=createInterface({input:process.stdin});
let relay;
try {
  const [line]=await once(input,'line');const request=JSON.parse(line);
  relay=await startPhoneAdbRelay({...request,onClosed:()=>{console.log(JSON.stringify({closed:true,at:Date.now()}));process.exit(0);}});
  request.token=null;console.log(JSON.stringify({port:relay.port}));
  process.once('SIGTERM',()=>relay.close());
  setTimeout(()=>relay.close(),120000).unref();
} catch(error) {console.log(JSON.stringify({error:error.code||error.name}));process.exitCode=1;input.close();}
