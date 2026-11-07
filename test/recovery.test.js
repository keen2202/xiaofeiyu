import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupBackup } from './helpers/backup.js';
import { bindMockAccount } from './helpers/harness.js';
import { RecoveryService } from '../src/backup-recovery.js';
import { JsonStore } from '../src/store.js';
import { makeReceipt } from '../src/contracts.js';
import { normalizeScope } from '../src/contracts.js';

async function restoreBackup({ kind = 'full', missingMedia = false } = {}) {
  const setup = await setupBackup();
  await bindMockAccount(setup.harness);
  let artifact = null;
  if (kind === 'full' || missingMedia) {
    artifact = await setup.harness.importFile('image.png', 'image', 'image-bytes');
  }
  if (missingMedia) {
    const record = await setup.harness.artifactStore.getArtifact(artifact.artifactId);
    await fs.chmod(path.join(setup.harness.paths.artifactsDir, record.relativePath), 0o644);
    await fs.rm(path.join(setup.harness.paths.artifactsDir, record.relativePath));
  }
  const backup = await setup.backup.create({ kind, requestId: `restore-${kind}` }, setup.harness.humanContext);
  const backupDir = path.join(setup.destinationRoot, 'backups', backup.backupId);
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-recovery-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  const recovery = new RecoveryService({
    recoveryDir: path.join(targetDir, 'recovery'),
    humanProof: setup.harness.humanProof,
    now: setup.harness.now
  });
  const restored = await recovery.restore(
    { from: backupDir, to: targetDir, requestId: 'restore-request' },
    setup.harness.humanContext
  );
  const store = new JsonStore({
    file: path.join(targetDir, 'state.json'),
    instanceFile: path.join(targetDir, 'instance.json'),
    now: setup.harness.now
  });
  await store.init({ bootstrap: false });
  const inspectService = new RecoveryService({
    store,
    recoveryDir: path.join(targetDir, 'recovery'),
    humanProof: setup.harness.humanProof,
    now: setup.harness.now
  });
  return { ...setup, artifact, backup, backupDir, targetDir, restored, store, recovery: inspectService };
}

test('restore creates a read-only new epoch and preserves permanent keys/unknowns', async () => {
  const ctx = await restoreBackup({ kind: 'full' });
  try {
    const state = await ctx.store.getSnapshot();
    const instance = await ctx.store.getInstance();
    assert.notEqual(state.historyEpoch, 'epoch_test');
    const backupState = JSON.parse(await fs.readFile(path.join(ctx.backupDir, 'state.json'), 'utf8'));
    assert.equal(state.eventSeq, Object.keys(backupState.journalPending || {}).length);
    assert.equal(state.events.length, state.eventSeq);
    assert.equal(instance.status, 'recovery-readonly');
    assert.deepEqual(instance.allowedCapabilities, []);
    assert.equal(state.recovery.phase, 'readonly');
    assert.equal(state.recovery.holds.length > 0, true);
    assert.equal(state.recovery.parent.backupId, ctx.backup.backupId);
    assert.equal(state.recovery.parent.sourceHistoryEpoch, 'epoch_test');
    assert.equal(Object.values(state.approvals).every((approval) => approval.usableForAuthorization === false), true);
    assert.equal(Object.keys(state.bindings).length, 0);
    assert.equal(Object.values(state.artifacts)[0].availability, 'available');
    assert.equal(Object.values(state.tasks).every((task) => ['succeeded', 'cancelled', 'interrupted'].includes(task.status)), true);
    const inspected = await ctx.recovery.inspect(ctx.restored.recoveryId);
    assert.equal(inspected.projectionConsistent, true);
    assert.equal(inspected.dispatchAllowed, false);
    assert.equal(inspected.phase, 'readonly');
  } finally {
    await ctx.store.close();
    await ctx.cleanup();
    await fs.rm(ctx.targetDir, { recursive: true, force: true });
  }
});

test('ledger restore reports missing media and never marks productions ready', async () => {
  const ctx = await restoreBackup({ kind: 'ledger', missingMedia: true });
  try {
    const state = await ctx.store.getSnapshot();
    assert.equal(state.recovery.missingMedia.length, 1);
    const artifact = Object.values(state.artifacts)[0];
    assert.equal(artifact.availability, 'unavailable');
    assert.equal(Object.values(state.productions).every((production) => production.readyForPublish === false), true);
  } finally {
    await ctx.store.close();
    await ctx.cleanup();
    await fs.rm(ctx.targetDir, { recursive: true, force: true });
  }
});

test('reconcile records fencing evidence without granting write access', async () => {
  const ctx = await restoreBackup({ kind: 'full' });
  try {
    const reconciled = await ctx.recovery.reconcile(
      {
        recoveryId: ctx.restored.recoveryId,
        evidence: {
          kind: 'isolation',
          source: 'owner:storage-isolation',
          sourceHash: 'sha256:' + 'a'.repeat(64),
          conclusion: 'isolated',
          note: 'old machine powered off and credentials revoked',
          scope: { kind: 'workspace', workspaceId: (await ctx.store.getSnapshot()).workspaceId }
        }
      },
      ctx.harness.humanContext
    );
    assert.equal(reconciled.phase, 'reconciling');
    assert.equal(reconciled.fencingEvidence, true);
    const state = await ctx.store.getSnapshot();
    assert.equal(state.recovery.phase, 'reconciling');
    assert.equal(state.recovery.holds.every((hold) => hold.status === 'active'), true);
    const instance = await ctx.store.getInstance();
    assert.equal(instance.status, 'recovery-readonly');
  } finally {
    await ctx.store.close();
    await ctx.cleanup();
    await fs.rm(ctx.targetDir, { recursive: true, force: true });
  }
});

test('authorize releases only the requested scope with evidence at the current revision', async () => {
  const ctx = await restoreBackup({ kind: 'full' });
  try {
    const workspaceId = (await ctx.store.getSnapshot()).workspaceId;
    const reconciled = await ctx.recovery.reconcile(
      {
        recoveryId: ctx.restored.recoveryId,
        evidence: {
          kind: 'isolation',
          source: 'owner:storage-isolation',
          sourceHash: 'sha256:' + 'b'.repeat(64),
          conclusion: 'isolated'
        }
      },
      ctx.harness.humanContext
    );
    const before = await ctx.store.getSnapshot();
    const activeBefore = before.recovery.holds.filter((hold) => hold.status === 'active');
    const commentHold = activeBefore.find(
      (hold) => hold.scope.kind === 'account_action' && hold.scope.action === 'comment'
    );
    assert.ok(commentHold);
    const authorized = await ctx.recovery.authorize(
      {
        recoveryId: ctx.restored.recoveryId,
        scope: commentHold.scope,
        evidenceId: reconciled.evidenceId
      },
      ctx.harness.humanContext
    );
    assert.equal(authorized.phase, 'restricted');
    const state = await ctx.store.getSnapshot();
    const instance = await ctx.store.getInstance();
    const commentHolds = state.recovery.holds.filter(
      (hold) => hold.scope.kind === 'account_action' && hold.scope.action === 'comment' && hold.status === 'active'
    );
    assert.equal(commentHolds.length, 0);
    assert.equal(state.recovery.holds.some((hold) => hold.status === 'active'), true);
    assert.equal(instance.status, 'active');
    assert.equal(instance.allowedCapabilities.includes('platform:bilibili'), true);
    const inspected = await ctx.recovery.inspect(ctx.restored.recoveryId);
    assert.equal(inspected.phase, 'restricted');
    assert.equal(inspected.decisions.length, 1);
  } finally {
    await ctx.store.close();
    await ctx.cleanup();
    await fs.rm(ctx.targetDir, { recursive: true, force: true });
  }
});

test('authorize without isolation evidence fails closed; instance projection crash leaves dispatch blocked', async () => {
  const ctx = await restoreBackup({ kind: 'full' });
  try {
    const workspaceId = (await ctx.store.getSnapshot()).workspaceId;
    const commentHold = (await ctx.store.getSnapshot()).recovery.holds.find(
      (hold) => hold.scope.kind === 'account_action' && hold.scope.action === 'comment'
    );
    await assert.rejects(
      () => ctx.recovery.authorize(
        { recoveryId: ctx.restored.recoveryId, scope: commentHold.scope, evidenceId: 'missing' },
        ctx.harness.humanContext
      ),
      (error) => error.code === 'RECOVERY_FENCING_REQUIRED'
    );
    const reconciled = await ctx.recovery.reconcile(
      {
        recoveryId: ctx.restored.recoveryId,
        evidence: {
          kind: 'isolation',
          source: 'owner',
          sourceHash: 'sha256:' + 'c'.repeat(64),
          conclusion: 'isolated'
        }
      },
      ctx.harness.humanContext
    );
    const { RecoveryService } = await import('../src/backup-recovery.js');
    const failing = new RecoveryService({
      store: ctx.store,
      recoveryDir: path.join(ctx.targetDir, 'recovery'),
      humanProof: ctx.harness.humanProof,
      now: ctx.harness.now,
      hooks: {
        beforeInstanceUpdate() {
          throw Object.assign(new Error('power cut before instance activation'), { code: 'RECOVERY_FENCING_REQUIRED' });
        }
      }
    });
    await assert.rejects(
      () => failing.authorize(
        { recoveryId: ctx.restored.recoveryId, scope: commentHold.scope, evidenceId: reconciled.evidenceId },
        ctx.harness.humanContext
      ),
      /power cut/
    );
    const instance = await ctx.store.getInstance();
    assert.equal(instance.status, 'recovery-readonly');
    assert.deepEqual(instance.allowedCapabilities, []);
  } finally {
    await ctx.store.close();
    await ctx.cleanup();
    await fs.rm(ctx.targetDir, { recursive: true, force: true });
  }
});

test('restore refuses a non-empty target', async () => {
  const setup = await setupBackup();
  try {
    const backup = await setup.backup.create({ kind: 'ledger', requestId: 'ne' }, setup.harness.humanContext);
    const dir = await setup.harness.store.getSnapshot();
    const target = path.join(setup.harness.dir, 'non-empty-target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'keep.txt'), 'keep');
    const recovery = new RecoveryService({
      recoveryDir: path.join(target, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now
    });
    await assert.rejects(
      () => recovery.restore(
        {
          from: path.join(setup.destinationRoot, 'backups', backup.backupId),
          to: target,
          requestId: 'non-empty'
        },
        setup.harness.humanContext
      ),
      (error) => error.code === 'RECOVERY_REQUIRED'
    );
  } finally {
    await setup.cleanup();
  }
});
