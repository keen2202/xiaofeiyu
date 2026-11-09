// Local OneBot v11 HTTP stub for the read-only `im probe` smoke test.
// This is NOT a QQ bridge: it only proves URL/action/auth/response mapping.
import http from 'node:http';

const PORT = Number(process.argv[2] || 13000);
const TOKEN = process.argv[3] || '';
const handlers = {
  get_status: () => ({ online: true, good: true }),
  get_login_info: () => ({ user_id: 123456789, nickname: 'stub-bot' }),
  send_private_msg: (body) => ({ message_id: 900001, echo: body.user_id })
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const action = url.pathname.replace(/^\/+/, '');
  if (TOKEN && url.searchParams.get('access_token') !== TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed', retcode: 401 }));
    return;
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const data = handlers[action] ? handlers[action](body) : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data === null
      ? { status: 'failed', retcode: 404, message: 'unsupported action' }
      : { status: 'ok', retcode: 0, data }));
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`onebot stub on http://127.0.0.1:${PORT}`));
