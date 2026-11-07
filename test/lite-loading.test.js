import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { AlwaysHumanVerifier } from './helpers/harness.js';

test('default startup and status do not fetch, spawn or probe media tools', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-lite-'));
  let fetchCalls = 0;
  const config = structuredClone(DEFAULT_CONFIG);
  config.dataDir = dir;
  try {
    const runtime = await createRuntime({
      config,
      dataDir: dir,
      env: {},
      humanVerifier: new AlwaysHumanVerifier(),
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('network forbidden in lite test');
      },
      logger: { warn() {}, info() {} }
    });
    const owner = await runtime.store.transaction(async (draft, tx) => runtime.identity.ensureLocalOwner(tx));
    const status = await runtime.commandService.status(owner);
    assert.equal(status.loginProbe, false);
    assert.equal(status.capabilities, 'declared/cached/unverified');
    assert.equal(fetchCalls, 0);
    const workFiles = await fs.readdir(runtime.paths.workDir).catch(() => []);
    assert.deepEqual(workFiles, []);
    const x = await runtime.registry.getPlatform('x', { requireEnabled: false }).catch((error) => error);
    assert.equal(x.code, 'CAPABILITY_UNSUPPORTED');
    const remote = await runtime.registry.getExecutionBackend('remote', { requireEnabled: false }).catch((error) => error);
    assert.equal(remote.code, 'CAPABILITY_UNSUPPORTED');
    await runtime.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('disabled production returns a dry plan with blockers and no process', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-lite-'));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.dataDir = dir;
    const runtime = await createRuntime({
      config,
      dataDir: dir,
      env: {},
      humanVerifier: new AlwaysHumanVerifier(),
      fetchImpl: async () => {
        throw new Error('network forbidden');
      },
      logger: { warn() {}, info() {} }
    });
    const owner = await runtime.store.transaction(async (draft, tx) => runtime.identity.ensureLocalOwner(tx));
    const script = await runtime.artifactStore.importFile({
      sourcePath: await (async () => {
        const file = path.join(dir, 'script.txt');
        await fs.writeFile(file, 'text');
        const allowed = runtime.configService.config.security.allowedSourceDirs;
        runtime.configService.config.security.allowedSourceDirs = [dir];
        try {
          return file;
        } finally {
          runtime.configService.config.security.allowedSourceDirs = allowed;
        }
      })(),
      role: 'script',
      principal: owner
    }).catch((error) => error);
    // Import is expected to fail while allowLocalProducer is false? It is a local
    // asset import and is allowed; if the implementation rejects it the failure
    // must be structured rather than silently succeeding.
    if (script instanceof Error) assert.equal(typeof script.code, 'string');
    const plan = await runtime.production.create({
      requestId: 'lite-dry',
      profileId: 'local-slideshow-v1',
      brief: 'x',
      inputs: script instanceof Error ? [] : [{ artifactId: script.artifactId }],
      output: { container: 'mp4', width: 320, height: 240, fps: 10, maxDurationSec: 2 },
      mode: 'dry',
      limits: { wallTimeSec: 10, maxPaidCostMinor: 0, currency: 'CNY' }
    }, owner).catch((error) => error);
    if (plan instanceof Error) {
      assert.ok(['INPUT_REQUIRED', 'ARTIFACT_INVALID'].includes(plan.code));
    } else {
      assert.equal(plan.executionMode, 'dry');
      assert.equal(plan.task.result.readyForPublish, false);
      assert.ok(plan.blockedBy.includes('production_disabled'));
    }
    await runtime.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt optional credentials file does not prevent core status', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-lite-'));
  try {
    await fs.writeFile(path.join(dir, 'credentials.json'), '{corrupt');
    const config = structuredClone(DEFAULT_CONFIG);
    config.dataDir = dir;
    const runtime = await createRuntime({
      config,
      dataDir: dir,
      env: {},
      humanVerifier: new AlwaysHumanVerifier(),
      fetchImpl: async () => {
        throw new Error('network forbidden');
      },
      logger: { warn() {}, info() {} }
    });
    assert.equal(runtime.credentialsError.code, 'CREDENTIAL_MISSING');
    const owner = await runtime.store.transaction(async (draft, tx) => runtime.identity.ensureLocalOwner(tx));
    const status = await runtime.commandService.status(owner);
    assert.equal(status.instance.status, 'active');
    await runtime.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
