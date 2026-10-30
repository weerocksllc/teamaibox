import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ANDROID_LAB_PLAYWRIGHT_PACKAGE ||
  'playwright');

test('synthetic AV fixture responds to input and emits timestamped pulse markers', {timeout: 30000}, async () => {
  const browser = await chromium.launch({headless: true, executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const page = await browser.newPage({viewport:{width:720,height:1600}});
    const errors=[];
    page.on('pageerror', error=>errors.push(error.message));
    await page.goto(new URL('../tools/fixtures/android-lab-av.html', import.meta.url).href);
    await page.getByRole('button',{name:'Start tone and clock'}).click();
    await page.getByRole('button',{name:'Tap marker'}).click();
    await page.getByLabel('Text test').fill('TEST-123');
    await page.waitForFunction(()=>window.androidLabFixture.events.filter(x=>x.kind==='pulse').length>=2);
    const events=await page.evaluate(()=>window.androidLabFixture.events);
    assert.equal(events.filter(x=>x.kind==='tap').length,1);
    assert.equal(await page.getByLabel('Text test').inputValue(),'TEST-123');
    assert.ok(events.find(x=>x.kind==='pulse'&&x.frame>0));
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('Cuttlefish compact fixture fits phone viewport and preserves synthetic text', {timeout:30000}, async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{
  const page=await browser.newPage({viewport:{width:360,height:490}});
  await page.goto(new URL('../tools/fixtures/android-lab-cuttlefish-av.html',import.meta.url).href);
  await page.getByRole('button',{name:'Start AV',exact:true}).click();
  await page.getByRole('button',{name:'Tap marker',exact:true}).click();
  await page.getByLabel('Text test').fill('TEST-123');
  await page.waitForFunction(()=>window.androidLabFixture.events.filter(e=>e.kind==='pulse').length>=2);
  const bounds=await page.locator('canvas').boundingBox();assert.ok(bounds.y+bounds.height<=490);
  assert.equal(await page.locator('#status').textContent(),'Tap 1');
  await page.reload();assert.equal(await page.getByLabel('Text test').inputValue(),'TEST-123');
 }finally{await browser.close();}
});
