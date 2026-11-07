import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWritablePhase, effectiveDryRun } from '../src/contracts.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ERROR_CODES, ERROR_HTTP, AppError } from '../src/errors.js';

function config({ global = true, production = true, publishing = true } = {}) {
  return {
    ...DEFAULT_CONFIG,
    dryRun: global,
    production: { ...DEFAULT_CONFIG.production, dryRun: production },
    publishing: { ...DEFAULT_CONFIG.publishing, dryRun: publishing }
  };
}

test('global/feature/invocation dry-run truth table', () => {
  const table = [
    [true, true, 'go', true, 'global_dry_run'],
    [true, false, 'dry', true, 'global_dry_run'],
    [false, true, 'go', true, 'production_dry_run'],
    [false, false, 'dry', true, 'invocation_dry'],
    [false, false, 'go', false, null]
  ];
  for (const [global, feature, invocation, expected, blockedBy] of table) {
    const result = effectiveDryRun({
      config: config({ global, production: feature }),
      feature: 'production',
      invocationMode: invocation
    });
    assert.equal(result.dryRun, expected);
    assert.equal(result.blockedBy, blockedBy);
    assert.equal(result.executionMode, expected ? 'dry' : 'go');
  }
  assert.equal(
    effectiveDryRun({ config: config({ global: false, publishing: true }), feature: 'publishing', invocationMode: 'go' }).blockedBy,
    'publishing_dry_run'
  );
});

test('all stable error codes have an HTTP mapping and unknown is non-retryable', () => {
  assert.equal(ERROR_CODES.length, 36);
  for (const code of ERROR_CODES) {
    assert.ok(Number.isInteger(ERROR_HTTP[code]), `${code} has no HTTP mapping`);
  }
  const unknown = new AppError('OPERATION_UNKNOWN', 'x');
  assert.equal(unknown.retryable, false);
  assert.equal(unknown.httpStatus, 409);
  const limited = new AppError('RATE_LIMITED', 'x');
  assert.equal(limited.retryable, true);
  assert.equal(limited.httpStatus, 429);
  assert.equal(new AppError('TRUST_UNAVAILABLE', 'x').httpStatus, 503);
  assert.equal(new AppError('CAPABILITY_UNSUPPORTED', 'x').httpStatus, 501);
});

test('error serialization recursively redacts secret-shaped details', () => {
  const error = new AppError('CONFIG_INVALID', 'bad', {
    details: { cookie: 'SESSDATA=x', nested: { apiKey: 'k', safe: 'ok' } }
  });
  const json = error.toJSON();
  assert.equal(json.details.cookie, '[redacted]');
  assert.equal(json.details.nested.apiKey, '[redacted]');
  assert.equal(json.details.nested.safe, 'ok');
});

test('migration quiescing/sealed and recovery readonly block new business writes', () => {
  const base = { migration: { phase: 'active', id: null }, recovery: { phase: 'normal' } };
  assert.equal(assertWritablePhase(base), true);
  for (const phase of ['quiescing', 'sealed', 'released', 'aborted']) {
    assert.throws(
      () => assertWritablePhase({ ...base, migration: { phase, id: 'm' } }),
      (error) => error.code === 'MIGRATION_BLOCKED'
    );
  }
  for (const phase of ['readonly', 'reconciling', 'blocked']) {
    assert.throws(
      () => assertWritablePhase({ ...base, recovery: { phase } }),
      (error) => error.code === 'RECOVERY_GAP'
    );
  }
  assert.equal(assertWritablePhase({ ...base, recovery: { phase: 'restricted' } }), true);
});
