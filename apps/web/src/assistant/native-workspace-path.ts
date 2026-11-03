/** Display navigation is limited to container workspace directories. Server authorization remains authoritative. */
export function isNativeWorkspace(path:string){
  return (path==='/workspace'||path.startsWith('/workspace/'))&&!/[\\\0-\x1f]/.test(path)
    &&!path.split('/').some(part=>part==='.'||part==='..');
}
export function nativeResultPath(path:string,directory:string){
  const relative=path.startsWith(directory+'/')?path.slice(directory.length+1):path.replace(/^\.\//,'');
  if(!relative||relative.startsWith('/')||/[\\\0-\x1f]/.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..'))return null;
  return relative;
}
