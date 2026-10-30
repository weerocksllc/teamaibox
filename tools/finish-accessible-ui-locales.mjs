import {readFile,writeFile} from 'node:fs/promises';
for(const [app,object,entries] of [
 ['messaging','messages',[['conversations','Conversations','聊天列表'],['messageArea','Messages','消息']]],
 ['team-drive','catalog',[['driveNavigation','Drive navigation','网盘导航'],['breadcrumb','Breadcrumb','当前位置']]],
]){
 const path=`apps/${app}-plugin/src/public/app.js`;let s=await readFile(path,'utf8');
 const anchor='const params=';if(!s.includes(anchor))throw Error('missing preference anchor');
 for(const[key,en,zh]of entries)if(!s.includes(`${object}.en.${key}=`))s=s.replace(anchor,`${object}.en.${key}=${JSON.stringify(en)};${object}["zh-CN"].${key}=${JSON.stringify(zh)};\n${anchor}`);
 await writeFile(path,s);
}
