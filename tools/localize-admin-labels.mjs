// Mechanical replacement of presentation-only JSX text; option values stay unchanged.
import {readFileSync,writeFileSync,readdirSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const root=resolve(import.meta.dirname,'..'),req=createRequire(realpathSync(resolve(root,'apps/web/node_modules/vite/package.json'))),{parseAst}=await import(req.resolve('rolldown/parseAst'));
const labels={
 'LIVE TELEMETRY':['Live resources','实时资源'],'MODEL CARD':['Model details','模型详情'],'PLUGIN ECOSYSTEM':['Applications','应用管理'],'EXTERNAL COMPUTE':['External compute','外部算力'],
 'SCHEDULER CONTROL':['Task scheduling','任务调度'],'SOURCE CENTER':['Software sources','软件源'],'LOCAL IDENTITIES':['Team accounts','团队账号'],
 'Internal only':['Local only','仅使用本机'],'Internal first':['Prefer local','优先本机'],'External first':['Prefer external','优先外部'],'Weighted':['Weighted allocation','按权重分配'],'Pinned':['Fixed provider','固定提供方'],
 'HTTPS URL':['HTTPS address','HTTPS 地址'],'Bearer':['Bearer token','Bearer 令牌'],'API key header':['API key header','API 密钥请求头'],'None':['None','无'],
 'System CA':['System certificates','系统证书'],'Custom CA':['Custom certificate','自定义证书'],'Unpriced':['Not priced','未定价'],'Provider reported':['Reported by provider','提供方报告'],'Platform estimated':['Platform estimate','平台估算'],
 'hosted':['Hosted repository','托管仓库'],'proxy-cache':['Proxy cache','代理缓存'],'upstream':['Upstream','上游来源'],'mirror':['Mirror','镜像源'],'offline-media':['Offline media','离线介质'],
 'internal':['Internal','内部'],'lan':['Local network','局域网'],'internet (HTTPS)':['Internet (HTTPS)','互联网（HTTPS）'],
 'required':['Required','必需'],'preferred':['Preferred','优先'],'not-available':['Not available','不可用'],'auto':['Automatic','自动'],'online':['Online','在线'],'offline':['Offline','离线'],
 'none':['None','无'],'read-through':['Read-through cache','按需读取缓存'],'immutable-offline':['Read-only offline cache','只读离线缓存'],
 'agent':['Agent','智能体'],'application-build':['Application build','应用构建'],'model-build':['Model build','模型构建'],'all':['All','全部'],'source':['Source code','源代码'],
 'allow-online':['Allow online access','允许联网'],'prefer-offline':['Prefer offline','优先离线'],'require-offline':['Offline only','仅限离线'],
 'local-filesystem':['Local filesystem','本地文件系统'],'local-block':['Local block device','本地块设备'],'s3-compatible':['S3-compatible storage','S3 兼容存储'],
};
const keys=Object.fromEntries(Object.keys(labels).map((v,i)=>[v,'presentation.label_'+i]));
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(resolve(dir,e.name)):e.name.endsWith('.tsx')?[resolve(dir,e.name)]:[]);}
for(const path of files(resolve(root,'apps/web/src'))){let source=readFileSync(path,'utf8');const ast=parseAst(source,{lang:'tsx'},path),edits=[];
 function walk(n){if(n.type==='JSXText'&&labels[n.value.trim()])edits.push([n.start,n.end,`{t(${JSON.stringify(keys[n.value.trim()])})}`]);for(const value of Object.values(n)){if(Array.isArray(value)){for(const c of value)if(c?.type)walk(c);}else if(value?.type)walk(value);}}
 walk(ast);for(const[start,end,text]of edits.sort((a,b)=>b[0]-a[0]))source=source.slice(0,start)+text+source.slice(end);if(edits.length)writeFileSync(path,source);
}
const path=resolve(root,'apps/web/src/i18n.ts');let source=readFileSync(path,'utf8');
for(const[name,index]of [['zhCN',1],['en',0]]){const match=source.match(new RegExp(`(?:export )?const ${name}[^=]*=\\s*\\{`));if(!match)throw Error('catalog not found: '+name);const at=match.index+match[0].length;
 if(source.slice(at,at+80).includes('presentation.label_0'))continue;
 source=source.slice(0,at)+'\n'+Object.entries(labels).map(([id,text])=>`  ${JSON.stringify(keys[id])}: ${JSON.stringify(text[index])},`).join('\n')+source.slice(at);
}writeFileSync(path,source);
