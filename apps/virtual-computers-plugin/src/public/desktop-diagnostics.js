import { productText } from "./product-localization.mjs";
// Opt-in, page-local test counters. No media, credentials, keys or URLs retained.
(() => {
  if (new URLSearchParams(location.search).get('diagnostics') !== '1') return;
  const stats = { socketOpens: 0, socketCloses: 0, audioStreams: 0, audioBytes: 0,
    nonzeroAudioBytes: 0, audioBuffersStarted: 0, audioBuffersEnded: 0,
    audioContextState: 'not-created', transportRoundTripSamples: 0 };
  const trips = [];
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      if (!/\/desktop-tunnel(?:\?|$)/.test(String(args[0]))) return;
      this.addEventListener('open', () => stats.socketOpens++);
      this.addEventListener('close', () => stats.socketCloses++);
      const streams = new Set(), parser = new Guacamole.Parser();
      parser.oninstruction = (op, params) => {
        if (op === '' && params[0] === 'ping') {
          const ms = Date.now() - Number(params[1]);
          if (Number.isFinite(ms) && ms >= 0) {
            trips.push(ms); if (trips.length > 120) trips.shift();
            const sorted = [...trips].sort((a,b) => a-b);
            stats.transportRoundTripSamples = sorted.length;
            stats.transportRoundTripP50Ms = sorted[Math.floor((sorted.length-1)*.5)];
            stats.transportRoundTripP95Ms = sorted[Math.ceil((sorted.length-1)*.95)];
          }
        }
        if (op === 'audio' && /^audio\/L(8|16);/.test(params[1])) {
          streams.add(params[0]); stats.audioStreams++; stats.audioFormat = params[1];
        }
        if (op === 'blob' && streams.has(params[0])) {
          const bytes = atob(params[1]); stats.audioBytes += bytes.length;
          for (let i=0;i<bytes.length;i++) if (bytes.charCodeAt(i)) stats.nonzeroAudioBytes++;
        }
        if (op === 'end') streams.delete(params[0]);
      };
      this.addEventListener('message', event => {
        if (typeof event.data === 'string') try { parser.receive(event.data); }
        catch { stats.parserError = true; }
      });
    }
  };
  const NativeAudio = window.AudioContext || window.webkitAudioContext;
  if (NativeAudio) {
    const ObservedAudio = class extends NativeAudio {
      constructor(...args) {
        super(...args);
        const update = () => {
          stats.audioContextState = this.state; stats.sampleRate = this.sampleRate;
          stats.baseLatencyMs = typeof this.baseLatency === 'number' ? this.baseLatency*1000 : null;
          stats.outputLatencyMs = typeof this.outputLatency === 'number' ? this.outputLatency*1000 : null;
        };
        this.addEventListener('statechange', update); update();
      }
      createBufferSource() {
        const source = super.createBufferSource(), start = source.start.bind(source);
        source.addEventListener('ended', () => stats.audioBuffersEnded++);
        source.start = (...args) => {
          const result = start(...args); stats.audioBuffersStarted++;
          stats.lastScheduledAheadMs = Math.max(0, ((args[0] || this.currentTime)-this.currentTime)*1000);
          return result;
        };
        return source;
      }
    };
    window.AudioContext = ObservedAudio;
    if (window.webkitAudioContext) window.webkitAudioContext = ObservedAudio;
  }
  const panel = document.createElement('details'), title = document.createElement('summary');
  title.textContent = productText(document.documentElement.lang, "Connection diagnostics (this page only)", "连接检查（仅本页）");
  const output = document.createElement('output'); output.id = 'windows-desktop-diagnostics';
  panel.style.cssText = 'position:fixed;right:8px;bottom:24px;z-index:5;max-width:320px;max-height:40vh;overflow:auto;background:Canvas;color:CanvasText;padding:8px;font:12px monospace';
  output.style.cssText = 'display:block;overflow-wrap:anywhere;white-space:pre-wrap';
  panel.append(title, output); document.body.append(panel);
  import('./desktop-latency.mjs').then(({createLatencyProbe}) => {
    const button = document.createElement('button'); button.type = 'button';
    const en = document.documentElement.lang === 'en';
    let enabled = false;
    button.textContent = productText(document.documentElement.lang, "Measure test-pattern response", "测量测试图案响应");
    const readPixel = () => {
      const screen = document.querySelector('#screen');
      if (!screen) return null;
      const area = screen.getBoundingClientRect();
      const x = area.left + area.width / 2, y = area.top + area.height / 2;
      for (const canvas of screen.querySelectorAll('canvas')) {
        const box = canvas.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0 || x < box.left || y < box.top || x >= box.right || y >= box.bottom) continue;
        try {
          const pixel = canvas.getContext('2d').getImageData(
            Math.floor((x - box.left) * canvas.width / box.width),
            Math.floor((y - box.top) * canvas.height / box.height), 1, 1).data;
          if (pixel[3] === 255) return pixel;
        } catch { return null; }
      }
      return null;
    };
    const probe = createLatencyProbe({ now: () => performance.now(), readPixel,
      requestFrame: callback => requestAnimationFrame(callback), report: value => { stats.testPatternResponse = value; } });
    button.addEventListener('click', () => {
      enabled = !enabled; probe.setEnabled(enabled);
      button.textContent = enabled ? (productText(document.documentElement.lang, "Stop measuring", "停止测量")) : (productText(document.documentElement.lang, "Measure test-pattern response", "测量测试图案响应"));
      document.querySelector('#screen')?.focus();
    });
    const help = document.createElement('p');
    help.textContent = productText(document.documentElement.lang, "Test window only: press 1–8. Measures browser input to returned test pixels, not physical monitor latency.", "仅用于专用测试窗口：按 1–8。测量浏览器按键到返回测试画面，不代表实体显示器延迟。");
    panel.append(button, help);
    document.addEventListener('keydown', event => {
      if (document.activeElement?.id === 'screen') probe.key(event.key, event.repeat);
    }, true);
    window.addEventListener('pagehide', () => probe.setEnabled(false), { once: true });
  }).catch(() => { stats.testPatternUnavailable = true; });
  const refresh = () => { output.textContent = JSON.stringify(stats, null, 2); };
  refresh(); const timer = setInterval(refresh, 1000);
  window.addEventListener('pagehide', () => clearInterval(timer), {once:true});
})();
