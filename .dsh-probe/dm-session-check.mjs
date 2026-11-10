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

const url = new URL('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions');
url.searchParams.set('session_type', '1');
url.searchParams.set('group_id', '0');
url.searchParams.set('count', '30');
url.searchParams.set('filter_anti_disturb', '0');
url.searchParams.set('sort_rule', '2');
url.searchParams.set('mobi_app', 'web');

const res = await fetch(url, {
  headers: {
    cookie,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    referer: 'https://www.bilibili.com/'
  }
});
const json = await res.json();
console.log('http', res.status, 'code', json.code, json.message || '');
const sessions = json?.data?.session_list || [];
console.log('sessions', sessions.length);
for (const s of sessions) {
  const last = s.last_msg || {};
  console.log(JSON.stringify({
    talker_id: s.talker_id,
    session_type: s.session_type,
    timestamp: last.timestamp,
    sender_uid: last.sender_uid,
    msg_type: last.msg_type,
    content: String(last.content || '').slice(0, 120)
  }));
}
const target = sessions.filter((s) => String(s.talker_id) === '508187015');
console.log('target_sessions', target.length);
if (target.length > 0) {
  const last = target[0].last_msg || {};
  console.log('target_last', JSON.stringify({
    timestamp: last.timestamp,
    sender_uid: last.sender_uid,
    msg_type: last.msg_type,
    content: String(last.content || '').slice(0, 200)
  }, null, 2));
}
