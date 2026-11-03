// Local acceptance-only plugin. Native OpenCode handles the auth storage.
import {randomBytes} from 'node:crypto';
export default async()=>({auth:{provider:'synthetic',methods:[{
  type:'oauth',label:'Synthetic code sign-in',prompts:[{type:'text',key:'team',message:'Synthetic team'}],
  authorize:async inputs=>{
    if(inputs?.team!=='fixture')throw Error('Synthetic team is required');
    return {url:'http://127.0.0.1:4100/authorize',method:'code',instructions:'Enter the generated synthetic code.',callback:async code=>code?{type:'success',key:code}:{type:'failed'}};
  },
},{
  type:'oauth',label:'Synthetic automatic sign-in',
  authorize:async()=>({url:'http://127.0.0.1:4100/authorize',method:'auto',instructions:'Synthetic automatic callback ready.',
    callback:async()=>({type:'success',key:randomBytes(32).toString('base64url')})}),
}]}});
