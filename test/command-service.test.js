import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeMockAdapter, mockCandidate, bindMockAccount } from './helpers/harness.js';
import { CommandService } from '../src/command-service.js';
import { BrowseModule } from '../src/modules/browse.js';
import { makePrincipal } from '../src/identity.js';

async function setup() {
  const harness = await createHarness({ overrides: { browse: { enabled: true } } });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter({ candidates: [mockCandidate()] });
  const browse = new BrowseModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: harness.configService,
    now: harness.now
  });
  const command = new CommandService({
    store: harness.store,
    taskManager: harness.taskManager,
    identity: harness.identity,
    configService: harness.configService,
    approvalService: harness.approvalService,
    effectGateway: harness.effectGateway,
    now: harness.now,
    services: { browse }
  });
  return { harness, adapter, browse, command };
}

function envelope(action, input, mode = 'go', requestId = 'r1') {
  return { schemaVersion: 1, requestId, action, input, mode };
}

test('same request key creates one task and replays the stored receipt', async () => {
  const { harness, command } = await setup();
  try {
    let runs = 0;
    const originalRun = harness.browse;
    const first = await command.execute(envelope('browse.run', {}, 'go'), harness.owner, { trusted: true });
    assert.equal(first.accepted, true);
    assert.ok(first.taskId);
    const second = await command.execute(envelope('browse.run', {}, 'go'), harness.owner, { trusted: true });
    assert.equal(second.deduplicated, true);
    assert.equal(second.taskId, first.taskId);
    const state = await harness.snapshot();
    const keys = Object.keys(state.requests);
    assert.equal(keys.length, 1);
    assert.equal(runs, 0);
  } finally {
    await harness.cleanup();
  }
});

test('same requestId with changed input is rejected without creating another task', async () => {
  const { harness, command } = await setup();
  try {
    await command.execute(envelope('browse.run', {}, 'go', 'same'), harness.owner, { trusted: true });
    const before = Object.keys((await harness.snapshot()).tasks).length;
    await assert.rejects(
      () => command.execute(envelope('browse.run', { extra: true }, 'go', 'same'), harness.owner, { trusted: true }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
    assert.equal(Object.keys((await harness.snapshot()).tasks).length, before);
  } finally {
    await harness.cleanup();
  }
});

test('read-only status does not grow the permanent request index', async () => {
  const { harness, command } = await setup();
  try {
    const before = Object.keys((await harness.snapshot()).requests).length;
    const result = await command.execute(envelope('status.get', {}, 'dry', 'read'), harness.owner, { trusted: true });
    assert.equal(result.accepted, true);
    assert.equal(Object.keys((await harness.snapshot()).requests).length, before);
  } finally {
    await harness.cleanup();
  }
});

test('agent without scope is denied and IM cannot call platform DM', async () => {
  const { harness, command } = await setup();
  try {
    const agent = await harness.store.transaction(async (draft, tx) =>
      harness.identity.create(tx, {
        kind: 'agent',
        role: 'assistant',
        sourceKind: 'agent',
        scopes: []
      })
    );
    await assert.rejects(
      () => command.execute(envelope('browse.run', {}, 'go', 'agent1'), agent, { trusted: true, sourceKind: 'http' }),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      () => command.execute(envelope('dm.send', { recipientMid: '1001', text: 'x' }, 'dry', 'im1'), harness.owner, {
        trusted: true,
        sourceKind: 'im'
      }),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

test('failed requests are replayed as failures, not silently re-executed', async () => {
  const { harness } = await setup();
  try {
    const command = new CommandService({
      store: harness.store,
      taskManager: harness.taskManager,
      identity: harness.identity,
      configService: harness.configService,
      approvalService: harness.approvalService,
      effectGateway: harness.effectGateway,
      now: harness.now,
      services: {
        browse: {
          async createTask() {
            throw Object.assign(new Error('boom'), { code: 'DEPENDENCY_UNAVAILABLE' });
          }
        }
      }
    });
    await assert.rejects(
      () => command.execute(envelope('browse.run', {}, 'go', 'fail1'), harness.owner, { trusted: true }),
      /boom/
    );
    await assert.rejects(
      () => command.execute(envelope('browse.run', {}, 'go', 'fail1'), harness.owner, { trusted: true }),
      (error) => error.code === 'DEPENDENCY_UNAVAILABLE' && error.details.replayed === true
    );
  } finally {
    await harness.cleanup();
  }
});

test('untrusted HTTP context is rejected', async () => {
  const { harness, command } = await setup();
  try {
    await assert.rejects(
      () => command.execute(envelope('status.get', {}, 'dry'), harness.owner, { trusted: false }),
      (error) => error.code === 'TRUST_UNAVAILABLE'
    );
  } finally {
    await harness.cleanup();
  }
});

test('task resume enforces ownership and the kind-specific write scope', async () => {
  const { harness, command } = await setup();
  try {
    const task = await harness.store.transaction(async (draft, tx) =>
      harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        accountRef: { platform: 'bilibili', accountId: '1001' },
        inputHash: 'jcs-sha256-v1:' + '7'.repeat(64)
      })
    );
    const agent = await harness.store.transaction(async (draft, tx) =>
      harness.identity.create(tx, {
        kind: 'agent',
        role: 'assistant',
        sourceKind: 'agent',
        scopes: ['task.resume.own', 'comment.draft']
      })
    );
    await assert.rejects(
      () => command.execute(
        envelope('task.resume', { taskId: task.id }, 'go', 'resume-other'),
        agent,
        { trusted: true }
      ),
      (error) => error.code === 'FORBIDDEN'
    );
    const scoped = await harness.store.transaction(async (draft, tx) =>
      harness.identity.create(tx, {
        kind: 'agent',
        role: 'assistant',
        sourceKind: 'agent',
        scopes: ['task.resume.own']
      })
    );
    const ownTask = await harness.store.transaction(async (draft, tx) =>
      harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: scoped.id,
        accountRef: { platform: 'bilibili', accountId: '1001' },
        inputHash: 'jcs-sha256-v1:' + '8'.repeat(64)
      })
    );
    await assert.rejects(
      () => command.execute(
        envelope('task.resume', { taskId: ownTask.id }, 'go', 'resume-no-scope'),
        scoped,
        { trusted: true }
      ),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});
