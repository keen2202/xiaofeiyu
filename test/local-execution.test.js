import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalExecutionBackend } from '../src/adapters/execution/local.js';
const FAKE_RUNNER = fileURLToPath(new URL('./helpers/fake-runner.mjs', import.meta.url));

function request(dir, id, testMode = 'success', overrides = {}) {
  return {
    executionId: id,
    taskId: 'task_test',
    stageId: 'render',
    attempt: 1,
    inputHash: 'jcs-sha256-v1:' + 'a'.repeat(64),
    profileId: 'local-slideshow-v1',
    profile: { id: 'local-slideshow-v1', version: '1.0.0' },
    tools: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' },
    workDir: dir,
    allowedInputRoots: [dir],
    limits: { wallTimeSec: 30 },
    plan: {
      width: 320,
      height: 240,
      fps: 10,
      durationSec: 2,
      segments: [],
      videoFile: 'render.mp4',
      coverFile: 'cover.jpg',
      testMode
    },
    ...overrides
  };
}

test('local backend runs the fixed runner, bounds output and does not leak credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-exec-'));
  const previous = process.env.BILI_SESSDATA;
  process.env.BILI_SESSDATA = 'secret-cookie';
  const backend = new LocalExecutionBackend({ runnerPath: FAKE_RUNNER });
  try {
    const submitted = await backend.submit(request(dir, 'exec_1'));
    assert.equal(submitted.accepted, true);
    const final = await backend.wait('exec_1');
    assert.equal(final.status, 'succeeded');
    assert.equal(final.outputs.video, 'render.mp4');
    assert.equal(final.outputs.envKeys.includes('BILI_SESSDATA'), false);
    assert.equal(await fs.readFile(path.join(dir, 'render.mp4'), 'utf8'), 'fake video bytes');
    await assert.rejects(
      () => backend.submit(request(dir, 'exec_1')),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    await backend.close();
    if (previous === undefined) delete process.env.BILI_SESSDATA;
    else process.env.BILI_SESSDATA = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('duplicate active submit is deduplicated and cancel only requests stop', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-exec-'));
  const backend = new LocalExecutionBackend({ runnerPath: FAKE_RUNNER });
  try {
    await backend.submit(request(dir, 'exec_slow', 'slow'));
    const duplicate = await backend.submit(request(dir, 'exec_slow', 'slow'));
    assert.equal(duplicate.deduplicated, true);
    const cancelled = await backend.cancel('exec_slow');
    assert.equal(cancelled.status, 'cancel_requested');
    const final = await backend.wait('exec_slow');
    assert.equal(final.status, 'cancelled');
  } finally {
    await backend.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('malformed, oversized and flooding output fail closed', async () => {
  for (const mode of ['badjson', 'oversize', 'flood']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-exec-'));
    const backend = new LocalExecutionBackend({ runnerPath: FAKE_RUNNER });
    try {
      await backend.submit(request(dir, `exec_${mode}`, mode));
      const final = await backend.wait(`exec_${mode}`);
      assert.equal(final.status, 'failed', mode);
    } finally {
      await backend.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

test('single concurrency limit and failed executions are terminal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-exec-'));
  const backend = new LocalExecutionBackend({ runnerPath: FAKE_RUNNER });
  try {
    await backend.submit(request(dir, 'exec_slow2', 'slow'));
    await assert.rejects(
      () => backend.submit(request(dir, 'exec_other')),
      (error) => error.code === 'BUDGET_EXCEEDED'
    );
    await backend.cancel('exec_slow2');
    await backend.wait('exec_slow2');
    const failed = new LocalExecutionBackend({ runnerPath: FAKE_RUNNER });
    try {
      await failed.submit(request(dir, 'exec_fail', 'fail'));
      const result = await failed.wait('exec_fail');
      assert.equal(result.status, 'failed');
      await assert.rejects(
        () => failed.submit(request(dir, 'exec_fail', 'fail')),
        (error) => error.code === 'IDEMPOTENCY_CONFLICT'
      );
    } finally {
      await failed.close();
    }
  } finally {
    await backend.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unsupported stages and an unsafe workDir are rejected before spawn', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-exec-'));
  const backend = new LocalExecutionBackend({ runnerPath: FAKE_RUNNER });
  try {
    await assert.rejects(
      () => backend.submit({ ...request(dir, 'exec_script'), stageId: 'script' }),
      (error) => error.code === 'CAPABILITY_UNSUPPORTED'
    );
    await assert.rejects(
      () => backend.submit({ ...request(dir, 'exec_rel'), workDir: 'relative/dir' }),
      (error) => error.code === 'INPUT_REQUIRED'
    );
  } finally {
    await backend.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
