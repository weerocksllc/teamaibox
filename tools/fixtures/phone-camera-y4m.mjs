// Synthetic video for Chromium's native fake-camera driver. No captured media.
import {open} from 'node:fs/promises';
export async function writeSyntheticCameraVideo(path){
  const file=await open(path,'wx',0o600),width=640,height=480,frames=36;
  try{
    await file.write(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`);
    const buffer=Buffer.alloc(width*height*3/2,128);
    for(let index=0;index<frames;index++){
      const flip=Math.floor(index/9)%2;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++)buffer[y*width+x]=(((x<width/2)===(y<height/2))!==Boolean(flip))?16:235;
      await file.write('FRAME\n');await file.write(buffer);
    }
    return {syntheticOnly:true,width,height,frames,fps:15,audio:false};
  }finally{await file.close();}
}
