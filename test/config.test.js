import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG,
  computeConfigHash,
  loadConfigFile,
  redactConfig,
  resolvePaths,
  validateConfig,
  ConfigService
} from '../src/config.js';
import { createHarness } from './helpers/harness.js';
import { AppError } from '../src/errors.js';

const exampleFile = fileURLToPath(new URL('../config.example.json', import.meta.url));

test('built-in defaults deep-equal config.example.json', async () => {
  const example = JSON.parse(await fs.readFile(exampleFile, 'utf8'));
  assert.deepEqual(DEFAULT_CONFIG, example);
  assert.doesNotThrow(() => validateConfig(structuredClone(example)));
});

test('zero values are preserved and accepted', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.owner.mid = 0;
  config.comments.perRound = 0;
  config.comments.dailyLimit = 0;
  config.directMessages.perRound = 0;
  config.comments.sameVideoDays = 0;
  assert.doesNotThrow(() => validateConfig(config));
});

test('boolean fields reject strings and numbers', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.comments.enabled = 'true';
  assert.throws(() => validateConfig(config), (error) => error.code === 'CONFIG_INVALID');
  const numeric = structuredClone(DEFAULT_CONFIG);
  numeric.dryRun = 1;
  assert.throws(() => validateConfig(numeric), (error) => error.code === 'CONFIG_INVALID');
});

test('invalid timezone, watch-history and unknown keys are rejected', () => {
  for (const mutate of [
    (config) => {
      config.timeZone = 'Mars/Olympus';
    },
    (config) => {
      config.browse.markWatchHistory = true;
    },
    (config) => {
      config.security.typoField = true;
    },
    (config) => {
      config.production.requireApproval = false;
    },
    (config) => {
      config.publishing.autoPublish = true;
    }
  ]) {
    const config = structuredClone(DEFAULT_CONFIG);
    mutate(config);
    assert.throws(() => validateConfig(config), (error) => ['CONFIG_INVALID', 'SCHEMA_UNSUPPORTED'].includes(error.code));
  }
});

test('external publishing needs allow flag and absolute command when not dry', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.dryRun = false;
  config.publishing.dryRun = false;
  config.publishing.provider = 'external';
  config.publishing.external.command = '/bin/false';
  assert.throws(() => validateConfig(config), (error) => error.code === 'CONFIG_INVALID');
  config.security.allowExternalPublisher = true;
  assert.doesNotThrow(() => validateConfig(config));
});

test('recursive redaction hides credential-shaped keys', () => {
  const redacted = redactConfig({ a: { apiKey: 'secret', token: 'x', safe: 'ok' }, cookie: 'SESSDATA=x' });
  assert.equal(redacted.a.apiKey, '[redacted]');
  assert.equal(redacted.a.token, '[redacted]');
  assert.equal(redacted.a.safe, 'ok');
  assert.equal(redacted.cookie, '[redacted]');
});

test('environment overrides have priority and preserve valid false', async () => {
  const file = path.join(await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'xfy-cfg-')), 'config.json');
  const config = await loadConfigFile(file, {
    env: { DSH_BILI_UNIFIED_DRY_RUN: 'false', DSH_BILI_UNIFIED_TIME_ZONE: 'UTC' }
  });
  assert.equal(config.dryRun, false);
  assert.equal(config.timeZone, 'UTC');
});

test('paths derive from dataDir with expected defaults', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.dataDir = path.resolve('example-data');
  const paths = resolvePaths(config, {});
  assert.equal(paths.stateFile, path.join(config.dataDir, 'state.json'));
  assert.equal(paths.journalDir, path.join(config.dataDir, 'journal'));
  assert.equal(paths.artifactsDir, path.join(config.dataDir, 'artifacts'));
  assert.equal(paths.productionProfilesFile, path.join(config.dataDir, 'production-profiles.json'));
});

test('configuration update is validated, increments revision and rejects HTTP privilege changes', async () => {
  const harness = await createHarness();
  try {
    const before = await harness.snapshot();
    const updated = await harness.configService.update(
      { browse: { enabled: true } },
      { source: 'http', expectedRevision: before.configRevision.version }
    );
    assert.equal(updated.browse.enabled, true);
    const after = await harness.snapshot();
    assert.equal(after.configRevision.version, before.configRevision.version + 1);
    assert.equal(after.configRevision.sha256, computeConfigHash(harness.configService.get()));
    await assert.rejects(
      () =>
        harness.configService.update(
          { timeZone: 'UTC' },
          { source: 'http', expectedRevision: after.configRevision.version }
        ),
      (error) => error.code === 'FORBIDDEN'
    );
    await assert.rejects(
      () =>
        harness.configService.update(
          { dryRun: false },
          { source: 'http', expectedRevision: after.configRevision.version }
        ),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

test('browse failure cooldown and no-subtitle fallback are validated config fields', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  assert.equal(config.browse.failureCooldownMinutes, 360);
  assert.equal(config.browse.allowNoSubtitle, false);
  assert.doesNotThrow(() => validateConfig(config));

  config.browse.failureCooldownMinutes = 0;
  assert.doesNotThrow(() => validateConfig(config));
  for (const invalid of [-1, 10081, '360', 1.5]) {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.browse.failureCooldownMinutes = invalid;
    assert.throws(() => validateConfig(bad), (error) => error.code === 'CONFIG_INVALID');
  }
  const badBoolean = structuredClone(DEFAULT_CONFIG);
  badBoolean.browse.allowNoSubtitle = 'false';
  assert.throws(() => validateConfig(badBoolean), (error) => error.code === 'CONFIG_INVALID');
  const unknown = structuredClone(DEFAULT_CONFIG);
  unknown.browse.typoCooldown = 1;
  assert.throws(() => validateConfig(unknown), (error) => error.code === 'CONFIG_INVALID');
});
