import {applyProductLabels} from './product-localization.mjs';
import { localizedCatalogs, normalizeProductLocale, productText } from "./product-localization.mjs";
import {applyPluginPreferenceSnapshotV1} from '/plugins/official.virtual-computers/preferences-v1.mjs';
import {createComputerApi,computerActions} from './computer-client.mjs?v=sharing-20261022';
import {createInstallationPanel} from './installation-panel.mjs';
import {installationText} from './installation-text.mjs';
import {computerOsText} from './computer-os-text.mjs';
const messages=localizedCatalogs({
 'zh-CN':{sharedTitle:'邀请我的电脑',sharedHint:'直接打开查看。允许控制的邀请可由当前控制者交接，主人随时可以收回。',eyebrow:'个人工作空间',title:'我的虚拟电脑',subtitle:'在浏览器里使用 Windows，应用和文件留在你的电脑里。',create:'＋ 创建电脑',refresh:'刷新',
 empty:'还没有虚拟电脑',emptyHint:'选择系统和资源，创建独立的工作电脑。',boundary:'关闭页面不会关机。需要释放运行资源时，请关闭电脑。',
 name:'电脑名称',nameRequired:'请输入电脑名称，不能只填写空格。',system:'系统',cpu:'CPU 核数',memory:'内存（GiB）',disk:'磁盘（GiB）',createHint:'创建后在列表中开机；可用资源不足时，请稍后再试。',
 cancel:'取消',save:'创建',delete:'删除电脑',confirmDelete:'删除这台电脑及全部应用和文件，无法撤销。',open:'打开显示器',console:'虚拟显示器',desktop:'远程桌面',more:'更多',start:'开机',shutdown:'关机',
 creating:'正在创建',stopped:'已关机',starting:'正在开机',running:'运行中',stopping:'正在关机',unavailable:'暂不可用',error:'需要处理',deleting:'正在删除',deleted:'已删除',
 unavailableHint:'虚拟电脑服务尚未就绪。已有电脑及数据不会因此删除。',systemUnavailable:'暂未开放',retry:'确认上次操作',submitted:'操作已提交，状态会自动更新。',
 uncertain:'请求结果尚未确认。请确认上次操作，不要重复创建。',count:'已保存 {n} 台 · 运行中 {running} 台',minimum:'所选系统至少需要 {cpu} 核、{memory} GiB 内存和 {disk} GiB 磁盘。',
 spec:'{cpu} 核 · {memory} GiB 内存 · {disk} GiB 磁盘',invalid_session:'登录已过期，请返回工作台重新登录。',computer_network_unavailable:'连接暂时中断，请重试。',
 computer_capacity_unavailable:'盒子的可用资源不足，电脑数据仍保留，请稍后重试。',computer_running_quota:'已达到管理员设置的同时运行数量上限。',computer_stored_quota:'已达到管理员设置的电脑数量上限。',
 computer_creation_paused:'管理员已暂停新建和开机，已有电脑及数据保留。',computer_profile_unavailable:'这个系统暂未开放新建，请选择其他系统。',
 computer_runtime_unavailable:'暂时无法确认电脑状态，数据和已分配的资源仍保留。连接恢复后会自动更新。',
 computer_unclean_shutdown:'电脑意外停止，原磁盘已保留。可以重新开机，Windows 可能会检查磁盘。',
 computer_run_exited:'电脑在操作完成前已停止。原磁盘已保留，可以重新开机。',failed:'操作未完成，请刷新状态后重试。'},
 en:{sharedTitle:'Shared with me',sharedHint:'Open to watch. Control can be handed over when invited. The owner can reclaim it at any time.',eyebrow:'PERSONAL WORKSPACE',title:'My virtual computers',subtitle:'Use Windows in your browser. Your apps and files stay on your computer.',create:'+ Create computer',refresh:'Refresh',
 empty:'No virtual computers yet',emptyHint:'Choose a system and resources to create your own workspace.',boundary:'Closing this page does not shut down Windows. Shut down the computer to release running resources.',
 name:'Computer name',nameRequired:'Enter a computer name, not just spaces.',system:'System',cpu:'CPU cores',memory:'Memory (GiB)',disk:'Disk (GiB)',createHint:'Start your computer from the list after creation. If resources are unavailable, try again later.',
 cancel:'Cancel',save:'Create',delete:'Delete computer',confirmDelete:'Delete this computer, including all apps and files. This cannot be undone.',open:'Open monitor',console:'Virtual monitor',desktop:'Remote desktop',more:'More',start:'Start',shutdown:'Shut down',
 creating:'Creating',stopped:'Shut down',starting:'Starting',running:'Running',stopping:'Shutting down',unavailable:'Unavailable',error:'Needs attention',deleting:'Deleting',deleted:'Deleted',
 unavailableHint:'Virtual computers are not ready yet. Existing computers and data are preserved.',systemUnavailable:'Not available yet',retry:'Check previous request',submitted:'Request submitted. Status updates automatically.',
 uncertain:'The request result is not confirmed. Retry the same request instead of creating another computer.',count:'{n} saved · {running} running',minimum:'This system needs at least {cpu} cores, {memory} GiB memory and {disk} GiB disk.',
 spec:'{cpu} cores · {memory} GiB memory · {disk} GiB disk',invalid_session:'Your session has expired. Sign in again from the workspace.',computer_network_unavailable:'Connection interrupted. Please retry.',
 computer_capacity_unavailable:'This appliance has insufficient resources. Your data is preserved; please retry later.',computer_running_quota:'You have reached the simultaneous-computer limit set by your administrator.',computer_stored_quota:'You have reached the computer limit set by your administrator.',
 computer_creation_paused:'Your administrator has paused creation and startup. Existing computers and data are preserved.',computer_profile_unavailable:'This system is not currently available for new computers. Choose another system.',
 computer_runtime_unavailable:'The computer status cannot be confirmed yet. Your data is unaffected. Status will update when the connection recovers.',
 computer_unclean_shutdown:'The computer stopped unexpectedly. Its original disk is preserved. You can start it again; Windows may check the disk.',
 computer_run_exited:'The computer stopped before the operation completed. Its original disk is preserved. You can start it again.',failed:'The operation could not complete. Refresh and try again.'}
});
const $=id=>document.getElementById(id),api=createComputerApi();
let locale=normalizeProductLocale(new URLSearchParams(location.search).get('locale')??document.documentElement.lang),availability=null,computers=[],shared=[],sharedKey,selectedDelete=null,busy=false,refreshing=false,left=false,timer,cardsKey,errorSource=null,noticeSource=null;
const t=(key,values={})=>Object.entries(values).reduce((text,[k,v])=>text.replaceAll('{'+k+'}',String(v)),key==='subtitle'?computerOsText(locale,'subtitle'):key==='computer_unclean_shutdown'?computerOsText(locale,'unclean'):messages[locale][key]??messages[locale].failed);
let installationChoice=null;
const installationPanel=createInstallationPanel({locale:()=>locale,onChange:()=>refresh()});
function renderInstallationChoice(){
 const supported=availability?.systems.find(s=>s.id===$('system').value)?.installable===true;
 $('installation-choice').hidden=!supported;
 $('installation-selection').textContent=installationChoice?.media.name??installationText(locale,'empty');
 $('installation-help').textContent=installationText(locale,'arm');
 $('choose-iso').textContent=installationText(locale,'choose');$('empty-computer').textContent=installationText(locale,'empty');
 $('choose-iso').disabled=busy||api.hasPending();$('empty-computer').disabled=busy||api.hasPending();
 $('create-form').querySelector('button[type=submit]').textContent=supported&&installationChoice?installationText(locale,'create'):t('save');
 $('create-form').querySelector('[data-i18n="createHint"]').textContent=supported&&installationChoice?installationText(locale,'arm'):t('createHint');
}
const show=(id,text)=>{$(id).textContent=text;$(id).hidden=!text;};
function error(e,source='mutation'){
 if(source==='refresh'&&errorSource==='mutation')return;
 errorSource=source;const message=e.uncertain?t('uncertain'):t(e.code??'failed');show('error',message);$('retry').hidden=!api.hasPending();
 if(source==='mutation')for(const [dialog,prefix] of [['editor','create'],['delete-dialog','delete']])if($(dialog).open){
  show(prefix+'-error',message);$(prefix+'-retry').hidden=!api.hasPending();$(prefix+'-error').focus();
 }
}
function renderDialogState(){
 for(const [dialog,prefix] of [['editor','create'],['delete-dialog','delete']]){
  const element=$(dialog);element.setAttribute('aria-busy',String(busy));
  for(const control of element.querySelectorAll('input,select,button[type="submit"]'))control.disabled=busy||api.hasPending();
  $(prefix+'-retry').disabled=busy;$(prefix+'-retry').hidden=!api.hasPending();
 }
}
function button(label,handler){const b=document.createElement('button');b.textContent=t(label);b.onclick=handler;b.disabled=busy||(api.hasPending()&&label!=='refresh');return b;}
function render(){
 applyProductLabels(document,locale);
 document.title=t('title');for(const el of document.querySelectorAll('[data-i18n]'))el.textContent=t(el.dataset.i18n);
 renderDialogState();
 renderInstallationChoice();installationPanel.refreshLabels();
 const invitationKey=JSON.stringify([locale,shared]);
 if(invitationKey!==sharedKey){sharedKey=invitationKey;$('shared-computers').replaceChildren();$('shared-section').hidden=!shared.length;
  for(const c of shared){const card=document.createElement('article'),title=document.createElement('h3'),detail=document.createElement('p');card.className='card';title.textContent=c.name;
   detail.className='muted';detail.textContent=c.ownerName+' · '+(c.permission==='control'?(productText(locale, "Can control", "允许控制")):(productText(locale, "View only", "仅观看")))+' · '+t(c.state);card.append(title,detail);
   if(['running','stopping'].includes(c.state)){const link=document.createElement('a');link.className='button primary';link.textContent=t('open');link.href='/plugins/official.virtual-computers/desktop.html?'+new URLSearchParams({computerId:c.id,mode:'console',locale,theme:document.documentElement.dataset.theme==='dark'?'dark':'light'});card.append(link);}
   else{const hint=document.createElement('p');hint.textContent=productText(locale, "Waiting for the owner to start this computer.", "等待主人开机后即可观看。");card.append(hint);}$('shared-computers').append(card);
  }
 }
 $('create').disabled=busy||api.hasPending()||!availability?.enabled||!availability.systems.some(s=>s.createEnabled);
 $('summary').textContent=t('count',{n:computers.length,running:computers.filter(c=>['running','stopping'].includes(c.state)).length});
 $('empty').hidden=computers.length!==0;
 // A heartbeat with unchanged data must not remove the focused button or
 // interrupt keyboard navigation while the user is choosing an action.
 const key=JSON.stringify([locale,busy,api.hasPending(),computers]);
 if(key===cardsKey)return;cardsKey=key;$('computers').replaceChildren();
 for(const c of computers){
  const card=document.createElement('article');card.className='card';const head=document.createElement('div');head.className='card-heading';
  const name=document.createElement('h2');name.textContent=c.name;const badge=document.createElement('span');badge.className='badge';badge.textContent=t(c.state);head.append(name,badge);
  const system=document.createElement('p');system.className='muted';system.textContent=c.system.name+' · '+c.system.edition;
  const spec=document.createElement('p');spec.className='spec muted';spec.textContent=t('spec',{cpu:c.resources.vcpus,memory:c.resources.memoryBytes/1024**3,disk:c.resources.diskBytes/1024**3});
  const actions=document.createElement('div');actions.className='card-actions';
  for(const action of computerActions(c)) {
   if(action==='open'){for(const mode of ['console',...(['running','stopping'].includes(c.state)?['desktop']:[])]){const a=document.createElement('a');a.className='button'+(mode==='console'?' primary':'');a.textContent=t(mode==='console'?'open':'desktop');a.href='/plugins/official.virtual-computers/desktop.html?'+new URLSearchParams({computerId:c.id,mode,locale,theme:document.documentElement.dataset.theme==='dark'?'dark':'light'});
    // Keep the desktop in this authenticated plugin frame. Some embedded
    // browsers isolate a new top-level tab from the signed-in application
    // session, which turns a valid desktop launch into a misleading 404.
    a.target='_self';if(mode==='console')actions.append(a);else{const more=document.createElement('details'),summary=document.createElement('summary');more.className='computer-more';summary.textContent=t('more');more.append(summary,a);actions.append(more);}}}
   else actions.append(button(action,()=>action==='refresh'?refresh():action==='delete'?confirmDelete(c):mutate('/'+c.id+'/'+action,'POST',{expectedRevision:c.revision})));
  }
  card.append(head,system,spec);if(c.errorCode){const note=document.createElement('p');note.textContent=t(c.errorCode);card.append(note);}
  if(c.state==='stopping'){const note=document.createElement('p');note.textContent=computerOsText(locale,'stopping');card.append(note);}
  {const install=button('more',()=>installationPanel.manage(c));install.textContent=installationText(locale,'install');actions.append(install);}
  card.append(actions);$('computers').append(card);
 }
}
async function refresh(){
 if(refreshing||left)return;refreshing=true;
 try{const [a,list,invitations]=await Promise.all([api.availability(),api.list(),api.shared()]);availability=a;computers=list.data;shared=invitations.data;
  if(a.ownerId)api.useJournal(localStorage,'teamaibox.computer-request.'+a.ownerId);
  $('retry').hidden=!api.hasPending();render();
  if(errorSource==='refresh'&&!api.hasPending()){show('error','');errorSource=null;}
  if(!a.enabled){show('notice',t(messages[locale][a.reasonCode]?a.reasonCode:'unavailableHint'));noticeSource='availability';}
  else if(noticeSource==='availability'){show('notice','');noticeSource=null;}}
 catch(e){if(!left)error(e,'refresh');}finally{refreshing=false;clearTimeout(timer);if(!document.hidden&&!left)timer=setTimeout(refresh,3000);}
}
async function mutate(path,method,input,retry=false){
 if(busy)return;busy=true;render();show('error','');errorSource=null;
 show('create-error','');show('delete-error','');
 try{const result=await(retry?api.retry():api.mutate(path,method,input));show('notice',result.state==='failed'?t(result.errorCode):t('submitted'));
  noticeSource='operation';
  $('editor').close();$('delete-dialog').close();$('retry').hidden=true;await refresh();}
 catch(e){error(e);}finally{busy=false;render();}
}
function systemResources(){
 const system=availability.systems.find(s=>s.id===$('system').value);if(!system)return;
 for(const key of ['vcpus','memoryGiB','diskGiB']){const field=$(key);field.min=String(system.minimum[key]);field.value=String(system.minimum[key]);
  const max=availability.limits.maximum[key];if(max!=null)field.max=String(max);else field.removeAttribute('max');}
 $('system-hint').textContent=t('minimum',{cpu:system.minimum.vcpus,memory:system.minimum.memoryGiB,disk:system.minimum.diskGiB});
 renderInstallationChoice();
}
$('create').onclick=()=>{
 show('create-error','');$('name').setCustomValidity('');
 installationChoice=null;
 $('name').value='';$('system').replaceChildren();for(const s of availability.systems){const option=document.createElement('option');option.value=s.id;option.disabled=!s.createEnabled;option.textContent=s.name+(s.createEnabled?'':' — '+t('systemUnavailable'));$('system').append(option);}
 $('system').value=availability.systems.find(s=>s.createEnabled).id;systemResources();$('editor').showModal();$('name').focus();
};
$('system').onchange=systemResources;$('cancel').onclick=()=>$('editor').close();
$('choose-iso').onclick=async()=>{const result=await installationPanel.choose(installationChoice?.media);if(result)installationChoice=result;renderInstallationChoice();};
$('empty-computer').onclick=()=>{installationChoice=null;renderInstallationChoice();};
$('name').oninput=()=>$('name').setCustomValidity('');
$('create-form').onsubmit=e=>{e.preventDefault();const name=$('name').value.trim().normalize('NFC');$('name').setCustomValidity(name?'':t('nameRequired'));
 if(!$('create-form').reportValidity()||busy||api.hasPending())return;
 mutate('','POST',{name,profileId:$('system').value,
 ...(availability.systems.find(s=>s.id===$('system').value)?.installable&&installationChoice?{installationMediaId:installationChoice.media.id,allowUnverified:installationChoice.allowUnverified}:{}),
 resources:Object.fromEntries(['vcpus','memoryGiB','diskGiB'].map(k=>[k,Number($(k).value)]))});};
function confirmDelete(c){selectedDelete=c;show('delete-error','');$('delete-name').textContent=c.name;$('delete-confirm').checked=false;$('delete-dialog').showModal();$('delete-cancel').focus();}
$('delete-cancel').onclick=()=>$('delete-dialog').close();$('delete-form').onsubmit=e=>{e.preventDefault();if(selectedDelete&&$('delete-confirm').checked)mutate('/'+selectedDelete.id,'DELETE',{expectedRevision:selectedDelete.revision,confirmDelete:true});};
$('refresh').onclick=refresh;$('retry').onclick=()=>mutate(null,null,null,true);
for(const prefix of ['create','delete'])$(prefix+'-retry').onclick=()=>mutate(null,null,null,true);
window.addEventListener('message',event=>{
 if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='teamaibox.plugin-preferences/v1'||event.data.pluginId!=='official.virtual-computers')return;
 if(event.data.revision<=Number(document.documentElement.dataset.pluginPreferenceRevision??0))return;
 try{const value=applyPluginPreferenceSnapshotV1({currentDocument:document,snapshot:event.data});locale=normalizeProductLocale(value.effective.locale);render();}catch{}
});
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden)refresh();});
window.addEventListener('pagehide',()=>{left=true;clearTimeout(timer);});
window.addEventListener('pageshow',()=>{if(left){left=false;refresh();}});
render();refresh();
