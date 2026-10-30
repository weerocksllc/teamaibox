/** Keyset pagination: inserts/read notifications do not shift an offset. */
export class ResultPages {
  #request; #size; #url; #revision=0; #cursor=null; #pending=null;
  items=[]; hasMore=true;
  constructor(request,size){this.#request=request;this.#size=size;}
  reset(url){this.#revision++;this.#url=url;this.#cursor=null;this.#pending=null;this.items=[];this.hasMore=true;}
  async load(){
    if(this.#pending)return this.#pending;
    if(!this.hasMore)return this.items;
    const revision=this.#revision;
    const operation=(async()=>{
      const url=new URL(this.#url,'https://local.invalid');url.searchParams.set('limit',String(this.#size));
      if(this.#cursor){url.searchParams.set('before_time',this.#cursor.time);url.searchParams.set('before_id',this.#cursor.id);}
      const response=await this.#request(url.pathname+url.search);
      if(revision!==this.#revision)return null;
      const page=Array.isArray(response)?response:response.data;
      if(!Array.isArray(page))throw Error('Invalid message page');
      const last=page.at(-1);
      if(last){
        const time=last.created_at??last.createdAt;
        if(!time||!last.id||(this.#cursor?.id===last.id))throw Error('Message page did not advance');
        this.#cursor={time,id:last.id};
      }
      const seen=new Set(this.items.map(item=>item.id));this.items.push(...page.filter(item=>!seen.has(item.id)));
      this.hasMore=page.length===this.#size;return this.items;
    })();
    this.#pending=operation;
    try{return await operation;}finally{if(this.#pending===operation)this.#pending=null;}
  }
}
