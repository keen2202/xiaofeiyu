import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarness, bindMockAccount, makeMockAdapter, mockCandidate } from './helpers/harness.js';
import { CommandService } from '../src/command-service.js';
import { ProductionModule } from '../src/modules/production.js';
import { PublisherModule } from '../src/modules/publisher.js';
import { CommentsModule } from '../src/modules/comments.js';
import { BrowseModule } from '../src/modules/browse.js';
import { Coordinator } from '../src/coordinator.js';
import { FakeExecutionBackend } from './helpers/fake-execution-backend.js';
import { LOCAL_SLIDESHOW_PROFILE } from '../src/production/profiles/local-slideshow.js';
import { createHttpHandler, createRuntime } from '../src/index.js';
import { DshImChannelAdapter, ImBridge } from '../src/adapters/channels/dsh-im.js';
import { makeMockImHost } from './helpers/mock-channel.js';

const envelope = (action, input = {}, mode = 'go', requestId = `${action}-1`) => ({ schemaVersion: 1, requestId, action, input, mode });

async function setup(extra = {}) {
  const h = await createHarness({ overrides: { dryRun: false, security: { allowLocalProducer: true },
    production: { enabled: true, dryRun: false }, publishing: { enabled: true, dryRun: false },
    browse: { enabled: true, minScore: 0, minSubtitleChars: 1 },
    comments: { enabled: true, allowTemplate: true }, ...extra } });
  await bindMockAccount(h);
  const backend = new FakeExecutionBackend();
  const production = new ProductionModule({ ...h, backend, profileLoader: async () => ({ ...structuredClone(LOCAL_SLIDESHOW_PROFILE), bound: true, blocked: [], tools: {} }),
    preflight: async () => ({ ok: true }), mediaValidator: async () => ({ ok: true, media: { width: 320, height: 240, fps: 10, duration: 5, sizeBytes: 16 } }) });
  const publisher = new PublisherModule(h);
  const adapter = makeMockAdapter({ candidates: [mockCandidate()] });
  const comments = new CommentsModule({ ...h, adapter });
  const browse = new BrowseModule({ ...h, adapter });
  const services = { production, publisher, comments, browse };
  const command = new CommandService({ ...h, services });
  const http = createHttpHandler({ commandService: command, store: h.store });
  const post = (url, body) => http({ method: 'POST', url, body, trustedContext: { trusted: true, principal: h.owner }, trustedHumanContext: h.humanContext });
  const script = await h.importFile('script.txt', 'script', 'script');
  const visual = await h.importFile('image.png', 'image', 'image');
  const input = { inputs: [script, visual].map(({ artifactId }) => ({ artifactId })), output: { container: 'mp4', width: 320, height: 240, fps: 10, maxDurationSec: 5 } };
  return { h, backend, production, publisher, comments, browse, adapter, command, post, input };
}

test('HTTP production uses envelope dry and rejects conflicting nested go before creating a task', async () => {
  const { h, command, input, backend, post } = await setup();
  try {
    await assert.rejects(() => command.execute(envelope('production.create', { ...input, mode: 'go' }, 'dry'), h.owner, { trusted: true }), { code: 'CONFIG_INVALID' });
    const response = await post('/production', { requestId: 'dry', mode: 'dry', input });
    assert.equal(response.status, 200);
    assert.equal(response.body.executionMode, 'dry');
    const task = (await h.snapshot()).tasks[response.body.taskId];
    assert.equal(task.result.readyForPublish, false);
    assert.equal(backend.requests.length, 0);
  } finally { await h.cleanup(); }
});

test('HTTP approval runs the original production once; replay and reject never start another execution', async () => {
  const { h, backend, input, post } = await setup();
  try {
    const created = (await post('/production', { requestId: 'create', mode: 'go', input })).body;
    const body = { approvalId: created.approval.id, nonce: created.nonce, decision: 'approve', mode: 'go', requestId: 'approve' };
    const approved = await post('/approvals/decide', body);
    assert.equal(approved.status, 200, JSON.stringify(approved));
    assert.equal(approved.body.taskId, created.taskId);
    assert.equal(approved.body.status, 'succeeded');
    assert.equal(backend.requests.length, 1);
    await post('/approvals/decide', { ...body, requestId: 'approve-again' });
    assert.equal(backend.requests.length, 1);
    const rejected = (await post('/production', { requestId: 'reject-create', mode: 'go', input })).body;
    const result = await post('/approvals/decide', { approvalId: rejected.approval.id, nonce: rejected.nonce, decision: 'reject', mode: 'go', requestId: 'reject' });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'failed');
    assert.equal(backend.requests.length, 1);
  } finally { await h.cleanup(); }
});

test('dry approval does not consume permission, and concurrent approval continuations execute once', async () => {
  const { h, command, input, backend } = await setup();
  try {
    const created = await command.execute(envelope('production.create', input), h.owner, { trusted: true });
    const decision = { approvalId: created.approval.id, nonce: created.nonce, decision: 'approve', mode: 'dry' };
    assert.equal((await command.decideAndContinue(decision, h.humanContext)).dryRun, true);
    assert.equal((await h.snapshot()).approvals[created.approval.id].decidedAt, null);
    await Promise.all([command.decideAndContinue({ ...decision, mode: 'go' }, h.humanContext), command.decideAndContinue({ ...decision, mode: 'go' }, h.humanContext)]);
    assert.equal(backend.requests.length, 1);
  } finally { await h.cleanup(); }
});

test('independent store transactions serialize while truly nested transactions fail', async () => {
  const h = await createHarness();
  try {
    await Promise.all(Array.from({ length: 5 }, () => h.store.transaction(async draft => {
      await new Promise(resolve => setTimeout(resolve, 5));
      draft.cursors.concurrent = (draft.cursors.concurrent || 0) + 1;
    })));
    assert.equal((await h.snapshot()).cursors.concurrent, 5);
    await assert.rejects(() => h.store.transaction(() => h.store.transaction(() => {})), /nested store transaction/);
  } finally { await h.cleanup(); }
});

test('HTTP approval sends a comment and prepares a manual publish without claiming publication', async () => {
  const { h, comments, adapter, publisher, post } = await setup();
  try {
    const comment = await comments.createDraft({ candidate: mockCandidate(), text: 'specific comment', principal: h.owner });
    const sent = await post('/comments/approve', { approvalId: comment.approval.id, nonce: comment.nonce, decision: 'approve', mode: 'go', requestId: 'comment-approval' });
    assert.equal(sent.status, 200, JSON.stringify(sent));
    assert.equal(adapter.calls.writeComment.length, 1);
    const video = await h.importFile('video.mp4', 'video', 'video');
    const draft = await publisher.create({ requestId: 'publish', mode: 'go', videoArtifactId: video.artifactId, accountRef: { platform: 'bilibili', accountId: '1001' }, metadata: { title: 'title', description: '', tags: ['test'], platformData: { tid: 1 } } }, h.owner);
    const prepared = await post('/approvals/decide', { approvalId: draft.approval.id, nonce: draft.nonce, decision: 'approve', mode: 'go', requestId: 'publish-approval' });
    assert.equal(prepared.status, 200, JSON.stringify(prepared));
    assert.equal(prepared.body.status, 'awaiting_manual');
    assert.equal((await h.snapshot()).tasks[draft.task.id].isSettled, false);
  } finally { await h.cleanup(); }
});

test('task and request association survives a crash immediately after task commit without replaying work', async () => {
  const { h, command } = await setup();
  try {
    let crashed = false;
    h.store.hooks.afterCommit = ({ state }) => {
      if (!crashed && Object.keys(state.tasks).length) { crashed = true; throw new Error('simulated crash after task commit'); }
    };
    await assert.rejects(() => command.execute(envelope('browse.run'), h.owner, { trusted: true }), /simulated crash/);
    h.store.hooks.afterCommit = null;
    const state = await h.snapshot();
    const record = Object.values(state.requests)[0];
    assert.ok(state.tasks[record.taskId]);
    const replay = await command.execute(envelope('browse.run'), h.owner, { trusted: true });
    assert.equal(replay.taskId, record.taskId);
    assert.equal(replay.deduplicated, true);
    assert.equal(Object.keys((await h.snapshot()).tasks).length, 1);
  } finally { await h.cleanup(); }
});

test('dead command owners become explicit unknown and interrupted approvals never auto-execute', async () => {
  const { h, command, input, backend } = await setup();
  try {
    const created = await command.execute(envelope('production.create', input), h.owner, { trusted: true });
    await h.approvalService.decide({ approvalId: created.approval.id, nonce: created.nonce, decision: 'approve', mode: 'go' }, h.humanContext);
    await h.store.transaction(async draft => {
      draft.requests.orphan = { status: 'pending', ownerPid: 2147483647 };
      draft.approvals[created.approval.id].continuation = { status: 'dispatching', ownerPid: 2147483647 };
    });
    await command.recoverInterruptedRequests();
    const state = await h.snapshot();
    assert.equal(state.requests.orphan.error.code, 'OPERATION_UNKNOWN');
    assert.equal(state.tasks[created.taskId].status, 'interrupted');
    assert.equal(backend.requests.length, 0);
  } finally { await h.cleanup(); }
});

test('IM task commit atomically records request, inbox and outbox; pump sends once and respects group suppression', async () => {
  const { h, command, input } = await setup({ im: { enabled: true, notifications: { enabled: true, minGapMs: 1000, perMinute: 20 }, groupReplies: 'none' } });
  let bridge;
  try {
    const binding = await h.store.transaction(async (draft, tx) => h.identity.bindIm(tx, { adapterId: 'dsh-im', botAccountId: 'bot', senderRef: 'sender', conversationIds: ['conversation'], principalId: h.owner.id, scopes: ['production.create', 'task.read.own'] }));
    const host = makeMockImHost();
    bridge = new ImBridge({ ...h, commandService: command, channel: new DshImChannelAdapter({ host, config: h.configService.get(), now: h.now }) });
    const event = { adapterId: 'dsh-im', botAccountId: 'bot', senderRef: 'sender', conversationId: 'conversation', eventId: 'event', occurredAt: h.now().toISOString(), command: { action: 'production.create', input, mode: 'dry' } };
    let atomicObserved = false;
    h.store.hooks.beforeCommit = ({ state }) => {
      const task = Object.values(state.tasks)[0];
      if (task && !atomicObserved) {
        assert.equal(Object.values(state.requests)[0].taskId, task.id);
        assert.equal(Object.values(state.inboxKeys)[0].taskId, task.id);
        assert.ok(Object.values(state.outbox).some(n => n.taskId === task.id && n.bindingId === binding.bindingId));
        atomicObserved = true;
      }
    };
    await bridge.start();
    const result = await bridge.ingest(event, { trusted: true });
    assert.equal(atomicObserved, true);
    assert.ok(result.notificationId);
    await bridge.pump();
    await bridge.pump();
    assert.equal(host.calls.send.length, 1);
    await bridge.ingest({ ...event, eventId: 'group', group: true }, { trusted: true });
    h.now.advance(2000);
    await bridge.pump();
    assert.equal(host.calls.send.length, 1);
  } finally { await bridge?.stop(); await h.cleanup(); }
});

test('coordinator rejects overlapping rounds and dry manual browsing does not send auto comments', async () => {
  const { h, browse, comments, adapter } = await setup({ comments: { enabled: true, allowTemplate: true, mode: 'auto' } });
  const coordinator = new Coordinator({ ...h, browse, comments });
  try {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const discover = adapter.discover;
    adapter.discover = async (...args) => { await gate; return discover(...args); };
    const first = coordinator.runBrowse({ principal: h.owner, mode: 'dry' });
    await assert.rejects(() => coordinator.runBrowse({ principal: h.owner }), { code: 'DUPLICATE_OPERATION' });
    release();
    await first;
    assert.equal(adapter.calls.writeComment.length, 0);
    assert.equal(coordinator.executingKinds.size, 0);
    await coordinator.stop();
    await assert.rejects(() => coordinator.runBrowse({ principal: h.owner }), { code: 'DUPLICATE_OPERATION' });
  } finally { await h.cleanup(); }
});

test('capacity stops new effects and background generation but permits archival and in-flight settlement', async () => {
  const { h, comments, adapter, browse } = await setup({ comments: { enabled: true, allowTemplate: true, mode: 'auto' }, scheduler: { enabled: true } });
  const coordinator = new Coordinator({ ...h, browse, comments });
  try {
    const created = await comments.createDraft({ candidate: mockCandidate(), text: 'capacity test', principal: h.owner });
    const before = await h.store.capacityStatus();
    await fs.mkdir(path.join(h.dir, 'recovery'), { recursive: true });
    await fs.writeFile(path.join(h.dir, 'recovery', 'evidence.json'), 'evidence');
    assert.equal((await h.store.capacityStatus()).recoveryBytes, 8);
    h.store.capacityLimits = { warningBytes: before.totalBytes - 1, hardBytes: before.totalBytes * 10 };
    await coordinator.start();
    assert.equal((await coordinator.tick()).reason, 'capacity_warning');
    h.store.capacityLimits.hardBytes = 1;
    await assert.rejects(() => comments.send({ taskId: created.task.id, mode: 'go', principal: h.owner }), error => error.details?.reason === 'capacity_limit');
    assert.equal(adapter.calls.writeComment.length, 0);
    assert.ok((await h.journal.flush()).archived > 0);
    h.store.capacityLimits.hardBytes = 100 * 1024 * 1024;
    const write = adapter.writeComment;
    adapter.writeComment = async (...args) => { h.store.capacityLimits.hardBytes = 1; return write(...args); };
    const sent = await comments.send({ taskId: created.task.id, mode: 'go', principal: h.owner });
    assert.equal(sent.operation.status, 'confirmed');
  } finally { await coordinator.stop(); await h.cleanup(); }
});

test('runtime maintenance archives enabled idle service events and closes its timer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-maintenance-'));
  const runtime = await createRuntime({ dataDir: dir, env: {}, config: { diary: { enabled: true } } });
  try {
    await runtime.start();
    assert.ok(runtime.maintenance.timer);
    await runtime.store.transaction(async (_, tx) => tx.appendEvent({ type: 'maintenance.fixture', payload: {} }));
    await runtime.maintenance.tick();
    assert.equal(Object.keys((await runtime.store.getSnapshot()).journalPending).length, 0);
    assert.ok((await runtime.store.capacityStatus()).journalBytes > 0);
    await runtime.close();
    assert.equal(runtime.maintenance.timer, null);
  } finally { await runtime.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
