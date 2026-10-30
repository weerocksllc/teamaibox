// Isolated layout regression: actual markup/styles, synthetic messages, no API.
// PORT=4188 node apps/messaging-plugin/test/composer-layout-fixture.mjs
// Open http://127.0.0.1:4188/ and inspect the on-page assertions.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applicationPluginSharedAsset } from '../../../packages/application-plugin-runtime/src/static-server.mjs';

const publicRoot = new URL('../src/public/', import.meta.url);
const cases = [
  { name: 'desktop-long-history', width: 1480, height: 720, theme: 'light' },
  { name: 'short-dark-history', width: 1024, height: 500, theme: 'dark' },
  { name: 'mobile-long-history', width: 390, height: 600, theme: 'light' },
  { name: 'empty-conversation', width: 1024, height: 500, theme: 'light', empty: true },
  { name: 'loading-history', width: 390, height: 600, theme: 'dark', loading: true },
  { name: 'errors-attachment-multiline', width: 390, height: 600, theme: 'light', extras: true },
];

function initializeFixture(config) {
  const $ = selector => document.querySelector(selector);
  document.documentElement.dataset.theme = config.theme;
  document.documentElement.dataset.mobileView = 'chat';
  $('#chat-placeholder').hidden = true;
  $('#chat-active').hidden = false;
  $('#chat-title').textContent = '聊天布局检查';
  $('#chat-subtitle').textContent = config.name;
  $('#history-loading').hidden = !config.loading;
  $('#message-empty').hidden = !config.empty;
  $('#message-list').hidden = !!config.empty;
  if (!config.empty) {
    for (let i = 0; i < 60; i++) {
      const row = document.createElement('li');
      row.className = 'message-row' + (i % 2 ? ' is-own' : '');
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      const message = document.createElement('p');
      message.className = 'message-text';
      message.textContent = `${i + 1}. 测试消息，只检查输入区和滚动，不发送到服务器。`;
      bubble.append(message); row.append(bubble); $('#message-list').append(row);
    }
  }
  $('#message-input').value = '这是未发送的本地草稿';
  $('#send-message').disabled = false;
  $('#composer').addEventListener('submit', event => event.preventDefault());
  if (config.extras) {
    for (const [id, content] of [
      ['history-error', '消息历史暂时无法加载，请稍后重试。'],
      ['composer-error', '消息未发送，草稿已保留。'],
      ['attachment-strip', '待发送的附件.png'],
      ['history-older', '查看更早的消息'],
    ]) { const element = document.getElementById(id); element.hidden = false; element.textContent = content; }
    $('#message-input').style.height = '120px';
    $('#message-input').value = '多行草稿\n第二行\n第三行\n第四行\n第五行';
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const composer = rect('composer'), input = rect('message-input'), send = rect('send-message');
    const list = $('#message-list'), active = $('#chat-active');
    const checks = {
      composerContained: composer.top >= 0 && composer.bottom <= innerHeight + 1,
      inputContained: input.top >= composer.top && input.bottom <= composer.bottom + 1,
      sendContained: send.top >= composer.top && send.bottom <= composer.bottom + 1,
      noPageOverflow: document.documentElement.scrollHeight <= innerHeight + 1,
      noChatOverflow: active.scrollHeight <= active.clientHeight + 1,
      historyScrollable: config.empty || list.scrollHeight > list.clientHeight,
      historyAboveComposer: config.empty || rect('message-list').bottom <= composer.top + 1,
    };
    const result = { name: config.name, passed: Object.values(checks).every(Boolean), checks,
      viewport: { width: innerWidth, height: innerHeight },
      composer: { top: composer.top, bottom: composer.bottom, height: composer.height } };
    document.documentElement.dataset.layoutResult = result.passed ? 'passed' : 'failed';
    parent.postMessage({ kind: 'composer-layout-result', result }, location.origin);
  }));
}

const harness = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>聊天输入区布局回归</title>
<style>body{font:14px system-ui;margin:24px;background:#f4f7f8;color:#173033}iframe{display:block;border:1px solid #ccd8dc;max-width:none}section{margin:24px 0}pre{white-space:pre-wrap}.pass{color:#087f78}.fail{color:#b42318}</style>
<h1>聊天输入区布局回归（仅合成数据）</h1><p id="summary">检查中</p><pre id="results"></pre>
${cases.map((c, i) => `<section><h2>${c.name} · ${c.width} × ${c.height}</h2><iframe title="${c.name}" width="${c.width}" height="${c.height}" src="/case/${i}"></iframe></section>`).join('')}
<script>const results=new Map();addEventListener('message',e=>{if(e.origin!==location.origin||e.data.kind!=='composer-layout-result')return;results.set(e.data.result.name,e.data.result);const values=[...results.values()],passed=values.filter(x=>x.passed).length;document.querySelector('#summary').textContent=passed+' / ${cases.length} 通过';document.querySelector('#summary').className=passed===${cases.length}?'pass':'fail';document.querySelector('#results').textContent=JSON.stringify(values,null,2);document.documentElement.dataset.layoutResult=values.length===${cases.length}?(passed===${cases.length}?'passed':'failed'):'pending';});</script></html>`;

createServer(async (request, response) => {
  const path = new URL(request.url, 'http://fixture.invalid').pathname;
  let content, type = 'text/html; charset=utf-8';
  if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
  if (path === '/') content = harness;
  else if (/^\/case\/[0-5]$/.test(path)) {
    const config = cases[Number(path.split('/').at(-1))];
    content = (await readFile(new URL('index.html', publicRoot), 'utf8'))
      .replace('<script type="module" src="/plugins/official.messaging/app.js"></script>',
        `<script>(${initializeFixture.toString()})(${JSON.stringify(config)})</script>`);
  } else if (path.startsWith('/plugins/official.messaging/')) {
    const asset = path.slice('/plugins/official.messaging/'.length);
    if (!['app.css', 'platform-preferences.css', 'ui-system.css'].includes(asset)) {
      response.writeHead(404); response.end(); return;
    }
    type = 'text/css; charset=utf-8';
    const shared = applicationPluginSharedAsset(asset);
    content = shared ? shared.body : await readFile(new URL(asset, publicRoot));
  } else { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); response.end(content);
}).listen(Number(process.env.PORT || 4188), '127.0.0.1', () => console.log(`Layout fixture: http://127.0.0.1:${process.env.PORT || 4188}/ (${fileURLToPath(publicRoot)})`));
