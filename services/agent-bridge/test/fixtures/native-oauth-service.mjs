// Synthetic OAuth + MCP fixture only. Never a product authentication service.
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
const origin=process.env.SYNTHETIC_RESOURCE_ORIGIN??'http://127.0.0.1:4101';
// The opt-in browser test publishes this fixture only on a random host loopback
// port. Discovery/token exchange still happen inside the owning container.
const authorizationOrigin=process.env.SYNTHETIC_AUTHORIZATION_ORIGIN??origin;
const codes=new Map();let used=false;
const token=randomUUID();
http.createServer(async(req,res)=>{
  const url=new URL(req.url,origin);
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(url.pathname==='/.well-known/oauth-protected-resource/mcp'||url.pathname==='/.well-known/oauth-protected-resource')return json({resource:origin+'/mcp',authorization_servers:[origin]});
  if(url.pathname==='/.well-known/oauth-authorization-server')return json({issuer:origin,authorization_endpoint:authorizationOrigin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
  let body='';for await(const chunk of req)body+=chunk;
  if(url.pathname==='/register'){const registered=JSON.parse(body);return json({...registered,client_id:'synthetic-native-client',token_endpoint_auth_method:'none'});}
  if(url.pathname==='/authorize'){
    const code=randomUUID();codes.set(code,{challenge:url.searchParams.get('code_challenge'),redirect:url.searchParams.get('redirect_uri')});
    const target=new URL(url.searchParams.get('redirect_uri'));target.searchParams.set('state',url.searchParams.get('state'));target.searchParams.set('code',code);
    res.writeHead(302,{location:target.href});return res.end();
  }
  if(url.pathname==='/token'){
    const form=new URLSearchParams(body),entry=codes.get(form.get('code'));codes.delete(form.get('code'));
    if(!entry||entry.redirect!==form.get('redirect_uri')||entry.challenge!==createHash('sha256').update(form.get('code_verifier')??'').digest('base64url'))return json({error:'invalid_grant'},400);
    used=true;return json({access_token:token,token_type:'Bearer',expires_in:3600});
  }
  if(url.pathname==='/evidence')return json({nativePkceExchange:used});
  if(url.pathname!=='/mcp')return json({},404);
  if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`});return res.end();}
  if(req.method==='GET'){res.writeHead(405);return res.end();}
  const rpc=JSON.parse(body);
  if(rpc.id===undefined){res.writeHead(202);return res.end();}
  const result=rpc.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'synthetic-oauth',version:'1'}}:rpc.method==='tools/list'?{tools:[]}:{};
  return json({jsonrpc:'2.0',id:rpc.id,result});
}).listen(4101,process.env.SYNTHETIC_AUTHORIZATION_ORIGIN||process.env.SYNTHETIC_RESOURCE_ORIGIN?'0.0.0.0':'127.0.0.1');
