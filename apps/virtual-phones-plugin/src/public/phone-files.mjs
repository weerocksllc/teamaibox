import { localizedCatalogs, productText } from "./product-localization.mjs";
import {sha256Blob} from './sha256.mjs';
import {confirmPhoneInstallation} from './phone-install-confirmation.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const words=localizedCatalogs({zh:{title:'文件与 APK',hint:'普通文件保存到手机的 Download/TeamAIBox；APK 安装不会自动授予应用权限。',choose:'选择文件',upload:'传入文件',install:'安装 APK',refresh:'刷新文件',close:'返回手机',cancel:'取消传输',empty:'此目录还没有文件。',download:'下载',working:'正在处理…',done:'已完成。',failed:'未能完成。请检查手机状态和文件后重试。',cancelled:'已中断传输。如已提交 Android 安装，请在手机中确认结果。',oversize:'请选择有效的非空文件。',confirm:'将这个 APK 安装到当前手机？只安装你信任的应用。',installFailed:'Android 拒绝了这个 APK，未确认安装成功。'},
en:{title:'Files and APKs',hint:'Files go to Download/TeamAIBox. Installing an APK does not automatically grant permissions.',choose:'Choose file',upload:'Send file',install:'Install APK',refresh:'Refresh files',close:'Back to phone',cancel:'Cancel transfer',empty:'No files in this directory.',download:'Download',working:'Working…',done:'Completed.',failed:'Could not finish. Check the phone and file, then retry.',cancelled:'Transfer interrupted. If installation had already reached Android, check its result on the phone.',oversize:'Choose a valid, non-empty file.',confirm:'Install this APK on the current phone? Only install applications you trust.',installFailed:'Android rejected this APK. Installation was not confirmed.'}});
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const validName=name=>typeof name==='string'&&name.trim()===name&&name.length>0&&new TextEncoder().encode(name).length<=240&&!['.','..'].includes(name)&&!name.startsWith('.transfer-')&&!/[\\/\p{Cc}\p{Cf}]/u.test(name);

export function createPhoneFiles({element,getPhone,fetchImpl=fetch}) {
  const find=id=>element.querySelector('#'+id);let controller=null,epoch=0,phone=null,files=[];
  const t=key=>{
    const zh=document.documentElement.lang.startsWith('zh');
    if(key==='confirmInstall')return productText(document.documentElement.lang, "Confirm installation", "确认安装");
    if(key==='declineInstall')return productText(document.documentElement.lang, "Cancel installation", "取消安装");
    if(key==='installCancelled')return productText(document.documentElement.lang, "Installation cancelled. No file was uploaded.", "已取消安装，未上传文件。");
    return words[document.documentElement.lang][key];
  };
  function translate(){for(const el of element.querySelectorAll('[data-file-label]'))el.textContent=t(el.dataset.fileLabel);render();}
  function render(){
    for(const button of element.querySelectorAll('[data-file-operation]'))button.disabled=Boolean(controller);
    find('phone-file-input').disabled=Boolean(controller);find('phone-file-cancel').hidden=!controller;
    const children=files.map(file=>{const row=document.createElement('div');row.className='phone-file-row';
      const label=document.createElement('span');label.textContent=file.name;
      const size=document.createElement('small');size.textContent=(file.sizeBytes/1024).toFixed(1)+' KiB';
      const button=document.createElement('button');button.textContent=t('download');button.disabled=Boolean(controller);button.addEventListener('click',()=>void perform(signal=>download(file,signal)));
      row.append(label,size,button);return row;});
    if(!children.length){const empty=document.createElement('p');empty.textContent=t('empty');children.push(empty);}
    find('phone-file-list').replaceChildren(...children);
  }
  async function json(path,{method='GET',body,headers={},signal}={}) {
    signal?.throwIfAborted();
    if(method!=='GET'){
      const tokens=document.cookie.split(';').map(v=>v.trim()).filter(v=>v.startsWith('__Host-teamaibox-csrf='));
      const csrf=tokens.length===1?tokens[0].slice('__Host-teamaibox-csrf='.length):'';
      if(!csrf)throw Error('invalid_session');headers={...headers,'x-csrf-token':csrf};
    }
    const response=await fetchImpl(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',signal,
      headers:{accept:'application/json',...(body&&!headers['content-type']?{'content-type':'application/json'}:{}),...headers},
      body:body===undefined?undefined:body instanceof Blob?body:JSON.stringify(body)});
    if(!response.headers.get('content-type')?.includes('application/json'))throw Error('phone_response_invalid');
    const reader=response.body.getReader();let size=0;const chunks=[];
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1024**2){await reader.cancel();throw Error('phone_response_invalid');}chunks.push(part.value);}}
    finally{reader.releaseLock();}
    const value=JSON.parse(await new Blob(chunks).text());signal?.throwIfAborted();if(!response.ok)throw Error(value?.error?.code||'phone_request_failed');return value;
  }
  const root=()=>{if(!phone||!UUID.test(phone.id)||!Number.isSafeInteger(phone.generation))throw Error('phone_stale_run');return '/api/v1/virtual-phones/'+phone.id;};
  async function refresh(signal) {const target=phone,current=epoch;const value=await json(root()+'/files?generation='+target.generation,{signal});
    if(current!==epoch||phone!==target)throw Error('phone_stale_run');
    if(value?.phoneId!==target.id||!Array.isArray(value.data)||value.data.some(f=>!validName(f.name)||!Number.isSafeInteger(f.sizeBytes)||f.sizeBytes<0))throw Error('phone_response_invalid');files=value.data;}
  async function perform(action) {
    if(controller||!phone)return;const current=epoch;controller=new AbortController();const signal=controller.signal;
    const active=controller,timer=null;find('phone-file-status').textContent=t('working');render();
    try{await action(signal);if(current===epoch)find('phone-file-status').textContent=t('done');}
    catch(error){if(current===epoch)find('phone-file-status').textContent=t(signal.aborted?'cancelled':error.message==='phone_install_cancelled'?'installCancelled':error.message==='phone_upload_too_large'?'oversize':error.message==='phone_install_failed'?'installFailed':'failed');}
    finally{clearTimeout(timer);if(current===epoch){controller=null;render();}}
  }
  async function upload(install,signal) {
    const file=find('phone-file-input').files[0];if(!file||file.size<1||!validName(file.name))throw Error('phone_upload_too_large');
    if(install&&!await confirmPhoneInstallation(element,file,signal))throw Error('phone_install_cancelled');
    const sha256=await sha256Blob(file,{signal});signal.throwIfAborted();
    let uploadId=null,complete=false;
    try{
      const started=await json('/api/v1/objects/multipart',{method:'POST',body:{capability:'virtual_phone',name:file.name,media_type:'application/octet-stream',size:file.size,sha256},signal});
      uploadId=started?.upload?.uploadId;if(!UUID.test(uploadId??''))throw Error('phone_response_invalid');
      const parts=[],partSize=4*1024**2;
      for(let offset=0;offset<file.size;offset+=partSize){const part=file.slice(offset,Math.min(offset+partSize,file.size)),partHash=await hash(await part.arrayBuffer()),number=parts.length+1;
        await json(`/api/v1/objects/multipart/${uploadId}/parts/${number}`,{method:'PUT',body:part,headers:{'content-type':'application/octet-stream','x-content-sha256':partHash},signal});parts.push({part_number:number,sha256:partHash});}
      const finished=await json('/api/v1/objects/multipart/'+uploadId,{method:'POST',body:{parts},signal});complete=true;
      const object=finished?.object;if(!UUID.test(object?.objectId??'')||!Number.isSafeInteger(object.version)||object.size!==file.size||object.integrity?.digest!==sha256)throw Error('phone_response_invalid');
      const result=await json(root()+(install?'/installations':'/files'),{method:'POST',signal,body:{expectedGeneration:phone.generation,
        file:{objectId:object.objectId,objectVersion:object.version,name:file.name.normalize('NFC'),sizeBytes:file.size,sha256}}});
      if(result?.phoneId!==phone.id||install&&result.installed!==true||!install&&(result.name!==file.name.normalize('NFC')||result.sha256!==sha256))throw Error('phone_response_invalid');
      find('phone-file-input').value='';await refresh(signal);
    }finally{
      if(uploadId&&!complete)await json('/api/v1/objects/multipart/'+uploadId,{method:'DELETE',signal:AbortSignal.timeout(5000)}).catch(()=>{});
    }
  }
  async function download(file,signal) {
    if(file.sizeBytes===0)throw Error('phone_object_invalid');
    const value=await json(root()+'/file-exports',{method:'POST',body:{expectedGeneration:phone.generation,name:file.name},signal});
    if(value?.phoneId!==phone.id||!UUID.test(value.objectId??'')||value.sizeBytes<1||!/^[a-f0-9]{64}$/.test(value.sha256??''))throw Error('phone_response_invalid');
    const reference=await json('/api/v1/objects/'+value.objectId+'/references',{method:'POST',body:{capability:'virtual_phone',expires_in_seconds:60},signal});
    if(!UUID.test(reference?.reference_id??''))throw Error('phone_response_invalid');
    const response=await fetchImpl('/api/v1/objects/references/'+reference.reference_id+'/content',{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
    if(!response.ok||Number(response.headers.get('content-length'))!==value.sizeBytes)throw Error('phone_response_invalid');
    const reader=response.body.getReader(),chunks=[];let total=0;
    try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>value.sizeBytes){await reader.cancel();throw Error('phone_response_invalid');}chunks.push(next.value);}}
    finally{reader.releaseLock();}
    const blob=new Blob(chunks,{type:'application/octet-stream'});if(total!==value.sizeBytes||await sha256Blob(blob,{signal})!==value.sha256)throw Error('phone_response_invalid');
    signal.throwIfAborted();const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function reset(){epoch++;controller?.abort();controller=null;phone=null;files=[];find('phone-file-input').value='';element.close();render();}
  function open(){const value=getPhone();if(!value||value.state!=='running')return;reset();phone=structuredClone(value);translate();element.showModal();void perform(refresh);}
  find('phone-file-upload').addEventListener('click',()=>void perform(signal=>upload(false,signal)));
  find('phone-file-install').addEventListener('click',()=>void perform(signal=>upload(true,signal)));
  find('phone-file-refresh').addEventListener('click',()=>void perform(refresh));
  find('phone-file-cancel').addEventListener('click',()=>controller?.abort());
  find('phone-file-close').addEventListener('click',reset);element.addEventListener('cancel',()=>reset());window.addEventListener('pagehide',reset);
  return {open,reset,translate,refresh(){if(phone){const current=getPhone();if(!current||current.id!==phone.id||current.generation!==phone.generation||current.state!=='running')reset();}}};
}
