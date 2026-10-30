import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneReconnectDelay} from '../src/public/phone-workspace.mjs';

test('recovery covers the measured 16.4 and 21.3 second guest reboots',()=>{
  let elapsed=0,attempts=0;
  while(elapsed<22000){
    const delay=phoneReconnectDelay(attempts++,elapsed);
    assert.notEqual(delay,null);assert.ok(delay>=1000&&delay<=5000);elapsed+=delay;
  }
  assert.ok(attempts>3);
});
test('recovery stops after twelve attempts even for immediate failures',()=>{
  assert.equal(phoneReconnectDelay(11,0),5000);
  assert.equal(phoneReconnectDelay(12,0),null);
});
test('slow or hidden-page recovery cannot schedule beyond 90 seconds',()=>{
  assert.equal(phoneReconnectDelay(4,89900),100);
  assert.equal(phoneReconnectDelay(1,90000),null);
  assert.equal(phoneReconnectDelay(1,120000),null);
});
