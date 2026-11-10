// Long-lived IM bridge daemon for interactive acceptance: keeps the OneBot
// bridge connected and processes any inbound QQ command until killed.
// Logs each onEvent response; never sends anything except plugin outbox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/index.js';

const dataDir = path.join(os.homedir(), '.dsh', 'dsh-bili-unified');
process.env.ONEBOT_ACCESS_TOKEN = fs.readFileSync('D:\\Tools\\NapCat\\.onebot-token.txt', 'utf8').trim();
const logger = { debug() {}, info() {}, warn(...args) { console.error('[warn]', ...args); } };
const runtime = await createRuntime({ dataDir, configFile: null, logger });

// Persist the one-time approval nonce for the local TTY decision (not printed).
const approvalFile = path.join(process.cwd(), '.dsh-probe', 'last-approval.json');const started = await runtime.imBridge.start(async (response, event) => {
  if (response.approval?.id && response.nonce) {
    try { fs.writeFileSync(approvalFile, JSON.stringify({ taskId: response.taskId ?? null, approvalId: response.approval.id, nonce: response.nonce, expiresAt: response.expiresAt ?? null, capturedAt: new Date().toISOString() }, null, 2) + '\n'); } catch {}
  }
  console.log('RESPONSE ' + JSON.stringify({
    at: new Date().toISOString(),
    eventId: event.eventId,
    senderRef: event.senderRef,
    conversationId: event.conversationId,
    command: event.command,
    accepted: response.accepted,
    taskId: response.taskId ?? null,
    status: response.status ?? null,
    notificationId: response.notificationId ?? null,
    protectionError: response.protectionError ?? null,
    error: response.error ?? null
  }));
});
console.log('DAEMON_START ' + JSON.stringify({ started: Boolean(started?.started), capabilities: runtime.imAdapter?.capabilities || null }));
const interval = setInterval(async () => {
  try {
    const snapshot = await runtime.store.getSnapshot();
    const pending = Object.values(snapshot.outbox || {}).filter((n) => n.status === 'pending').length;
    if (pending > 0) console.log('PENDING_OUTBOX ' + pending + ' at ' + new Date().toISOString());
  } catch {}
}, 15000);
const shutdown = async () => {
  clearInterval(interval);
  await runtime.imBridge.stop().catch(() => {});
  console.log('DAEMON_STOP');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 60000);
