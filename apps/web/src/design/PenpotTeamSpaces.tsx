import {useEffect,useRef,useState,type RefObject} from 'react';
import {Users} from 'lucide-react';
import {Button} from '@teamaibox/ui-system/components';
import {EditorDialog} from '../EditorDialog';
import type {Locale} from '../i18n';
import {penpotTeamCopy} from './penpot-team-copy';

const editor='/api/v1/design/editor/';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Team={teamId:string;name:string;role:'admin'|'editor'|'viewer';nativeTeamId:string|null};
const validId=(value:unknown):value is string=>typeof value==='string'&&uuid.test(value);
function validTeam(value:unknown):value is Team{
  if(!value||typeof value!=='object')return false;
  const team=value as Partial<Team>;
  return validId(team.teamId)&&typeof team.name==='string'&&
    (team.role==='admin'||team.role==='editor'||team.role==='viewer')&&
    (team.nativeTeamId===null||validId(team.nativeTeamId));
}

async function request(body:Record<string,string>,signal:AbortSignal){
  const name='__Host-teamaibox-csrf=';
  const tokens=document.cookie.split(';').map(value=>value.trim()).filter(value=>value.startsWith(name));
  if(tokens.length!==1)throw Error('session');
  const response=await fetch('/api/v1/design/teams',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
    headers:{'x-csrf-token':tokens[0].slice(name.length),'content-type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(12_000)])});
  if(!response.ok)throw Error('teams');
  return response.json();
}

export function PenpotTeamSpaces({frame,ready,locale,t}:{frame:RefObject<HTMLIFrameElement|null>;ready:boolean;locale:Locale;t:(key:string)=>string}){
  const [title,choose,enable,open,notEnabled,empty,failed,leaveFile]=penpotTeamCopy[locale];
  const [visible,setVisible]=useState(false),[teams,setTeams]=useState<Team[]|null>(null),[teamId,setTeamId]=useState('');
  const [busy,setBusy]=useState(false),[feedback,setFeedback]=useState<'failed'|'leave'|null>(null);
  const pending=useRef<AbortController|null>(null);
  useEffect(()=>()=>pending.current?.abort(),[]);
  const selected=teams?.find(team=>team.teamId===teamId);

  async function load(){
    if(pending.current)return;
    const action=new AbortController();
    pending.current=action;setBusy(true);setFeedback(null);setTeams(null);
    try{
      const result=await request({},action.signal);
      if(!Array.isArray(result?.teams)||!result.teams.every(validTeam))throw Error('team directory');
      if(!action.signal.aborted){
        const rows:Team[]=result.teams;
        setTeams(rows);
        setTeamId(previous=>rows.some(team=>team.teamId===previous)?previous:rows.length===1?rows[0].teamId:'');
      }
    }catch{if(!action.signal.aborted)setFeedback('failed');}
    finally{if(!action.signal.aborted){pending.current=null;setBusy(false);}}
  }

  async function activate(team:Team){
    if(pending.current||team.role!=='admin'||team.nativeTeamId)return;
    const action=new AbortController();
    pending.current=action;setBusy(true);setFeedback(null);
    try{
      const result=await request({teamId:team.teamId},action.signal);
      if(result?.teamId!==team.teamId||!validId(result.nativeTeamId))throw Error('activation');
      if(!action.signal.aborted)setTeams(rows=>rows?.map(row=>row.teamId===team.teamId?{...row,nativeTeamId:result.nativeTeamId}:row)??null);
    }catch{
      // Do not replay a mutation after a missing reply. A fresh directory read
      // lets the user see whether the original activation was acknowledged.
      if(!action.signal.aborted){setTeams(null);setFeedback('failed');}
    }finally{if(!action.signal.aborted){pending.current=null;setBusy(false);}}
  }

  function openTeam(nativeTeamId:string){
    try{
      const destination=frame.current?.contentWindow?.location;
      if(!validId(nativeTeamId)||destination?.origin!==window.location.origin||destination.pathname!==editor)throw Error('editor');
      // Only navigate from the native dashboard. Do not unload or switch an
      // active design (including its pending saves and AI connection).
      if(!/^#\/dashboard(?:\/|\?|$)/.test(destination.hash)){setFeedback('leave');return;}
      destination.hash='#/dashboard/recent?team-id='+nativeTeamId;
      setVisible(false);
    }catch{setFeedback('failed');}
  }

  return <>
    <Button variant="quiet" disabled={!ready} onClick={()=>{setVisible(true);void load();}}><Users size={16} aria-hidden="true"/>{title}</Button>
    {visible&&<EditorDialog title={title} closeLabel={t('common.close')} busy={busy} onCancel={()=>setVisible(false)}
      feedback={feedback==='failed'?failed:feedback==='leave'?leaveFile:busy?t('applications.loading'):null}>
      <div className="penpot-transfer-form">
        {teams===null&&feedback==='failed'&&<Button onClick={()=>void load()}>{t('applications.retry')}</Button>}
        {teams?.length===0&&<p>{empty}</p>}
        {Boolean(teams?.length)&&<label>{choose}
          <select value={teamId} disabled={busy} onChange={event=>{setTeamId(event.target.value);setFeedback(null);}}>
            <option value="" disabled>{choose}</option>
            {teams?.map(team=><option key={team.teamId} value={team.teamId}>{team.name}</option>)}
          </select>
        </label>}
        {selected&&(selected.nativeTeamId?<Button disabled={busy} onClick={()=>openTeam(selected.nativeTeamId!)}>{open}</Button>
          :selected.role==='admin'?<Button disabled={busy} onClick={()=>void activate(selected)}>{enable}</Button>:<p>{notEnabled}</p>)}
      </div>
    </EditorDialog>}
  </>;
}
