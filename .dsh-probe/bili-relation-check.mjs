import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const file = path.join(process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'dsh-bili-unified') : path.join(os.homedir(), '.dsh', 'dsh-bili-unified'), 'credentials.json');
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
const cookie = [`SESSDATA=${c.sessdata}`, c.bili_jct ? `bili_jct=${c.bili_jct}` : null, c.buvid3 ? `buvid3=${c.buvid3}` : null, c.dedeuserid ? `DedeUserID=${c.dedeuserid}` : null].filter(Boolean).join('; ');
const res = await fetch('https://api.bilibili.com/x/relation?fid=508187015', { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', cookie }, signal: AbortSignal.timeout(8000) });
const body = await res.json().catch(() => ({}));
console.log(JSON.stringify({ http: res.status, code: body.code, message: body.message, attribute: body.data?.attribute ?? null, attributeMeaning: (() => { const a = body.data?.attribute; if (a === 6) return 'mutual'; if (a === 1) return 'following_only'; if (a === 2) return 'followed_by_only'; if (a === 0) return 'none'; return 'unknown'; })() }));
