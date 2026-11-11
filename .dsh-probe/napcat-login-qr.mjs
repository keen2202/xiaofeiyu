// Fetch the NapCat QQ login QR code from its local WebUI and render it as a PNG.
// Output: .dsh-probe/napcat-login-qrcode.png (one-time login QR; do not commit).
// Never prints the WebUI token or the QR payload.
import fs from 'node:fs';
import crypto from 'node:crypto';

const base = 'http://127.0.0.1:6099';
const webui = JSON.parse(fs.readFileSync('D:/Tools/NapCat/config/webui.json', 'utf8'));
const hash = crypto.createHash('sha256').update(`${webui.token}.napcat`).digest('hex');

const loginRes = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash })
});
const login = await loginRes.json();
if (login.code !== 0) throw new Error(`WebUI login failed: ${login.code} ${login.message}`);
const headers = { authorization: `Bearer ${login.data.Credential}`, 'content-type': 'application/json' };

const call = async (path, body = {}) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const status = await call('/api/QQLogin/CheckLoginStatus');
if (status.json?.data?.isLogin) {
  console.log('ALREADY_LOGGED_IN uin=' + status.json.data.uin);
  process.exit(0);
}
const phase = status.json?.data?.loginPhase ?? 'unknown';
const qr = await call('/api/QQLogin/GetQQLoginQrcode');
const payload = qr.json?.data?.qrcode;
if (typeof payload !== 'string') throw new Error('NapCat did not return a QR payload');
const img = await fetch('https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=10&data=' + encodeURIComponent(payload));
const buf = Buffer.from(await img.arrayBuffer());
fs.writeFileSync('D:/Workespace/xiaofeiyu/.dsh-probe/napcat-login-qrcode.png', buf);
console.log(`QR_SAVED phase=${phase} png_bytes=${buf.length}`);
