// Test scaffolding for the probe profile only: create a local IM binding in the
// temporary probe data dir so an inbound OneBot event can resolve a principal.
// NOT for the real data dir and NOT for user data.
import path from 'node:path';
import fs from 'node:fs';
import { createRuntime } from '../src/index.js';
import { makePrincipal } from '../src/identity.js';

const dataDir = process.argv[2] || path.join(process.cwd(), '.dsh-probe-home', 'dsh-bili-unified');
fs.mkdirSync(dataDir, { recursive: true });
const configFile = path.join(dataDir, 'config.json');
const config = {
  im: {
    enabled: true,
    adapterId: 'dsh-im',
    transport: 'onebot-v11',
    maxMessageAgeSec: 600,
    approvalTtlSec: 600,
    groupReplies: 'none',
    notifications: { enabled: true, minGapMs: 1000, perMinute: 10 },
    onebot: {
      baseUrl: 'http://127.0.0.1:13000',
      websocketUrl: 'ws://127.0.0.1:13001',
      accessTokenEnv: 'ONEBOT_ACCESS_TOKEN',
      timeoutMs: 10000,
      reconnectMs: 5000
    }
  }
};
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log('probe config written:', configFile);

const runtime = await createRuntime({
  dataDir,
  env: {},
  humanVerifier: { async verify() { return true; } },
  fetchImpl: async () => { throw new Error('network disabled during probe setup'); },
  logger: { warn() {}, info() {} }
});
try {
  const binding = await runtime.store.transaction(async (draft, tx) => {
    const existing = Object.values(draft.bindings || {}).find(
      (item) => !item.revokedAt && item.adapterId === 'dsh-im' && item.senderRef === '20002'
    );
    if (existing) return existing;
    const principal = makePrincipal({
      id: 'im_owner_probe',
      kind: 'human',
      role: 'user',
      sourceKind: 'host_human_challenge',
      scopes: [],
      workspaceId: draft.workspaceId
    });
    draft.principals[principal.id] = principal;
    return runtime.identity.bindIm(tx, {
      adapterId: 'dsh-im',
      botAccountId: '123456789',
      senderRef: '20002',
      conversationIds: ['private:20002'],
      principalId: principal.id,
      scopes: ['task.read.own', 'task.cancel.own', 'production.create']
    });
  });
  console.log('probe binding:', JSON.stringify(binding));
} finally {
  await runtime.close();
}
