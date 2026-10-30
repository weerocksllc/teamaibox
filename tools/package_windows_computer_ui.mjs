import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,verify} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildBundle,validateBuildRecord} from './package_virtual_phones_ui.mjs';
const [buildPath,imagePath,outputPath,packageId,publisherPath]=process.argv.slice(2);
const need=(v,m)=>{if(!v)throw Error(m);};
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const root=resolve(new URL('..',import.meta.url).pathname);
need(/^windows-computer-ui-publication-\d{8}-a[1-9]\d*$/.test(packageId),'invalid package identity');
const build=JSON.parse(await readFile(buildPath));validateBuildRecord(build);
for(const source of build.sources)need(hash(await readFile(join(root,source.path)))===source.sha256,'build source changed');
const template=JSON.parse(await readFile(join(root,'apps/virtual-computers-plugin/manifest.release-template.json')));
const publisher=JSON.parse(await readFile(publisherPath));
need(publisher.publisherId===template.publisher.id&&publisher.pluginIds?.includes(template.id),'wrong publisher');
const signPayload=payload=>{
 const result=spawnSync(publisher.signCommand[0],publisher.signCommand.slice(1),{input:payload,timeout:30000,maxBuffer:16384});
 const signature=Buffer.from(result.stdout?.toString().trim()??'','base64');
 need(result.status===0&&signature.length===64&&verify(null,payload,publisher.publicKeyPem,signature),'signing failed');return signature;
};
const artifact=async suffix=>readFile(join(root,build.artifacts.find(x=>x.path.endsWith('/'+suffix)).path));
const result=buildBundle({template,imageBytes:await readFile(imagePath),repository:'localhost:15016/teamaibox/virtual-computers-plugin',
 sbomBytes:await artifact('ui.spdx.json'),scanBytes:await artifact('ui.grype.json'),build,keyId:publisher.keyId,signPayload});
await mkdir(outputPath);
for(const [name,bytes] of result.blobs)await writeFile(join(outputPath,name),bytes,{flag:'wx'});
await writeFile(join(outputPath,'bundle.json'),JSON.stringify(result.bundle),{flag:'wx'});
console.log(JSON.stringify({bundleId:packageId,pluginId:template.id,expectedBundleDigest:result.bundle.bundleSignature.payloadDigest}));
