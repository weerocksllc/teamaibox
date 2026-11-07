import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {PenpotNativeSourceExporter} from '../src/design/penpot-native-source-exporter.mjs';

function fixture({assetOrigin='http://native-frontend.invalid',changeAfter=Infinity}={}){
  const source={fileId:randomUUID(),pageId:randomUUID(),revision:2,documentVersion:0,format:'penpot'};
  const profileId=randomUUID(),assetPath='/assets/by-id/'+randomUUID(),calls=[];
  let checks=0;
  const nativeContext={assertCurrent:async()=>({profileId,nativeToken:'synthetic-native-session'})};
  const exporter=new PenpotNativeSourceExporter({backendOrigin:'http://native-backend.invalid',
    frontendOrigin:'http://native-frontend.invalid',nativePermissions:{
      async savedRevision({profileId:profile,fileId,pageId}){
        assert.deepEqual({profileId:profile,fileId,pageId},{profileId,fileId:source.fileId,pageId:source.pageId});
        return {revision:2,documentVersion:0,modifiedAt:++checks>=changeAfter?'2026-01-02':'2026-01-01'};
      },
    },fetchImplementation:async(url,options)=>{
      calls.push({origin:url.origin,path:url.pathname,options});
      if(url.pathname==='/api/main/methods/export-binfile'){
        assert.equal(options.redirect,'error');assert.equal(options.headers.cookie,'auth-token=synthetic-native-session');
        return new Response('event: progress\ndata: {}\n\nevent: end\ndata: '+JSON.stringify({'~#uri':assetOrigin+assetPath})+'\n\n',
          {headers:{'content-type':'text/event-stream;charset=UTF-8'}});
      }
      assert.equal(url.pathname,assetPath);
      assert.equal(url.origin,'http://native-frontend.invalid');
      return new Response(Buffer.from('504b030400000000','hex'));
    }});
  return {exporter,source,nativeContext,calls};
}

test('native source export fetches the validated archive and binds saved revision across rendering and download',async()=>{
  const {exporter,source,nativeContext,calls}=fixture();
  const result=await exporter.exportSaved({nativeContext,source});
  assert.equal(result.revision,2);assert.ok(result.bytes.subarray(0,4).equals(Buffer.from('504b0304','hex')));
  assert.equal(calls.length,2);
  assert.deepEqual(JSON.parse(calls[0].options.body),{'file-id':source.fileId,'include-libraries':false,'embed-assets':true});
});

test('an archive URL off the fixed origin or a changed saved snapshot is never downloaded',async()=>{
  for(const [fixtureOptions,error] of [[{assetOrigin:'http://elsewhere.invalid'},503],[{changeAfter:2},409]]){
    const {exporter,source,nativeContext,calls}=fixture(fixtureOptions);
    await assert.rejects(exporter.exportSaved({nativeContext,source}),{status:error});assert.equal(calls.length,1);
  }
});
