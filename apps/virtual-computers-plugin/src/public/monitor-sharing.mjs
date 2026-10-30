import {desktopRequestHeaders} from './desktop-session.mjs';
import {productText} from './product-localization.mjs';

// The UI reflects server authority; the websocket gateway independently gates
// every input instruction. No invitation grants guest lifecycle or RDP access.
export function mountMonitorSharing({base,onControl=()=>{}}){
 const $=id=>document.getElementById(id);
 const text=(zh,english)=>productText(document.documentElement.lang,english,zh);
 const dialog=$('sharing-dialog'),panel=$('monitor-controls');
 let viewerId=null,state=null,timer=null,epoch=0,busy=false,stopped=true,polling=false,participantsKey='',directoryOffset=0;
 const request=async(path,body)=>{
  const r=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
   headers:body===undefined?{accept:'application/json'}:desktopRequestHeaders(document.cookie),
   ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  const data=await r.json();if(!r.ok)throw Object.assign(Error('sharing'),{code:data.error?.code,status:r.status});return data;
 };
 function refreshLabels(){
 for(const n of dialog.querySelectorAll('[data-en]'))n.textContent=productText(document.documentElement.lang,n.dataset.en,n.dataset.zh??(n.dataset.zh=n.textContent));
 $('sharing-open').textContent=text('参与者与邀请','Participants & invitations');
 $('control-claim').textContent=text('接管控制','Take control');$('control-release').textContent=text('释放控制','Release control');
 participantsKey='';
 }
 refreshLabels();
 const report=(message='')=>{$('sharing-error').textContent=message;$('sharing-error').hidden=!message;};
 const fail=e=>report(e?.code==='computer_control_busy'?text('现在有人在控制，请让对方交接。','Someone is controlling. Ask them to hand over.'):
  [401,403,404].includes(e?.status)?text('访问权限已变化，请重新打开显示器。','Access changed. Reopen this monitor.'):
  text('操作未完成，请重试。','Could not complete the action. Please retry.'));
 const role=r=>r==='owner'?text('主人','Owner'):r==='control'?text('可控制','Can control'):text('仅观看','View only');
 function render(){
  if(stopped){panel.hidden=true;onControl(false);return;}
  const active=!!state?.viewerId,owner=state?.role==='owner';onControl(active&&state.canControl);
  panel.hidden=false;
  $('control-status').textContent=!active?text('正在确认观看权限…','Checking monitor access…'):
   state.mode==='shared'?(state.canControl?text('共同控制中','Shared control'):text('仅观看 · 共同控制已开启','View only · Shared control enabled')):
   state.canControl?text('你正在控制','You are controlling'):
   (state.participants.find(p=>p.viewerId===state.controller)?.name??text('无人','Nobody'))+text('正在控制 · 你仅观看',' is controlling · You are viewing');
  $('control-claim').hidden=!active||state.canControl||state.role==='view'||(!owner&&!!state.controller);
  $('control-release').hidden=!active||!state.canControl||state.mode==='shared';
  $('sharing-owner').hidden=!owner;$('sharing-reclaim').hidden=!owner||!active;
  $('sharing-mode').disabled=busy||!active||!owner;$('sharing-mode').checked=state?.mode==='shared';
  const key=JSON.stringify([state?.participants,state?.controller,state?.mode,owner,busy]);
  if(key!==participantsKey){participantsKey=key;$('sharing-participants').replaceChildren();
   for(const p of state?.participants??[]){const row=document.createElement('li'),label=document.createElement('span');
    label.textContent=p.name+(p.self?text('（此页面）',' (this page)'):'')+' · '+role(p.role)+(p.controlling?text(' · 控制中',' · Controlling'):'');row.append(label);
    if(active&&!p.self&&p.role!=='view'&&(owner||state.controller===viewerId)){
     const b=document.createElement('button');b.type='button';b.textContent=text('交给此页面','Hand over');b.disabled=busy;b.onclick=()=>action('handoff',p.viewerId);row.append(b);
    }$('sharing-participants').append(row);
   }
  }
  for(const id of ['control-claim','control-release','sharing-reclaim'])$(id).disabled=busy||!active;
 }
 async function poll(){
  if(stopped||polling)return;polling=true;const current=epoch;
  try{const next=await request(base+'/monitor-presence?'+new URLSearchParams({viewerId}));
   if(current!==epoch)return;state=next;render();
  }catch(e){if(current===epoch){onControl(false);$('control-status').textContent=text('控制状态暂不可达 · 暂停输入','Control status unavailable · Input paused');}}
  finally{polling=false;if(!stopped&&current===epoch)timer=setTimeout(poll,1000);else if(!stopped)timer=setTimeout(poll,0);}
 }
 async function action(action,targetViewerId){
  if(busy||!viewerId)return;busy=true;report();render();const current=epoch;
  try{const next=await request(base+'/monitor-control',{viewerId,action,...(targetViewerId?{targetViewerId}:{})});if(current===epoch)state=next;}
  catch(e){fail(e);if(!dialog.open)dialog.showModal();}finally{busy=false;render();}
 }
 async function grants(){
  const result=await request(base+'/monitor-sharing');$('sharing-grants').replaceChildren();
  for(const g of result.data){const row=document.createElement('li'),label=document.createElement('span'),select=document.createElement('select'),remove=document.createElement('button');
   label.textContent=g.displayName+' · @'+g.username;select.setAttribute('aria-label',g.displayName+text('的权限',' permission'));
   for(const [value,name] of [['view',text('仅观看','View only')],['control',text('允许控制','Allow control')]])select.add(new Option(name,value));select.value=g.permission;
   select.onchange=()=>updateGrant(g.identityId,select.value);remove.type='button';remove.textContent=text('撤销邀请','Revoke invitation');remove.onclick=()=>updateGrant(g.identityId,null);row.append(label,select,remove);$('sharing-grants').append(row);
  }
  $('sharing-empty').hidden=!!result.data.length;
 }
 async function updateGrant(identityId,permission){
  if(busy)return;busy=true;report();render();
  try{await request(base+'/monitor-sharing',{identityId,permission});await grants();$('sharing-feedback').textContent=permission===null?text('邀请已撤销，对方页面已断开。','Invitation revoked. Their monitor has disconnected.'):text('邀请已保存，对方可从“虚拟电脑 → 邀请我的电脑”打开。','Invitation saved. Open Virtual computers → Shared with me.');}
  catch(e){fail(e);}finally{busy=false;render();}
 }
 async function directory(more=false){
  const q=$('sharing-search').value.trim();if(!more){directoryOffset=0;$('sharing-member').replaceChildren();}
  const result=await request(q?'/api/v1/identities/search?'+new URLSearchParams({q,limit:50}):'/api/v1/identities/directory?'+new URLSearchParams({limit:50,after:directoryOffset}));
  for(const user of result.data){if(user.id===result.meta?.actorIdentityId)continue;$('sharing-member').add(new Option(user.displayName+' · @'+user.username,user.id));}
  directoryOffset=result.meta?.nextOffset??0;$('sharing-load-more').hidden=!directoryOffset||!!q;
  $('sharing-invite').disabled=!$('sharing-member').options.length;
 }
 $('sharing-open').onclick=async()=>{report();dialog.showModal();if(state?.role==='owner')try{await Promise.all([grants(),directory()]);}catch(e){fail(e);}};
 $('sharing-close').onclick=()=>dialog.close();
 $('control-claim').onclick=()=>action(state?.role==='owner'?'reclaim':'claim');$('control-release').onclick=()=>action('release');
 $('sharing-mode').onchange=()=>action($('sharing-mode').checked?'shared':'exclusive');$('sharing-reclaim').onclick=()=>action('reclaim');
 $('sharing-search-form').onsubmit=e=>{e.preventDefault();directory().catch(fail);};$('sharing-load-more').onclick=()=>directory(true).catch(fail);
 $('sharing-invite-form').onsubmit=e=>{e.preventDefault();if($('sharing-member').value)updateGrant($('sharing-member').value,$('sharing-permission').value);};
 return {refreshLabels(){refreshLabels();render();},join(id){this.leave();viewerId=id;stopped=false;state=null;render();poll();},leave(){stopped=true;epoch++;clearTimeout(timer);viewerId=null;state=null;onControl(false);panel.hidden=true;dialog.close();}};
}
