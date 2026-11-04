import {constants} from 'node:fs';
import {open,mkdir,realpath} from 'node:fs/promises';
import {PlatformError} from '../../../packages/observability/src/index.mjs';

export const WORKSPACE_IMPORT_BYTES=16*1024*1024;
const failure=(code,status=400)=>new PlatformError(code,'The workspace file operation could not be completed',{status});
function segments(directory){
  if(typeof directory!=='string'||directory.length>4096||!(directory==='/workspace'||directory.startsWith('/workspace/'))||/[\\\0-\x1f]/.test(directory))throw failure('assistant_workspace_path_invalid');
  const parts=directory.slice('/workspace'.length).replace(/^\//,'').split('/');
  if(directory==='/workspace')return [];
  if(parts.some(p=>!p||p==='.'||p==='..'||p.startsWith('.')))throw failure('assistant_workspace_path_invalid');
  return parts;
}
function filename(value){
  if(typeof value!=='string'||!value.trim()||value.length>128||/[\\/\0-\x1f]/.test(value)||['.','..','.teamaibox','.git'].includes(value))throw failure('assistant_workspace_name_invalid');
  return value;
}
/** Runs inside the existing owner container. No commands, Docker API or Agent execution. */
export async function workspaceFileOperation({operation,body,root='/workspace'}){
  if(!['folders','files'].includes(operation)||!body||typeof body!=='object'||Array.isArray(body))throw failure('assistant_workspace_operation_invalid');
  const allowed=operation==='folders'?['directory','name']:['directory','name','content'];
  if(Object.keys(body).some(key=>!allowed.includes(key)))throw failure('assistant_workspace_operation_invalid');
  const parts=segments(body.directory),name=filename(body.name);
  let content;
  if(operation==='files'){
    if(typeof body.content!=='string'||body.content.length>Math.ceil(WORKSPACE_IMPORT_BYTES/3)*4||body.content.length%4||/[^A-Za-z0-9+/=]/.test(body.content))throw failure('assistant_workspace_content_invalid',413);
    content=Buffer.from(body.content,'base64');if(content.length>WORKSPACE_IMPORT_BYTES||content.toString('base64')!==body.content)throw failure('assistant_workspace_content_invalid',413);
  }
  const handles=[];
  try{
    // Pin every directory, rejecting symlinks at each component. Subsequent
    // access is descriptor-relative, not a check-then-use of the original path.
    const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
    let parent=await open(root,flags);handles.push(parent);const base=await realpath(`/proc/self/fd/${parent.fd}`);
    for(const part of parts){parent=await open(`/proc/self/fd/${parent.fd}/${part}`,flags);handles.push(parent);}
    const actual=await realpath(`/proc/self/fd/${parent.fd}`);
    if(actual!==base&&!actual.startsWith(base+'/'))throw failure('assistant_workspace_path_denied',403);
    const target=`/proc/self/fd/${parent.fd}/${name}`;
    if(operation==='folders'){
      await mkdir(target,{mode:0o700});return {directory:body.directory+'/'+name,status:'created'};
    }
    let file;
    try{file=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
    catch(error){if(error.code==='EEXIST')return {name,status:'exists'};throw error;}
    try{await file.writeFile(content);await file.sync();}finally{await file.close();}
    return {name,status:'created'};
  }catch(error){
    if(error instanceof PlatformError)throw error;
    if(['ELOOP','ENOTDIR','EACCES'].includes(error.code))throw failure('assistant_workspace_path_denied',403);
    if(error.code==='EEXIST')throw failure('assistant_workspace_folder_exists',409);
    if(error.code==='ENOENT')throw failure('assistant_workspace_folder_missing',404);
    throw failure('assistant_workspace_file_unavailable',503);
  }finally{content?.fill(0);for(const handle of handles.reverse())await handle.close();}
}
