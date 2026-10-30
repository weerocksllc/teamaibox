// Content-free Guacamole handshake probe. Does not send guest keyboard/mouse
// input or credentials. The caller supplies a temporary owned desktop ticket.
import { WebSocket } from '../apps/platform-api/node_modules/ws/wrapper.mjs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
const ws = new WebSocket(config.url, 'guacamole', { ca: config.ca,
  headers: { Cookie: config.cookie, Origin: config.origin }, handshakeTimeout: 10000 });
let buffer = ''; const opcodes = {}, metrics = { messages: 0, bytes: 0, binary: 0 };
const timer = setTimeout(() => ws.close(), 15000);
ws.on('message', (data, binary) => {
  metrics.messages++; metrics.bytes += data.length; if (binary) metrics.binary++;
  buffer += data.toString(); let offset = 0, values = [];
  while (offset < buffer.length) {
    const dot = buffer.indexOf('.', offset); if (dot < 0) break;
    const length = Number(buffer.slice(offset, dot));
    if (!Number.isSafeInteger(length) || dot + 1 + length >= buffer.length) break;
    values.push(buffer.slice(dot + 1, dot + 1 + length)); offset = dot + 2 + length;
    if (buffer[offset - 1] === ';') {
      const op = values[0];
      if (['', 'sync', 'mouse', 'cursor', 'required', 'error', 'disconnect', 'size', 'name'].includes(op)) opcodes[op || 'internal'] = (opcodes[op || 'internal'] || 0) + 1;
      if (op === 'sync') ws.send('4.sync,' + values[1].length + '.' + values[1] + ';');
      values = []; buffer = buffer.slice(offset); offset = 0;
    }
  }
});
ws.on('error', () => { metrics.transportError = true; });
ws.on('close', () => { clearTimeout(timer); console.log(JSON.stringify({ metrics, opcodes })); });
