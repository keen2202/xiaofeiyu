import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/harness.js';
import { ProductionModule } from '../src/modules/production.js';
import { LOCAL_SLIDESHOW_PROFILE } from '../src/production/profiles/local-slideshow.js';
import { nowIso } from '../src/utils.js';
import { FakeExecutionBackend } from './helpers/fake-execution-backend.js';

async function setup({ maxPaidCostMinor = 0, paidProvider = null, limits = {}, backend = null } = {}) {
  const harness = await createHarness({
    allowedCapabilities: ['core:read', 'core:write', 'production:local', 'production:paid'],
    overrides: {
      dryRun: false,
      security: { allowLocalProducer: true },
      production: {
        enabled: true,
        dryRun: false,
        limits: { wallTimeSec: 120, maxPaidCostMinor, currency: 'CNY', maxOutputBytes: 1048576 }
      }
    }
  });
  const production = new ProductionModule({
    store: harness.store,
    taskManager: harness.taskManager,
    configService: harness.configService,
    artifactStore: harness.artifactStore,
    effectGateway: harness.effectGateway,
    approvalService: harness.approvalService,
    journal: harness.journal,
    backend: backend || { async submit() {}, async wait() {} },
    profileLoader: async () => ({
      ...structuredClone(LOCAL_SLIDESHOW_PROFILE),
      bound: true,
      blocked: [],
      tools: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' }
    }),
    preflight: async () => ({ ok: true }),
    mediaValidator: async () => ({ ok: true }),
    paidProvider,
    now: harness.now
  });
  const script = await harness.importFile('script.txt', 'script', 'text');
  const image = await harness.importFile('image.png', 'image', 'image');
  return { harness, production, refs: [{ artifactId: script.artifactId }, { artifactId: image.artifactId }], limits };
}

function job(refs, overrides = {}) {
  return {
    requestId: `budget-${Math.random()}`,
    profileId: 'local-slideshow-v1',
    brief: 'x',
    inputs: refs,
    output: { container: 'mp4', width: 320, height: 240, fps: 10, maxDurationSec: 5 },
    mode: 'go',
    limits: { wallTimeSec: 60, maxPaidCostMinor: 0, currency: 'CNY' },
    ...overrides
  };
}

test('paid provider calls require an explicit ceiling and a configured provider', async () => {
  const noProvider = await setup();
  try {
    await assert.rejects(
      () => noProvider.production.create(
        job(noProvider.refs, { providerRefs: { text: { providerId: 'x', budgetId: 'b', amountMinor: 1 } } }),
        noProvider.harness.owner
      ),
      (error) => error.code === 'CAPABILITY_UNSUPPORTED'
    );
  } finally {
    await noProvider.harness.cleanup();
  }
  const provider = { id: 'x', async generateText() { return 'text'; } };
  const zeroBudget = await setup({ paidProvider: provider });
  try {
    await assert.rejects(
      () => zeroBudget.production.create(
        job(zeroBudget.refs, { providerRefs: { text: { providerId: 'x', budgetId: 'b', amountMinor: 1 } } }),
        zeroBudget.harness.owner
      ),
      (error) => error.code === 'BUDGET_EXCEEDED'
    );
  } finally {
    await zeroBudget.harness.cleanup();
  }
  const tooHigh = await setup({ maxPaidCostMinor: 10 });
  try {
    await assert.rejects(
      () => tooHigh.production.create(job(tooHigh.refs, { limits: { maxPaidCostMinor: 11 } }), tooHigh.harness.owner),
      (error) => error.code === 'BUDGET_EXCEEDED'
    );
  } finally {
    await tooHigh.harness.cleanup();
  }
});

test('unknown paid cost freezes the budget across a new business key', async () => {
  const harness = await createHarness({
    allowedCapabilities: ['core:read', 'core:write', 'production:paid']
  });
  try {
    const task = await harness.store.transaction(async (draft, tx) => {
      const created = harness.taskManager.create(tx, {
        kind: 'production',
        principalId: harness.owner.id,
        inputHash: 'jcs-sha256-v1:' + '6'.repeat(64)
      });
      harness.taskManager.transition(tx, created, 'running', { approved: true });
      return created;
    });
    const base = {
      namespace: 'provider',
      action: 'provider_call',
      accountRef: null,
      taskIds: [task.id],
      inputHash: task.inputHash,
      protected: true,
      budget: { provider: 'p', budgetId: 'b', currency: 'CNY', amountMinor: 50, capMinor: 100 }
    };
    const unknown = await harness.effectGateway.executeOperation({
      ...base,
      businessKey: 'provider:first'
    }, async () => {
      throw new Error('timeout');
    });
    assert.equal(unknown.operation.status, 'unknown');
    await assert.rejects(
      () => harness.effectGateway.reserveOperation({
        ...base,
        businessKey: 'provider:second',
        budget: { ...base.budget, amountMinor: 60 }
      }),
      (error) => error.code === 'BUDGET_EXCEEDED'
    );
    const resolved = await harness.effectGateway.resolve(
      { operationId: unknown.operation.id, decision: 'not_sent', note: 'provider confirms no charge' },
      harness.humanContext
    );
    assert.equal(resolved.operation.status, 'not_sent');
    const retry = await harness.effectGateway.reserveOperation({
      ...base,
      businessKey: 'provider:third',
      budget: { ...base.budget, amountMinor: 60 }
    });
    assert.equal(retry.operation.status, 'reserved');
  } finally {
    await harness.cleanup();
  }
});

test('paid text provider is reserved, approved and settled through EffectGateway', async () => {
  const calls = [];
  const provider = {
    id: 'mock-provider',
    async quote() {
      return { amountMinor: 10, currency: 'CNY' };
    },
    async generateText({ taskId, operationContext }) {
      calls.push({ taskId, operationContext });
      return {
        text: '由付费 provider 生成的叙述。',
        receipt: {
          platform: 'provider',
          accountId: 'mock-provider',
          action: 'provider_call',
          externalId: 'call_1',
          verification: 'publisher_receipt',
          receivedAt: new Date().toISOString()
        }
      };
    }
  };
  const built = await setup({ maxPaidCostMinor: 50, paidProvider: provider, backend: new FakeExecutionBackend() });
  try {
    const created = await built.production.create(
      job(built.refs, {
        providerRefs: { text: { providerId: 'mock-provider', budgetId: 'budget-1' } },
        limits: { wallTimeSec: 60, maxPaidCostMinor: 50, currency: 'CNY' }
      }),
      built.harness.owner
    );
    assert.equal(created.task.status, 'waiting_approval');
    const { approvalDecide } = await import('./helpers/harness.js');
    await approvalDecide(built.harness, { approvalId: created.approval.id, nonce: created.nonce });
    const result = await built.production.run({ taskId: created.task.id, mode: 'go', principal: built.harness.owner });
    assert.equal(result.task.status, 'succeeded');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operationContext.permit, 'dispatch-once');
    const state = await built.harness.snapshot();
    const budget = Object.values(state.budgets)[0];
    assert.equal(budget.spentMinor, 10);
    assert.equal(budget.reservedMinor, 0);
    const script = result.task.stages.find((entry) => entry.stage === 'script');
    assert.equal(script.checkpoint.providerText, '由付费 provider 生成的叙述。');
    assert.ok(script.checkpoint.providerOperationId);
  } finally {
    await built.harness.cleanup();
  }
});

test('paid provider unknown freezes budget and leaves readyForPublish=false', async () => {
  const provider = {
    id: 'mock-provider',
    async quote() {
      return { amountMinor: 10, currency: 'CNY' };
    },
    async generateText() {
      throw new Error('provider timeout');
    }
  };
  const built = await setup({ maxPaidCostMinor: 50, paidProvider: provider, backend: new FakeExecutionBackend() });
  try {
    const created = await built.production.create(
      job(built.refs, {
        providerRefs: { text: { providerId: 'mock-provider', budgetId: 'budget-2' } },
        limits: { wallTimeSec: 60, maxPaidCostMinor: 50, currency: 'CNY' }
      }),
      built.harness.owner
    );
    const { approvalDecide } = await import('./helpers/harness.js');
    await approvalDecide(built.harness, { approvalId: created.approval.id, nonce: created.nonce });
    const result = await built.production.run({ taskId: created.task.id, mode: 'go', principal: built.harness.owner });
    assert.equal(result.task.status, 'unknown');
    assert.equal(result.task.result.readyForPublish, false);
    const state = await built.harness.snapshot();
    const budget = Object.values(state.budgets)[0];
    assert.equal(budget.unknownMinor, 10);
    assert.equal(budget.spentMinor, 0);
  } finally {
    await built.harness.cleanup();
  }
});
