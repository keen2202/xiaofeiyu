import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequestKey,
  computeInputHash,
  computeMetadataHash,
  normalizeRequestEnvelope,
  scopeCovers,
  scopeKeyFor,
  assertNoMatchingHold,
  makeRecoveryHold,
  normalizeScope
} from '../src/contracts.js';
import { jcsHash, normalizedTextHash } from '../src/utils.js';
import { AppError } from '../src/errors.js';

test('JCS gold vectors match SPEC §21.1', () => {
  assert.equal(jcsHash({ a: 1, b: '你好' }), 'jcs-sha256-v1:f904ecdbf542d8dba6a81d16e73ba685adcd7da823f1b38ff41d78e2341ca088');
  assert.equal(
    jcsHash({ action: 'comment', contentRef: { contentId: 'BV_EXAMPLE', platform: 'bilibili' }, text: '你好' }),
    'jcs-sha256-v1:c770c268e85c7456a62aab59eed0c07547317d3b78e1bca1a444382e994fe9f3'
  );
  assert.equal(
    normalizedTextHash('  你好\r\n'),
    'jcs-sha256-v1:0922515335495b677fa44d53bcf0f33d9fbfc8fda4aba447afa805f0f206a8b9'
  );
});

test('requestKey has the exact scoped JCS definition', () => {
  const key = buildRequestKey({
    workspaceId: 'w',
    principalId: 'p',
    action: 'comment.draft',
    requestId: 'r'
  });
  assert.match(key, /^jcs-sha256-v1:[a-f0-9]{64}$/);
  assert.notEqual(
    key,
    buildRequestKey({ workspaceId: 'w', principalId: 'other', action: 'comment.draft', requestId: 'r' })
  );
});

test('input and metadata hashes cover artifacts, target, versions and fee cap', () => {
  const base = computeInputHash({
    action: 'production.run',
    input: { brief: 'x' },
    artifacts: [{ artifactId: 'artifact_a', sha256: 'a'.repeat(64), role: 'script' }],
    profileVersion: '1',
    feeCapMinor: 0
  });
  assert.notEqual(
    base,
    computeInputHash({
      action: 'production.run',
      input: { brief: 'x' },
      artifacts: [{ artifactId: 'artifact_a', sha256: 'a'.repeat(64), role: 'script' }],
      profileVersion: '1',
      feeCapMinor: 100
    })
  );
  const metadataHash = computeMetadataHash({
    videoSha256: 'b'.repeat(64),
    target: { platform: 'bilibili', accountId: '1' },
    metadata: { title: 't' }
  });
  assert.match(metadataHash, /^jcs-sha256-v1:/);
});

test('unknown envelope fields and actions are rejected', () => {
  assert.throws(
    () =>
      normalizeRequestEnvelope({
        schemaVersion: 1,
        requestId: 'r',
        action: 'status.get',
        input: {},
        approved: true
      }),
    (error) => error instanceof AppError && error.code === 'SCHEMA_UNSUPPORTED'
  );
  assert.throws(
    () => normalizeRequestEnvelope({ schemaVersion: 1, requestId: 'r', action: 'rm -rf', input: {} }),
    (error) => error.code === 'CAPABILITY_UNSUPPORTED'
  );
});

test('recovery scopes are structured and workspace parents cover children', () => {
  const workspace = normalizeScope({ kind: 'workspace', workspaceId: 'w' });
  const action = normalizeScope({
    kind: 'account_action',
    workspaceId: 'w',
    platform: 'bilibili',
    accountId: '1',
    action: 'comment'
  });
  assert.equal(scopeCovers(workspace, action), true);
  assert.equal(scopeCovers(action, workspace), false);
  const wildcard = { ...action, action: '*' };
  assert.equal(scopeCovers(wildcard, action), true);
  assert.equal(scopeKeyFor(action), scopeKeyFor({ ...action }));
  const hold = makeRecoveryHold({ id: 'h', caseId: 'c', scope: wildcard, revision: 1, createdAt: new Date().toISOString() });
  assert.throws(
    () => assertNoMatchingHold({ workspaceId: 'w', recovery: { holds: [hold] }, tasks: {} }, action),
    (error) => error.code === 'RECOVERY_GAP'
  );
  assert.equal(
    assertNoMatchingHold({ workspaceId: 'w', recovery: { holds: [hold] }, tasks: {} }, workspace),
    true
  );
});
