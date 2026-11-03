// Isolated acceptance fixture, not a product MCP client or execution engine.
import http from 'node:http';
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
if(process.argv[2]==='mcp'){
  const input=readline.createInterface({input:process.stdin});
  input.on('line',line=>{
    const request=JSON.parse(line);if(request.id===undefined)return;
    let result={};
    if(request.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{},...(process.argv[3]==='resources'?{resources:{}}:{})},serverInfo:{name:'synthetic-local',version:'1.0.0'}};
    if(request.method==='resources/list')result={resources:process.argv[3]==='resources'?[{name:'Synthetic catalog note',uri:'synthetic://notes/intro',description:'Owner-only synthetic resource metadata',mimeType:'text/plain'}]:[]};
    if(request.method==='tools/list')result={tools:[{name:'echo',description:'Return a synthetic acceptance result',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
    if(request.method==='tools/call'){
      appendFileSync('/workspace/synthetic-mcp-called','called\n');
      result={content:[{type:'text',text:'synthetic MCP completed'}]};
    }
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
  });
}else{
  const observed=new Set();
  let lastMarkers=[],sensitiveLeak=false;
  let boxCalls=0,boxRevoked=false;
  if(process.env.BOX_FIXTURE_TOKEN)http.createServer((request,response)=>{
    if(request.url==='/revoke'&&request.method==='POST'){boxRevoked=true;response.writeHead(204).end();return;}
    if(request.method!=='GET'||request.url!=='/v1/status'){response.writeHead(404).end();return;}
    boxCalls++;
    if(boxRevoked||request.headers.authorization!=='Bearer '+process.env.BOX_FIXTURE_TOKEN){response.writeHead(403).end();return;}
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({status:'ready',services:[{name:'Synthetic design service',status:'ready'}],internalCredential:process.env.BOX_FIXTURE_TOKEN}));
  }).listen(4102,'127.0.0.1');
  http.createServer(async(request,response)=>{
    if(request.url==='/evidence'){
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({markers:[...observed],lastMarkers,sensitiveLeak,boxCalls}));return;
    }
    let raw='';for await(const chunk of request)raw+=chunk;
    const body=JSON.parse(raw||'{}');
    if(process.env.SYNTHETIC_SECRET_CANARY&&raw.includes(process.env.SYNTHETIC_SECRET_CANARY))sensitiveLeak=true;
    if(!request.url?.endsWith('/chat/completions')){response.writeHead(404).end();return;}
    if(JSON.stringify(body.messages??[]).includes('TAB_HOLD'))await new Promise(resolve=>setTimeout(resolve,5000));
    lastMarkers=[];
    for(const marker of ['TAB_SKILL_ACCEPTED','TAB_AGENT_ACCEPTED','TAB_INSTRUCTIONS_ACCEPTED','TAB_COMMAND_ACCEPTED','TAB_PLUGIN_ACCEPTED']){
      if(JSON.stringify(body.messages??[]).includes(marker)){observed.add(marker);lastMarkers.push(marker);}
    }
    const completed=body.messages?.some(message=>message.role==='tool');
    const missingDependency=JSON.stringify(body.messages??[]).includes('TAB_MISSING_DEP');
    const question=JSON.stringify(body.messages??[]).includes('TAB_QUESTION');
    const todo=JSON.stringify(body.messages??[]).includes('TAB_TODO');
    const child=JSON.stringify(body.messages??[]).includes('TAB_CHILD');
    const edit=JSON.stringify(body.messages??[]).includes('TAB_EDIT');
    const tool=body.tools?.find(item=>question?item.function?.name==='question':todo?item.function?.name==='todowrite':child?item.function?.name==='task':missingDependency||edit?item.function?.name==='bash':item.function?.name?.endsWith('echo')||item.function?.name?.endsWith('box_status'));
    const args=question?{questions:[{header:'Synthetic choice',question:'Which synthetic option?',options:[{label:'Alpha',description:'First option'},{label:'Beta',description:'Second option'}],multiple:false}]}:todo?{todos:[{content:'Synthetic native todo',status:'in_progress',priority:'high'}]}:child?{description:'Synthetic child session',prompt:'Reply with a short synthetic result; do not use tools.',subagent_type:'explore'}:missingDependency?{command:'tab-fixture-missing-tool',description:'Check a synthetic missing dependency'}:edit?{command:"printf 'Changed by native tool\\n' > example.txt",description:'Update the synthetic fixture file'}:{};
    const chunk=delta=>({id:'synthetic-completion',object:'chat.completion.chunk',created:1,model:'synthetic',choices:[{index:0,delta,finish_reason:null}]});
    response.writeHead(200,{'content-type':'text/event-stream'});
    const send=value=>response.write('data: '+JSON.stringify(value)+'\n\n');
    send(chunk({role:'assistant'}));
    if(!completed&&tool)send(chunk({tool_calls:[{index:0,id:'synthetic-call',type:'function',function:{name:tool.function.name,arguments:JSON.stringify(args)}}]}));
    else send(chunk({content:'Synthetic native execution completed.'}));
    send({id:'synthetic-completion',object:'chat.completion.chunk',created:1,model:'synthetic',choices:[{index:0,delta:{},finish_reason:!completed&&tool?'tool_calls':'stop'}],usage:{prompt_tokens:12,completion_tokens:6,total_tokens:18}});
    response.end('data: [DONE]\n\n');
  }).listen(4100,'127.0.0.1');
}
