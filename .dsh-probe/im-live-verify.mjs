// 真实 OneBot v11 → 插件 ImBridge 联调验证（只读）。
// 启动真实 data dir 的运行时 + IM bridge，等待 owner 从 QQ 发结构化命令，
// 打印插件侧的 onEvent 响应、inboxKeys、outbox 与组件状态。不发送任何消息。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/index.js';

const dataDir = path.join(os.homedir(), '.dsh', 'dsh-bili-unified');
const tokenFile = 'D:\\Tools\\NapCat\\.onebot-token.txt';
process.env.ONEBOT_ACCESS_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();

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
console.log('WAITING for an inbound QQ command (up to 180s)...');
await new Promise((resolve) => setTimeout(resolve, 180000));
const snapshot = await runtime.store.getSnapshot();
const inbox = Object.values(snapshot.inboxKeys || {});
console.log('INBOX ' + JSON.stringify(inbox.slice(-5), null, 2));
console.log('OUTBOX ' + JSON.stringify(Object.values(snapshot.outbox || {}), null, 2));
console.log('RESPONSES ' + JSON.stringify(responses, null, 2));
await runtime.imBridge.stop();
try {
  await runtime.stop?.();
} catch {}
console.log('DONE');
process.exit(0);
