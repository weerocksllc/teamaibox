/** Deep links contain only native IDs and container-relative workspace paths. */
export function readNativeLocation(url:URL) {
  const path=url.searchParams.get('assistantDirectory')??'/workspace';
  const directory=(path==='/workspace'||path.startsWith('/workspace/'))&&!/[\\\0-\x1f]/.test(path)
    &&!path.split('/').some(part=>part==='..'||part==='.')?path:'/workspace';
  const id=url.searchParams.get('assistantSession');
  return {directory,sessionId:id&&/^ses_[A-Za-z0-9]+$/.test(id)?id:null};
}
export function writeNativeLocation(url:URL,sessionId:string|null,directory:string) {
  const next=new URL(url);
  if(sessionId)next.searchParams.set('assistantSession',sessionId);else next.searchParams.delete('assistantSession');
  if(directory==='/workspace')next.searchParams.delete('assistantDirectory');else next.searchParams.set('assistantDirectory',directory);
  return next;
}
