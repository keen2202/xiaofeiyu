// Local OneBot v11 stub (HTTP action API + forward WebSocket server) used by
// the read-only `im probe` smoke test and the real-DSH stub integration probe.
// This is NOT a QQ bridge: it only proves protocol wiring, auth, event
// normalization and outbound send request shape.
//
// Usage: node .dsh-probe/onebot-stub.mjs <httpPort> [token|-] [wsPort]
//   POST /<action>      OneBot actions: get_status / get_login_info / send_private_msg
//   POST /__emit        push one raw OneBot event to every connected WS client
//   GET  /__log         JSONL of received actions and events (same as log file)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 13000);
const TOKEN = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : '';
const WS_PORT = Number(process.argv[4] || (PORT + 1));
const LOG_FILE = path.join(HERE, 'onebot-stub.log');

const clients = new Set();
const logLines = [];

function log(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  logLines.push(line);
  try { fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8'); } catch { /* ignore */ }
}

function authOk(url) {
  if (!TOKEN) return true;
  return url.searchParams.get('access_token') === TOKEN;
}

const handlers = {
  get_status: () => ({ online: true, good: true }),
  get_login_info: () => ({ user_id: 123456789, nickname: 'stub-bot' }),
  send_private_msg: (body) => ({ message_id: 900001 + ((body.user_id || 0) % 1000), echo: body.user_id })
};

function response(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

// --- minimal RFC 6455 server side (unmasked server->client frames only; the
// client (our plugin) sends no data frames in this probe) ---
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x81, length]), payload]);
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function handleClientData(socket, buffer) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const opcode = first & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) return buffer.slice(offset);
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) return buffer.slice(offset);
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (cursor + maskLength + length > buffer.length) return buffer.slice(offset);
    if (opcode === 0x8) {
      try { socket.end(Buffer.from([0x88, 0x00])); } catch { /* ignore */ }
      return Buffer.alloc(0);
    }
    if (opcode === 0x9) {
      try { socket.write(Buffer.from([0x8a, 0x00])); } catch { /* ignore */ }
    }
    offset = cursor + maskLength + length;
  }
  return Buffer.alloc(0);
}

function attachWebSocket(socket) {
  clients.add(socket);
  log({ kind: 'ws-open', clients: clients.size });
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    pending = handleClientData(socket, pending);
  });
  socket.on('error', () => { clients.delete(socket); });
  socket.on('close', () => {
    clients.delete(socket);
    log({ kind: 'ws-close', clients: clients.size });
  });
}

function upgradeHandler(req, socket) {
  const url = new URL(req.url, `http://127.0.0.1:${WS_PORT}`);
  if (!authOk(url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));
  attachWebSocket(socket);
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (!authOk(url)) {
    response(res, 401, { status: 'failed', retcode: 401 });
    return;
  }
  const action = url.pathname.replace(/^\/+/, '');
  if (action === '__log') {
    response(res, 200, { lines: logLines });
    return;
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { response(res, 400, { status: 'failed', retcode: 400 }); return; }
    if (action === '__emit') {
      const frame = encodeFrame(JSON.stringify(body));
      let delivered = 0;
      for (const socket of clients) {
        try { socket.write(frame); delivered += 1; } catch { /* ignore */ }
      }
      log({ kind: 'emit', event: body, delivered });
      response(res, 200, { delivered });
      return;
    }
    const handler = handlers[action];
    log({ kind: 'action', action, body });
    if (!handler) {
      response(res, 200, { status: 'failed', retcode: 404, message: 'unsupported action' });
      return;
    }
    response(res, 200, { status: 'ok', retcode: 0, data: handler(body) });
  });
});

const wsServer = http.createServer((req, res) => {
  response(res, 404, { status: 'failed', retcode: 404 });
});
wsServer.on('upgrade', upgradeHandler);

httpServer.listen(PORT, '127.0.0.1', () => {
  wsServer.listen(WS_PORT, '127.0.0.1', () => {
    log({ kind: 'ready', http: PORT, ws: WS_PORT, token: Boolean(TOKEN) });
    console.log(`onebot stub ready http=http://127.0.0.1:${PORT} ws=ws://127.0.0.1:${WS_PORT} token=${TOKEN ? 'yes' : 'no'}`);
  });
});
