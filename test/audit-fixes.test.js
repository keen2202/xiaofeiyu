import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHarness, bindMockAccount, makeMockAdapter, mockCandidate, approvalDecide } from './helpers/harness.js';
import { CommentsModule } from '../src/modules/comments.js';
import { BrowseModule } from '../src/modules/browse.js';
import { setupBackup } from './helpers/backup.js';
import { ConfigService, loadConfigFile } from '../src/config.js';
import { BilibiliClient } from '../src/bilibili.js';
import { BilibiliPlatformAdapter } from '../src/adapters/platforms/bilibili.js';
import { Coordinator } from '../src/coordinator.js';
import { NAV_WBI, createMockFetch, responseJson } from './helpers/mock-fetch.js';
import { migrationCapabilityChecks } from '../src/migration-capabilities.js';
import { computeConfigHash } from '../src/config.js';

async function approvedComment(harness) {
  await bindMockAccount(harness);
  const adapter = makeMockAdapter();
  const comments = new CommentsModule({ ...harness, adapter });
  const draft = await comments.createDraft({ candidate: mockCandidate(), text: 'authority regression', principal: harness.owner });
  await approvalDecide(harness, { approvalId: draft.approval.id, nonce: draft.nonce });
  return { comments, adapter, draft };
}

test('audit: revocation after approval blocks a new reservation without a platform call', async () => {
  const h = await createHarness({ overrides: { dryRun: false, comments: { enabled: true } } });
  try {
    const { comments, adapter, draft } = await approvedComment(h);
    await h.store.transaction(async state => { state.principals[h.owner.id].revokedAt = h.now().toISOString(); });
    await assert.rejects(comments.send({ taskId: draft.task.id, mode: 'go', principal: h.owner }), { code: 'FORBIDDEN' });
    assert.equal(adapter.calls.writeComment.length, 0);
  } finally { await h.cleanup(); }
});

test('audit: scope removal after reservation blocks dispatch and retains the reservation', async () => {
  const h = await createHarness({ overrides: { dryRun: false, comments: { enabled: true } } });
  try {
    const { draft } = await approvedComment(h);
    const { operation } = await h.effectGateway.reserveOperation({
      namespace: 'platform', action: 'comment', accountRef: draft.task.accountRef,
      businessKey: 'audit-reserved', inputHash: draft.task.inputHash, taskIds: [draft.task.id],
      approvalId: draft.approval.id, approvalAction: 'comment.send'
    });
    await h.store.transaction(async state => { state.principals[h.owner.id].scopes = []; });
    let writes = 0;
    await assert.rejects(h.effectGateway.dispatchOperation(operation.id, async () => { writes++; }), { code: 'FORBIDDEN' });
    assert.equal(writes, 0);
    assert.equal((await h.snapshot()).operations[operation.id].status, 'reserved');
  } finally { await h.cleanup(); }
});

test('audit: revoking an IM binding invalidates its existing approved task', async () => {
  const h = await createHarness({ overrides: { dryRun: false, comments: { enabled: true } } });
  try {
    const { comments, adapter, draft } = await approvedComment(h);
    await h.store.transaction(async (state, tx) => {
      const binding = h.identity.bindIm(tx, { adapterId: 'dsh-im', botAccountId: 'bot', senderRef: 'sender',
        conversationIds: ['private:sender'], principalId: h.owner.id, scopes: ['comment.draft'] });
      state.tasks[draft.task.id].authorizationBindingId = binding.bindingId;
      state.tasks[draft.task.id].notificationTarget = { bindingId: binding.bindingId, conversationId: 'private:sender' };
      h.identity.revokeIm(tx, binding.bindingId);
    });
    await assert.rejects(comments.send({ taskId: draft.task.id, mode: 'go', principal: h.owner }), { code: 'FORBIDDEN' });
    assert.equal(adapter.calls.writeComment.length, 0);
    await h.store.transaction(async state => { delete state.tasks[draft.task.id].authorizationBindingId; });
    await assert.rejects(comments.send({ taskId: draft.task.id, mode: 'go', principal: h.owner }), { code: 'FORBIDDEN' });
    assert.equal(adapter.calls.writeComment.length, 0);
  } finally { await h.cleanup(); }
});

test('audit: same/unknown failure domain allows backup but cannot protect dispatch; policy changes invalidate protection', async () => {
  const b = await setupBackup({ harnessOptions: { overrides: { dryRun: false, comments: { enabled: true } } },
    policy: { failureDomainVerification: null, failureDomain: 'same disk NOT independent' } });
  try {
    b.harness.effectGateway.protection = b.backup;
    const { comments, adapter, draft } = await approvedComment(b.harness);
    await b.backup.create({ kind: 'ledger', requestId: 'unverified' }, b.harness.humanContext);
    assert.equal((await b.backup.getProtection()).status, 'unprotected');
    await assert.rejects(comments.send({ taskId: draft.task.id, mode: 'go', principal: b.harness.owner }), { code: 'BACKUP_UNPROTECTED' });
    assert.equal(adapter.calls.writeComment.length, 0);
    const verified = { ...b.policy, failureDomainVerification: { independent: true, sourceRoot: b.harness.dir,
      destinationRoot: b.destinationRoot, verifiedBy: 'test-owner', verifiedAt: b.harness.now().toISOString() } };
    await b.policyService.save(verified);
    assert.equal((await b.backup.getProtection()).status, 'unprotected');
    await b.backup.create({ kind: 'ledger', requestId: 'verified' }, b.harness.humanContext);
    assert.equal((await b.backup.getProtection()).status, 'protected');
    const { operation } = await b.harness.effectGateway.reserveOperation({ namespace: 'platform', action: 'comment',
      businessKey: 'audit-backup-policy', inputHash: draft.task.inputHash, taskIds: [draft.task.id],
      accountRef: draft.task.accountRef, approvalId: draft.approval.id, approvalAction: 'comment.send' });
    await b.policyService.save({ ...verified, maxPointAgeMinutes: 21 });
    assert.equal((await b.backup.getProtection()).status, 'unprotected');
    let writes = 0;
    await assert.rejects(b.harness.effectGateway.dispatchOperation(operation.id, async () => { writes++; }), { code: 'BACKUP_UNPROTECTED' });
    assert.equal(writes, 0);
    await b.policyService.save({ ...verified, failureDomainVerification: { ...verified.failureDomainVerification, independent: false } });
    assert.equal((await b.backup.getProtection()).status, 'unprotected');
  } finally { await b.cleanup(); }
});

test('audit: fresh ledger does not hide a stale full recovery point', async () => {
  const b = await setupBackup();
  try {
    await b.backup.create({ kind: 'full', requestId: 'full' }, b.harness.humanContext);
    b.harness.now.advance(25 * 3600000);
    await b.backup.create({ kind: 'ledger', requestId: 'ledger' }, b.harness.humanContext);
    const result = await b.backup.getProtection();
    assert.equal(result.status, 'protected');
    assert.equal(result.mediaStatus, 'degraded');
    assert.equal(result.fullAgeMs, 25 * 3600000);
    assert.equal((await b.backup.status()).mediaUnprotectedReason, 'full_recovery_point_stale');
  } finally { await b.cleanup(); }
});

test('audit: host priorities survive file updates and restart', async () => {
  const h = await createHarness();
  try {
    const file = path.join(h.dir, 'priority.json');
    await fs.writeFile(file, JSON.stringify({ dryRun: false, browse: { perRound: 2 } }));
    const injected = { dryRun: true, browse: { perRound: 7 } };
    assert.equal((await loadConfigFile(file, { env: {}, injected })).dryRun, true);
    const service = new ConfigService({ dataDir: h.dir, file, env: {}, injected, store: h.store, now: h.now });
    await service.load();
    await service.update({ dryRun: false, browse: { perRound: 3 } }, { source: 'cli' });
    assert.equal(service.get().dryRun, true);
    assert.equal(service.get().browse.perRound, 7);
    const restarted = new ConfigService({ dataDir: h.dir, file, env: {}, injected, store: h.store, now: h.now });
    await restarted.load();
    assert.equal(restarted.get().dryRun, true);
    assert.equal(restarted.getRevision().sha256, service.getRevision().sha256);
  } finally { await h.cleanup(); }
});

test('audit: popular/search/detail/subtitle reads wait unlocked and a cold WBI cache respects circuit and auth pause', async () => {
  const h = await createHarness({ overrides: { browse: { enabled: true, sources: ['popular', 'search'], keywords: ['test'], minSubtitleChars: 1, minScore: 0 }, comments: { enabled: true } } });
  try {
    await bindMockAccount(h);
    const fetchImpl = createMockFetch(({ url }) => {
      if (url.includes('/nav')) return responseJson(NAV_WBI);
      if (url.includes('/popular')) return responseJson({ code: 0, data: { list: [{ bvid: 'BV1xx411c7mD', aid: 1 }] } });
      if (url.includes('/search/type')) return responseJson({ code: 0, data: { result: [] } });
      if (url.includes('/wbi/view')) return responseJson({ code: 0, data: { bvid: 'BV1xx411c7mD', aid: 1, cid: 2 } });
      if (url.includes('/player/v2')) return responseJson({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://i0.hdslb.com/subtitle.json' }] } } });
      if (url.includes('subtitle.json')) return responseJson({ body: [{ content: 'subtitle retrieved' }] });
      if (url.includes('/reply')) return responseJson({ code: 0, data: { replies: [] } });
      throw new Error('unexpected request');
    });
    const waits = [];
    const client = new BilibiliClient({ config: h.configService.get(), store: h.store, rateLimiter: h.rateLimiter,
      now: h.now, fetchImpl, sleep: async ms => {
        // A transaction succeeds during the wait: no global lock is retained.
        await h.store.transaction(async () => {});
        waits.push(ms); h.now.advance(ms);
      } });
    const adapter = new BilibiliPlatformAdapter({ client, store: h.store, configService: h.configService });
    const browse = new BrowseModule({ ...h, adapter });
    const task = await browse.createTask({ principal: h.owner });
    const result = await browse.run({ taskId: task.id, principal: h.owner });
    assert.equal(result.task.status, 'succeeded');
    assert.equal(result.task.result.selected.length, 1);
    assert.equal(fetchImpl.calls.length, 7);
    assert.equal(waits.length, 6);
    assert.equal((await h.snapshot()).rate['bilibili:1001'].read.dayCount, 7);
    await h.store.transaction(async state => h.rateLimiter.recordRisk(state, 'bilibili:1001', { code: 412 }));
    client.wbiCache = null;
    await assert.rejects(client.videoDetails('BV1xx411c7mD'), { code: 'RATE_LIMITED' });
    assert.equal(fetchImpl.calls.length, 7);
    await h.store.transaction(async state => { state.accounts['bilibili:1001'].authPausedAt = h.now().toISOString(); });
    await assert.rejects(client.videoDetails('BV1xx411c7mD'), { code: 'CREDENTIAL_MISSING' });
    assert.equal(fetchImpl.calls.length, 7);
  } finally { await h.cleanup(); }
});

test('audit: scheduler has a stable service identity without human/admin scopes', async () => {
  const h = await createHarness({ overrides: { browse: { enabled: true }, comments: { enabled: true } } });
  try {
    const coordinator = new Coordinator({ ...h });
    const principal = await coordinator._schedulerPrincipal();
    assert.equal(principal.kind, 'service');
    assert.equal(principal.sourceKind, 'scheduler');
    assert.deepEqual(principal.scopes, ['browse.run', 'comment.draft']);
    assert.equal((await coordinator._schedulerPrincipal()).id, principal.id);
    await assert.rejects(h.humanProof.assert({ principal, proof: { kind: 'test', ok: true } }, {}), { code: 'FORBIDDEN' });
    await h.store.transaction(async state => { state.principals[principal.id].revokedAt = h.now().toISOString(); });
    await assert.rejects(coordinator._schedulerPrincipal(), { code: 'FORBIDDEN' });
  } finally { await h.cleanup(); }
});

test('audit: revoking the deciding IM binding blocks a locally created approved task', async () => {
  const h = await createHarness({ overrides: { dryRun: false, comments: { enabled: true } } });
  try {
    await bindMockAccount(h);
    const adapter = makeMockAdapter();
    const comments = new CommentsModule({ ...h, adapter });
    const draft = await comments.createDraft({ candidate: mockCandidate(), text: 'binding revoke', principal: h.owner });
    const binding = await h.store.transaction(async (state, tx) => h.identity.bindIm(tx, {
      adapterId: 'dsh-im', botAccountId: 'bot', senderRef: 'sender', conversationIds: ['private:sender'],
      principalId: h.owner.id, scopes: ['approval.decide.own']
    }));
    await h.approvalService.decide({ approvalId: draft.approval.id, decision: 'approve', nonce: draft.nonce },
      { ...h.humanContext, principal: { ...h.owner, bindingId: binding.bindingId } });
    await h.store.transaction(async (state, tx) => h.identity.revokeIm(tx, binding.bindingId));
    await assert.rejects(comments.send({ taskId: draft.task.id, mode: 'go', principal: h.owner }), { code: 'FORBIDDEN' });
    assert.equal(adapter.calls.writeComment.length, 0);
  } finally { await h.cleanup(); }
});

test('audit: staged config recovery preserves host restrictions and does not persist them into the file layer', async () => {
  const h = await createHarness();
  try {
    const file = path.join(h.dir, 'reconcile.json');
    const candidate = { browse: { enabled: true, perRound: 2 }, dryRun: false };
    await fs.writeFile(`${file}.next`, JSON.stringify(candidate));
    const service = new ConfigService({ dataDir: h.dir, file, env: {}, injected: { dryRun: true, browse: { perRound: 7 } }, store: h.store, now: h.now });
    await h.store.transaction(async state => { state.configIntent = { phase: 'prepared', nextFile: `${file}.next`,
      nextVersion: state.configRevision.version + 1, fileSha256: computeConfigHash(candidate),
      nextSha256: computeConfigHash(service._effectiveConfig(candidate)) }; });
    await service.load();
    assert.equal(service.get().dryRun, true);
    assert.equal(service.get().browse.perRound, 7);
    assert.equal(service.get().browse.enabled, true);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), candidate);
    assert.equal((await h.snapshot()).configIntent, null);
  } finally { await h.cleanup(); }
});

test('audit: IM capability requires both a reverified binding and an available principal', async () => {
  const h = await createHarness({ overrides: { im: { enabled: true } } });
  try {
    await h.store.transaction(async (state, tx) => {
      h.identity.bindIm(tx, { adapterId: 'dsh-im', botAccountId: 'bot', senderRef: 'sender',
        conversationIds: ['conv'], principalId: h.owner.id, scopes: ['task.read.own'] });
      state.principals[h.owner.id].requiresReverification = true;
    });
    const checks = migrationCapabilityChecks({ configService: h.configService, channel: { async probe() { return { status: 'available' }; } } });
    const result = await checks({ state: await h.snapshot(), requestedCapabilities: ['im'] });
    assert.equal(result.capabilities.includes('im'), false);
    assert.equal(result.blocked[0].code, 'FORBIDDEN');
    await h.store.transaction(async state => { state.principals[h.owner.id].requiresReverification = false; });
    assert.equal((await checks({ state: await h.snapshot(), requestedCapabilities: ['im'] })).capabilities.includes('im'), true);
  } finally { await h.cleanup(); }
});

test('audit: runtime capability verification rejects unbound dependencies and mismatched accounts without grants', async () => {
  const h = await createHarness({ overrides: { publishing: { enabled: true } } });
  try {
    await bindMockAccount(h);
    let probes = 0;
    const checks = migrationCapabilityChecks({ configService: h.configService,
      credentials: { assertWriteAllowed() {} }, adapter: { async verifyAccount() { probes++; return { accountRef: { platform: 'bilibili', accountId: 'different' } }; } } });
    const state = await h.snapshot();
    assert.deepEqual((await checks({ state })).capabilities, ['core:read', 'core:write']);
    assert.equal(probes, 0);
    const result = await checks({ state, requestedCapabilities: ['platform:bilibili', 'publish:manual', 'production:local', 'publish:external', 'im'] });
    assert.deepEqual(result.capabilities, ['core:read', 'core:write']);
    assert.equal(result.blocked.length, 5);
    assert.equal(probes, 1);
  } finally { await h.cleanup(); }
});
