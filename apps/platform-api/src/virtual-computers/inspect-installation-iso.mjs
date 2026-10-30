// Random-access inspection of an immutable object version. Never mounts or
// executes member content; the budget limits metadata work, not ISO size.
const SECTOR=2048, BUDGET=4*1024**2;
class Invalid extends Error {}
class Budget extends Error {}
export async function inspectInstallationIso({size,readRange}) {
  if(!Number.isSafeInteger(size)||size<1||typeof readRange!=='function')throw TypeError('Invalid ISO reader');
  let bytes=0,descriptorWindow=null;
  const read=async(offset,count)=>{
    if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(count)||offset<0||count<0||offset+count>size)throw new Invalid();
    if(bytes+count>BUDGET)throw new Budget();
    bytes+=count;
    if(!count)return Buffer.alloc(0);
    if(descriptorWindow&&offset>=16*SECTOR&&offset+count<=16*SECTOR+descriptorWindow.length)
      return descriptorWindow.subarray(offset-16*SECTOR,offset-16*SECTOR+count);
    const value=await readRange(offset,count);
    if(!Buffer.isBuffer(value)||value.length!==count)throw new Invalid();
    return value;
  };
  const record=b=>{
    if(b.length<34||b[0]!==b.length||33+b[32]>b.length)throw new Invalid();
    const extent=b.readUInt32LE(2),length=b.readUInt32LE(10);
    if(extent!==b.readUInt32BE(6)||length!==b.readUInt32BE(14)||extent*SECTOR+length>size)throw new Invalid();
    return {offset:extent*SECTOR,size:length,directory:Boolean(b[25]&2),name:b.subarray(33,33+b[32]).toString('ascii').split(';')[0].toUpperCase()};
  };
  const children=async entry=>{
    if(!entry.directory)throw new Invalid();
    const b=await read(entry.offset,entry.size),result=[];
    for(let offset=0;offset<b.length;){
      const length=b[offset];
      if(!length){offset=(Math.floor(offset/SECTOR)+1)*SECTOR;continue;}
      if(offset+length>b.length||Math.floor(offset/SECTOR)!==Math.floor((offset+length-1)/SECTOR))throw new Invalid();
      const child=record(b.subarray(offset,offset+length));
      if(!['\0','\u0001'].includes(child.name))result.push(child);
      offset+=length;
    }
    return result;
  };
  const architecture=async entry=>{
    if(entry.directory||entry.size<64)return null;
    const b=await read(entry.offset,Math.min(entry.size,4096));
    if(b.toString('ascii',0,2)!=='MZ')return null;
    const offset=b.readUInt32LE(60);
    if(offset+6>entry.size)throw new Invalid();
    const pe=offset+6<=b.length?b.subarray(offset,offset+6):await read(entry.offset+offset,6);
    if(pe.toString('ascii',0,4)!=='PE\0\0')return null;
    return ({43620:'aarch64',34404:'x86_64',332:'x86'})[pe.readUInt16LE(4)]??null;
  };
  let result;
  try {
    let root=null,udf=false,elTorito=false;
    const endSector=Math.min(Math.floor(size/SECTOR),80);
    // GCM object ranges authenticate the complete encrypted file. Fetch the
    // contiguous descriptor region once, not 64 full-file authentication passes.
    if(endSector>16)descriptorWindow=await read(16*SECTOR,(endSector-16)*SECTOR);
    for(let sector=16;sector<endSector;sector++){
      const b=descriptorWindow.subarray((sector-16)*SECTOR,(sector-15)*SECTOR),magic=b.toString('ascii',1,6);
      if(['NSR02','NSR03'].includes(magic))udf=true;
      if(magic!=='CD001')continue;
      if(b[6]!==1)throw new Invalid();
      if(b[0]===0&&b.toString('ascii',7,39).replace(/[\0 ]+$/u,'')==='EL TORITO SPECIFICATION')elTorito=true;
      if(b[0]===1){
        if(b.readUInt16LE(128)!==SECTOR)throw new Budget();
        if(b.readUInt32LE(80)<17||b.readUInt32LE(80)*SECTOR>size)throw new Invalid();
        root=record(b.subarray(156,156+b[156]));
      }
    }
    if(!root)result={compatibility:udf?'unverified':'invalid',format:udf?'udf':null,architectures:[]};
    else {
      const efi=(await children(root)).find(e=>e.name==='EFI'&&e.directory);
      const boot=efi?(await children(efi)).find(e=>e.name==='BOOT'&&e.directory):null;
      const entries=boot?await children(boot):[],architectures=new Set();let arm=false;
      for(const entry of entries){
        if(!['BOOTAA64.EFI','BOOTX64.EFI','BOOTIA32.EFI'].includes(entry.name))continue;
        const arch=await architecture(entry);if(arch)architectures.add(arch);
        if(entry.name==='BOOTAA64.EFI'&&arch==='aarch64')arm=true;
      }
      const compatibility=arm?'arm64':architectures.size&&!architectures.has('aarch64')?'wrong-architecture':!entries.length&&!elTorito&&!udf?'not-bootable':'unverified';
      result={compatibility,format:'iso9660',architectures:[...architectures].sort()};
    }
  }catch(error){
    if(!(error instanceof Invalid||error instanceof Budget))throw error; // Storage/transport failure is NOT compatibility success.
    result={compatibility:error instanceof Budget?'unverified':'invalid',format:null,architectures:[]};
  }
  return {...result,sizeBytes:size,metadataBytesRead:bytes};
}
