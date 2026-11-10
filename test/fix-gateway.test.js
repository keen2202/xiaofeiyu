import test from 'node:test';
import assert from 'node:assert/strict';
import { EffectGateway } from '../src/effect-gateway.js';
import { BilibiliClient } from '../src/bilibili.js';
import { CredentialService, credentialRevision } from '../src/credentials.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { DEFAULT_CONFIG, validateConfig } from '../src/config.js';
import { createHarness, bindMockAccount } from './helpers/harness.js';
import { makeMockChannel } from './helpers/mock-channel.js';
import { makePrincipal } from '../src/identity.js';
import { createMockFetch, responseJson, NAV_WBI } from './helpers/mock-fetch.js';
import { makeMockPlatformAdapter, makeMockRemoteBackend } from './helpers/mock-platforms.js';
import { deepClone, nowIso } from '../src/utils.js';

const accountRef = { platform: 'bilibili', accountId: '1001' };

async function makeTask(harness, kind = 'comment') {
  return harness.store.transaction(async (draft, tx) => {
    const task = harness.taskManager.create(tx, {
      kind,
      principalId: harness.owner.id,
      accountRef,
      inputHash: 'jcs-sha256-v1:' + '2'.repeat(64)
    });
    harness.taskManager.transition(tx, task, 'running', { approved: true });
    return task;
  });
}

function reservation(harness, task, overrides = {}) {
  return {
    namespace: 'platform',
    action: 'comment',
    receiptAction: 'comment',
    recoveryAction: 'comment',
    accountRef,
    businessKey: `comment:${Math.random()}`,
    taskIds: [task.id],
    inputHash: task.inputHash,
    protected: true,
    ...overrides
  };
}

function receipt(action = 'comment', overrides = {}) {
  return {
    platform: 'bilibili',
    accountId: '1001',
    action,
    externalId: 'external-1',
    url: 'https://example.test/1',
    verification: 'platform_readback',
    receivedAt: nowIso(),
    ...overrides
  };
}

function makeGateway(harness, { credentials = null, services = {} } = {}) {
  return new EffectGateway({
    store: harness.store,
    taskManager: harness.taskManager,
    approvalService: harness.approvalService,
    identity: harness.identity,
    humanProof: harness.humanProof,
    rateLimiter: harness.rateLimiter,
    configService: harness.configService,
    credentials,
    services,
    protection: harness.protectionProvider,
    now: harness.now
  });
}

async function credentialServiceFor(harness, credentials = { sessdata: 'SESS', bili_jct: 'JCT' }) {
  const service = new CredentialService({ store: harness.store, env: {}, file: null, now: harness.now });
  service.credentials = { sessdata: '', bili_jct: '', buvid3: '', dedeuserid: '', ...credentials };
  service.verifier = async () => ({ mid: 1001, uname: 'tester', isLogin: true });
  await service.verifyAndBind({ principal: harness.owner, ownerMid: 0 });
  return service;
}

async function notificationSetup() {
  const harness = await createHarness({
    overrides: {
      im: {
        enabled: true,
        adapterId: 'dsh-im',
        maxMessageAgeSec: 600,
        approvalTtlSec: 600,
        groupReplies: 'summary',
        notifications: { enabled: true, minGapMs: 1000, perMinute: 2 }
      }
    }
  });
  await bindMockAccount(harness);
  const binding = await harness.store.transaction(async (draft, tx) => {
    const principal = makePrincipal({
      id: 'im_user',
      kind: 'human',
      role: 'user',
      sourceKind: 'host_human_challenge',
      scopes: [],
      workspaceId: draft.workspaceId
    });
    draft.principals[principal.id] = principal;
    return harness.identity.bindIm(tx, {
      adapterId: 'dsh-im',
      botAccountId: 'bot1',
      senderRef: 'sender1',
      conversationIds: ['conv1'],
      principalId: principal.id,
      scopes: ['task.read.own']
    });
  });
  await harness.effectGateway.assertNotificationProtection(binding, 'conv1');
  const notification = await harness.store.transaction(async (draft, tx) =>
    harness.effectGateway.appendNotification(tx, {
      bindingId: binding.bindingId,
      conversationId: 'conv1',
      summary: 'reply'
    })
  );
  return { harness, binding, notification };
}

/* --------------------------- G-P1-1 risk control --------------------------- */

test('HTTP 412 HTML opens the persisted circuit and blocks the next read locally', async () => {
  const harness = await createHarness();
  try {
    await bindMockAccount(harness);
    const fetchImpl = createMockFetch(() =>
      responseJson('<html>risk control</html>', { status: 412, headers: { 'retry-after': '120' } })
    );
    const client = new BilibiliClient({
      config: harness.config,
      credentials: { sessdata: 'SESS', bili_jct: 'JCT' },
      fetchImpl,
      now: harness.now,
      store: harness.store,
      rateLimiter: harness.rateLimiter
    });
    await assert.rejects(
      () => client.whoami(),
      (error) => error.code === 'BILI_API_ERROR' && error.retryable === false
    );
    assert.equal(fetchImpl.calls.length, 1);
    const state = await harness.snapshot();
    const circuit = state.rate['bilibili:1001'].circuit;
    assert.ok(circuit.openUntil);
    assert.equal(circuit.lastCode, 412);
    assert.ok(state.events.some((event) => event.type === 'bilibili.circuit.opened'));
    const callsBefore = fetchImpl.calls.length;
    await assert.rejects(() => client.whoami(), (error) => error.code === 'RATE_LIMITED');
    assert.equal(fetchImpl.calls.length, callsBefore);
  } finally {
    await harness.cleanup();
  }
});

/* --------------------------- G-P1-2 auth pause --------------------------- */

test('login failure persists a manual auth pause that only a human resume clears', async () => {
  const harness = await createHarness();
  try {
    await bindMockAccount(harness);
    let loginBroken = true;
    const fetchImpl = createMockFetch(() =>
      loginBroken ? responseJson({ code: -101, message: 'not logged in' }) : responseJson(NAV_WBI)
    );
    const client = new BilibiliClient({
      config: harness.config,
      credentials: { sessdata: 'SESS', bili_jct: 'JCT' },
      fetchImpl,
      now: harness.now,
      store: harness.store,
      rateLimiter: harness.rateLimiter
    });
    await assert.rejects(() => client.whoami(), (error) => error.code === 'CREDENTIAL_MISSING');
    assert.equal(fetchImpl.calls.length, 1);
    let state = await harness.snapshot();
    assert.ok(state.accounts['bilibili:1001'].authPausedAt);
    assert.equal(state.accounts['bilibili:1001'].authPausedCode, '-101');
    const callsBefore = fetchImpl.calls.length;
    await assert.rejects(
      () => client.whoami(),
      (error) => error.code === 'CREDENTIAL_MISSING' && /paused/.test(error.message)
    );
    assert.equal(fetchImpl.calls.length, callsBefore);
    await harness.store.transaction(async (draft, tx) => {
      harness.rateLimiter.clearAuthPause(tx, 'bilibili:1001', { note: 'operator resumed', actor: 'local_human' });
    });
    state = await harness.snapshot();
    assert.equal(state.accounts['bilibili:1001'].authPausedAt, null);
    assert.ok(state.events.some((event) => event.type === 'account.auth.resumed'));
    // The first read already consumed its time slot; wait for the next one.
    loginBroken = false;
    harness.now.advance(harness.config.rateLimit.minGapMs + 1);
    const profile = await client.whoami();
    assert.equal(profile.isLogin, true);
    assert.equal(fetchImpl.calls.length, callsBefore + 1);
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------- G-P1-3 credentials gate ------------------------- */

test('credential changes fail closed at reservation and at the dispatch boundary', async () => {
  const harness = await createHarness();
  try {
    const credentials = await credentialServiceFor(harness);
    const gateway = makeGateway(harness, { credentials });
    const task = await makeTask(harness);
    const firstRevision = credentialRevision(credentials.credentials);
    const reserved = await gateway.reserveOperation(reservation(harness, task));
    assert.equal(reserved.operation.credentialRevision, firstRevision);
    const state = await harness.snapshot();
    assert.equal(state.operations[reserved.operation.id].credentialRevision, firstRevision);

    credentials.credentials = { sessdata: 'NEW-SESS', bili_jct: 'JCT', buvid3: '', dedeuserid: '' };
    await assert.rejects(
      () => gateway.reserveOperation(reservation(harness, task)),
      (error) => error.code === 'IDENTITY_UNVERIFIED'
    );

    // Re-verify the new credential: the recorded reservation revision is stale,
    // so dispatch must fail closed instead of sending under a changed credential.
    await credentials.verifyAndBind({ principal: harness.owner });
    let executed = 0;
    await assert.rejects(
      () =>
        gateway.dispatchOperation(reserved.operation.id, async () => {
          executed += 1;
          return receipt();
        }),
      (error) => error.code === 'IDENTITY_UNVERIFIED'
    );
    assert.equal(executed, 0);

    // A manually paused account also blocks platform write reservations.
    await harness.store.transaction(async (draft) => {
      draft.accounts['bilibili:1001'].authPausedAt = nowIso(harness.now);
      draft.accounts['bilibili:1001'].authPausedReason = 'login_invalid';
      draft.accounts['bilibili:1001'].authPausedCode = '-101';
    });
    await assert.rejects(
      () => gateway.reserveOperation(reservation(harness, task, { businessKey: 'comment:paused' })),
      (error) => error.code === 'CREDENTIAL_MISSING'
    );
  } finally {
    await harness.cleanup();
  }
});

/* --------------------- G-P1-4 execution dispatch context --------------------- */

test('ExecutionDispatchContext is issued once, verified and rejected when forged', async () => {
  const harness = await createHarness();
  try {
    const gateway = makeGateway(harness);
    const context = gateway.issueExecutionContext({
      executionId: 'exec_1',
      taskId: 'task_1',
      stageId: 'render',
      attempt: 1,
      inputHash: 'jcs-sha256-v1:' + 'a'.repeat(64),
      instanceId: 'instance_1',
      profileId: 'local-slideshow-v1'
    });
    assert.equal(context.permit, 'dispatch-once');
    assert.equal(typeof context.token, 'string');
    assert.equal(gateway.executionContextVerifier.verify(context), true);
    assert.throws(
      () => gateway.executionContextVerifier.verify({ ...context, token: 'forged-token' }),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.throws(
      () => gateway.executionContextVerifier.verify({ ...context, attempt: 2 }),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.throws(
      () => gateway.executionContextVerifier.verify({ ...context, permit: 'forever' }),
      (error) => error.code === 'FORBIDDEN'
    );
    assert.throws(
      () => gateway.issueExecutionContext({ executionId: 'exec_2' }),
      (error) => error.code === 'FORBIDDEN'
    );
    gateway.executionContextVerifier.consume(context);
    assert.throws(
      () => gateway.executionContextVerifier.verify(context),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------ G-P1-5 invalidated approvals ------------------------ */

test('migration-invalidated approvals are rejected at the reservation boundary', async () => {
  const harness = await createHarness();
  try {
    const gateway = makeGateway(harness);
    const { task, challenge } = await harness.store.transaction(async (draft, tx) => {
      const current = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        accountRef,
        inputHash: 'jcs-sha256-v1:' + '3'.repeat(64)
      });
      harness.taskManager.transition(tx, current, 'waiting_approval');
      return {
        task: current,
        challenge: harness.approvalService.create(tx, {
          task: current,
          action: 'comment.send',
          inputHash: current.inputHash,
          principalId: harness.owner.id
        })
      };
    });
    await harness.approvalService.decide(
      { approvalId: challenge.approval.id, decision: 'approve', nonce: challenge.nonce, mode: 'go' },
      harness.humanContext
    );
    const request = reservation(harness, task, {
      approvalId: challenge.approval.id,
      approvalAction: 'comment.send'
    });
    // Sanity: the approval works before the invalidation marker is set.
    const reserved = await gateway.reserveOperation(request);
    assert.equal(reserved.operation.status, 'reserved');
    await harness.store.transaction(async (draft) => {
      draft.approvals[challenge.approval.id].usableForAuthorization = false;
      draft.approvals[challenge.approval.id].invalidatedByMigration = true;
    });
    await assert.rejects(
      () => gateway.reserveOperation({ ...request, businessKey: 'comment:invalidated' }),
      (error) => error.code === 'APPROVAL_STALE' && /invalidated/.test(error.message)
    );
  } finally {
    await harness.cleanup();
  }
});

/* --------------------------- G-P1-6 cancelOperation --------------------------- */

test('cancelOperation releases a never-dispatched reservation and rejects dispatched ones', async () => {
  const harness = await createHarness();
  try {
    const gateway = makeGateway(harness);
    const task = await makeTask(harness);
    const request = reservation(harness, task, {
      businessKey: 'comment:cancel',
      quota: { key: 'bilibili:1001', action: 'comment', actionQuota: { perDay: 5, perHour: 5 } }
    });
    const reserved = await gateway.reserveOperation(request);
    assert.equal((await harness.snapshot()).rate['bilibili:1001'].write.hourCount, 1);
    const cancelled = await gateway.cancelOperation(
      {
        operationId: reserved.operation.id,
        reason: 'pre-dispatch recheck failed',
        evidence: { provenance: 'dispatch_precheck', note: 'never entered _prepareDispatch' }
      },
      harness.humanContext
    );
    assert.equal(cancelled.operation.status, 'cancelled');
    const state = await harness.snapshot();
    assert.equal(state.businessKeys['comment:cancel'].status, 'cancelled');
    assert.equal(state.rate['bilibili:1001'].write.hourCount, 0);
    assert.equal(state.operations[reserved.operation.id].cancellation.actor, harness.owner.id);
    assert.ok(state.events.some((event) => event.type === 'operation.cancelled'));
    const again = await gateway.cancelOperation(
      { operationId: reserved.operation.id, reason: 'again', evidence: true },
      harness.humanContext
    );
    assert.equal(again.deduplicated, true);
    await assert.rejects(
      () => gateway.cancelOperation({ operationId: reserved.operation.id }, harness.humanContext),
      (error) => error.code === 'INPUT_REQUIRED'
    );
    const unknown = await gateway.executeOperation(
      reservation(harness, task, { businessKey: 'comment:unknown' }),
      async () => {
        throw new Error('timeout');
      }
    );
    assert.equal(unknown.operation.status, 'unknown');
    await assert.rejects(
      () =>
        gateway.cancelOperation(
          { operationId: unknown.operation.id, reason: 'no', evidence: true },
          harness.humanContext
        ),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      () => gateway.cancelOperation({ operationId: 'missing-op', reason: 'no', evidence: true }, harness.humanContext),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------------ G-P1-7 outbox gates ------------------------------ */

test('notification dispatch rechecks the configuration revision and instance state', async () => {
  const configStale = await notificationSetup();
  const channel = makeMockChannel();
  try {
    configStale.harness.configService.config.dryRun = false;
    await assert.rejects(
      () => configStale.harness.effectGateway.dispatchNotification(configStale.notification.id, channel),
      (error) => error.code === 'CONFIG_INVALID'
    );
    assert.equal(channel.calls.send.length, 0);
  } finally {
    await configStale.harness.cleanup();
  }
  const pausedInstance = await notificationSetup();
  try {
    await pausedInstance.harness.store.updateInstance((instance) => {
      instance.status = 'paused';
      return instance;
    });
    await assert.rejects(
      () => pausedInstance.harness.effectGateway.dispatchNotification(pausedInstance.notification.id, channel),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    assert.equal(channel.calls.send.length, 0);
  } finally {
    await pausedInstance.harness.cleanup();
  }
});

/* ------------------- G-P2-1 read retry reserves quota again ------------------- */

test('read retries consume a second ledger read slot', async () => {
  const harness = await createHarness();
  try {
    await bindMockAccount(harness);
    let reads = 0;
    const fetchImpl = createMockFetch(async () => {
      reads += 1;
      if (reads === 1) return responseJson({ code: 0, data: {} }, { status: 503 });
      return responseJson(NAV_WBI);
    });
    const client = new BilibiliClient({
      config: harness.config,
      credentials: { sessdata: 'SESS', bili_jct: 'JCT' },
      fetchImpl,
      now: harness.now,
      store: harness.store,
      rateLimiter: harness.rateLimiter
    });
    await client.whoami();
    assert.equal(reads, 2);
    const state = await harness.snapshot();
    assert.equal(state.rate['bilibili:1001'].read.hourCount, 2);
  } finally {
    await harness.cleanup();
  }
});

/* ----------------------------- G-P2-3 redirect ----------------------------- */

test('cookie-bearing requests are redirected manually and off-whitelist hops are rejected', async () => {
  const harness = await createHarness();
  try {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: false,
        status: 302,
        headers: { get: (name) => (String(name).toLowerCase() === 'location' ? 'https://evil.example/x' : null) },
        async text() {
          return '';
        }
      };
    };
    const client = new BilibiliClient({
      config: harness.config,
      credentials: { sessdata: 'SESS', bili_jct: 'JCT' },
      fetchImpl,
      now: harness.now
    });
    await assert.rejects(() => client.whoami(), (error) => error.code === 'FORBIDDEN');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, 'manual');
    assert.match(calls[0].options.headers.cookie, /SESSDATA=SESS/);
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------- G-P2-4 resolve idempotency ------------------------- */

test('resolve is idempotent for a matching receipt and external readbacks require a BV', async () => {
  const harness = await createHarness();
  try {
    const gateway = makeGateway(harness);
    const task = await makeTask(harness);
    const unknown = await gateway.executeOperation(
      reservation(harness, task, { businessKey: 'comment:resolve' }),
      async () => {
        throw new Error('timeout');
      }
    );
    const first = await gateway.resolve(
      {
        operationId: unknown.operation.id,
        decision: 'confirmed',
        receipt: receipt('comment'),
        note: 'platform readback'
      },
      harness.humanContext
    );
    assert.equal(first.operation.status, 'confirmed');
    const same = await gateway.resolve(
      {
        operationId: unknown.operation.id,
        decision: 'confirmed',
        receipt: receipt('comment'),
        note: 'platform readback'
      },
      harness.humanContext
    );
    assert.equal(same.deduplicated, true);
    await assert.rejects(
      () =>
        gateway.resolve(
          {
            operationId: unknown.operation.id,
            decision: 'confirmed',
            receipt: receipt('comment', { externalId: 'different-external' }),
            note: 'platform readback'
          },
          harness.humanContext
        ),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );

    const externalUnknown = await gateway.executeOperation(
      {
        namespace: 'external',
        action: 'publish_external',
        receiptAction: 'publish_external',
        accountRef,
        businessKey: 'publish:external:1',
        taskIds: [task.id],
        inputHash: task.inputHash,
        protected: true
      },
      async () => {
        throw new Error('timeout');
      }
    );
    await assert.rejects(
      () =>
        gateway.resolve(
          {
            operationId: externalUnknown.operation.id,
            decision: 'confirmed',
            receipt: {
              platform: 'bilibili',
              accountId: '1001',
              action: 'publish_external',
              externalId: 'not-a-bv',
              url: 'https://www.bilibili.com/video/not-a-bv',
              verification: 'platform_readback',
              receivedAt: nowIso()
            }
          },
          harness.humanContext
        ),
      (error) => error.code === 'OPERATION_UNKNOWN' && /BV/.test(error.message)
    );
    const externalResolved = await gateway.resolve(
      {
        operationId: externalUnknown.operation.id,
        decision: 'confirmed',
        receipt: {
          platform: 'bilibili',
          accountId: '1001',
          action: 'publish_external',
          externalId: 'BV1xx411c7mD',
          url: 'https://www.bilibili.com/video/BV1xx411c7mD',
          verification: 'platform_readback',
          receivedAt: nowIso()
        }
      },
      harness.humanContext
    );
    assert.equal(externalResolved.operation.status, 'confirmed');
  } finally {
    await harness.cleanup();
  }
});

test('not_sent resolve records a structured evidence reference (G-P2-9)', async () => {
  const harness = await createHarness();
  try {
    const gateway = makeGateway(harness);
    const task = await makeTask(harness);
    const unknown = await gateway.executeOperation(
      reservation(harness, task, { businessKey: 'comment:not-sent' }),
      async () => {
        throw new Error('timeout');
      }
    );
    const resolved = await gateway.resolve(
      {
        operationId: unknown.operation.id,
        decision: 'not_sent',
        note: 'platform log shows no comment',
        evidenceRef: 'evidence:platform-log:42'
      },
      harness.humanContext
    );
    assert.equal(resolved.operation.status, 'not_sent');
    const state = await harness.snapshot();
    assert.equal(state.operations[unknown.operation.id].resolution.evidenceRef, 'evidence:platform-log:42');
  } finally {
    await harness.cleanup();
  }
});

/* --------------------------- I5 / I6 service hooks --------------------------- */

test('settlement and resolve report late ledger writes and diary rebuilds in-transaction', async () => {
  const calls = { late: [], dirty: [] };
  const services = {
    migration: {
      noteLateLedgerWrite(draft, tx, payload) {
        calls.late.push(payload);
        return true;
      }
    },
    diary: {
      markDirty(draft, tx, payload) {
        calls.dirty.push(payload);
        return true;
      }
    }
  };
  const harness = await createHarness();
  try {
    const gateway = makeGateway(harness, { services });
    const task = await makeTask(harness);
    const confirmed = await gateway.executeOperation(
      reservation(harness, task, { businessKey: 'comment:hooked' }),
      async () => receipt()
    );
    assert.deepEqual(calls.late, [{ operationId: confirmed.operation.id, kind: 'operation.confirmed' }]);
    assert.equal(calls.dirty.length, 0);

    calls.late.length = 0;
    const unknown = await gateway.executeOperation(
      reservation(harness, task, { businessKey: 'comment:hooked-unknown' }),
      async () => {
        throw new Error('timeout');
      }
    );
    calls.late.length = 0;
    calls.dirty.length = 0;
    await gateway.resolve(
      { operationId: unknown.operation.id, decision: 'confirmed', receipt: receipt('comment'), note: 'readback' },
      harness.humanContext
    );
    assert.deepEqual(calls.late, [{ operationId: unknown.operation.id, kind: 'operation.resolve' }]);
    assert.equal(calls.dirty.length, 1);
    assert.equal(calls.dirty[0].operationId, unknown.operation.id);
    assert.equal(calls.dirty[0].kind, 'operation.resolve.confirmed');
    assert.equal(calls.dirty[0].taskId, task.id);
    assert.match(calls.dirty[0].date, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------------- I7 cooldown ------------------------------- */

test('cooldown windows are evaluated inside the reservation transaction', async () => {
  const harness = await createHarness();
  try {
    const gateway = makeGateway(harness);
    const task = await makeTask(harness, 'dm');
    const targetKey = 'dm-target:bilibili:1001:2002';
    await harness.store.transaction(async (draft) => {
      draft.businessKeys[targetKey] = {
        key: targetKey,
        namespace: 'platform',
        type: 'dm',
        status: 'confirmed',
        confirmedAt: nowIso(harness.now),
        updatedAt: nowIso(harness.now)
      };
    });
    const cooldown = { businessKey: targetKey, days: 7 };
    const base = {
      namespace: 'platform',
      action: 'dm',
      receiptAction: 'dm',
      accountRef,
      extraBusinessKeys: [targetKey],
      reusableBusinessKeys: [targetKey],
      taskIds: [task.id],
      inputHash: task.inputHash,
      protected: true,
      cooldown
    };
    await assert.rejects(
      () => gateway.reserveOperation({ ...base, businessKey: 'dm:cooldown' }),
      (error) => error.code === 'DUPLICATE_TARGET' && error.details.businessKey === targetKey
    );
    harness.now.advance(8 * 24 * 60 * 60 * 1000);
    const reserved = await gateway.reserveOperation({ ...base, businessKey: 'dm:cooldown' });
    assert.equal(reserved.operation.status, 'reserved');
    // A proven not-sent target never starts a cooldown window.
    await harness.store.transaction(async (draft) => {
      draft.businessKeys[targetKey].status = 'not_sent';
    });
    const failedKey = await gateway.reserveOperation({
      ...base,
      businessKey: 'dm:not-sent',
      cooldown: { businessKey: targetKey, days: 7 }
    });
    assert.equal(failedKey.operation.status, 'reserved');
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------------ G-P1-7 unwired ------------------------------ */

test('mock X/Douyin/remote doubles are contract-only and never become enabled adapters', async () => {
  const registry = new AdapterRegistry();
  assert.equal(registry.hasPlatform('x'), false);
  assert.equal(registry.hasPlatform('douyin'), false);
  assert.throws(
    () => registry.assertPlatformCapability('douyin', 'write.comment'),
    (error) => error.code === 'CAPABILITY_UNSUPPORTED'
  );
  const adapter = makeMockPlatformAdapter('x');
  assert.equal(adapter.capabilities['write.comment'].supported, false);
  assert.equal(adapter.capabilities['dm.send'].supported, false);
  await assert.rejects(() => adapter.writeComment({}), (error) => error.code === 'CAPABILITY_UNSUPPORTED');
  await assert.rejects(() => adapter.discover({}), (error) => error.code === 'CAPABILITY_UNSUPPORTED');
  registry.registerPlatform({
    name: 'x',
    enabled: false,
    declaration: adapter.capabilities,
    factory: async () => adapter
  });
  await assert.rejects(() => registry.getPlatform('x'), (error) => error.code === 'FEATURE_DISABLED');
  assert.equal(registry.abilityStatus('x', 'write.comment').supported, false);
  assert.equal(registry.abilityStatus('x', 'dm.send').reason, 'disabled');
  assert.throws(() => makeMockPlatformAdapter('weibo'), /unknown mock platform/);

  const remote = makeMockRemoteBackend();
  assert.deepEqual(remote.capabilities.supportedStages, []);
  await assert.rejects(() => remote.submit({}), (error) => error.code === 'CAPABILITY_UNSUPPORTED');

  const invalid = deepClone(DEFAULT_CONFIG);
  invalid.platforms = { enabled: ['x'] };
  assert.throws(() => validateConfig(invalid), (error) => error.code === 'CONFIG_INVALID');
});

test('not_sent resolve releases reserved write quota so the daily action can retry', async () => {
  const harness = await createHarness();
  try {
    const gateway = makeGateway(harness);
    const task = await makeTask(harness, 'dm');
    const quota = { key: 'bilibili:1001', action: 'dm', actionQuota: { perHour: 12, perDay: 1 } };
    const unknown = await gateway.executeOperation(
      reservation(harness, task, { action: 'dm', receiptAction: 'dm', recoveryAction: 'dm', quota }),
      async () => {
        throw new Error('read time slot is not available yet');
      }
    );
    assert.equal(unknown.operation.status, 'unknown');
    let state = await harness.snapshot();
    assert.equal(state.rate['bilibili:1001'].write.actions.dm.dayCount, 1);
    const resolved = await gateway.resolve(
      {
        operationId: unknown.operation.id,
        decision: 'not_sent',
        note: 'local read-slot guard rejected before the platform request',
        evidenceRef: 'evidence:local:read-slot-guard'
      },
      harness.humanContext
    );
    assert.equal(resolved.operation.status, 'not_sent');
    state = await harness.snapshot();
    assert.equal(state.rate['bilibili:1001'].write.actions.dm.dayCount, 0);
    assert.ok(state.operations[unknown.operation.id].quota.releasedAt);
    const resolveEvent = state.events.find((entry) => entry.type === 'operation.not_sent');
    assert.equal(resolveEvent.payload.quotaReleased, true);
    // The release must make a legitimate retry possible once the write gap passed.
    harness.now.advance(121000);
    const retried = await gateway.executeOperation(
      reservation(harness, task, {
        action: 'dm',
        receiptAction: 'dm',
        recoveryAction: 'dm',
        quota,
        businessKey: 'dm:retry-after-not-sent'
      }),
      async () => receipt('dm')
    );
    assert.equal(retried.operation.status, 'confirmed');
  } finally {
    await harness.cleanup();
  }
});
test('a not_sent dispatch failure releases quota and records platform error details', async () => {
  const harness = await createHarness();
  try {
    const gateway = makeGateway(harness);
    const task = await makeTask(harness, 'dm');
    const quota = { key: 'bilibili:1001', action: 'dm', actionQuota: { perHour: 12, perDay: 1 } };
    const failed = await gateway.executeOperation(
      reservation(harness, task, { action: 'dm', receiptAction: 'dm', recoveryAction: 'dm', quota }),
      async () => {
        throw Object.assign(new Error('请求错误'), {
          code: 'BILI_API_ERROR',
          notSent: true,
          details: { biliCode: -400 }
        });
      }
    );
    assert.equal(failed.operation.status, 'failed');
    assert.equal(failed.operation.error.details.biliCode, -400);
    const state = await harness.snapshot();
    assert.equal(state.rate['bilibili:1001'].write.actions.dm.dayCount, 0);
    assert.ok(state.operations[failed.operation.id].quota.releasedAt);
    const event = state.events.find((entry) => entry.type === 'operation.failed');
    assert.equal(event.payload.quotaReleased, true);
  } finally {
    await harness.cleanup();
  }
});