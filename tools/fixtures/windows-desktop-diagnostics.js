/* Lab-only, content-free counters. Never records keys, credentials or media. */
(() => {
  const stats = { sockets: 0, socketOpens: 0, socketCloses: 0, instructions: {}, audioStreams: 0, audioBytes: 0, nonzeroAudioBytes: 0,
    audioBuffersStarted: 0, audioContextState: 'not-created',
    audioContextSampleRate: null, baseLatencyMs: null, outputLatencyMs: null };
  const roundTrips = [];
  const refresh = () => {
    let node = document.getElementById('windows-desktop-diagnostics');
    if (!node) {
      node = document.createElement('output');
      node.id = 'windows-desktop-diagnostics';
      node.style.cssText = 'position:fixed;right:4px;top:4px;background:#fff;color:#123;padding:5px;font:11px monospace;z-index:99999;max-width:320px;pointer-events:none';
      document.body.appendChild(node);
    }
    node.textContent = JSON.stringify(stats);
  };
  const NativeSocket = window.WebSocket;
  class ObservedSocket extends NativeSocket {
    constructor(...args) {
      super(...args);
      if (!/\/(?:websocket|desktop)-tunnel/.test(String(args[0]))) return;
      stats.sockets++;
      this.addEventListener('open', () => stats.socketOpens++);
      this.addEventListener('close', () => stats.socketCloses++);
      const audio = new Set();
      const parser = new Guacamole.Parser();
      parser.oninstruction = (opcode, params) => {
        if (['', 'required', 'sync', 'size', 'error', 'disconnect'].includes(opcode)) stats.instructions[opcode || 'internal'] = (stats.instructions[opcode || 'internal'] || 0) + 1;
        if (opcode === '' && params[0] === 'ping' && Number.isFinite(Number(params[1]))) {
          const elapsed = Date.now() - Number(params[1]);
          if (elapsed >= 0) {
            roundTrips.push(elapsed); if (roundTrips.length > 120) roundTrips.shift();
            const sorted = [...roundTrips].sort((a, b) => a - b);
            stats.transportRoundTripSamples = sorted.length;
            stats.transportRoundTripP50Ms = sorted[Math.floor((sorted.length - 1) * .5)];
            stats.transportRoundTripP95Ms = sorted[Math.ceil((sorted.length - 1) * .95)];
          }
        }
        if (opcode === 'audio') { audio.add(params[0]); stats.audioStreams++; stats.audioFormat = params[1]; }
        if (opcode === 'blob' && audio.has(params[0])) {
          const bytes = atob(params[1]);
          stats.audioBytes += bytes.length;
          for (let i = 0; i < bytes.length; i++) if (bytes.charCodeAt(i)) stats.nonzeroAudioBytes++;
        }
        if (opcode === 'end') audio.delete(params[0]);
      };
      this.addEventListener('message', event => {
        if (typeof event.data === 'string') {
          try { parser.receive(event.data); } catch (_) { stats.parserError = true; }
        }
      });
    }
  }
  window.WebSocket = ObservedSocket;
  const NativeAudio = window.AudioContext || window.webkitAudioContext;
  if (NativeAudio) {
    class ObservedAudio extends NativeAudio {
      constructor(...args) {
        super(...args);
        const update = () => {
          stats.audioContextState = this.state;
          stats.audioContextSampleRate = this.sampleRate;
          stats.baseLatencyMs = typeof this.baseLatency === 'number' ? this.baseLatency * 1000 : null;
          stats.outputLatencyMs = typeof this.outputLatency === 'number' ? this.outputLatency * 1000 : null;
        };
        this.addEventListener('statechange', update);
        update();
      }
      createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        source.start = (...args) => {
          stats.audioBuffersStarted++;
          stats.lastScheduledAheadMs = Math.max(0, ((args[0] || this.currentTime) - this.currentTime) * 1000);
          return start(...args);
        };
        return source;
      }
    }
    window.AudioContext = ObservedAudio;
    if (window.webkitAudioContext) window.webkitAudioContext = ObservedAudio;
  }
  setInterval(refresh, 1000);
})();
