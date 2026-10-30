export function computerActions(c) {
  if(c.state==='running')return ['open','shutdown'];
  if(c.state==='stopping')return ['open','refresh'];
  if(c.state==='stopped')return ['open','start','delete'];
  if(c.state==='starting')return ['open','refresh'];
  if(c.state==='error')return ['refresh'];
  return ['refresh'];
}
export function createComputerApi({fetcher=fetch,cookie=()=>document.cookie,uuid=()=>crypto.randomUUID()}={}) {
  let pending=null;
  let journal=null;
  const remember=()=>{if(journal){if(pending)journal.storage.setItem(journal.key,JSON.stringify(pending));else journal.storage.removeItem(journal.key);}};
  async function send(path,{method='GET',body,key}={}) {
    const headers={accept:'application/json'};
    if(method!=='GET') {
      const tokens=cookie().split(';').map(v=>v.trim()).filter(v=>v.startsWith('__Host-teamaibox-csrf='));
      const csrf=tokens[0]?.slice('__Host-teamaibox-csrf='.length);
      if(tokens.length!==1||!csrf)throw Object.assign(Error('invalid_session'),{code:'invalid_session'});
      headers['x-csrf-token']=csrf;headers['content-type']='application/json';headers['idempotency-key']=key;
    }
    let response;
    try {response=await fetcher('/api/v1/virtual-computers'+path,{method,headers,credentials:'same-origin',cache:'no-store',
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});}
    catch {throw Object.assign(Error('computer_network_unavailable'),{code:'computer_network_unavailable',uncertain:method!=='GET'});}
    let data;try {data=await response.json();}catch{throw Object.assign(Error('computer_response_invalid'),{code:'computer_response_invalid',uncertain:method!=='GET'});}
    if(!response.ok)throw Object.assign(Error(data.error?.message??'computer_request_failed'),{code:data.error?.code??'computer_request_failed',uncertain:method!=='GET'&&response.status>=500});
    return data;
  }
  async function retry() {
    if(!pending)throw Error('No pending computer request');
    const request=pending;
    try {const response=await send(request.path,request);if(pending===request){pending=null;remember();}return response;}
    catch(e){if(!e.uncertain&&pending===request){pending=null;remember();}throw e;}
  }
  return {list:()=>send(''),get:id=>send('/'+encodeURIComponent(id)),shared:()=>send('/shared-with-me'),availability:()=>send('/availability'),operation:id=>send('/operations/'+encodeURIComponent(id)),
    media:()=>send('/installation-media'),installation:id=>send('/'+encodeURIComponent(id)+'/installation'),
    useJournal(storage,key){
      if(journal?.key===key)return;
      if(pending)throw Error('computer_request_pending');
      journal={storage,key};const raw=storage.getItem(key);if(!raw)return;
      const saved=JSON.parse(raw);
      if(!saved||!['POST','DELETE'].includes(saved.method)||typeof saved.path!=='string'
        ||!(saved.path===''||/^\/[a-z0-9/-]+$/i.test(saved.path))||typeof saved.key!=='string'
        ||!saved.body||typeof saved.body!=='object')throw Error('computer_request_journal_invalid');
      pending=saved;
    },
    hasPending:()=>pending!==null,retry,
    async mutate(path,method,body){
      if(pending)throw Object.assign(Error('computer_request_pending'),{code:'computer_request_pending'});
      pending={path,method,body:structuredClone(body),key:uuid()};remember();return retry();
    }};
}
