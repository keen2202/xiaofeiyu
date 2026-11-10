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
const selfMid = String(creds.dedeuserid || '');

const eps = [
  'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=508187015&session_type=1&size=20',
  'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_session_msgs?talker_id=508187015&session_type=1&size=20'
];
for (const url of eps) {
  try {
    const res = await fetch(url, { headers });
    const json = await res.json();
    console.log('==', url.split('/v1/')[0].split('//')[1], 'http', res.status, 'code', json.code, json.message || '');
    const msgs = json?.data?.messages || json?.data?.session_msgs || [];
    console.log('messages', msgs.length);
    for (const m of msgs.slice(0, 12)) {
      console.log(JSON.stringify({
        ts: m.timestamp,
        iso: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
        sender: m.sender_uid,
        self: String(m.sender_uid) === selfMid,
        type: m.msg_type,
        content: String(m.content || '').slice(0, 140)
      }));
    }
  } catch (error) {
    console.log('==', url, 'ERROR', error.message);
  }
}
