import assert from 'node:assert/strict';
import test from 'node:test';
import {mediaSource,dataBytes,safeRaster,safeMessageLink} from '../src/assistant/message-media.ts';
import {richMessageKeys,richMessageText} from '../src/assistant/rich-message-copy.ts';
import {supportedLocaleCodes} from '../../../packages/ui-system/src/locale-registry.mjs';
test('workspace image references normalize inside the owner workspace',()=>{
  assert.deepEqual(mediaSource('../chart.png','/workspace/project'),{kind:'workspace',path:'chart.png'});
  assert.deepEqual(mediaSource('file:///workspace/project/chart.png','/workspace'),{kind:'workspace',path:'project/chart.png'});
  assert.deepEqual(mediaSource('a%20b.png','/workspace/project'),{kind:'workspace',path:'project/a b.png'});
});
test('unsafe media paths, encoded escapes and credential URLs are unavailable',()=>{
  for(const source of ['../../etc/passwd','file:///etc/passwd','file://elsewhere/workspace/a.png','/workspace/.teamaibox/key','/workspace/.git/config','//host/image.png','javascript:alert(1)','data:image/svg+xml;base64,PHN2Zz4=\n','%252e%252e/x.png','https://secret:password@invalid.example/image.png'])assert.equal(mediaSource(source,'/workspace').kind,'unavailable',source);
});
test('external images remain explicit links, not automatic resource fetches',()=>{
  assert.deepEqual(mediaSource('https://example.org/a.png','/workspace'),{kind:'external',url:'https://example.org/a.png',host:'example.org'});
});
test('data bytes are canonical and raster MIME is verified from bytes',()=>{
  const source=mediaSource('data:image/png;base64,iVBORw0KGgo=','/workspace');assert.equal(source.kind,'data');
  const bytes=dataBytes(source);assert.equal(safeRaster(bytes,source.mime),'image/png');
  assert.throws(()=>safeRaster(new TextEncoder().encode('<svg onload="alert(1)"/>'),'image/png'));
  assert.throws(()=>safeRaster(bytes,'image/jpeg'));
  assert.throws(()=>dataBytes({kind:'data',mime:'image/png',body:'Zh=='}));
});
test('message links cannot become application commands or unsafe schemes',()=>{
  for(const link of ['javascript:alert(1)','data:text/html,test','file:///workspace/a','//host/path','/admin','https://user:secret@example.org','https:\\example.org'])assert.equal(safeMessageLink(link),undefined);
  assert.equal(safeMessageLink('https://example.org/guide'),'https://example.org/guide');
});
test('every new action has a nonempty label in all 17 product locales',()=>{
  assert.equal(supportedLocaleCodes.length,17);
  for(const locale of supportedLocaleCodes)for(const key of richMessageKeys)assert.ok(richMessageText(locale,key)?.trim(),locale+':'+key);
});
