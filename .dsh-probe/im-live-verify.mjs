// 真实 OneBot v11 → 插件 ImBridge 端到端验证（入站 + 出站通知）。
// 启动真实 data dir 的运行时 + IM bridge，等待 owner 从 QQ 发结构化命令，
// 记录插件 onEvent 响应，等待 outbox pump 发出真实回信，打印 inbox/outbox。
// 只发送由插件 outbox 产生的通知（一次摘要回信）；不发送其他消息。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/index.js';

const dataDir = path.join(os.homedir(), '.dsh', 'dsh-bili-unified');
const tokenFile = 'D:\\Tools\\NapCat\\.onebot-token.txt';
process.env.ONEBOT_ACCESS_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logger = { debug() {}, info() {}, warn(...args) { console.error('[warn]', ...args); } };
const runtime = await createRuntime({ dataDir, configFile: null, logger });
const responses = [];
const started = await runtime.imBridge.start(async (response, event) => {
  const line = {
    at: new Date().toISOString(),
    event: {
      eventId: event.eventId,
      senderRef: event.senderRef,
      conversationId: event.conversationId,
      command: event.command
    },
    response: {
      accepted: response.accepted,
      candidate: response.candidate ?? null,
      taskId: response.taskId ?? null,
      status: response.status ?? null,
      notificationId: response.notificationId ?? null,
      protectionError: response.protectionError ?? null,
      deduplicated: response.deduplicated ?? null,
      message: response.message ?? null
    }
  };
  responses.push(line);
  console.log('RESPONSE ' + JSON.stringify(line));
});
console.log('START ' + JSON.stringify({ started: Boolean(started?.started), capabilities: runtime.imAdapter?.capabilities || null }));
console.log('WAITING for one inbound QQ command (up to 300s)...');
const deadline = Date.now() + 300000;
while (responses.length === 0 && Date.now() < deadline) await sleep(500);
if (responses.length === 0) {
  console.log('TIMEOUT no inbound command');
} else {
  console.log('INBOUND received; waiting 12s for outbox dispatch...');
  await sleep(12000);
}
const snapshot = await runtime.store.getSnapshot();
const inbox = Object.values(snapshot.inboxKeys || {});
console.log('INBOX ' + JSON.stringify(inbox.slice(-3), null, 2));
const outbox = Object.values(snapshot.outbox || {});
console.log('OUTBOX ' + JSON.stringify(outbox, null, 2));
console.log('RESPONSES ' + JSON.stringify(responses, null, 2));
await runtime.imBridge.stop();
try {
  await runtime.stop?.();
} catch {}
console.log('DONE');
process.exit(0);
