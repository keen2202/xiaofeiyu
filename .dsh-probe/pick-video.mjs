import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.homedir(), '.dsh', 'dsh-bili-unified');
const creds = JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials.json'), 'utf8'));
const cookie = [
  `SESSDATA=${creds.sessdata}`,
  creds.bili_jct ? `bili_jct=${creds.bili_jct}` : null,
  creds.buvid3 ? `buvid3=${creds.buvid3}` : null,
  creds.dedeuserid ? `DedeUserID=${creds.dedeuserid}` : null
].filter(Boolean).join('; ');
const headers = {
  cookie,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  referer: 'https://www.bilibili.com/'
};
const res = await fetch('https://api.bilibili.com/x/web-interface/popular?ps=5&pn=1', { headers });
const json = await res.json();
console.log('code', json.code, json.message || '');
for (const item of json?.data?.list || []) {
  console.log(JSON.stringify({ bvid: item.bvid, aid: item.aid, title: String(item.title || '').slice(0, 40), ownerMid: item.owner?.mid, author: item.owner?.name }));
}
