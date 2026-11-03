// Optional example, not a built-in integration or a second MCP runtime.
import {readFile} from 'node:fs/promises';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';

const origin=new URL(process.env.BOX_API_ORIGIN??'https://example.invalid');
if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash
  ||(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin.hostname))))throw Error('Set an HTTPS API origin (HTTP is allowed for loopback fixtures only)');
const tokenFile=process.env.BOX_API_TOKEN_FILE;
if(!tokenFile?.startsWith('/workspace/')||tokenFile.split('/').some(part=>part==='.'||part==='..')||/[\\\0\r\n]/.test(tokenFile))throw Error('Set a scoped credential file inside your workspace');
const server=new Server({name:'box-status-example',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{
  name:'box_status',description:'Read service status using your scoped account access. Does not change services or files.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  if(request.params.name!=='box_status'||Object.keys(request.params.arguments??{}).length)return {isError:true,content:[{type:'text',text:'Unsupported status request.'}]};
  try{
    const raw=await readFile(tokenFile);let token;
    try{token=raw.toString('utf8').trim();}finally{raw.fill(0);}
    if(token.length<32||token.length>8192||/[\s\0]/.test(token))throw Error('credential unavailable');
    const response=await fetch(new URL('/v1/status',origin),{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(5000)});
    token='';
    if(!response.ok)throw Error('status unavailable');
    const value=await response.json();
    // Return only this tool's public status fields, never response headers,
    // credentials, arbitrary backend metadata or raw errors.
    if(!['ready','starting','unavailable'].includes(value.status)||!Array.isArray(value.services))throw Error('invalid status');
    const result={status:value.status,services:value.services.slice(0,100).map(service=>({
      name:String(service.name??'').slice(0,80),status:['ready','starting','unavailable'].includes(service.status)?service.status:'unavailable',
    }))};
    return {content:[{type:'text',text:JSON.stringify(result)}]};
  }catch{return {isError:true,content:[{type:'text',text:'Status is unavailable. Check your scoped access and service connection.'}]};}
});
await server.connect(new StdioServerTransport());
