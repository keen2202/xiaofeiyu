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

const aid = 117565317715732;
const expectedRpid = '323659699648';
const expectedText = '这个合集太全了，看完很有共鸣，感谢整理！';
const url = new URL('https://api.bilibili.com/x/v2/reply');
url.searchParams.set('type', '1');
url.searchParams.set('oid', String(aid));
url.searchParams.set('sort', '2');
url.searchParams.set('pn', '1');
url.searchParams.set('ps', '30');

const res = await fetch(url, { headers });
const json = await res.json();
console.log('http', res.status, 'code', json.code, json.message || '');
const replies = json?.data?.replies || [];
console.log('fetched replies:', replies.length);
const found = replies.find((item) => String(item.rpid) === expectedRpid);
if (!found) {
  console.log('MATCH_NOT_FOUND_IN_FIRST_PAGE');
  process.exit(2);
}
const content = found.content?.message ?? '';
console.log(JSON.stringify({
  rpid: String(found.rpid),
  oid: String(found.oid),
  mid: String(found.mid),
  uname: found.member?.uname ?? null,
  ctime: found.ctime,
  like: found.like,
  rcount: found.rcount,
  content,
  textMatches: content === expectedText,
  state: found.state,
  url: `https://www.bilibili.com/video/BV1mv4Y6rESW#reply${found.rpid}`
}, null, 2));
