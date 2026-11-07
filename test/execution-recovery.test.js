import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';
import { ProductionModule } from '../src/modules/production.js';
import { processStartIso } from '../src/utils.js';

function makeProduction(harness) {
  return new ProductionModule({
    store: harness.store,
    taskManager: harness.taskManager,
    configService: harness.configService,
    artifactStore: harness.artifactStore,
    effectGateway: harness.effectGateway,
    approvalService: harness.approvalService,
    journal: harness.journal,
    backend: { async submit() {}, async wait() {}, async close() {} },
    profileLoader: async () => ({ id: 'local-slideshow-v1', version: '1.0.0', bound: true, tools: {}, blocked: [] }),
    preflight: async () => ({ ok: true }),
    mediaValidator: async () => ({ ok: true }),
    now: harness.now
  });
}

test('startup recovery marks orphaned executions interrupted without respawn', async () => {
  const harness = await createHarness();
  try {
    const production = makeProduction(harness);
    const taskId = await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'production',
        principalId: harness.owner.id,
        inputHash: 'jcs-sha256-v1:' + '4'.repeat(64),
        input: {
          profileId: 'local-slideshow-v1',
          profileVersion: '1.0.0',
          output: { maxDurationSec: 5 },
          limits: { wallTimeSec: 60, maxOutputBytes: 1000 },
          scriptArtifactId: 'artifact_none',
          visualArtifactIds: []
        }
      });
      harness.taskManager.transition(tx, task, 'running', { approved: true });
      task.stages = [{ stage: 'render', status: 'running', checkpoint: null }];
      task.executionIds = ['exec_orphan'];
      draft.executions.exec_orphan = {
        executionId: 'exec_orphan',
        taskId: task.id,
        stageId: 'render',
        attempt: 1,
        status: 'accepted',
        inputHash: task.inputHash,
        ownerPid: 999999,
        processStartedAt: new Date(0).toISOString(),
        createdAt: new Date().toISOString(),
        finishedAt: null
      };
      return task.id;
    });
    const result = await production.recoverInterrupted();
    assert.equal(result.affected.includes(taskId), true);
    const state = await harness.snapshot();
    assert.equal(state.executions.exec_orphan.status, 'interrupted');
    assert.equal(state.tasks[taskId].status, 'interrupted');
    assert.equal(state.tasks[taskId].stages[0].status, 'interrupted');
    assert.equal(state.tasks[taskId].result.readyForPublish, false);
    assert.equal((await production.getStatus(taskId)).production, null);
  } finally {
    await harness.cleanup();
  }
});

test('an execution owned by a live identical process is not stolen', async () => {
  const harness = await createHarness();
  try {
    const production = makeProduction(harness);
    await harness.store.transaction(async (draft, tx) => {
      const task = harness.taskManager.create(tx, {
        kind: 'production',
        principalId: harness.owner.id,
        inputHash: 'jcs-sha256-v1:' + '5'.repeat(64),
        input: { profileId: 'local-slideshow-v1' }
      });
      harness.taskManager.transition(tx, task, 'running', { approved: true });
      draft.executions.live = {
        executionId: 'live',
        taskId: task.id,
        stageId: 'render',
        attempt: 1,
        status: 'running',
        ownerPid: process.pid,
        processStartedAt: processStartIso(),
        createdAt: new Date().toISOString()
      };
    });
    const result = await production.recoverInterrupted();
    assert.equal(result.affected.length, 0);
    assert.equal((await harness.snapshot()).executions.live.status, 'running');
  } finally {
    await harness.cleanup();
  }
});
