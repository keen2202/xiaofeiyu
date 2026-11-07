import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, approvalDecide } from './helpers/harness.js';
import { ProductionModule } from '../src/modules/production.js';
import { FakeExecutionBackend } from './helpers/fake-execution-backend.js';
import { LOCAL_SLIDESHOW_PROFILE } from '../src/production/profiles/local-slideshow.js';

function fakeProfile() {
  return {
    ...structuredClone(LOCAL_SLIDESHOW_PROFILE),
    version: '1.0.0',
    bound: true,
    blocked: [],
    tools: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' }
  };
}

async function setup({ production = {}, preflight = null, mediaValidator = null, audioProbe = null, backend = null } = {}) {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      security: { allowLocalProducer: true },
      production: {
        enabled: true,
        dryRun: false,
        requireApproval: true,
        limits: { wallTimeSec: 120, maxPaidCostMinor: 0, currency: 'CNY', maxOutputBytes: 1048576 },
        ...production
      }
    }
  });
  let backendCalls = 0;
  const executionBackend = backend || new FakeExecutionBackend();
  const productionModule = new ProductionModule({
    store: harness.store,
    taskManager: harness.taskManager,
    configService: harness.configService,
    artifactStore: harness.artifactStore,
    effectGateway: harness.effectGateway,
    approvalService: harness.approvalService,
    journal: harness.journal,
    backend: executionBackend,
    profileLoader: async () => fakeProfile(),
    preflight: preflight || (async () => ({ ok: true, tools: {} })),
    mediaValidator:
      mediaValidator ||
      (async () => ({
        ok: true,
        media: { width: 320, height: 240, fps: 10, duration: 5, hasAudio: false, hasSubtitle: false, sizeBytes: 16 }
      })),
    audioProbe: audioProbe || (async () => ({ durationSec: 3 })),
    now: harness.now
  });
  return { harness, production: productionModule, backend: executionBackend };
}

async function inputs(harness) {
  const script = await harness.importFile('script.txt', 'script', '这是脚本正文。\n\n第二段。');
  const image = await harness.importFile('image.png', 'image', 'fake image bytes');
  return [
    { artifactId: script.artifactId },
    { artifactId: image.artifactId }
  ];
}

function job(harness, refs, overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: `production-${Math.random()}`,
    profileId: 'local-slideshow-v1',
    brief: 'test',
    inputs: refs,
    output: { container: 'mp4', width: 320, height: 240, fps: 10, maxDurationSec: 5 },
    mode: 'go',
    limits: { wallTimeSec: 60, maxPaidCostMinor: 0, currency: 'CNY' },
    ...overrides
  };
}

test('dry run produces a plan, zero backend calls and readyForPublish=false', async () => {
  const { harness, production, backend } = await setup();
  try {
    const refs = await inputs(harness);
    const result = await production.create(job(harness, refs, { mode: 'dry' }), harness.owner);
    assert.equal(result.dryRun, true);
    assert.equal(result.task.status, 'succeeded');
    assert.equal(result.task.result.readyForPublish, false);
    assert.equal(backend.requests.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('approved go runs fixed stages, imports real artifact bytes and becomes readyForPublish', async () => {
  const { harness, production, backend } = await setup();
  try {
    const refs = await inputs(harness);
    const created = await production.create(job(harness, refs), harness.owner);
    assert.equal(created.task.status, 'waiting_approval');
    assert.ok(created.nonce);
    await assert.rejects(
      () => production.run({ taskId: created.task.id, mode: 'go', principal: harness.owner }),
      (error) => error.code === 'APPROVAL_REQUIRED'
    );
    await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
    const result = await production.run({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(result.task.status, 'succeeded');
    assert.equal(result.task.result.readyForPublish, true);
    assert.equal(backend.requests.length, 1);
    const state = await harness.snapshot();
    const productionRecord = state.productions[created.task.id];
    assert.equal(productionRecord.readyForPublish, true);
    assert.equal(productionRecord.media.width, 320);
    const stages = Object.fromEntries(result.task.stages.map((entry) => [entry.stage, entry.status]));
    assert.equal(stages.script, 'succeeded');
    assert.equal(stages.assets, 'succeeded');
    assert.equal(stages.voice, 'skipped');
    assert.equal(stages.render, 'succeeded');
    assert.equal(stages.validate, 'succeeded');
    const videoArtifact = state.artifacts[productionRecord.artifacts.video.artifactId];
    assert.equal(videoArtifact.role, 'video');
    assert.equal(videoArtifact.sha256, productionRecord.artifacts.video.sha256);
    assert.equal(JSON.stringify(productionRecord.manifest).includes('/tmp'), false);
  } finally {
    await harness.cleanup();
  }
});

test('audio and subtitle inputs create a non-skipped voice stage', async () => {
  let probed = 0;
  const { harness, production } = await setup({
    audioProbe: async () => {
      probed += 1;
      return { durationSec: 3 };
    }
  });
  try {
    const refs = await inputs(harness);
    refs.push({ artifactId: (await harness.importFile('audio.mp3', 'audio', 'fake audio')).artifactId });
    refs.push({ artifactId: (await harness.importFile('sub.srt', 'subtitle', '1\n00:00:00,000 --> 00:00:02,000\nhello\n')).artifactId });
    const created = await production.create(job(harness, refs), harness.owner);
    await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
    const result = await production.run({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(result.task.status, 'succeeded');
    const voice = result.task.stages.find((entry) => entry.stage === 'voice');
    assert.equal(voice.status, 'succeeded');
    assert.equal(voice.checkpoint.audioDurationSec, 3);
    assert.equal(probed, 1);
  } finally {
    await harness.cleanup();
  }
});

test('missing tools, missing inputs and invalid output specs are blocked', async () => {
  const blocked = await setup({ preflight: async () => ({ ok: false, blockedBy: ['ffmpeg_missing'] }) });
  try {
    const refs = await inputs(blocked.harness);
    await assert.rejects(
      () => blocked.production.create(job(blocked.harness, refs), blocked.harness.owner),
      (error) => error.code === 'DEPENDENCY_UNAVAILABLE'
    );
  } finally {
    await blocked.harness.cleanup();
  }
  const normal = await setup();
  try {
    const refs = await inputs(normal.harness);
    await assert.rejects(
      () => normal.production.create(job(normal.harness, refs, {
        output: { container: 'mp4', width: 321, height: 240, fps: 10, maxDurationSec: 5 }
      }), normal.harness.owner),
      (error) => error.code === 'INPUT_REQUIRED'
    );
    await assert.rejects(
      () => normal.production.create(job(normal.harness, [{ artifactId: refs[0].artifactId }]), normal.harness.owner),
      (error) => error.code === 'INPUT_REQUIRED'
    );
  } finally {
    await normal.harness.cleanup();
  }
});

test('media validation failure is not ready and resume reuses verified stage checkpoints', async () => {
  let failValidation = true;
  let validationCalls = 0;
  const backend = new FakeExecutionBackend();
  const { harness, production } = await setup({
    backend,
    mediaValidator: async () => {
      validationCalls += 1;
      if (failValidation) throw Object.assign(new Error('corrupt media'), { code: 'ARTIFACT_INVALID' });
      return { ok: true, media: { width: 320, height: 240, fps: 10, duration: 5, sizeBytes: 16 } };
    }
  });
  try {
    const refs = await inputs(harness);
    const created = await production.create(job(harness, refs), harness.owner);
    await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
    const failed = await production.run({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(failed.task.status, 'failed');
    assert.equal(failed.task.result.readyForPublish, false);
    const renderCallsAfterFailure = backend.requests.length;
    assert.equal(renderCallsAfterFailure, 1);
    failValidation = false;
    const resumed = await production.resume({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(resumed.task.status, 'waiting_approval');
    await approvalDecide(harness, { approvalId: resumed.approval.id, nonce: resumed.nonce });
    const result = await production.run({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(result.task.status, 'succeeded');
    assert.equal(result.task.result.readyForPublish, true);
    assert.equal(backend.requests.length, renderCallsAfterFailure);
    assert.equal(validationCalls >= 2, true);
  } finally {
    await harness.cleanup();
  }
});
