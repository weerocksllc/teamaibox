// Isolated layout fixtures; never proxies an appliance or a write request.
// Reuses the local operations preview, with deterministic result/error content.
import { createServer } from 'node:http';
import { applicationPluginSharedAsset } from '../../../packages/application-plugin-runtime/src/static-server.mjs';
const apps = ['drawing', 'ocr', 'asr', 'translation'];
const ids = Object.fromEntries(apps.map((app, i) => [app, `00000000-0000-4000-8000-00000000090${i + 1}`]));
const results = {
  drawing: { schema: 'teamaibox.ai.image-result.v1', job_id: ids.drawing, prompt: '团队发布资料', outputs: [{ encrypted: true, preview_path: `/api/v1/objects/references/${ids.drawing}/content`, download_path: `/api/v1/objects/references/${ids.drawing}/content?download=1` }], reproducibility: { size: '1024x1024', seed: 42, steps: 20 }, provenance: { profile_key: '设计示例' } },
  ocr: { schema: 'teamaibox.ai.ocr-result.v1', text: '产品发布会议纪要\n\n一、交付材料\n陈玫负责整理演示材料，林默负责更新说明。\n\n二、时间安排\n周五前完成核对。', pages: [{ page_number: 1, blocks: [{ id: '01', block_type: 'text', text: '一、交付材料', confidence: .98 }, { id: '02', block_type: 'table', content_format: 'html', confidence: null, structure: { html: '<table><tr><th>负责人</th><th>行动项</th></tr><tr><td>陈玫</td><td>客户演示材料</td></tr></table>' } }] }], extensions: { provenance: { model_key: '设计示例' } } },
  asr: { schema: 'teamaibox.ai.asr-result.v1', text: '确认本周的交付安排。', language: { code: 'zh' }, duration_seconds: 64, speaker_information: { supported: true, speaker_count: 2 }, segments: Array.from({ length: 8 }, (_, i) => ({ id: String(i), start_seconds: i * 8, end_seconds: (i + 1) * 8, speaker: `说话人 ${i % 2 + 1}`, text: '确认本周的交付安排。演示材料与使用说明都需要在周五前完成。' })), provenance: { profile_key: '设计示例' } },
  translation: { schema: 'teamaibox.ai.translation-result.v1', text: 'The release materials will be ready by Friday. Please confirm the action items with your team.', source_language: 'zh', target_language: 'en', input_kind: 'text', segments: [{ id: '1', start_ms: null, end_ms: null, source_text: '发布材料将在周五前准备好，请与团队确认行动项。', translated_text: 'The release materials will be ready by Friday. Please confirm the action items with your team.' }], workflow: { stages: [{ capability: 'translation', status: 'succeeded' }], intermediates: [] }, provenance: { completed_at: '2026-10-22T03:00:00Z' } },
};
function send(res, body, type = 'application/json', status = 200, headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4193');
  if(url.pathname==='/__responsive')return send(res,'<!doctype html><html><meta charset="utf-8"><title>Isolated responsive UI</title><style>body{margin:16px;background:#152226;color:white;font:14px system-ui}iframe{display:block;width:780px;height:500px;border:1px solid #5b767b}</style><p>780 × 500 · isolated presentation fixture</p><iframe title="Responsive workbench" src="/apps/messaging?audit=ready"></iframe></html>','text/html');
  const mode = url.searchParams.get('audit') || req.headers.cookie?.match(/audit-mode=(\w+)/)?.[1] || 'ready';
  const headers = url.searchParams.has('audit') ? { 'set-cookie': `audit-mode=${mode}; Path=/; SameSite=Lax` } : {};
  if (req.method !== 'GET') return send(res, { error: { code: 'request_failed', message: '暂时无法保存，输入内容已保留。' } }, 'application/json', 503);
  if (url.pathname === `/api/v1/objects/references/${ids.drawing}/content`) return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><rect width="1024" height="768" fill="#edf5f3"/><circle cx="760" cy="250" r="210" fill="#8adbc8"/><path d="M0 600L400 260L800 768H0" fill="#087f78"/><text x="80" y="140" font-family="sans-serif" font-size="54" fill="#17292b">Precision Workspace</text></svg>', 'image/svg+xml');
  const jobApp = apps.find(app => url.pathname === `/api/v1/jobs/${ids[app]}`);
  if (jobApp) return send(res, { id: ids[jobApp], status: mode === 'error' ? 'failed' : 'succeeded', result: results[jobApp], error: mode === 'error' ? { message: '任务未完成，请检查输入后重试。原文件不受影响。' } : null });
  const camera = url.pathname.match(/^\/api\/v1\/virtual-phones\/([^/]+)\/camera$/);
  if (camera) return send(res, { object: 'virtual_phone.camera', phoneId: camera[1], generation: 1, state: 'stopped', capabilities: { image: true, browser: true, video: true, usb: true, udp: true } });
  if (/\/camera\/(devices|network-sources)$/.test(url.pathname)) return send(res, { phoneId: url.pathname.split('/')[4], generation: 1, runId: '00000000-0000-4000-8000-000000000909', data: [] });
  if (/^\/api\/v1\/jobs\/[^/]+\/events$/.test(url.pathname)) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': synthetic layout fixture\n\n'); return; }
  if (mode === 'error' && url.pathname.startsWith('/api/') && url.pathname !== '/api/v1/applications') return send(res, { error: { code: 'request_failed', message: '暂时无法连接，输入内容已保留。' } }, 'application/json', 503);
  const asset = url.pathname.match(/^\/plugins\/[^/]+\/(.+)$/);
  const shared = asset && applicationPluginSharedAsset(asset[1]);
  if (shared) return send(res, shared.body, shared.contentType);
  try {
    const upstream = await fetch(`http://127.0.0.1:4179${url.pathname}${url.search}`, { signal: AbortSignal.timeout(10000) });
    const type = upstream.headers.get('content-type') || 'text/plain';
    let body = Buffer.from(await upstream.arrayBuffer());
    const plugin = url.pathname.match(/^\/plugins\/official\.(drawing|ocr|asr|translation)\/?(?:index.html)?$/)?.[1];
    if (plugin && type.includes('text/html')) {
      const keys = { drawing: 'teamaibox.drawing.current-job.v1', translation: 'teamaibox.translation.active-job.v1', ocr: 'teamaibox:official.ocr:active-job', asr: 'teamaibox:official.asr:active-job' };
      const command = mode === 'ready' ? `sessionStorage.removeItem(${JSON.stringify(keys[plugin])})` : `sessionStorage.setItem(${JSON.stringify(keys[plugin])},${JSON.stringify(ids[plugin])})`;
      body = Buffer.from(body.toString().replace('<head>', `<head><script>${command};</script>`));
    }
    return send(res, body, type, upstream.status, headers);
  } catch { return send(res, { error: { code: 'isolated_preview_unavailable' } }, 'application/json', 503); }
}).listen(4193, '127.0.0.1', () => console.log('Isolated layout preview: http://127.0.0.1:4193'));
