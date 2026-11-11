// Isolated audit reproductions. No real network, account, IM or media execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfigFile, DEFAULT_CONFIG } from '../../src/config.js';
import { BilibiliClient } from '../../src/bilibili.js';
import { BilibiliPlatformAdapter } from '../../src/adapters/platforms/bilibili.js';
import { createHarness, bindMockAccount, makeMockAdapter, mockCandidate, approvalDecide } from '../../test/helpers/harness.js';
import { CommentsModule } from '../../src/modules/comments.js';
import { Coordinator } from '../../src/coordinator.js';
import { setupBackup } from '../../test/helpers/backup.js';
import { NAV_WBI, responseJson, createMockFetch } from '../../test/helpers/mock-fetch.js';

const workspace = path.resolve(import.meta.dirname, '../..');
const root = await fs.mkdtemp(path.join(workspace, '.audit-probe-'));
const oldTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
Object.assign(process.env, { TEMP: root, TMP: root, TMPDIR: root });
const results = {};
try {
  const file = path.join(root, 'config.json');
  await fs.writeFile(file, JSON.stringify({ dryRun: false, browse: { perRound: 2 } }));
  const loaded = await loadConfigFile(file, { env: {}, injected: { dryRun: true, browse: { perRound: 7 } } });
  results.configPrecedence = { expected: { dryRun: true, perRound: 7 }, actual: { dryRun: loaded.dryRun, perRound: loaded.browse.perRound } };

  const backupFixture = await setupBackup({ policy: { failureDomain: 'same-physical-disk; NOT independent', verifiedBy: 'audit-test-owner' } });
  try {
    await backupFixture.backup.create({ kind: 'ledger', requestId: 'audit-same-disk' }, backupFixture.harness.humanContext);
    results.sameDiskProtection = await backupFixture.backup.getProtection();
    await backupFixture.backup.create({ kind: 'full', requestId: 'audit-full' }, backupFixture.harness.humanContext);
    backupFixture.harness.now.advance(25 * 60 * 60 * 1000);
    await backupFixture.backup.create({ kind: 'ledger', requestId: 'audit-next-day' }, backupFixture.harness.humanContext);
    results.staleFullCoverage = { fullAgeHours: 25, ...(await backupFixture.backup.getProtection()) };
  } finally { await backupFixture.cleanup(); }

  const harness = await createHarness();
  try {
    const fetchImpl = createMockFetch(({ url }) => {
      if (url.includes('/nav')) return responseJson(NAV_WBI);
      if (url.includes('/wbi/view')) return responseJson({ code: 0, data: { bvid: 'BV1xx411c7mD', aid: 1234, cid: 5678, owner: { mid: 2002 }, title: 'audit', duration: 60 } });
      if (url.includes('/popular')) return responseJson({ code: 0, data: { list: [{ bvid: 'BV1xx411c7mD', aid: 1234, cid: 5678 }] } });
      if (url.includes('/search/type')) return responseJson({ code: 0, data: { result: [] } });
      if (url.includes('/player/v2')) return responseJson({ code: 0, data: { subtitle: { subtitles: [] } } });
      throw new Error(`Unexpected mock URL: ${url}`);
    });
    const client = new BilibiliClient({ config: harness.configService.get(), store: harness.store, rateLimiter: harness.rateLimiter, now: harness.now, fetchImpl });
    const adapter = new BilibiliPlatformAdapter({ client, store: harness.store, configService: harness.configService, logger: { warn() {} }, now: harness.now });
    try {
      await adapter.discover({ sources: ['popular', 'search'], keywords: ['audit'] });
      results.multiSourceRead = { success: true };
    } catch (error) { results.multiSourceRead = { code: error.code, message: error.message }; }
    harness.now.advance(2000);
    const content = await adapter.readContent({ contentRef: { platform: 'bilibili', contentId: 'BV1xx411c7mD' } });
    results.detailThenSubtitle = { subtitle: content.subtitle, subtitleError: content.subtitleError };
    await harness.store.transaction(async draft => { harness.rateLimiter.recordRisk(draft, 'bilibili:unverified', { code: 412 }); });
    client.wbiCache = null;
    const before = fetchImpl.calls.length;
    try { await client.videoDetails('BV1xx411c7mD'); } catch (error) {
      results.coldWbiDuringCircuit = { code: error.code, networkCallsDespiteCircuit: fetchImpl.calls.slice(before).map(call => call.url) };
    }
    results.mockReadUrls = fetchImpl.calls.map(call => call.url.split('?')[0]);
  } finally { await harness.cleanup(); }

  const approvalHarness = await createHarness({ overrides: { dryRun: false, comments: { enabled: true } } });
  try {
    await bindMockAccount(approvalHarness);
    const adapter = makeMockAdapter();
    const comments = new CommentsModule({ ...approvalHarness, adapter });
    const draft = await comments.createDraft({ candidate: mockCandidate(), text: 'audit approval revocation', principal: approvalHarness.owner });
    await approvalDecide(approvalHarness, { approvalId: draft.approval.id, nonce: draft.nonce });
    await approvalHarness.store.transaction(async state => { state.principals[approvalHarness.owner.id].revokedAt = approvalHarness.now().toISOString(); });
    const sent = await comments.send({ taskId: draft.task.id, mode: 'go', principal: approvalHarness.owner });
    results.approvedThenRevoked = { mockWrites: adapter.calls.writeComment.length, operationStatus: sent.operation?.status };
  } finally { await approvalHarness.cleanup(); }

  const schedulerHarness = await createHarness();
  try {
    const coordinator = new Coordinator({ ...schedulerHarness });
    const principal = await coordinator._ownerPrincipal();
    results.schedulerPrincipal = { kind: principal.kind, sourceKind: principal.sourceKind, role: principal.role, scopes: principal.scopes };
  } finally { await schedulerHarness.cleanup(); }

  const spec = await fs.readFile(path.join(workspace, 'doc/SPEC.md'), 'utf8');
  const specDefault = JSON.parse(spec.slice(spec.indexOf('### 4.3')).match(/```json\s*([\s\S]*?)```/)[1]);
  const example = JSON.parse(await fs.readFile(path.join(workspace, 'config.example.json'), 'utf8'));
  results.configSchemaDrift = {
    implementationExtraImKeys: Object.keys(DEFAULT_CONFIG.im).filter(key => !(key in specDefault.im)),
    exampleExtraImKeys: Object.keys(example.im).filter(key => !(key in specDefault.im))
  };
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const [key, value] of Object.entries(oldTemp)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (!root.startsWith(workspace + path.sep + '.audit-probe-')) throw new Error('Unexpected cleanup path');
  await fs.rm(root, { recursive: true, force: true });
}
