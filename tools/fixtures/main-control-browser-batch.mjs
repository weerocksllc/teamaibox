/** Await this function inside one cua_repl call (at most 45 seconds).
 * Browser APIs cannot be called after that tool's execution context ends.
 * Each exclusive batch keeps failed reads as well as successful observations.
 */
export async function sampleBatch(read, fs, path, { seconds=35, intervalMs=2000, id, readyPath=null }={}) {
  if(typeof read!=='function'||!id||seconds<=0||seconds>45||intervalMs<250||intervalMs>10000)throw TypeError('invalid_batch');
  await fs.writeFile(path,'',{flag:'wx'});
  const end=Date.now()+seconds*1000;let count=0;
  while(Date.now()<end){
    let row;
    try{row={...await read(),id};}catch{row={at:new Date().toISOString(),id,width:0,height:0,time:0,paused:true,muted:true,hidden:false,readyState:0};}
    await fs.appendFile(path,JSON.stringify(row)+'\n');count++;
    if(readyPath&&row.width>0&&row.height>0&&!row.paused&&!row.muted&&!row.hidden&&row.readyState===4){
      try{await fs.writeFile(readyPath,JSON.stringify(row),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
      readyPath=null;
    }
    await new Promise(resolve=>setTimeout(resolve,intervalMs));
  }
  return {path,observations:count};
}
