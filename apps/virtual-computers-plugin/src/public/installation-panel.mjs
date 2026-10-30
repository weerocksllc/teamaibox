import {createComputerApi} from './computer-client.mjs';
import {createInstallationUpload} from './installation-upload.mjs';
import {installationText} from './installation-text.mjs';

const element=(tag,attributes={},text)=>{
 const node=document.createElement(tag);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value);
 if(text!==undefined)node.textContent=text;return node;
};
const csrf=()=>document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-teamaibox-csrf='))?.split('=').slice(1).join('=');
async function driveRequest(path){
 const response=await fetch('/api/v1/files/'+path,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});
 const value=await response.json();if(!response.ok)throw Object.assign(Error('drive'),{code:value.error?.code});return value;
}
const knownError=code=>({computer_optical_locked:'locked',computer_operation_pending:'pending',computer_request_pending:'pending',
 computer_media_in_use:'locked',computer_media_not_ready:'missing',computer_media_wrong_architecture:'x64',
 computer_media_confirmation_required:'unverified',computer_installation_shutdown_required:'upgrade',computer_installation_upgrade_required:'upgrade',
 computer_upload_reselect_same_file:'resume',computer_media_unverified:'unverified',computer_state_conflict:'refresh'}[code]??'failed');

/** Shared by the create dialog, computer card and virtual monitor. Source
 * selection is read-only; mounting and boot intentions are explicit actions.
 * Closing pauses only a local upload, never a VM or an accepted import job. */
export function createInstallationPanel({locale=()=>document.documentElement.lang,onChange=()=>{}}={}) {
 const api=createComputerApi(),dialog=element('dialog',{class:'installation-dialog','aria-labelledby':'installation-heading'});
 const heading=element('h2',{id:'installation-heading'}),close=element('button',{type:'button'}),header=element('div',{class:'installation-heading'});
 header.append(heading,close);
 const intro=element('p',{class:'muted'}),opticalState=element('p',{class:'installation-optical-state','aria-live':'polite'}),status=element('p',{role:'status','aria-live':'polite'}),error=element('p',{role:'alert',tabindex:'-1',hidden:''});
 const sources=element('div',{class:'installation-actions'}),body=element('section',{class:'installation-content'});
 const progress=element('progress',{max:'1',value:'0',hidden:''}),uploadActions=element('div',{class:'installation-actions',hidden:''});
 const footer=element('div',{class:'installation-actions'}),hint=element('p',{class:'muted'});
 dialog.append(header,intro,opticalState,status,error,sources,progress,uploadActions,body,footer,hint);document.body.append(dialog);
 let ownerId,upload,controller,uploadTask,mode,computer,installation,selected=null,resolveChoice,busy=false,timer,disposed=false,focusBefore;
 let media=[],view='library',driveRoot=null,drivePath=[],labelNodes=new Map(),errorKey=null,statusKey=null,progressValue=null,removeCandidate=null,adoptionState=null;
 const text=key=>installationText(locale(),key);
 function label(node,key){labelNodes.set(node,key);node.textContent=text(key);return node;}
 function button(key,run,{disabled=false}={}){
  const b=label(element('button',{type:'button'}),key);b.disabled=disabled;
  b.onclick=()=>Promise.resolve().then(run).catch(showError);return b;
 }
 function showError(e){errorKey=knownError(e.code);error.textContent=text(errorKey);error.hidden=false;error.focus();}
 function clearError(){error.hidden=true;errorKey=null;}
 function setStatus(key){statusKey=key;status.textContent=key?text(key):'';}
 async function withBusy(run){
  if(busy||api.hasPending())return;busy=true;clearError();renderControls();
  try{return await run();}catch(e){showError(e);}finally{busy=false;renderControls();}
 }
 function chooseReady(item){return item?.state==='ready'&&['arm64','unverified'].includes(item.compatibility);}
 function confirmedSelection(){
  if(!chooseReady(selected))throw Object.assign(Error('missing'),{code:'computer_media_not_ready'});
  if(selected.compatibility!=='arm64'&&!body.querySelector('[name="allow-unverified"]')?.checked)
   throw Object.assign(Error('unverified'),{code:'computer_media_unverified'});
  return {media:selected,allowUnverified:selected.compatibility!=='arm64'};
 }
 function renderControls(){
  label(close,'close');heading.textContent=(computer?computer.name+' · ':'')+text(mode==='choose'?'choose':'install');
  intro.textContent=text('arm');hint.textContent=text(mode==='choose'?'copy':'boundary');
  opticalState.hidden=!installation;
  if(installation)opticalState.textContent=text('library')+' · '+(media.find(m=>m.id===installation.observedMediaId)?.name??'—')+
   (installation.operationId||installation.autoStart?' · '+text('pending'):'')+(installation.boot?.state==='pending'?' · '+text('boot'):'');
  sources.replaceChildren(button('library',()=>switchView('library')),button('upload',()=>switchView('upload')),button('drive',()=>switchView('drive')));
  for(const b of sources.children)b.disabled=busy||Boolean(uploadTask)||api.hasPending();
  footer.replaceChildren();
  if(api.hasPending())footer.append(button('refresh',async()=>{
   if(busy)return;busy=true;renderControls();try{const result=await api.retry();
    if(result.source==='upload'&&upload?.pending()?.phase==='complete')upload.acknowledgeImport();
    await load();onChange();}catch(e){showError(e);}finally{busy=false;renderControls();}
  },{disabled:busy}));
  if(mode==='choose')footer.append(button('choose',()=>{
   const result=confirmedSelection();resolveChoice?.(result);resolveChoice=null;dialog.close();
  },{disabled:busy||Boolean(uploadTask)||!chooseReady(selected)||api.hasPending()}));
  else if(!installation&&adoptionState){
   hint.textContent=text('upgrade');
   footer.append(button('adopt',()=>withBusy(async()=>{
    await api.mutate('/'+computer.id+'/installation/adopt','POST',{expectedRevision:adoptionState.computerRevision});
    await load();onChange();
   }),{disabled:busy||!adoptionState.canAdopt||api.hasPending()}));
  }else if(installation){
   const waiting=busy||Boolean(installation.operationId)||installation.autoStart||api.hasPending();
   footer.append(button('mount',()=>withBusy(async()=>{const chosen=confirmedSelection();await action('mount',{mediaId:chosen.media.id,allowUnverified:chosen.allowUnverified});}),{disabled:waiting||!chooseReady(selected)}));
   footer.append(button('eject',()=>withBusy(()=>action('eject')),{disabled:waiting||!installation.observedMediaId}));
   footer.append(button(installation.boot?.state==='pending'?'cancelBoot':'boot',()=>withBusy(async()=>{
    await action(installation.boot?.state==='pending'?'cancel-boot':'boot-disc');setStatus('bootHint');
   }),{disabled:waiting||!installation.observedMediaId||installation.boot?.state==='armed'}));
   footer.append(button('installed',()=>withBusy(()=>action('installed')),{disabled:waiting||['pending','armed'].includes(installation.boot?.state)}));
  }
  if(errorKey)error.textContent=text(errorKey);
  if(statusKey)status.textContent=text(statusKey)+(progressValue===null?'':' · '+Math.round(progressValue*100)+'%');
 }
 async function action(action,input={}){
  const result=await api.mutate('/'+computer.id+'/installation/'+action,'POST',{expectedRevision:installation.revision,...input});
  if(result.state==='failed')throw {code:result.errorCode};await load();onChange();
 }
 async function load(){
  const list=await api.media();if(!dialog.open)return;
  media=list.data;selected=media.find(m=>m.id===selected?.id)??null;
  if(selected?.state==='ready'&&statusKey==='preparing')setStatus('ready');
  if(computer){const state=await api.installation(computer.id);installation=state.installation;adoptionState=state.supported?null:state;
   if(installation?.errorCode)showError({code:installation.errorCode});
   else if(errorKey==='upgrade'&&state.supported)clearError();}
  if(view==='library')renderLibrary();renderControls();
  clearTimeout(timer);if(dialog.open)timer=setTimeout(()=>load().catch(showError),2500);
 }
 function renderLibrary(){
  // Preserve selection/focus while imports progress; do not replace stable rows.
  const signature=JSON.stringify([locale(),media,selected?.id,removeCandidate]);
  if(body.dataset.signature===signature)return;
  body.dataset.signature=signature;body.replaceChildren();
  if(!media.length)body.append(label(element('p',{class:'muted'}),'missing'));
  for(const item of media){
   const row=element('div',{class:'installation-media-row'}),pick=element('button',{type:'button','aria-pressed':String(selected?.id===item.id)});
   pick.disabled=!chooseReady(item)||busy;const name=element('strong',{},item.name),detail=element('span',{class:'muted'});
   detail.textContent=text(item.compatibility==='wrong-architecture'?'x64':['invalid','not-bootable'].includes(item.compatibility)?'failed':item.state==='ready'?'ready':item.state==='failed'?'failed':'preparing')+' · '+new Intl.NumberFormat(locale(),{maximumFractionDigits:1}).format(item.size/1024**3)+' GiB';
   pick.append(name,detail);pick.onclick=()=>{selected=item;renderLibrary();renderControls();};row.append(pick);
   if(['ready','failed'].includes(item.state))row.append(button('remove',()=>{removeCandidate=item.id;renderLibrary();}));
   body.append(row);
   if(removeCandidate===item.id){
    const confirmation=element('div',{class:'installation-confirm'});confirmation.append(label(element('p'),'confirmRemove'),
     button('remove',()=>withBusy(async()=>{await api.mutate('/installation-media/'+item.id,'DELETE',{expectedRevision:item.revision,confirmDelete:true});removeCandidate=null;await load();})),
     button('close',()=>{removeCandidate=null;renderLibrary();}));body.append(confirmation);
   }
  }
  if(selected?.compatibility==='unverified'){
   const accept=element('label',{class:'installation-confirm'}),box=element('input',{type:'checkbox',name:'allow-unverified'});
   accept.append(box,label(element('span'),'unverified'));body.append(accept);
  }
  if(selected?.compatibility==='wrong-architecture')body.append(label(element('p',{role:'alert'}),'x64'));
  if(['invalid','not-bootable'].includes(selected?.compatibility))body.append(label(element('p',{role:'alert'}),'failed'));
 }
 async function switchView(next){
  view=next;delete body.dataset.signature;body.replaceChildren();clearError();
  if(next==='library'){renderLibrary();return;}
  if(next==='drive'){driveRoot=null;drivePath=[];await browseDrive();return;}
  const file=element('input',{type:'file',accept:'.iso,application/x-iso9660-image'}),field=element('label');
  field.append(label(element('span'),'upload'),file);body.append(field);
  if(upload.pending())body.append(label(element('p',{class:'muted','data-upload-resume':''}),'resume'),button('cancel',cancelUpload));
  file.onchange=()=>{const chosen=file.files[0];file.value='';if(chosen)beginUpload(chosen);};
 }
 async function cancelUpload(){
  controller?.abort();await uploadTask;
  try{const result=await upload.cancel();if(result.complete){setStatus('resume');return;}setStatus(null);await switchView('upload');}catch(e){showError(e);}
 }
 function beginUpload(file){
  if(uploadTask||busy)return;controller=new AbortController();clearError();progress.hidden=false;progressValue=0;
  const resumeNote=body.querySelector('[data-upload-resume]');if(resumeNote)resumeNote.hidden=true;
  uploadActions.hidden=false;uploadActions.replaceChildren(button('pause',()=>controller.abort()),button('cancel',cancelUpload));
  uploadTask=(async()=>{
   try{
    const reference=await upload.upload(file,{signal:controller.signal});
    const item=await api.mutate('/installation-media','POST',{source:'upload',name:file.name,referenceId:reference.reference_id});
    upload.acknowledgeImport();selected=item;view='library';delete body.dataset.signature;await load();setStatus('preparing');
   }catch(e){setStatus('resume');if(!controller.signal.aborted)showError(e);}
   finally{uploadTask=null;controller=null;progress.hidden=true;progressValue=null;uploadActions.hidden=true;renderControls();}
  })();renderControls();
 }
 async function browseDrive(){
  body.replaceChildren();delete body.dataset.signature;
  if(!driveRoot){
   const roots=(await driveRequest('bootstrap')).data;if(view!=='drive'||!dialog.open)return;
   for(const root of roots)body.append(button(root.scope_kind==='user'?'personal':'team',async()=>{driveRoot=root;await browseDrive();}));
   return;
  }
  body.append(button('back',async()=>{if(drivePath.length)drivePath.pop();else driveRoot=null;await browseDrive();}));
  const parent=drivePath.at(-1);
  if(parent)body.append(element('p',{},drivePath.map(p=>p.name).join(' / ')));
  const response=await driveRequest('roots/'+driveRoot.id+'/entries'+(parent?'?parent_id='+parent.id:''));
  if(view!=='drive'||!dialog.open)return;
  for(const entry of response.data){
   if(entry.kind!=='folder'&&!/\.iso$/i.test(entry.name))continue;
   const b=element('button',{type:'button',class:'installation-drive-entry'},(entry.kind==='folder'?'▸ ':'')+entry.name);
   b.onclick=()=>entry.kind==='folder'?(drivePath.push(entry),browseDrive().catch(showError)):withBusy(async()=>{
    const item=await api.mutate('/installation-media','POST',{source:'drive',name:entry.name,fileId:entry.id,version:entry.current_version});
    selected=item;view='library';delete body.dataset.signature;await load();setStatus('preparing');
   });body.append(b);
  }
 }
 async function open({target=null,selection=null}={}){
  if(uploadTask){controller?.abort();await uploadTask;}
  if(disposed)return;mode=target?'manage':'choose';computer=target;installation=null;adoptionState=null;selected=selection;removeCandidate=null;view='library';
  clearError();setStatus(null);body.replaceChildren();delete body.dataset.signature;focusBefore=document.activeElement;
  dialog.showModal();renderControls();close.focus();
  try{const availability=await api.availability();ownerId=availability.ownerId;
   api.useJournal(localStorage,'teamaibox.installation-request.'+ownerId);
   upload=createInstallationUpload({ownerId,storage:localStorage,csrf,onProgress:({phase,progress:value})=>{
    progressValue=value;progress.value=value;statusKey=phase;
    const message=text(phase)+' · '+Math.round(value*100)+'%';
    if(status.textContent!==message)status.textContent=message;
    // Progress does not change actions. Rebuilding all controls for every MiB
    // leaks detached label nodes and needlessly invalidates keyboard focus.
   }});await load();}catch(e){showError(e);}
 }
 close.onclick=()=>dialog.close();dialog.addEventListener('close',()=>{
  clearTimeout(timer);controller?.abort();resolveChoice?.(null);resolveChoice=null;focusBefore?.focus();
 });
 window.addEventListener('pagehide',()=>{controller?.abort();clearTimeout(timer);});
 return {
  choose(selection=null){return new Promise(resolve=>{resolveChoice=resolve;void open({selection});});},
  manage:target=>open({target}),
  refreshLabels(){for(const [node,key] of labelNodes){if(node.isConnected)node.textContent=text(key);else labelNodes.delete(node);}if(dialog.open){delete body.dataset.signature;if(view==='library')renderLibrary();renderControls();}},
  destroy(){disposed=true;dialog.close();dialog.remove();}
 };
}
