import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupBackup } from './helpers/backup.js';
import { RecoveryService } from '../src/backup-recovery.js';
import { JsonStore } from '../src/store.js';
import { EventJournal } from '../src/event-journal.js';
import { ConfigService } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { IdentityService } from '../src/identity.js';
import { DiaryModule } from '../src/modules/diary.js';

test('diary rebuild after recovery includes facts archived before the parent cut', async () => {
  const setup = await setupBackup({
    harnessOptions: { overrides: { diary: { enabled: true, publicBook: true } } }
  });
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-recovery-diary-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  try {
    await setup.harness.store.transaction(async (draft, tx) => {
      tx.appendEvent({
        type: 'browse.round.completed',
        actor: 'test',
        payload: { selected: [{ bvid: 'BVparent' }], failed: [] }
      });
    });
    const flushed = await setup.harness.journal.flush();
    assert.equal(flushed.archived, 1);
    const backup = await setup.backup.create({ kind: 'full', requestId: 'diary-parent-cut' }, setup.harness.humanContext);
    const restore = new RecoveryService({
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now
    });
    const restored = await restore.restore(
      {
        from: path.join(setup.destinationRoot, 'backups', backup.backupId),
        to: targetDir,
        requestId: 'diary-parent-restore'
      },
      setup.harness.humanContext
    );
    const store = new JsonStore({
      file: path.join(targetDir, 'state.json'),
      instanceFile: path.join(targetDir, 'instance.json'),
      now: setup.harness.now
    });
    await store.init({ bootstrap: false });
    try {
      const configService = new ConfigService({
        dataDir: targetDir,
        injected: setup.harness.config,
        env: {},
        now: setup.harness.now
      });
      await configService.load();
      const journal = new EventJournal({ store, dir: path.join(targetDir, 'journal'), now: setup.harness.now });
      const taskManager = new TaskManager({ store, now: setup.harness.now });
      const identity = new IdentityService({ store, now: setup.harness.now });
      const recovery = new RecoveryService({
        store,
        configService,
        recoveryDir: path.join(targetDir, 'recovery'),
        humanProof: setup.harness.humanProof,
        taskManager,
        now: setup.harness.now
      });
      const stateBefore = await store.getSnapshot();
      const workspaceScope = { kind: 'workspace', workspaceId: stateBefore.workspaceId };
      const isolation = await recovery.reconcile(
        {
          recoveryId: restored.recoveryId,
          evidence: {
            kind: 'isolation',
            source: 'owner',
            sourceHash: 'sha256:' + 'f'.repeat(64),
            conclusion: 'isolated'
          }
        },
        setup.harness.humanContext
      );
      await recovery.authorize(
        { recoveryId: restored.recoveryId, scope: workspaceScope, evidenceId: isolation.evidenceId },
        setup.harness.humanContext
      );
      const owner = await store.transaction(async (draft) => {
        const principal = Object.values(draft.principals).find(
          (entry) => entry.kind === 'human' && entry.role === 'owner'
        );
        principal.scopes = ['*'];
        principal.requiresReverification = false;
        return principal;
      });
      const diary = new DiaryModule({
        store,
        journal,
        configService,
        identity,
        diaryDir: path.join(targetDir, 'diary'),
        now: setup.harness.now
      });
      const generated = await diary.generate({
        date: '2026-11-07',
        scope: `workspace/${stateBefore.workspaceId}`,
        book: 'public',
        principal: owner
      });
      assert.equal(generated.facts.browseRounds, 1);
      assert.equal(generated.facts.eventCount >= 1, true);
      assert.match(generated.content, /轮次：1/);
    } finally {
      await store.close();
    }
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
    await setup.cleanup();
  }
});

test('diary rebuild tolerates a backup cut with unflushed parent events', async () => {
  const setup = await setupBackup({
    harnessOptions: { overrides: { diary: { enabled: true, publicBook: true } } }
  });
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-recovery-diary-pending-'));
  await fs.rm(targetDir, { recursive: true, force: true });
  try {
    await setup.harness.store.transaction(async (draft, tx) => {
      tx.appendEvent({
        type: 'browse.round.completed',
        actor: 'test',
        payload: { selected: [{ bvid: 'BVpending' }], failed: [] }
      });
    });
    const backup = await setup.backup.create({ kind: 'full', requestId: 'diary-pending-cut' }, setup.harness.humanContext);
    const restore = new RecoveryService({
      recoveryDir: path.join(targetDir, 'recovery'),
      humanProof: setup.harness.humanProof,
      now: setup.harness.now
    });
    const restored = await restore.restore(
      {
        from: path.join(setup.destinationRoot, 'backups', backup.backupId),
        to: targetDir,
        requestId: 'diary-pending-restore'
      },
      setup.harness.humanContext
    );
    const store = new JsonStore({
      file: path.join(targetDir, 'state.json'),
      instanceFile: path.join(targetDir, 'instance.json'),
      now: setup.harness.now
    });
    await store.init({ bootstrap: false });
    try {
      const configService = new ConfigService({
        dataDir: targetDir,
        injected: setup.harness.config,
        env: {},
        now: setup.harness.now
      });
      await configService.load();
      const journal = new EventJournal({ store, dir: path.join(targetDir, 'journal'), now: setup.harness.now });
      const taskManager = new TaskManager({ store, now: setup.harness.now });
      const identity = new IdentityService({ store, now: setup.harness.now });
      const recovery = new RecoveryService({
        store,
        configService,
        recoveryDir: path.join(targetDir, 'recovery'),
        humanProof: setup.harness.humanProof,
        taskManager,
        now: setup.harness.now
      });
      const stateBefore = await store.getSnapshot();
      const isolation = await recovery.reconcile(
        {
          recoveryId: restored.recoveryId,
          evidence: {
            kind: 'isolation',
            source: 'owner',
            sourceHash: 'sha256:' + 'a'.repeat(64),
            conclusion: 'isolated'
          }
        },
        setup.harness.humanContext
      );
      await recovery.authorize(
        {
          recoveryId: restored.recoveryId,
          scope: { kind: 'workspace', workspaceId: stateBefore.workspaceId },
          evidenceId: isolation.evidenceId
        },
        setup.harness.humanContext
      );
      const owner = await store.transaction(async (draft) => {
        const principal = Object.values(draft.principals).find(
          (entry) => entry.kind === 'human' && entry.role === 'owner'
        );
        principal.scopes = ['*'];
        principal.requiresReverification = false;
        return principal;
      });
      const diary = new DiaryModule({
        store,
        journal,
        configService,
        identity,
        diaryDir: path.join(targetDir, 'diary'),
        now: setup.harness.now
      });
      const generated = await diary.generate({
        date: '2026-11-07',
        scope: `workspace/${stateBefore.workspaceId}`,
        book: 'public',
        principal: owner
      });
      assert.equal(generated.facts.browseRounds, 1);
      assert.match(generated.content, /轮次：1/);
    } finally {
      await store.close();
    }
  } finally {
    await fs.rm(targetDir, { recursive: true, force: true });
    await setup.cleanup();
  }
});
