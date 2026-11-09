/**
 * fix-core regression suite (P1/P2 core state layer). Implementation record:
 *
 * C-P1-1 [I2] config commit protocol:
 *   src/config.js:677 onChange, :720 reconcileConfigIntent, :768 _commitReconciledRevision,
 *   :792 _discardConfigIntent, :852 update (stage .next -> intent txn -> rename -> revision txn),
 *   :857 expectedRevision enforcement, :1013 _assertConfigWritable, :1030 assertCurrentState
 *   (sha256 + version), :807 syncRevision-runs-reconcile, store.js:122 configIntent field.
 * C-P1-2 [I1] credential write gate:
 *   src/credentials.js:121 requireWrite, :136 assertWriteAllowed, :168 describeBinding,
 *   :204 reconcileCredentialBinding; store.js:198 validateExtendedNestedState allows
 *   accounts[].credentialMismatchAt/authPaused*.
 * C-P1-3 [I3] task revision/settlement:
 *   src/task-manager.js:57 validateTaskCombination, :183/197 assertTransition self-check,
 *   :263 recompute (hasUnknownOperation, succeeded+pendingApprovals, running clears finishedAt),
 *   :330 recomputeParent (browse failure aggregation), :411 reviseInput, :447 resume
 *   (revision+1, finishedAt null); store.js:251 validateState calls combination check.
 * C-P1-4 [I10] state field admission: store.js:193/:198 validateExtendedNestedState
 *   (migration.lateReceipts/sealedPackage/executorStopEvidence/executorStopEvidenceHash/
 *   unsettledExecutions/reopenedAt/releaseCut/targetStopEvidence{Hash,Evidence}/targetDisabled/targetDataDir,
 *   artifactPendingImports[].fileMode, executions[].previousExecutionId/checkpointRef/requestId/
 *   workspaceId/instanceId/inputArtifactRefs/sourceOwnerPid/sourceProcessStartedAt,
 *   recovery.holds[].exposureId/exposureIds, tasks[].holds[].releaseNote/releasedBy,
 *   diaries.__pendingRebuild/factsHash, accounts authPaused{At,Reason,Code} and credentialMismatchAt,
 *   tasks.hasUnknownOperation, operations.credentialRevision).
 * C-P1-5 [I11] prune: store.js:804 prune (unsettled/hold/approval/execution/request/outbox/
 *   production/publish references protected; returns {removedTasks, removedOps}).
 * C-P2-1 event-journal idempotent archival: src/event-journal.js:82 archivedCount,
 *   :94 idempotent branch, :280 clearIdempotentPending.
 * C-P2-2 capacity cache: store.js:360 capacityCacheMs, :701 capacityStatus(allowCache),
 *   :722 recovery scan cache; public status remains a fresh scan.
 * C-P2-3 dead code removed from src/config.js (ABSOLUTE_OR_EMPTY, allowForeignRevision,
 *   empty fail-closed block, unused imports).
 * C-P2-4 browse config fields: config.example.json:25-26, src/config.js:28/71-72/162-163/306.
 * C-P2-5 100MiB helper: store.js:34 JOURNAL_PENDING_LIMIT, :763 _assertCapacityAcceptance,
 *   :786 assertBusinessAcceptance, :671 tx.assertBusinessAcceptance.
 * C-P2-6 AgentClient.reconfigure: src/agent.js:26.
 * C-P2-7 identity.findLocalOwner: src/identity.js:69; AppError message redaction:
 *   src/errors.js:163 redactSecretMessage, :190 toJSON.
 * C-P2-8 this file (31 tests) plus test/config.test.js and test/task-manager.test.js updates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ConfigService,
  DEFAULT_CONFIG,
  computeConfigHash,
  validateConfig
} from '../src/config.js';
import { createHarness } from './helpers/harness.js';
import {
  JOURNAL_PENDING_LIMIT,
  JsonStore,
  createInitialState,
  validateState
} from '../src/store.js';
import { EventJournal } from '../src/event-journal.js';
import { CredentialService, credentialRevision, saveCredentials } from '../src/credentials.js';
import { AgentClient } from '../src/agent.js';
import { AppError, redactSecretMessage } from '../src/errors.js';
import { atomicWriteJson, deepClone, nowIso, pathExists } from '../src/utils.js';
import { createMockFetch, responseJson } from './helpers/mock-fetch.js';

const INPUT_HASH = 'jcs-sha256-v1:' + 'a'.repeat(64);

function eventsOfType(state, type) {
  return (state.events || []).filter((event) => event.type === type);
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function newConfigServiceOn(harness, hooks = {}) {
  const service = new ConfigService({
    dataDir: harness.dir,
    file: harness.paths.configFile,
    store: harness.store,
    env: {},
    now: harness.now,
    hooks
  });
  await service.load();
  return service;
}

function writePreparedIntent(harness, { nextSha256, nextVersion = null }) {
  const nextFile = `${harness.paths.configFile}.next`;
  return harness.store.transaction(async (draft, tx) => {
    draft.configIntent = {
      phase: 'prepared',
      nextVersion: nextVersion ?? (draft.configRevision?.version || 0) + 1,
      nextSha256,
      nextFile: path.resolve(nextFile),
      prevSha256: draft.configRevision?.sha256 || '',
      at: nowIso(harness.now)
    };
    tx.appendEvent({ type: 'config.update.prepared', actor: 'http', payload: {} });
  });
}

async function withTask(harness, kind = 'browse', extra = {}) {
  return harness.store.transaction(async (draft, tx) => {
    return harness.taskManager.create(tx, {
      kind,
      principalId: harness.owner.id,
      inputHash: INPUT_HASH,
      input: {},
      ...extra
    });
  });
}

// ---------------------------------------------------------------------------
// I2: configuration update protocol / onChange / revision CAS / recovery
// ---------------------------------------------------------------------------

test('I2 config update commits revision atomically, emits events and notifies onChange in order', async () => {
  const harness = await createHarness();
  try {
    const before = await harness.snapshot();
    const order = [];
    const changes = [];
    const unsubscribe = harness.configService.onChange((event) => {
      order.push('first');
      changes.push(event);
    });
    harness.configService.onChange(() => order.push('second'));
    const updated = await harness.configService.update(
      { browse: { enabled: true, failureCooldownMinutes: 0, allowNoSubtitle: true } },
      { source: 'http', expectedRevision: before.configRevision.version }
    );
    assert.equal(updated.browse.enabled, true);
    assert.equal(updated.browse.failureCooldownMinutes, 0);
    assert.equal(updated.browse.allowNoSubtitle, true);
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].config.browse.enabled, true);
    assert.equal(changes[0].previous.browse.enabled, false);
    assert.equal(changes[0].revision.version, before.configRevision.version + 1);

    const after = await harness.snapshot();
    assert.equal(after.configRevision.version, before.configRevision.version + 1);
    assert.equal(after.configRevision.sha256, computeConfigHash(harness.configService.get()));
    assert.equal(after.configIntent, null);
    assert.equal(eventsOfType(after, 'config.update.prepared').length, 1);
    assert.equal(eventsOfType(after, 'config.updated').length, 1);
    const onDisk = await readJsonIfExists(harness.paths.configFile);
    assert.equal(onDisk.browse.enabled, true);
    assert.equal(await pathExists(`${harness.paths.configFile}.next`), false);

    unsubscribe();
    await harness.configService.update(
      { browse: { enabled: false } },
      { source: 'http', expectedRevision: after.configRevision.version }
    );
    assert.deepEqual(order, ['first', 'second', 'second']);
  } finally {
    await harness.cleanup();
  }
});

test('I2 remote config updates require expectedRevision and reject stale revisions', async () => {
  const harness = await createHarness();
  try {
    const service = harness.configService;
    const before = await harness.snapshot();
    const nextFile = `${harness.paths.configFile}.next`;
    for (const source of ['http', 'command']) {
      await assert.rejects(
        () => service.update({ browse: { enabled: true } }, { source }),
        (error) => error.code === 'INPUT_REQUIRED'
      );
    }
    await assert.rejects(
      () =>
        service.update(
          { browse: { enabled: true } },
          { source: 'http', expectedRevision: before.configRevision.version + 7 }
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );
    const after = await harness.snapshot();
    assert.equal(after.configRevision.version, before.configRevision.version);
    assert.equal(after.configIntent, null);
    assert.equal(await pathExists(nextFile), false);
    assert.equal(await pathExists(harness.paths.configFile), false);
  } finally {
    await harness.cleanup();
  }
});

test('I2 config update is blocked by a live intent, migration phase and recovery phase', async () => {
  const harness = await createHarness();
  try {
    const service = harness.configService;
    const snapshot = await harness.snapshot();
    const nextFile = `${harness.paths.configFile}.next`;
    await writePreparedIntent(harness, { nextSha256: computeConfigHash({ placeholder: true }) });
    await assert.rejects(
      () =>
        service.update(
          { browse: { enabled: true } },
          { source: 'http', expectedRevision: snapshot.configRevision.version }
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );
    assert.equal(await pathExists(nextFile), false);
    await harness.store.transaction(async (draft) => {
      draft.configIntent = null;
      draft.migration = { phase: 'sealed', id: 'migration_test' };
    });
    await assert.rejects(
      () =>
        service.update(
          { browse: { enabled: true } },
          { source: 'http', expectedRevision: snapshot.configRevision.version }
        ),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
    await harness.store.transaction(async (draft) => {
      draft.migration = { phase: 'active', id: null };
      draft.recovery.phase = 'readonly';
    });
    await assert.rejects(
      () =>
        service.update(
          { browse: { enabled: true } },
          { source: 'http', expectedRevision: snapshot.configRevision.version }
        ),
      (error) => error.code === 'RECOVERY_GAP'
    );
    await harness.store.transaction(async (draft) => {
      draft.recovery.phase = 'normal';
    });
    const updated = await service.update(
      { browse: { enabled: true } },
      { source: 'http', expectedRevision: snapshot.configRevision.version }
    );
    assert.equal(updated.browse.enabled, true);
  } finally {
    await harness.cleanup();
  }
});

test('I2 a caught update failure rolls the staged file and intent back', async () => {
  const harness = await createHarness();
  try {
    const service = await newConfigServiceOn(harness, {
      beforeRename() {
        throw new Error('simulated config rename crash');
      }
    });
    const before = await harness.snapshot();
    await assert.rejects(
      () =>
        service.update(
          { browse: { enabled: true } },
          { source: 'http', expectedRevision: before.configRevision.version }
        ),
      /simulated config rename crash/
    );
    const after = await harness.snapshot();
    assert.equal(after.configRevision.version, before.configRevision.version);
    assert.equal(after.configRevision.sha256, before.configRevision.sha256);
    assert.equal(after.configIntent, null);
    assert.equal(await pathExists(`${harness.paths.configFile}.next`), false);
    assert.equal(await pathExists(harness.paths.configFile), false);
    assert.equal(eventsOfType(after, 'config.update.prepared').length, 1);
    assert.equal(eventsOfType(after, 'config.update.aborted').length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('I2 startup reconciliation finishes a prepared intent whose next file was staged', async () => {
  const harness = await createHarness();
  try {
    const merged = deepClone(harness.configService.get());
    merged.browse.enabled = true;
    validateConfig(merged);
    const hash = computeConfigHash(merged);
    const nextFile = `${harness.paths.configFile}.next`;
    await atomicWriteJson(nextFile, merged, { mode: 0o600 });
    const before = await harness.snapshot();
    await writePreparedIntent(harness, { nextSha256: hash });

    const service = await newConfigServiceOn(harness);
    assert.equal(service.get().browse.enabled, true);
    const after = await harness.snapshot();
    assert.equal(after.configRevision.version, before.configRevision.version + 1);
    assert.equal(after.configRevision.sha256, hash);
    assert.equal(after.configIntent, null);
    assert.equal(await pathExists(nextFile), false);
    const recovered = after.events.filter(
      (event) => event.type === 'config.updated' && event.payload?.recovered === 'next_file'
    );
    assert.equal(recovered.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('I2 startup reconciliation commits an intent whose rename already happened', async () => {
  const harness = await createHarness();
  try {
    const merged = deepClone(harness.configService.get());
    merged.browse.enabled = true;
    validateConfig(merged);
    const hash = computeConfigHash(merged);
    await atomicWriteJson(harness.paths.configFile, merged, { mode: 0o600 });
    const before = await harness.snapshot();
    await writePreparedIntent(harness, { nextSha256: hash });

    const service = await newConfigServiceOn(harness);
    assert.equal(service.get().browse.enabled, true);
    const after = await harness.snapshot();
    assert.equal(after.configRevision.version, before.configRevision.version + 1);
    assert.equal(after.configRevision.sha256, hash);
    assert.equal(after.configIntent, null);
    assert.equal(await pathExists(`${harness.paths.configFile}.next`), false);
    const recovered = after.events.filter(
      (event) => event.type === 'config.updated' && event.payload?.recovered === 'config_file'
    );
    assert.equal(recovered.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('I2 startup reconciliation discards an intent that never completed', async () => {
  const harness = await createHarness();
  try {
    await atomicWriteJson(harness.paths.configFile, harness.configService.get(), { mode: 0o600 });
    const before = await harness.snapshot();
    await writePreparedIntent(harness, {
      nextSha256: 'jcs-sha256-v1:' + 'b'.repeat(64)
    });
    await newConfigServiceOn(harness);
    const after = await harness.snapshot();
    assert.equal(after.configRevision.version, before.configRevision.version);
    assert.equal(after.configIntent, null);
    assert.equal(await pathExists(`${harness.paths.configFile}.next`), false);
    const discarded = eventsOfType(after, 'config.update.discarded');
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0].payload.reason, 'hash_mismatch');
  } finally {
    await harness.cleanup();
  }
});

test('I2 startup removes an orphan staging file with no intent', async () => {
  const harness = await createHarness();
  try {
    const merged = deepClone(harness.configService.get());
    const nextFile = `${harness.paths.configFile}.next`;
    await atomicWriteJson(nextFile, merged, { mode: 0o600 });
    const before = await harness.snapshot();
    await newConfigServiceOn(harness);
    const after = await harness.snapshot();
    assert.equal(after.configRevision.version, before.configRevision.version);
    assert.equal(await pathExists(nextFile), false);
  } finally {
    await harness.cleanup();
  }
});

test('I2 concurrent updates cannot silently lose a revision (CAS)', async () => {
  const harness = await createHarness();
  try {
    const service = harness.configService;
    const before = await harness.snapshot();
    await service.update(
      { browse: { enabled: true } },
      { source: 'http', expectedRevision: before.configRevision.version }
    );
    const first = await harness.snapshot();
    await assert.rejects(
      () =>
        service.update(
          { browse: { enabled: false } },
          { source: 'http', expectedRevision: before.configRevision.version }
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );
    const after = await harness.snapshot();
    assert.equal(after.configRevision.version, first.configRevision.version);
    assert.equal(after.configRevision.sha256, first.configRevision.sha256);
    assert.equal(after.configIntent, null);
    assert.equal(await pathExists(`${harness.paths.configFile}.next`), false);
    const onDisk = await readJsonIfExists(harness.paths.configFile);
    assert.equal(onDisk.browse.enabled, true);
  } finally {
    await harness.cleanup();
  }
});

test('I2 assertCurrentState checks both the config hash and the revision version', async () => {
  const harness = await createHarness();
  try {
    const state = await harness.snapshot();
    harness.configService.assertCurrentState(state);
    assert.throws(
      () =>
        harness.configService.assertCurrentState({
          ...state,
          configRevision: { ...state.configRevision, version: state.configRevision.version + 3 }
        }),
      (error) =>
        error.code === 'CONFIG_INVALID' && error.details.expectedVersion === state.configRevision.version
    );
    assert.throws(
      () =>
        harness.configService.assertCurrentState({
          ...state,
          configRevision: { ...state.configRevision, sha256: 'jcs-sha256-v1:deadbeef' }
        }),
      (error) => error.code === 'CONFIG_INVALID'
    );
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// I1: credential write gate / binding description / mismatch reconciliation
// ---------------------------------------------------------------------------

async function bindCredentialService(harness, { sessdata = 'cookie1', biliJct = 'j', dedeuserid = '1001', mid = 1001 } = {}) {
  const file = path.join(harness.dir, 'credentials.json');
  await saveCredentials(file, { sessdata, bili_jct: biliJct, dedeuserid });
  const service = new CredentialService({
    file,
    env: {},
    store: harness.store,
    now: harness.now,
    verifier: async () => ({ isLogin: true, mid, uname: 'tester' })
  });
  await service.load();
  await service.verifyAndBind({ principal: harness.owner, ownerMid: harness?.ownerMid ?? mid });
  return { service, file };
}

test('I1 write gate allows only a verified binding that matches the loaded credential', async () => {
  const harness = await createHarness();
  try {
    const { service, file } = await bindCredentialService(harness);
    let state = await harness.snapshot();
    assert.equal(service.assertWriteAllowed(state), true);
    const binding = service.describeBinding(state);
    assert.equal(binding.bound, true);
    assert.equal(binding.accountId, '1001');
    assert.equal(binding.mismatch, false);
    assert.equal(binding.credentialRevision, credentialRevision(service.get()));
    assert.ok(binding.verifiedAt);

    await saveCredentials(file, { sessdata: 'cookie2', bili_jct: 'j', dedeuserid: '1001' });
    await service.load();
    state = await harness.snapshot();
    assert.equal(service.describeBinding(state).mismatch, true);
    assert.throws(() => service.assertWriteAllowed(state), (error) => error.code === 'IDENTITY_UNVERIFIED');

    const reconciled = await service.reconcileCredentialBinding({ actor: 'system' });
    assert.equal(reconciled.mismatch, true);
    assert.equal(reconciled.recorded, true);
    state = await harness.snapshot();
    assert.equal(typeof state.accounts['bilibili:1001'].credentialMismatchAt, 'string');
    assert.equal(eventsOfType(state, 'identity.credential.mismatch').length, 1);

    await service.verifyAndBind({ principal: harness.owner, ownerMid: 1001 });
    state = await harness.snapshot();
    assert.equal(state.accounts['bilibili:1001'].credentialMismatchAt, undefined);
    assert.equal(service.assertWriteAllowed(state), true);
    assert.equal(service.describeBinding(state).mismatch, false);
  } finally {
    await harness.cleanup();
  }
});

test('I1 write gate fail-closed order: no account, missing record, missing credentials', async () => {
  const harness = await createHarness();
  try {
    const file = path.join(harness.dir, 'empty-credentials.json');
    await saveCredentials(file, {});
    const service = new CredentialService({ file, env: {}, store: harness.store, now: harness.now });
    await service.load();
    let state = await harness.snapshot();
    assert.throws(() => service.assertWriteAllowed(state), (error) => error.code === 'CREDENTIAL_MISSING');

    await harness.store.transaction(async (draft) => {
      draft.activeAccountRef = { platform: 'bilibili', accountId: '9999' };
    });
    state = await harness.snapshot();
    assert.throws(() => service.assertWriteAllowed(state), (error) => error.code === 'IDENTITY_UNVERIFIED');

    await harness.store.transaction(async (draft) => {
      draft.accounts['bilibili:9999'] = {
        accountRef: { platform: 'bilibili', accountId: '9999' },
        mid: '9999',
        credentialRevision: null,
        lastVerifiedAt: null
      };
    });
    state = await harness.snapshot();
    assert.throws(() => service.assertWriteAllowed(state), (error) => error.code === 'CREDENTIAL_MISSING');
    assert.equal(service.describeBinding(state).bound, true);
    assert.equal(service.describeBinding(state).mismatch, true);
  } finally {
    await harness.cleanup();
  }
});

test('I1 requireWrite is part of the write gate (sessdata present, bili_jct missing)', async () => {
  const harness = await createHarness();
  try {
    const file = path.join(harness.dir, 'sessdata-only.json');
    await saveCredentials(file, { sessdata: 'cookie1' });
    const service = new CredentialService({ file, env: {}, store: harness.store, now: harness.now });
    await service.load();
    const revision = credentialRevision(service.get());
    await harness.store.transaction(async (draft) => {
      draft.activeAccountRef = { platform: 'bilibili', accountId: '1001' };
      draft.accounts['bilibili:1001'] = {
        accountRef: { platform: 'bilibili', accountId: '1001' },
        mid: '1001',
        credentialRevision: revision,
        lastVerifiedAt: nowIso(harness.now)
      };
    });
    const state = await harness.snapshot();
    assert.throws(() => service.assertWriteAllowed(state), (error) => error.code === 'CREDENTIAL_MISSING');
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// I3: task revisions, settlement and combination validation
// ---------------------------------------------------------------------------

test('I3 reviseInput bumps revision, supersedes pending approvals and audits the event', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH,
        input: { text: 'old' }
      });
      harness.taskManager.transition(tx, task, 'waiting_approval');
      const approval = harness.approvalService.create(tx, {
        task,
        action: 'comment.send',
        inputHash: task.inputHash,
        principalId: harness.owner.id,
        ttlSec: 600
      });
      return { taskId: task.id, approvalId: approval.approval.id };
    });
    const nextHash = 'jcs-sha256-v1:' + 'b'.repeat(64);
    const revised = await harness.store.transaction(async (draft, tx) => {
      harness.taskManager.reviseInput(
        tx,
        draft.tasks[created.taskId],
        { input: { text: 'new' }, inputHash: nextHash },
        { actor: 'human:test' }
      );
      return {
        task: structuredClone(draft.tasks[created.taskId]),
        approval: structuredClone(draft.approvals[created.approvalId])
      };
    });
    assert.equal(revised.task.revision, 2);
    assert.equal(revised.task.inputHash, nextHash);
    assert.equal(revised.task.input.text, 'new');
    assert.ok(revised.approval.supersededAt);
    assert.equal(revised.approval.supersededByRevision, 2);

    const state = await harness.snapshot();
    const event = eventsOfType(state, 'task.input.revised').at(-1);
    assert.equal(event.taskId, created.taskId);
    assert.equal(event.payload.revision, 2);
    assert.equal(event.payload.inputHash, nextHash);
    assert.deepEqual(event.payload.supersededApprovals, [created.approvalId]);
    await assert.rejects(
      () =>
        harness.approvalService.decide(
          { approvalId: created.approvalId, decision: 'approve', nonce: 'nonce', mode: 'go' },
          harness.humanContext
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );

    const terminal = await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'browse',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      harness.taskManager.transition(tx, task, 'running');
      harness.taskManager.transition(tx, task, 'succeeded');
      return task.id;
    });
    await assert.rejects(
      () =>
        harness.store.transaction(async (draft, tx) => {
          harness.taskManager.reviseInput(tx, draft.tasks[terminal], { inputHash: 'x' });
        }),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

test('I3 resume bumps revision, clears finishedAt and keeps old approvals stale', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      harness.taskManager.transition(tx, task, 'waiting_approval');
      const approval = harness.approvalService.create(tx, {
        task,
        action: 'comment.send',
        inputHash: task.inputHash,
        principalId: harness.owner.id,
        ttlSec: 600
      });
      harness.taskManager.transition(tx, task, 'running', { approved: true });
      harness.taskManager.transition(tx, task, 'interrupted');
      return { taskId: task.id, approvalId: approval.approval.id };
    });
    const resumed = await harness.store.transaction(async (draft, tx) => {
      harness.taskManager.resume(tx, draft.tasks[created.taskId], {
        manual: true,
        verified: true,
        approved: true
      });
      return structuredClone(draft.tasks[created.taskId]);
    });
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.revision, 2);
    assert.equal(resumed.finishedAt, null);
    assert.equal(resumed.attempts, 1);
    await assert.rejects(
      () =>
        harness.approvalService.decide(
          { approvalId: created.approvalId, decision: 'approve', nonce: 'nonce', mode: 'go' },
          harness.humanContext
        ),
      (error) => error.code === 'APPROVAL_STALE'
    );
  } finally {
    await harness.cleanup();
  }
});

test('I3 pending approvals keep succeeded/partial tasks unsettled until superseded', async () => {
  const harness = await createHarness();
  try {
    const created = await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      harness.taskManager.transition(tx, task, 'waiting_approval');
      const approval = harness.approvalService.create(tx, {
        task,
        action: 'comment.send',
        inputHash: task.inputHash,
        principalId: harness.owner.id,
        ttlSec: 600
      });
      harness.taskManager.transition(tx, task, 'running', { approved: true });
      harness.taskManager.transition(tx, task, 'succeeded');
      assert.equal(task.status, 'succeeded');
      assert.equal(task.isSettled, false);
      assert.equal(task.finishedAt, null);
      return { taskId: task.id, approvalId: approval.approval.id };
    });
    const settled = await harness.store.transaction(async (draft, tx) => {
      draft.approvals[created.approvalId].supersededAt = nowIso(harness.now);
      harness.taskManager.recompute(tx, draft.tasks[created.taskId]);
      return structuredClone(draft.tasks[created.taskId]);
    });
    assert.equal(settled.isSettled, true);
    assert.ok(settled.finishedAt);

    const partial = await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      harness.taskManager.transition(tx, task, 'waiting_approval');
      const approval = harness.approvalService.create(tx, {
        task,
        action: 'comment.send',
        inputHash: task.inputHash,
        principalId: harness.owner.id,
        ttlSec: 600
      });
      harness.taskManager.transition(tx, task, 'running', { approved: true });
      harness.taskManager.transition(tx, task, 'partial', { result: { ok: false } });
      assert.equal(task.isSettled, false);
      draft.approvals[approval.approval.id].supersededAt = nowIso(harness.now);
      harness.taskManager.recompute(tx, task);
      assert.equal(task.isSettled, true);
      assert.equal(task.finishedAt !== null, true);
      return task.id;
    });
    assert.ok(partial);
  } finally {
    await harness.cleanup();
  }
});

test('I3 hasUnknownOperation follows pending unknown/dispatching operations', async () => {
  const harness = await createHarness();
  try {
    const taskId = await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      harness.taskManager.transition(tx, task, 'running');
      draft.operations.op_dispatching = {
        id: 'op_dispatching',
        status: 'dispatching',
        taskIds: [task.id],
        dispatchAt: nowIso(harness.now),
        createdAt: nowIso(harness.now)
      };
      task.operationIds.push('op_dispatching');
      task.pendingOperationIds.push('op_dispatching');
      harness.taskManager.recompute(tx, task);
      assert.equal(task.hasUnknownOperation, true);
      assert.equal(task.isSettled, false);
      draft.operations.op_dispatching.status = 'confirmed';
      harness.taskManager.settleOperation(tx, draft.operations.op_dispatching);
      harness.taskManager.recompute(tx, task);
      assert.equal(task.hasUnknownOperation, false);
      return task.id;
    });
    assert.ok(taskId);
  } finally {
    await harness.cleanup();
  }
});

test('I3 running transition never keeps a stale finishedAt', async () => {
  const harness = await createHarness();
  try {
    await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'browse',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      task.finishedAt = '2020-01-01T00:00:00.000Z';
      harness.taskManager.transition(tx, task, 'running');
      assert.equal(task.finishedAt, null);
      assert.equal(task.status, 'running');
    });
  } finally {
    await harness.cleanup();
  }
});

test('I3 cancelling a running task self-checks dispatched operations', async () => {
  const harness = await createHarness();
  try {
    await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      harness.taskManager.transition(tx, task, 'running');
      draft.operations.op_dispatched = {
        id: 'op_dispatched',
        status: 'confirmed',
        taskIds: [task.id],
        dispatchAt: nowIso(harness.now),
        createdAt: nowIso(harness.now)
      };
      task.operationIds.push('op_dispatched');
      assert.throws(
        () => harness.taskManager.transition(tx, task, 'cancelled', { provenUndispatched: true }),
        (error) => error.code === 'OPERATION_UNKNOWN'
      );
    });
    await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      harness.taskManager.transition(tx, task, 'running');
      harness.taskManager.transition(tx, task, 'cancelled', { provenUndispatched: true });
      assert.equal(task.status, 'cancelled');
      assert.equal(task.isSettled, true);
    });
  } finally {
    await harness.cleanup();
  }
});

test('I3 validateState rejects illegal task field combinations and accepts legal ones', async () => {
  const harness = await createHarness();
  try {
    const taskId = await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'browse',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      harness.taskManager.transition(tx, task, 'running');
      harness.taskManager.transition(tx, task, 'succeeded');
      return task.id;
    });
    const valid = await harness.snapshot();
    assert.doesNotThrow(() => validateState(structuredClone(valid)));

    const settledButUnsettled = structuredClone(valid);
    settledButUnsettled.tasks[taskId].isSettled = false;
    assert.throws(
      () => validateState(settledButUnsettled),
      (error) => error.code === 'STORE_CORRUPTED'
    );

    const unknownWithFinishedAt = structuredClone(valid);
    unknownWithFinishedAt.tasks[taskId] = {
      ...unknownWithFinishedAt.tasks[taskId],
      status: 'unknown',
      isSettled: false,
      executionActive: false,
      finishedAt: nowIso(harness.now)
    };
    assert.throws(
      () => validateState(unknownWithFinishedAt),
      (error) => error.code === 'STORE_CORRUPTED'
    );

    const unknownButSettled = structuredClone(valid);
    unknownButSettled.tasks[taskId].hasUnknownOperation = true;
    assert.throws(
      () => validateState(unknownButSettled),
      (error) => error.code === 'STORE_CORRUPTED'
    );
  } finally {
    await harness.cleanup();
  }
});

test('I3/M07 browse parents aggregate settled child failures as partial, never failed', async () => {
  const harness = await createHarness();
  try {
    const parentId = await harness.store.transaction(async (draft, tx) => {
      const parent = harness.taskManager.create(tx, {
        kind: 'browse',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      const child = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH,
        parentTaskId: parent.id
      });
      harness.taskManager.transition(tx, child, 'running');
      harness.taskManager.transition(tx, child, 'failed', { result: { ok: false } });
      assert.equal(draft.tasks[parent.id].status, 'partial');
      assert.notEqual(draft.tasks[parent.id].status, 'failed');
      return parent.id;
    });
    assert.ok(parentId);

    // Late child failure after a browse round already settled as succeeded.
    const lateParentId = await harness.store.transaction(async (draft, tx) => {
      const parent = harness.taskManager.create(tx, {
        kind: 'browse',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      harness.taskManager.transition(tx, parent, 'running');
      harness.taskManager.transition(tx, parent, 'succeeded');
      const lateChild = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH,
        parentTaskId: parent.id
      });
      harness.taskManager.transition(tx, lateChild, 'running');
      harness.taskManager.transition(tx, lateChild, 'failed', { result: { ok: false } });
      assert.equal(draft.tasks[parent.id].status, 'partial');
      return parent.id;
    });
    assert.ok(lateParentId);
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// I10: state field admission for new nested fields
// ---------------------------------------------------------------------------

test('I10 validateState admits every new nested extension field', async () => {
  const harness = await createHarness();
  try {
    assert.equal(createInitialState({ workspaceId: 'w', historyEpoch: 'e' }).configIntent, null);
    const state = await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      draft.configIntent = null;
      draft.accounts['bilibili:1001'] = {
        accountRef: { platform: 'bilibili', accountId: '1001' },
        mid: '1001',
        authPausedAt: nowIso(harness.now),
        authPausedReason: 'login expired',
        authPausedCode: '-101',
        credentialMismatchAt: null
      };
      draft.migration.lateReceipts = [
        { operationId: 'op_late', kind: 'comment', at: nowIso(harness.now) }
      ];
      draft.migration.sealedPackage = { packageId: 'pkg_1', snapshotHash: 'hash' };
      draft.migration.executorStopEvidence = {
        source: 'cli',
        note: 'all executors stopped',
        at: nowIso(harness.now),
        refs: []
      };
      draft.migration.executorStopEvidenceHash = 'jcs-sha256-v1:' + 'd'.repeat(64);
      draft.migration.unsettledExecutions = ['exec_unsettled_1'];
      draft.migration.reopenedAt = nowIso(harness.now);
      draft.migration.releaseCut = {
        sourceHistoryEpoch: draft.historyEpoch,
        cutEventSeq: draft.eventSeq,
        snapshotHash: 'jcs-sha256-v1:' + 'e'.repeat(64)
      };
      draft.migration.targetStopEvidenceHash = 'jcs-sha256-v1:' + 'f'.repeat(64);
      draft.migration.targetStopEvidence = 'target service stopped by owner';
      draft.migration.targetDisabled = true;
      draft.migration.targetDataDir = path.join(harness.dir, 'target-data');
      draft.migration.targetDisabledAt = nowIso(harness.now);
      task.holds.push({
        id: 'hold_ext',
        kind: 'migration',
        caseId: null,
        scope: { workspaceId: draft.workspaceId },
        scopeKey: 'workspace_test',
        revision: 1,
        status: 'released',
        evidenceRefs: [],
        createdAt: nowIso(harness.now),
        releasedAt: nowIso(harness.now),
        releaseNote: 'released after review',
        releasedBy: harness.owner.id
      });
      draft.recovery.holds.push({
        id: 'hold_recovery',
        kind: 'recovery',
        scope: { workspaceId: draft.workspaceId },
        scopeKey: 'workspace_test',
        exposureId: 'exposure_1',
        exposureIds: ['exposure_1']
      });
      draft.diaries.__pendingRebuild = {
        diary_public: { date: '2026-11-09', scope: 'public', reason: 'resolve', at: nowIso(harness.now) }
      };
      draft.diaries.diary_public = { factsHash: 'jcs-sha256-v1:' + 'c'.repeat(64) };
      draft.executions.exec_ext = {
        executionId: 'exec_ext',
        taskId: task.id,
        previousExecutionId: 'exec_prev',
        checkpointRef: 'ckpt_1',
        requestId: 'req_1',
        workspaceId: draft.workspaceId,
        instanceId: tx.instanceId,
        sourceOwnerPid: process.pid,
        sourceProcessStartedAt: nowIso(harness.now),
        inputArtifactRefs: [{ artifactId: 'art_1', sha256: 'x' }]
      };
      draft.operations.op_ext = {
        id: 'op_ext',
        status: 'confirmed',
        taskIds: [task.id],
        credentialRevision: 'rev_1',
        createdAt: nowIso(harness.now)
      };
      draft.artifactPendingImports.imp_ext = { artifactId: 'art_1', fileMode: 0o444 };
      return true;
    });
    assert.equal(state, true);
    const snapshot = await harness.snapshot();
    assert.equal(snapshot.accounts['bilibili:1001'].authPausedCode, '-101');
    assert.equal(snapshot.migration.lateReceipts.length, 1);
    assert.equal(snapshot.migration.sealedPackage.packageId, 'pkg_1');
    assert.equal(snapshot.migration.unsettledExecutions.length, 1);
    assert.equal(snapshot.migration.executorStopEvidenceHash.length > 0, true);
    assert.equal(snapshot.migration.targetDisabled, true);
    assert.equal(snapshot.migration.releaseCut.cutEventSeq, 0);
    assert.equal(snapshot.recovery.holds[0].exposureId, 'exposure_1');
    assert.deepEqual(snapshot.recovery.holds[0].exposureIds, ['exposure_1']);
    const storedTask = Object.values(snapshot.tasks)[0];
    assert.equal(storedTask.holds[0].releaseNote, 'released after review');
    assert.equal(storedTask.holds[0].releasedBy, harness.owner.id);
    assert.equal(snapshot.diaries.__pendingRebuild.diary_public.scope, 'public');
    assert.equal(snapshot.executions.exec_ext.checkpointRef, 'ckpt_1');
    assert.equal(snapshot.executions.exec_ext.sourceOwnerPid, process.pid);
    assert.equal(typeof snapshot.executions.exec_ext.sourceProcessStartedAt, 'string');
    assert.equal(snapshot.operations.op_ext.credentialRevision, 'rev_1');
    assert.equal(snapshot.artifactPendingImports.imp_ext.fileMode, 0o444);
    assert.doesNotThrow(() => validateState(structuredClone(snapshot)));
  } finally {
    await harness.cleanup();
  }
});

test('I10 validateState fails closed on malformed extension fields', async () => {
  const harness = await createHarness();
  try {
    const valid = await harness.snapshot();
    const mutations = [
      (state) => {
        state.configIntent = { phase: 'not-prepared' };
      },
      (state) => {
        state.accounts['bilibili:1'] = { authPausedAt: 1234 };
      },
      (state) => {
        state.migration.lateReceipts = { not: 'an array' };
      },
      (state) => {
        state.migration.executorStopEvidence = 'cli';
      },
      (state) => {
        state.diaries.__pendingRebuild = 'dirty';
      },
      (state) => {
        state.diaries.diary_bad = { factsHash: 42 };
      },
      (state) => {
        state.executions.exec_bad = { inputArtifactRefs: 'refs' };
      },
      (state) => {
        state.executions.exec_bad = { sourceOwnerPid: 'not-a-pid' };
      },
      (state) => {
        state.operations.op_bad = { credentialRevision: 5 };
      },
      (state) => {
        state.artifactPendingImports.imp_bad = { fileMode: '0444' };
      },
      (state) => {
        state.migration.unsettledExecutions = ['ok', 5];
      },
      (state) => {
        state.migration.executorStopEvidenceHash = 5;
      },
      (state) => {
        state.migration.releaseCut = 'cut';
      },
      (state) => {
        state.migration.targetDisabled = 'yes';
      },
      (state) => {
        state.recovery.holds = [{ exposureIds: 'exposure_1' }];
      },
      (state) => {
        state.tasks.release_hold_task = {
          id: 'release_hold_task',
          status: 'queued',
          isSettled: false,
          executionActive: false,
          finishedAt: null,
          holds: [{ id: 'hold_bad', releaseNote: 5 }]
        };
      }
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(valid);
      mutate(copy);
      assert.throws(
        () => validateState(copy),
        (error) => error.code === 'STORE_CORRUPTED',
        `mutation must be rejected: ${mutate.toString()}`
      );
    }
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// I11 / C-P1-5 / C-P2-2 / C-P2-5: prune, capacity cache and gate helper
// ---------------------------------------------------------------------------

test('C-P1-5 prune protects unsettled, hold-bearing and referenced tasks/operations', async () => {
  const harness = await createHarness();
  try {
    const ids = await harness.store.transaction(async (draft, tx) => {
      const tm = harness.taskManager;
      const settle = (kind) => {
        const task = tm.create(tx, { kind, principalId: harness.owner.id, inputHash: INPUT_HASH });
        tm.transition(tx, task, 'running');
        tm.transition(tx, task, 'succeeded');
        return task;
      };
      const removableA = settle('browse');
      const removableB = settle('diary');
      const approvalRef = settle('comment');
      draft.approvals.approval_prune = {
        id: 'approval_prune',
        taskId: approvalRef.id,
        action: 'comment.send',
        decision: 'pending',
        decidedAt: null,
        expiresAt: nowIso(harness.now),
        createdAt: nowIso(harness.now)
      };
      const outboxRef = settle('dm');
      draft.outbox.outbox_prune = {
        id: 'outbox_prune',
        taskId: outboxRef.id,
        status: 'sent',
        createdAt: nowIso(harness.now)
      };
      const unknownTask = tm.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      tm.transition(tx, unknownTask, 'running');
      tm.transition(tx, unknownTask, 'unknown', { verified: true });
      draft.operations.op_prune_unknown = {
        id: 'op_prune_unknown',
        status: 'unknown',
        taskIds: [unknownTask.id],
        dispatchAt: nowIso(harness.now),
        createdAt: nowIso(harness.now)
      };
      unknownTask.operationIds.push('op_prune_unknown');
      unknownTask.pendingOperationIds.push('op_prune_unknown');
      tm.recompute(tx, unknownTask);
      const holdTask = tm.create(tx, {
        kind: 'comment',
        principalId: harness.owner.id,
        inputHash: INPUT_HASH
      });
      tm.addHold(tx, holdTask, {
        kind: 'recovery',
        scope: { workspaceId: draft.workspaceId },
        scopeKey: 'workspace_test'
      });
      return {
        removable: [removableA.id, removableB.id],
        protectedIds: [approvalRef.id, outboxRef.id, unknownTask.id, holdTask.id]
      };
    });
    const result = await harness.store.prune({ maxTasks: 2, maxOperations: 0 });
    assert.equal(result.removedTasks, 2);
    assert.equal(result.removedOps, 0);
    const state = await harness.snapshot();
    for (const taskId of ids.removable) assert.equal(state.tasks[taskId], undefined);
    for (const taskId of ids.protectedIds) assert.ok(state.tasks[taskId], `task ${taskId} must be protected`);
    assert.ok(state.operations.op_prune_unknown);
    const pruned = eventsOfType(state, 'store.pruned');
    assert.equal(pruned.length, 1);
    assert.equal(pruned[0].payload.removedTasks, 2);

    const again = await harness.store.prune({ maxTasks: 2, maxOperations: 0 });
    assert.deepEqual(again, { removedTasks: 0, removedOps: 0 });
  } finally {
    await harness.cleanup();
  }
});

test('C-P2-2 capacity cache throttles scan-heavy paths while status stays exact', async () => {
  const harness = await createHarness();
  try {
    const recoveryDir = path.join(harness.dir, 'recovery');
    await fs.mkdir(recoveryDir, { recursive: true });
    await fs.writeFile(path.join(recoveryDir, 'ev1.bin'), Buffer.alloc(100, 1));
    const fresh1 = await harness.store.capacityStatus();
    assert.ok(fresh1.recoveryBytes >= 100);
    await harness.store.capacityStatus(null, { allowCache: true });
    await fs.writeFile(path.join(recoveryDir, 'ev2.bin'), Buffer.alloc(200, 2));
    const cached = await harness.store.capacityStatus(null, { allowCache: true });
    assert.equal(cached.recoveryBytes, fresh1.recoveryBytes);
    const fresh2 = await harness.store.capacityStatus();
    assert.ok(fresh2.recoveryBytes >= cached.recoveryBytes + 200);
    assert.ok(['healthy', 'warning', 'blocked'].includes(fresh2.status));
  } finally {
    await harness.cleanup();
  }
});

test('C-P2-5 capacity gate helper blocks new business at the hard limit', async () => {
  const harness = await createHarness();
  const originalLimits = harness.store.capacityLimits;
  try {
    assert.equal(JOURNAL_PENDING_LIMIT, 10000);
    harness.store.capacityLimits = { warningBytes: 1, hardBytes: 1 };
    await assert.rejects(
      () => harness.store.assertBusinessAcceptance(),
      (error) => error.code === 'STORE_CORRUPTED' && error.details.reason === 'capacity_limit'
    );
    await assert.rejects(
      () =>
        harness.store.transaction(async (draft, tx) => {
          tx.assertBusinessAcceptance();
        }),
      (error) => error.code === 'STORE_CORRUPTED'
    );
    harness.store.capacityLimits = originalLimits;
    await harness.store.assertBusinessAcceptance();
    await harness.store.transaction(async (draft, tx) => {
      assert.equal(tx.assertBusinessAcceptance(), true);
    });
  } finally {
    harness.store.capacityLimits = originalLimits;
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// C-P2-1: concurrent archival idempotency
// ---------------------------------------------------------------------------

test('C-P2-1 concurrent archival with the same segment hash is idempotent', async () => {
  const harness = await createHarness();
  try {
    let triggered = false;
    const outerJournal = new EventJournal({
      store: harness.store,
      dir: harness.paths.journalDir,
      now: harness.now,
      hooks: {
        async afterSegmentRename() {
          if (triggered) return;
          triggered = true;
          // Simulate a concurrent process confirming the same segment first.
          await harness.journal.flush();
        }
      }
    });
    await harness.store.transaction(async (draft, tx) => {
      for (let i = 0; i < 10; i += 1) tx.appendEvent({ type: 'x', payload: { i } });
    });
    const result = await outerJournal.flush();
    assert.equal(triggered, true);
    assert.equal(result.archived, 0);
    const state = await harness.snapshot();
    assert.equal(Object.keys(state.journalPending).length, 0);
    assert.equal(Object.keys(state.journalSegments).length, 1);
    const events = await harness.journal.readEvents();
    assert.equal(events.length, 10);
  } finally {
    await harness.cleanup();
  }
});

test('C-P2-1 archival still rejects a registered segment with a different hash', async () => {
  const harness = await createHarness();
  try {
    await harness.store.transaction(async (draft, tx) => {
      for (let i = 0; i < 3; i += 1) tx.appendEvent({ type: 'x', payload: { i } });
    });
    await harness.store.transaction(async (draft) => {
      draft.journalSegments['epoch_test:1-3'] = {
        key: 'epoch_test:1-3',
        relativePath: 'epoch_test/1-3-conflict.json',
        historyEpoch: 'epoch_test',
        startSeq: 1,
        endSeq: 3,
        hash: 'jcs-sha256-v1:' + '0'.repeat(64),
        count: 3,
        sizeBytes: 1,
        createdAt: nowIso(harness.now)
      };
    });
    await assert.rejects(() => harness.journal.flush(), (error) => error.code === 'JOURNAL_CORRUPTED');
    const state = await harness.snapshot();
    assert.equal(Object.keys(state.journalPending).length, 3);
    assert.equal(state.journalSegments['epoch_test:1-3'].hash, 'jcs-sha256-v1:' + '0'.repeat(64));
  } finally {
    await harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// C-P2-6 / C-P2-7: AgentClient.reconfigure, findLocalOwner, error redaction
// ---------------------------------------------------------------------------

test('C-P2-6 AgentClient.reconfigure swaps the config used for endpoint/model/enabled', async () => {
  const fetchImpl = createMockFetch(async () => responseJson({ choices: [{ message: { content: 'hello' } }] }));
  const agent = new AgentClient({
    config: { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, enabled: false } },
    fetchImpl,
    env: { DEEPSEEK_API_KEY: 'key' }
  });
  await assert.rejects(() => agent.generateText({ task: 'x', input: 'y' }), (error) => error.code === 'AGENT_DISABLED');
  agent.reconfigure({
    ...DEFAULT_CONFIG,
    agent: {
      ...DEFAULT_CONFIG.agent,
      enabled: true,
      baseUrl: 'https://agent.example/v1',
      model: 'model-two',
      timeoutMs: 12345
    }
  });
  assert.equal(agent.timeoutMs, 12345);
  const text = await agent.generateText({ task: 'x', input: 'y' });
  assert.equal(text, 'hello');
  const call = fetchImpl.calls.at(-1);
  assert.equal(call.url, 'https://agent.example/v1/chat/completions');
  assert.equal(JSON.parse(call.body).model, 'model-two');
  assert.throws(() => agent.reconfigure(null), (error) => error.code === 'CONFIG_INVALID');
});

test('C-P2-7 identity.findLocalOwner is a pure read that never mutates the ledger', async () => {
  const harness = await createHarness();
  try {
    const beforeText = await fs.readFile(harness.paths.stateFile, 'utf8');
    const state = await harness.snapshot();
    const owner = harness.identity.findLocalOwner(state);
    assert.equal(owner.id, harness.owner.id);
    const afterText = await fs.readFile(harness.paths.stateFile, 'utf8');
    assert.equal(afterText, beforeText);
    const revoked = structuredClone(state);
    revoked.principals[owner.id].revokedAt = nowIso(harness.now);
    assert.equal(harness.identity.findLocalOwner(revoked), null);
    assert.equal(harness.identity.findLocalOwner({ principals: {} }), null);
    assert.equal(harness.identity.findLocalOwner(null), null);
  } finally {
    await harness.cleanup();
  }
});

test('C-P2-7 AppError.toJSON redacts credential-shaped message text', async () => {
  const error = new AppError(
    'CONFIG_INVALID',
    'call failed SESSDATA=secret-cookie; bili_jct=csrf-token Bearer abcdefghijklmnop?token=topsecret',
    { details: {} }
  );
  const json = error.toJSON();
  assert.equal(json.code, 'CONFIG_INVALID');
  assert.equal(JSON.stringify(json).includes('secret-cookie'), false);
  assert.equal(JSON.stringify(json).includes('csrf-token'), false);
  assert.equal(JSON.stringify(json).includes('topsecret'), false);
  assert.equal(JSON.stringify(json).includes('abcdefghijklmnop'), false);
  assert.equal(json.message.includes('[redacted]'), true);
  assert.equal(redactSecretMessage('plain message'), 'plain message');
  assert.equal(redactSecretMessage(''), '');
});
