import assert from 'node:assert/strict';
import test from 'node:test';
import {desktopSize, ReconnectSchedule, connectParameters, desktopEndpoints, desktopRequestHeaders} from '../src/public/desktop-session.mjs';
test('remote desktop preserves CSS pixel dimensions instead of halving Retina viewport', () => {
  assert.deepEqual(desktopSize(1024, 900), {width:1024, height:900, dpi:96});
  assert.deepEqual(desktopSize(1920.4, 1079.9), {width:1920, height:1079, dpi:96});
  assert.equal(desktopSize(0,900), null);
  assert.equal(desktopSize(NaN,900), null);
});
test('reconnect backs off without abandoning the user or creating a guest', () => {
  const retry=new ReconnectSchedule();
  assert.deepEqual(Array.from({length:6},()=>retry.next()), [2000,4000,8000,15000,15000,15000]);
  retry.reset(); assert.equal(retry.next(),2000);
});
test('fresh auth is encoded for one desktop, without login/password query parameters', () => {
  const query=new URLSearchParams(connectParameters({authToken:'a&b',dataSource:'json',connectionId:'Windows 11'}, desktopSize(1280,720),['audio/L16;rate=44100,channels=2']));
  assert.equal(query.get('token'),'a&b'); assert.equal(query.get('GUAC_WIDTH'),'1280');
  assert.equal(query.get('GUAC_HEIGHT'),'720'); assert.equal(query.get('GUAC_DPI'),'96');
  assert.equal(query.has('password'), false); assert.equal(query.has('username'), false);
  assert.equal(query.get('GUAC_ID'),'Windows 11'); assert.equal(query.getAll('GUAC_AUDIO').length,1);
  assert.throws(()=>connectParameters({},desktopSize(1280,720)));
});
test('product desktop uses same-origin routes scoped to the selected computer', () => {
  const id='10000000-0000-4000-8000-000000000001';
  const paths=desktopEndpoints('https://10.64.0.20/apps/virtual-computers/desktop?upstream=evil',{computerId:id});
  assert.equal(paths.session,`/api/v1/virtual-computers/${id}/desktop-sessions`);
  assert.equal(paths.tunnel,`/api/v1/virtual-computers/${id}/desktop-tunnel`);
  assert.equal(paths.lab,false);
  assert.throws(()=>desktopEndpoints('http://10.64.0.20/',{computerId:id}));
  assert.throws(()=>desktopEndpoints('https://10.64.0.20/',{computerId:'../../other'}));
});
test('loopback adapter requires explicit lab markup and is rejected on product HTTPS', () => {
  assert.equal(desktopEndpoints('http://127.0.0.1:18962/guacamole/desktop.html',{labDesktop:'true'}).lab,true);
  assert.throws(()=>desktopEndpoints('http://127.0.0.1:18962/guacamole/desktop.html',{}));
  assert.throws(()=>desktopEndpoints('https://10.64.0.20/',{labDesktop:'true'}));
});
test('member card desktop links select only one computer ID; conflicting selection is rejected',()=>{
  const id='10000000-0000-4000-8000-000000000001',url=`https://10.64.0.20/plugins/official.virtual-computers/desktop.html?computerId=${id}`;
  assert.equal(desktopEndpoints(url).session,`/api/v1/virtual-computers/${id}/desktop-sessions`);
  assert.throws(()=>desktopEndpoints(url+'&computerId='+id));
  assert.throws(()=>desktopEndpoints(url,{computerId:'20000000-0000-4000-8000-000000000002'}));
  assert.throws(()=>desktopEndpoints('https://10.64.0.20/desktop.html?computerId=..%2fother'));
});
test('desktop handshakes use the existing platform CSRF cookie, never Windows credentials', () => {
  assert.equal(desktopRequestHeaders('__Host-teamaibox-csrf=example; other=abc')['x-csrf-token'], 'example');
  for (const cookie of ['', '__Host-teamaibox-csrf=', '__Host-teamaibox-csrf=a; __Host-teamaibox-csrf=b']) assert.throws(() => desktopRequestHeaders(cookie));
  assert.deepEqual(desktopRequestHeaders('', true), { 'Content-Type': 'application/json' });
});
test('installation console selects the same owned guest, not an arbitrary remote service',()=>{
  const base='https://10.64.0.20/plugins/official.virtual-computers/desktop.html?computerId=10000000-0000-4000-8000-000000000001';
  assert.equal(desktopEndpoints(base+'&mode=console').mode,'console');
  assert.equal(desktopEndpoints(base+'&mode=desktop').mode,'desktop');
  assert.equal(desktopEndpoints(base).mode,'console');
  assert.throws(()=>desktopEndpoints(base+'&mode=console&mode=desktop'));
  assert.throws(()=>desktopEndpoints(base+'&mode=ssh'));
});
