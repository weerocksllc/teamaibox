import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { MemoryNpmCatalog } from "../gateways/npm/src/memory-npm-catalog.mjs";
import { NpmGatewayService } from "../gateways/npm/src/npm-gateway-service.mjs";
import { NpmRegistryHttpApi } from "../gateways/npm/src/npm-registry-http-api.mjs";
import { createNpmGatewayServer } from "../gateways/npm/server/npm-gateway-server.mjs";
import { MemoryPipContentStore } from "../gateways/pip/src/memory-pip-catalog.mjs";

const execute=promisify(execFile),ADMIN="018f6f18-24d7-7c21-9b62-8c017419958b",SOURCE="018f6f18-24d7-7c21-9b62-8c0174199501";

test("a real npm client installs a verified package through the internal registry",{timeout:30000},async(t)=>{
  const temporary=await mkdtemp(join(tmpdir(),"teamaibox-npm-client-"));t.after(()=>rm(temporary,{recursive:true,force:true}));
  const packageRoot=join(temporary,"package");await mkdir(packageRoot);await writeFile(join(packageRoot,"package.json"),JSON.stringify({name:"demo-package",version:"1.0.0",main:"index.js"}));await writeFile(join(packageRoot,"index.js"),"module.exports = 'installed-through-gateway';\n");
  const tarball=join(temporary,"demo-package-1.0.0.tgz");await execute("tar",["-czf",tarball,"-C",temporary,"package"]);const bytes=await readFile(tarball);
  const integrity=`sha512-${createHash("sha512").update(bytes).digest("base64")}`,sha256=`sha256:${createHash("sha256").update(bytes).digest("hex")}`,shasum=createHash("sha1").update(bytes).digest("hex");
  const policy={policyKey:"npm.test",offlineMode:"require-offline",packageRules:[],sources:[{sourceId:SOURCE,priority:1,source:{sourceId:SOURCE,kind:"hosted",enabled:true,onlineMode:"offline",packageScopes:["*"]}}]},context={identityId:ADMIN,permissions:["source:manage"],environment:"agent",architecture:"arm64"};
  const service=new NpmGatewayService({catalog:new MemoryNpmCatalog(),content:new MemoryPipContentStore(),policyResolver:{resolve:async()=>policy}});await service.importPackage({context,artifact:{packageName:"demo-package",version:"1.0.0",integrity,sha256,shasum,size:bytes.byteLength,sourceId:SOURCE,sourceKind:"hosted",locationKey:"npm/test/demo",dependencies:{},optionalDependencies:{},peerDependencies:{},engines:{node:">=18"},cpu:[],os:[],hasInstallScript:false,signatureStatus:"not-available",scanStatus:"passed",license:"MIT"},bytes});
  let origin="http://127.0.0.1";const server=createNpmGatewayServer({api:new NpmRegistryHttpApi({service}),contextResolver:{resolve:async()=>context},originProvider:{getOrigin:async()=>origin}});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));origin=`http://127.0.0.1:${server.address().port}`;
  const project=join(temporary,"consumer");await mkdir(project);await writeFile(join(project,"package.json"),'{"name":"consumer","version":"1.0.0","private":true}');await execute("npm",["install","--ignore-scripts","--no-audit","--no-fund","--registry",`${origin}/npm/registry/`,"demo-package@1.0.0"],{cwd:project,timeout:20000});
  const installed=await readFile(join(project,"node_modules","demo-package","index.js"),"utf8");assert.match(installed,/installed-through-gateway/);
});
