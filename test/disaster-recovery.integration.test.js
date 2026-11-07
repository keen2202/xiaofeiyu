import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupBackup } from './helpers/backup.js';
import { bindMockAccount } from './helpers/harness.js';
import { RecoveryService } from '../src/backup-recovery.js';
import { JsonStore } from '../src/store.js';
import { ConfigService } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { IdentityService } from '../src/identity.js';
import { ApprovalService } from '../src/approval.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { EffectGateway } from '../src/effect-gateway.js';
import { nowIso } from '../src/utils.js';

test('10:00 cut, 10:05 confirmed external effect, 10:06 loss: restore blocks repeat without inventing not_sent', async () => {
  const setup = await setupBackup();
  try {
    await bindMockAccount(setup.harness);
    const accountRef = { platform: 'bilibili', accountId: '1001' };
    const task = await setup.harness.store.transaction(async (draft, tx) => {
      const created = setup.harness.taskManager.create(tx, {
        kind: 'comment',
        principalId: setup.harness.owner.id,
        accountRef,
        inputHash: 'jcs-sha256-v1:' + 'a'.repeat(64)
      });
      setup.harness.taskManager.transition(tx, created, 'running', { approved: true });
      return created;
    });
    const cutTime = setup.harness.now();
    const backup = await setup.backup.create({ kind: 'full', requestId: 'cut-1000' }, setup.harness.humanContext);
    setup.harness.now.advance(5 * 60 * 1000);
    const businessKey = 'comment:bilibili:1001:BV1:after-cut';
    const sent = await setup.harness.effectGateway.executeOperation(
      {
        namespace: 'platform',
        action: 'comment',
        receiptAction: 'comment',
        recoveryAction: 'comment',
        accountRef,
        businessKey,
        taskIds: [task.id],
        inputHash: 'jcs-sha256-v1:' + 'b'.repeat(64),
        protected: true
      },
      async () => ({
        platform: 'bilibili',
        accountId: '1001',
        action: 'comment',
        externalId: 'rpid-after-cut',
        url: 'https://www.bilibili.com/video/BV1#reply',
        verification: 'platform_readback',
        receivedAt: nowIso(setup.harness.now)
      })
    );
    assert.equal(sent.operation.status, 'confirmed');
    const sourceAfter = await setup.harness.snapshot();
    assert.equal(sourceAfter.businessKeys[businessKey].status, 'confirmed');
    setup.harness.now.advance(60 * 1000);
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-dr-target-'));
    await fs.rm(targetDir, { recursive: true, force: true });
    const restoreService = new RecoveryService({
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now
    });
    const restored = await restoreService.restore(
      {
        from: path.join(setup.destinationRoot, 'backups', backup.backupId),
        to: targetDir,
        requestId: 'restore-1006'
      },
      setup.harness.humanContext
    );
    const targetStore = new JsonStore({
      file: path.join(targetDir, 'state.json'),
      instanceFile: path.join(targetDir, 'instance.json'),
      now: setup.harness.now
    });
    await targetStore.init({ bootstrap: false });
    try {
      const restoredState = await targetStore.getSnapshot();
      const instance = await targetStore.getInstance();
      assert.equal(instance.status, 'recovery-readonly');
      assert.equal(restoredState.businessKeys[businessKey], undefined);
      assert.equal(restoredState.operations[sent.operation.id], undefined);
      assert.equal(restoredState.recovery.holds.some((hold) => hold.scope.kind === 'account_action' && hold.scope.action === 'comment'), true);
      assert.equal(restoredState.historyEpoch !== sourceAfter.historyEpoch, true);
      const backupState = JSON.parse(
        await fs.readFile(path.join(setup.destinationRoot, 'backups', backup.backupId, 'state.json'), 'utf8')
      );
      assert.equal(restoredState.eventSeq, Object.keys(backupState.journalPending || {}).length);
      assert.ok(restoredState.eventSeq > 0);
      assert.equal(restoredState.tasks[task.id].status, 'interrupted');
      assert.equal(restoredState.tasks[task.id].holds.some((hold) => hold.kind === 'recovery'), true);
      assert.equal(restored.missingMedia.length >= 0, true);
      // Build a gateway on the restored copy. Even a deliberately active
      // instance projection cannot bypass the scope-level RecoveryHold.
      const configService = new ConfigService({ dataDir: setup.harness.dir, injected: setup.harness.config, env: {} });
      await configService.load();
      const taskManager = new TaskManager({ store: targetStore, now: setup.harness.now });
      const identity = new IdentityService({ store: targetStore, now: setup.harness.now });
      const approvalService = new ApprovalService({
        store: targetStore,
        taskManager,
        identity,
        humanProof: setup.harness.humanProof,
        now: setup.harness.now
      });
      const gateway = new EffectGateway({
        store: targetStore,
        taskManager,
        approvalService,
        identity,
        humanProof: setup.harness.humanProof,
        rateLimiter: new RateLimiter({ now: setup.harness.now, getTimeZone: () => 'Asia/Shanghai' }),
        configService,
        protection: { async getProtection() { return { status: 'protected' }; } },
        now: setup.harness.now
      });
      await assert.rejects(
        () => gateway.reserveOperation({
          namespace: 'platform',
          action: 'comment',
          accountRef,
          businessKey,
          taskIds: [task.id],
          inputHash: 'jcs-sha256-v1:' + 'b'.repeat(64),
          protected: true
        }),
        (error) => ['MIGRATION_BLOCKED', 'RECOVERY_GAP'].includes(error.code)
      );
      await targetStore.updateInstance((draft) => {
        draft.status = 'active';
        draft.allowedCapabilities = ['core:read', 'core:write', 'platform:bilibili'];
      });
      await assert.rejects(
        () => gateway.reserveOperation({
          namespace: 'platform',
          action: 'comment',
          accountRef,
          businessKey,
          taskIds: [task.id],
          inputHash: 'jcs-sha256-v1:' + 'b'.repeat(64),
          protected: true
        }),
        (error) => error.code === 'RECOVERY_GAP'
      );
      const afterAttempts = await targetStore.getSnapshot();
      assert.equal(afterAttempts.operations[sent.operation.id], undefined);
      assert.equal(Object.keys(afterAttempts.businessKeys).includes(businessKey), false);
      assert.equal(afterAttempts.tasks[task.id].status !== 'succeeded', true);
    } finally {
      await targetStore.close();
    }
    await fs.rm(targetDir, { recursive: true, force: true });
  } finally {
    await setup.cleanup();
  }
});
