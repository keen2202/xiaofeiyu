import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, approvalDecide } from './helpers/harness.js';
import { PublisherModule } from '../src/modules/publisher.js';

const FAKE_PUBLISHER = fileURLToPath(new URL('./helpers/fake-publisher.mjs', import.meta.url));

async function setup({ externalMode = 'success', overrides = {} } = {}) {
  const harness = await createHarness({
    allowedCapabilities: [
      'core:read', 'core:write', 'platform:bilibili', 'production:local',
      'publish:manual', 'publish:external'
    ],
    overrides: {
      dryRun: false,
      security: { allowExternalPublisher: true, allowedSourceDirs: [] },
      publishing: {
        enabled: true,
        dryRun: false,
        requireApproval: true,
        provider: 'manual',
        outputDir: '',
        external: {
          command: process.execPath,
          args: [FAKE_PUBLISHER, externalMode, '{video}', '{cover}', '{title}', '{bundleDir}'],
          timeoutMs: 10000,
          successJson: true
        }
      },
      ...overrides
    }
  });
  const publisher = new PublisherModule({
    store: harness.store,
    taskManager: harness.taskManager,
    approvalService: harness.approvalService,
    humanProof: harness.humanProof,
    artifactStore: harness.artifactStore,
    configService: harness.configService,
    effectGateway: harness.effectGateway,
    now: harness.now
  });
  const video = await harness.importFile('video.mp4', 'video', 'fake video bytes');
  const cover = await harness.importFile('cover.jpg', 'cover', 'fake cover bytes');
  return { harness, publisher, video, cover };
}

function job(harness, video, cover, overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: `publish-${Math.random()}`,
    productionTaskId: null,
    videoArtifactId: video.artifactId,
    coverArtifactId: cover.artifactId,
    accountRef: { platform: 'bilibili', accountId: '1001' },
    metadata: { title: '测试投稿', description: 'desc', tags: ['tag'], platformData: { tid: 1 } },
    provider: 'manual',
    mode: 'go',
    ...overrides
  };
}

async function bind(harness) {
  await harness.store.transaction(async (draft) => {
    draft.accounts['bilibili:1001'] = {
      accountRef: { platform: 'bilibili', accountId: '1001' },
      mid: '1001',
      uname: 'tester',
      credentialRevision: 'r',
      devId: 'dev',
      boundAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
      verifiedFrom: 'whoami'
    };
    draft.activeAccountRef = { platform: 'bilibili', accountId: '1001' };
  });
}

test('manual publishing creates a bundle, waits for a human assertion and then succeeds', async () => {
  const { harness, publisher, video, cover } = await setup();
  await bind(harness);
  try {
    const created = await publisher.create(job(harness, video, cover), harness.owner);
    assert.equal(created.task.status, 'waiting_approval');
    await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
    const prepared = await publisher.prepare({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(prepared.awaitingManual, true);
    assert.equal(prepared.task.status, 'awaiting_manual');
    assert.equal(prepared.task.isSettled, false);
    const metadata = JSON.parse(await fs.readFile(path.join(prepared.bundleDir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.published, false);
    assert.equal(metadata.operationId, null);
    const completed = await publisher.complete(
      { taskId: created.task.id, bvid: 'BV1xx411c7mD', note: 'manually uploaded' },
      harness.humanContext
    );
    assert.equal(completed.task.status, 'succeeded');
    assert.equal(completed.publish.status, 'published');
    assert.equal(completed.receipt.verification, 'manual_assertion');
    const again = await publisher.complete(
      { taskId: created.task.id, bvid: 'BV1xx411c7mD', note: 'same' },
      harness.humanContext
    );
    assert.equal(again.deduplicated, true);
    await assert.rejects(
      () => publisher.complete({ taskId: created.task.id, bvid: 'BV1yyyyyyyyy', note: 'conflict' }, harness.humanContext),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    await harness.cleanup();
  }
});

test('artifact replacement after approval is rejected before bundle creation', async () => {
  const { harness, publisher, video, cover } = await setup();
  await bind(harness);
  try {
    const created = await publisher.create(job(harness, video, cover), harness.owner);
    await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
    const record = await harness.artifactStore.getArtifact(video.artifactId);
    const file = path.join(harness.paths.artifactsDir, record.relativePath);
    await fs.chmod(file, 0o644);
    await fs.writeFile(file, 'replaced');
    await assert.rejects(
      () => publisher.prepare({ taskId: created.task.id, mode: 'go', principal: harness.owner }),
      (error) => error.code === 'ARTIFACT_INVALID'
    );
  } finally {
    await harness.cleanup();
  }
});

test('dry publishing writes no bundle and is not published', async () => {
  const { harness, publisher, video, cover } = await setup();
  await bind(harness);
  try {
    const result = await publisher.create(job(harness, video, cover, { mode: 'dry' }), harness.owner);
    assert.equal(result.dryRun, true);
    assert.equal(result.task.status, 'succeeded');
    assert.equal(result.publish.status, 'dry_run');
    assert.equal(result.task.result.readyForPublish, false);
  } finally {
    await harness.cleanup();
  }
});

test('external publisher uses a fixed execFile and confirms a structured receipt', async () => {
  const { harness, publisher, video, cover } = await setup();
  await bind(harness);
  try {
    const created = await publisher.create(job(harness, video, cover, { provider: 'external' }), harness.owner);
    assert.equal(created.task.status, 'waiting_approval');
    await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
    const result = await publisher.prepare({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(result.operation.status, 'confirmed');
    assert.equal(result.task.status, 'succeeded');
    assert.equal(result.publish.receipt.verification, 'publisher_receipt');
    assert.equal(result.publish.receipt.externalId, 'BV1xx411c7mD');
  } finally {
    await harness.cleanup();
  }
});

test('external invalid output after start becomes unknown and is resolved on the original operation', async () => {
  const { harness, publisher, video, cover } = await setup({ externalMode: 'invalid-after-start' });
  await bind(harness);
  try {
    const created = await publisher.create(job(harness, video, cover, { provider: 'external' }), harness.owner);
    await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
    const prepared = await publisher.prepare({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(prepared.operation.status, 'unknown');
    assert.equal(prepared.task.status, 'unknown');
    const operationId = prepared.publish.externalOperationId;
    const receipt = {
      platform: 'bilibili',
      accountId: '1001',
      action: 'publish_external',
      externalId: 'BV1xx411c7mD',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      verification: 'platform_readback',
      receivedAt: new Date().toISOString()
    };
    const resolved = await publisher.resolveExternal(
      { taskId: created.task.id, decision: 'confirmed', receipt, note: 'readback verified' },
      harness.humanContext
    );
    assert.equal(resolved.operation.id, operationId);
    assert.equal(resolved.operation.status, 'confirmed');
    assert.equal(resolved.publish.status, 'published');
  } finally {
    await harness.cleanup();
  }
});

test('external missing configuration does not fall back to manual', async () => {
  const { harness, publisher, video, cover } = await setup({
    overrides: { security: { allowExternalPublisher: false } }
  });
  await bind(harness);
  try {
    await assert.rejects(
      () => publisher.create(job(harness, video, cover, { provider: 'external' }), harness.owner),
      (error) => error.code === 'EXTERNAL_PUBLISH_DISABLED'
    );
  } finally {
    await harness.cleanup();
  }
});

test('a dry publish record does not block a later real publish request', async () => {
  const { harness, publisher, video, cover } = await setup();
  await bind(harness);
  try {
    const dry = await publisher.create(job(harness, video, cover, { mode: 'dry' }), harness.owner);
    assert.equal(dry.task.status, 'succeeded');
    const real = await publisher.create(job(harness, video, cover, { mode: 'go' }), harness.owner);
    assert.notEqual(real.task.id, dry.task.id);
    assert.equal(real.task.status, 'waiting_approval');
    assert.ok(real.nonce);
  } finally {
    await harness.cleanup();
  }
});
