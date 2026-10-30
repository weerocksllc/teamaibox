import {productText} from '../../../../packages/ui-system/src/product-localization.mjs';
import {useEffect,useState} from 'react';
import '../phones/phone-administration.css';

type Policy={enabled:boolean;revision:number;maximum:Record<string,number>;storedPerUser:number|null;runningPerUser:number|null};
type Quota={ownerId:string;displayName:string;loginName:string;stored:number;running:number;revision:number;storedPerUser:number|null;runningPerUser:number|null};
type System={id:string;name:string;edition:string;version:string;createEnabled:boolean;revision:string};
type Data={policy:Policy;systems:System[];
  nodes:{nodeId:string;nodeName:string|null;ready:boolean;running:number}[]};
const ROOT='/api/v1/admin/virtual-computers';
async function request<T>(path:string,body?:unknown):Promise<T>{
  const cookie=document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-teamaibox-csrf='));
  const response=await fetch(ROOT+path,{method:body===undefined?'GET':'PUT',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),
    headers:body===undefined?{}:{'content-type':'application/json','x-csrf-token':decodeURIComponent(cookie?.split('=').slice(1).join('=')??'')},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw Error(value?.error?.code??'request_failed');return value;
}
import { EditorDialog } from "../EditorDialog";

export function ComputerAdministrationPanel({locale,canManage}:{locale:string;canManage:boolean}){
  const t=(cn:string,en:string)=>productText(locale,en,cn);
  const [data,setData]=useState<Data|null>(null),[draft,setDraft]=useState<Policy|null>(null),[users,setUsers]=useState<Quota[]>([]);
  const [search,setSearch]=useState(''),[cursor,setCursor]=useState<string|null>(null),[edit,setEdit]=useState<Quota|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const error=(e:unknown)=>{
    const messages:Record<string,string>={
      computer_state_conflict:t('设置已被修改，请刷新后重试。','Settings changed. Refresh before retrying.'),
      computer_profile_version_conflict:t('这个版本编号已存在。新版本请使用新的编号，不能覆盖已有版本。','This version ID already exists. Use a new ID instead of overwriting it.'),
      computer_profile_not_installed:t('本机尚未安装这个系统版本，或安装内容不匹配。请先完成安装，再开放新建。','The appliance does not have a matching installed system. Install it before enabling creation.'),
      computer_input_invalid:t('系统说明或资源设置不正确，请检查后重试。','Check the system description and resource settings.'),
      computer_profile_unavailable:t('系统说明不完整，无法导入。','The system description is incomplete.')};
    return e instanceof Error&&messages[e.message]||t('操作未完成，请检查权限或刷新后重试。','Unable to complete. Check permission or refresh and retry.');
  };
  async function load(after:string|null=null){
    if(!canManage)return;setBusy(true);setMessage('');
    try{
      const query=new URLSearchParams({search});if(after)query.set('after',after);
      const [result,page]=await Promise.all([request<Data>(''),request<{data:Quota[];nextCursor:string|null}>('/quotas?'+query)]);
      setData(result);setDraft(structuredClone(result.policy));setUsers(page.data);setCursor(page.nextCursor);setEdit(null);
    }catch(e){setMessage(error(e));}finally{setBusy(false);}
  }
  useEffect(()=>{void load();},[canManage]);
  async function save(kind:'policy'|'quota'){
    if(!draft||busy||!canManage)return;setBusy(true);setMessage('');
    try{
      if(kind==='policy')await request('/policy',{...draft,revision:undefined,expectedRevision:draft.revision});
      else if(edit)await request('/quotas/'+encodeURIComponent(edit.ownerId),{storedPerUser:edit.storedPerUser,runningPerUser:edit.runningPerUser,expectedRevision:edit.revision});
      await load();setMessage(t('设置已保存；现有电脑不会被关机或删除。','Saved. Existing computers are not shut down or deleted.'));
    }catch(e){setMessage(error(e));}finally{setBusy(false);}
  }
  async function importSystem(file:File){
    if(busy||!canManage)return;setBusy(true);setMessage('');
    try{
      await request('/systems',{profile:JSON.parse(await file.text())});await load();
      setMessage(t('系统说明已导入。安装到本机后，可以开放新建。原电脑不会改变。','System description imported. Enable creation after local installation. Existing computers are unchanged.'));
    }catch(e){setMessage(e instanceof SyntaxError?t('文件不是有效的 JSON 系统说明。','The file is not valid system JSON.'):error(e));}finally{setBusy(false);}
  }
  async function publishSystem(system:System){
    if(busy||!canManage)return;setBusy(true);setMessage('');
    try{
      await request('/systems/'+encodeURIComponent(system.id),{enabled:!system.createEnabled,expectedRevision:system.revision});await load();
      setMessage(t('系统设置已保存，仅影响新建电脑。已有电脑仍可正常开机和使用。','System setting saved. Only new computers are affected; existing computers remain usable.'));
    }catch(e){setMessage(error(e));}finally{setBusy(false);}
  }
  const number=(value:string)=>value===''?null:Number(value);
  const labels={vcpus:t('每台 CPU 核数上限','Maximum CPUs per computer'),memoryGiB:t('每台内存上限（GiB）','Maximum memory (GiB)'),diskGiB:t('每台磁盘上限（GiB）','Maximum disk (GiB)')};
  const quotas=(value:Policy|Quota,update:(key:'storedPerUser'|'runningPerUser',v:number|null)=>void)=>(['storedPerUser','runningPerUser'] as const).map(key=><label key={key}>
    <span>{key==='storedPerUser'?t('可保存数量','Saved computers'):t('可同时运行','Running computers')}</span>
    <input type="number" min={0} step={1} value={value[key]??''} disabled={busy} placeholder={t('按可用资源','Available resources')}
      onChange={e=>update(key,number(e.target.value))}/></label>);
  if(!canManage)return <p role="alert">{t('没有虚拟电脑管理权限。','Computer management permission is required.')}</p>;
  return <section className="phone-admin" aria-label={t('虚拟电脑管理','Virtual computer administration')}>
    <header className="phone-admin-header"><h2>{t('虚拟电脑管理','Virtual computer administration')}</h2><button className="secondary-button" disabled={busy} onClick={()=>void load()}>{t('刷新','Refresh')}</button></header>
    {message&&<p role="status">{message}</p>}
    {!data||!draft?<p>{t('正在读取…','Loading…')}</p>:<>
      <form className="phone-admin-card" onSubmit={e=>{e.preventDefault();void save('policy');}}><h3>{t('创建与资源设置','Creation and resources')}</h3>
        <label className="phone-admin-check"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>{t('允许新建和开机','Allow creation and startup')}</label>
        <p className="phone-admin-muted">{t('暂停只影响新建和开机，不中断正在使用的电脑。留空表示不另设上限，实际可用资源仍会检查。','Pausing affects only creation and startup. Leave a limit blank to use available resources; existing computers keep running.')}</p>
        <div className="phone-admin-fields">{Object.entries(labels).map(([key,label])=><label key={key}><span>{label}</span><input type="number" min={1} step={1} value={draft.maximum[key]??''} disabled={busy}
          onChange={e=>{const maximum={...draft.maximum},v=number(e.target.value);if(v===null)delete maximum[key];else maximum[key]=v;setDraft({...draft,maximum});}}/></label>)}
          {quotas(draft,(key,v)=>setDraft({...draft,[key]:v}))}</div>
        <div className="precision-save-row"><span role="status">{JSON.stringify(draft)!==JSON.stringify(data.policy) ? t("有未保存的修改","Unsaved changes") : t("当前生效设置","Current settings")}</span><button className="primary-button" disabled={busy} type="submit">{t('保存设置','Save settings')}</button></div>
      </form>
      <div className="phone-admin-grid"><section className="phone-admin-card"><h3>{t('可用系统','Systems')}</h3>{data.systems.map(s=><div key={s.id}><p><strong>{s.name} · {s.edition}</strong><br/>{s.version} · {s.createEnabled?t('可供新建','Available to create'):t('暂未开放','Not available yet')}</p>
        <button className="secondary-button" disabled={busy} onClick={()=>void publishSystem(s)}>{s.createEnabled?t('暂停此系统新建','Pause new computers'):t('开放此系统新建','Enable new computers')}</button></div>)}
        <details><summary>{t('导入系统版本','Import a system version')}</summary><p className="phone-admin-muted">{t('导入系统说明文件（JSON），再将对应安装介质配置到本机。这里不会下载 Windows、授予许可证或修改已有电脑。','Import a system description (JSON), then install matching media on this appliance. This does not download Windows, grant a license or modify existing computers.')}</p>
          <input aria-label={t('系统说明文件','System description file')} type="file" accept=".json,application/json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void importSystem(file);}}/></details>
      </section>
      <section className="phone-admin-card"><h3>{t('本机状态','Device status')}</h3>{(data.nodes.length === 1 ? data.nodes : []).map(n=><p key={n.nodeId}><strong>{n.nodeName??t('本机设备','This device')}</strong><br/>{n.ready?t('已连接','Connected'):t('暂不可用','Unavailable')} · {t('运行中','Running')} {n.running}</p>)}
        <a href="/admin/device">{t('查看本机资源','View device resources')}</a> · <a href="/admin/storage">{t('管理存储','Manage storage')}</a></section></div>
      <section className="phone-admin-card"><h3>{t('用户额度','User quotas')}</h3><p className="phone-admin-muted">{t('管理资源不授予查看他人电脑画面或文件的权限。','Resource management does not grant access to another user’s screen or files.')}</p>
        <form className="phone-admin-search" onSubmit={e=>{e.preventDefault();void load();}}><input aria-label={t('搜索用户','Search users')} type="search" value={search} onChange={e=>setSearch(e.target.value)}/><button className="secondary-button" disabled={busy}>{t('搜索','Search')}</button></form>
        {edit&&<EditorDialog title={t("调整额度","Edit quota")} description={`${edit.displayName} (@${edit.loginName})`} busy={busy} onCancel={()=>setEdit(null)} feedback={message}><form className="phone-admin-editor" onSubmit={e=>{e.preventDefault();void save('quota');}}><p className="precision-editor__hint">{t("修改仅在保存后生效。","Changes take effect only after saving.")}</p><div className="phone-admin-fields">{quotas(edit,(key,v)=>setEdit({...edit,[key]:v}))}</div>
          <p>{t('留空表示按资源分配；0 表示不允许新增。不会删除已有电脑。','Blank means resource-based admission; zero prevents new allocations. Existing computers are not deleted.')}</p>
          <button type="submit" className="primary-button" disabled={busy}>{t('保存额度','Save quota')}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>setEdit(null)}>{t('取消','Cancel')}</button></form></EditorDialog>}
        <div className="phone-admin-table"><table><thead><tr><th>{t('用户','User')}</th><th>{t('已保存','Saved')}</th><th>{t('运行中','Running')}</th><th>{t('管理','Manage')}</th></tr></thead><tbody>{users.map(u=><tr key={u.ownerId}><td>{u.displayName}<small>@{u.loginName}</small></td><td>{u.stored} / {u.storedPerUser??'—'}</td><td>{u.running} / {u.runningPerUser??'—'}</td><td><button className="secondary-button" disabled={busy} onClick={()=>setEdit({...u})}>{t('调整额度','Edit quota')}</button></td></tr>)}</tbody></table></div>
        {cursor&&<button className="secondary-button" disabled={busy} onClick={()=>void load(cursor)}>{t('下一页','Next page')}</button>}
      </section>
    </>}
  </section>;
}
