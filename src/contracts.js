import { AppError } from './errors.js';
import {
  assertSafeRelativePath,
  canonicalize,
  deepClone,
  isPlainObject,
  jcsHash,
  normalizedTextHash,
  sha256Hex,
  sha256Base64Url
} from './utils.js';

export const SCHEMA_VERSION = 1;
export const REQUEST_MODES = Object.freeze(['dry', 'go']);

export const REQUEST_ACTIONS = Object.freeze([
  'status.get',
  'account.verify',
  'config.update',
  'browse.run',
  'diary.generate',
  'comment.draft',
  'comment.send',
  'comment.approve',
  'dm.send',
  'production.create',
  'production.run',
  'publish.create',
  'publish.prepare',
  'publish.complete',
  'publish.resolve',
  'approval.decide',
  'task.get',
  'task.list',
  'task.cancel',
  'task.resume',
  'operation.resolve',
  'outbox.resolve',
  'artifact.import',
  'im.bind',
  'im.revoke',
  'migration.prepare',
  'migration.export',
  'migration.release',
  'migration.import',
  'migration.validate',
  'migration.activate',
  'migration.status',
  'migration.abort',
  'migration.disable-target',
  'migration.rollback',
  'backup.policy',
  'backup.create',
  'backup.verify',
  'backup.status',
  'backup.prune',
  'recovery.restore',
  'recovery.inspect',
  'recovery.reconcile',
  'recovery.authorize'
]);

const ENVELOPE_KEYS = new Set(['schemaVersion', 'requestId', 'action', 'input', 'mode', 'extensions']);

export function normalizeRequestEnvelope(envelope) {
  if (!isPlainObject(envelope)) {
    throw new AppError('CONFIG_INVALID', 'RequestEnvelope must be an object');
  }
  const unknown = Object.keys(envelope).filter((key) => !ENVELOPE_KEYS.has(key));
  if (unknown.length > 0) {
    throw new AppError('SCHEMA_UNSUPPORTED', 'unknown RequestEnvelope fields', {
      details: { fields: unknown }
    });
  }
  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    throw new AppError('SCHEMA_UNSUPPORTED', 'unsupported RequestEnvelope schemaVersion', {
      details: { schemaVersion: envelope.schemaVersion }
    });
  }
  if (typeof envelope.requestId !== 'string' || envelope.requestId.trim() === '' || envelope.requestId.length > 200) {
    throw new AppError('CONFIG_INVALID', 'requestId is required');
  }
  if (!REQUEST_ACTIONS.includes(envelope.action)) {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'unknown action', {
      details: { action: envelope.action }
    });
  }
  if (!isPlainObject(envelope.input)) {
    throw new AppError('CONFIG_INVALID', 'input must be an object');
  }
  const mode = envelope.mode ?? 'dry';
  if (!REQUEST_MODES.includes(mode)) {
    throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
  }
  if (envelope.extensions !== undefined && !isPlainObject(envelope.extensions)) {
    throw new AppError('SCHEMA_UNSUPPORTED', 'extensions must be an object');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: envelope.requestId.trim(),
    action: envelope.action,
    input: deepClone(envelope.input),
    mode,
    extensions: envelope.extensions ? deepClone(envelope.extensions) : {}
  };
}

export function buildRequestKey({ workspaceId, principalId, action, requestId }) {
  if (!workspaceId || !principalId || !action || !requestId) {
    throw new AppError('CONFIG_INVALID', 'requestKey scope fields are required');
  }
  return `jcs-sha256-v1:${sha256Hex(canonicalize({ workspaceId, principalId, action, requestId }))}`;
}

export function computeInputHash({
  action,
  input,
  artifacts = [],
  outputSpec,
  profileVersion,
  providerVersion,
  target,
  feeCapMinor,
  metadata
} = {}) {
  if (typeof action !== 'string' || action === '') {
    throw new AppError('CONFIG_INVALID', 'inputHash action is required');
  }
  const payload = { action };
  if (input !== undefined) payload.input = input;
  if (artifacts.length > 0) {
    payload.artifacts = artifacts
      .map((artifact) => ({
        artifactId: artifact.artifactId,
        sha256: artifact.sha256,
        role: artifact.role
      }))
      .sort((a, b) => String(a.artifactId).localeCompare(String(b.artifactId)));
  }
  if (outputSpec !== undefined) payload.outputSpec = outputSpec;
  if (profileVersion !== undefined) payload.profileVersion = profileVersion;
  if (providerVersion !== undefined) payload.providerVersion = providerVersion;
  if (target !== undefined) payload.target = target;
  if (feeCapMinor !== undefined) payload.feeCapMinor = feeCapMinor;
  if (metadata !== undefined) payload.metadata = metadata;
  return jcsHash(payload);
}

export function computeMetadataHash({ action = 'publish', videoSha256, coverSha256 = null, target, metadata, providerVersion } = {}) {
  return jcsHash({
    action,
    videoSha256,
    coverSha256,
    target,
    metadata,
    providerVersion: providerVersion ?? null
  });
}

export function normalizeMode(value, { required = true } = {}) {
  if (value === undefined && !required) return 'dry';
  if (!REQUEST_MODES.includes(value)) {
    throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
  }
  return value;
}

export function effectiveDryRun({ config, feature, invocationMode }) {
  const globalDry = config.dryRun === true;
  let featureDry = false;
  let blockedBy = null;
  if (feature === 'production' && config.production?.dryRun === true) {
    featureDry = true;
  }
  if (feature === 'publishing' && config.publishing?.dryRun === true) {
    featureDry = true;
  }
  const invocationDry = invocationMode === 'dry';
  if (globalDry) blockedBy = 'global_dry_run';
  else if (featureDry) blockedBy = `${feature}_dry_run`;
  else if (invocationDry) blockedBy = 'invocation_dry';
  return {
    dryRun: globalDry || featureDry || invocationDry,
    executionMode: globalDry || featureDry || invocationDry ? 'dry' : 'go',
    blockedBy
  };
}

/**
 * Serialize the non-dispatch freeze shared by task creation and multi-file
 * commits. Migration quiescing/sealed/released blocks new business; recovery
 * readonly/reconciling/blocked blocks it until a scope is authorized.
 */
export function assertWritablePhase(state) {
  if (state?.migration?.phase !== 'active') {
    throw new AppError('MIGRATION_BLOCKED', 'migration freeze blocks new business writes', {
      details: { phase: state?.migration?.phase || null }
    });
  }
  const phase = state?.recovery?.phase || 'normal';
  if (['readonly', 'reconciling', 'blocked'].includes(phase)) {
    throw new AppError('RECOVERY_GAP', `recovery phase ${phase} blocks new business writes`);
  }
  return true;
}

export function assertSchemaVersion(value, expected = SCHEMA_VERSION, label = 'schemaVersion') {
  if (value !== expected) {
    throw new AppError('SCHEMA_UNSUPPORTED', `${label} must be ${expected}`, {
      details: { actual: value }
    });
  }
}

export function assertAccountRef(accountRef) {
  if (
    !isPlainObject(accountRef) ||
    typeof accountRef.platform !== 'string' ||
    accountRef.platform === '' ||
    typeof accountRef.accountId !== 'string' ||
    accountRef.accountId === ''
  ) {
    throw new AppError('IDENTITY_UNVERIFIED', 'invalid AccountRef');
  }
  if (Object.keys(accountRef).some((key) => !['platform', 'accountId', 'extensions'].includes(key))) {
    throw new AppError('SCHEMA_UNSUPPORTED', 'unknown AccountRef fields');
  }
  return { platform: accountRef.platform, accountId: accountRef.accountId, extensions: accountRef.extensions || {} };
}

export function assertContentRef(contentRef) {
  if (
    !isPlainObject(contentRef) ||
    typeof contentRef.platform !== 'string' ||
    contentRef.platform === '' ||
    typeof contentRef.contentId !== 'string' ||
    contentRef.contentId === ''
  ) {
    throw new AppError('PUBLISH_INPUT_INVALID', 'invalid ContentRef');
  }
  if (Object.keys(contentRef).some((key) => !['platform', 'contentId', 'platformData', 'extensions'].includes(key))) {
    throw new AppError('SCHEMA_UNSUPPORTED', 'unknown ContentRef fields');
  }
  return deepClone(contentRef);
}

export const ARTIFACT_ROLES = Object.freeze(['script', 'image', 'clip', 'audio', 'subtitle', 'video', 'cover']);

export function assertArtifactRef(ref, { role = null } = {}) {
  if (!isPlainObject(ref)) throw new AppError('ARTIFACT_INVALID', 'invalid ArtifactRef');
  if (typeof ref.artifactId !== 'string' || !/^artifact_[A-Za-z0-9]+$/.test(ref.artifactId)) {
    throw new AppError('ARTIFACT_INVALID', 'invalid artifactId');
  }
  if (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) {
    throw new AppError('ARTIFACT_INVALID', 'invalid artifact sha256');
  }
  if (!Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 0) {
    throw new AppError('ARTIFACT_INVALID', 'invalid artifact size');
  }
  if (typeof ref.mediaType !== 'string' || ref.mediaType === '') {
    throw new AppError('ARTIFACT_INVALID', 'invalid artifact mediaType');
  }
  if (!ARTIFACT_ROLES.includes(ref.role)) {
    throw new AppError('ARTIFACT_INVALID', 'invalid artifact role');
  }
  if (role && ref.role !== role) {
    throw new AppError('ARTIFACT_INVALID', `artifact role must be ${role}`);
  }
  return ref;
}

export function assertReceipt(receipt, { platform = null, accountId = null, action = null } = {}) {
  if (!isPlainObject(receipt)) throw new AppError('OPERATION_UNKNOWN', 'missing structured receipt');
  if (platform && receipt.platform !== platform) {
    throw new AppError('OPERATION_UNKNOWN', 'receipt platform does not match operation');
  }
  if (accountId && String(receipt.accountId) !== String(accountId)) {
    throw new AppError('OPERATION_UNKNOWN', 'receipt account does not match operation');
  }
  if (action && receipt.action !== action) {
    throw new AppError('OPERATION_UNKNOWN', 'receipt action does not match operation');
  }
  if (typeof receipt.externalId !== 'string' || receipt.externalId === '') {
    throw new AppError('OPERATION_UNKNOWN', 'receipt externalId is required');
  }
  if (!['manual_assertion', 'publisher_receipt', 'platform_readback'].includes(receipt.verification)) {
    throw new AppError('OPERATION_UNKNOWN', 'receipt verification is invalid');
  }
  if (typeof receipt.receivedAt !== 'string' || Number.isNaN(Date.parse(receipt.receivedAt))) {
    throw new AppError('OPERATION_UNKNOWN', 'receipt receivedAt is invalid');
  }
  return receipt;
}

export function makeReceipt({ platform, accountId, action, externalId, url = null, verification, receivedAt }) {
  return {
    platform,
    accountId: String(accountId),
    action,
    externalId,
    url,
    verification,
    receivedAt
  };
}

export function assertOperationContext(context) {
  if (!isPlainObject(context)) throw new AppError('FORBIDDEN', 'OperationContext is required');
  for (const key of ['operationId', 'businessKey', 'action', 'inputHash', 'permit']) {
    if (context[key] === undefined || context[key] === null || context[key] === '') {
      throw new AppError('FORBIDDEN', `OperationContext.${key} is required`);
    }
  }
  if (context.accountRef !== undefined && context.accountRef !== null) {
    assertAccountRef(context.accountRef);
  }
  if (context.permit !== 'dispatch-once') {
    throw new AppError('FORBIDDEN', 'invalid OperationContext permit');
  }
  return context;
}

export function assertExecutionDispatchContext(context) {
  if (!isPlainObject(context)) throw new AppError('FORBIDDEN', 'ExecutionDispatchContext is required');
  for (const key of ['executionId', 'taskId', 'stageId', 'attempt', 'inputHash', 'permit']) {
    if (context[key] === undefined || context[key] === null || context[key] === '') {
      throw new AppError('FORBIDDEN', `ExecutionDispatchContext.${key} is required`);
    }
  }
  if (context.permit !== 'dispatch-once') {
    throw new AppError('FORBIDDEN', 'invalid ExecutionDispatchContext permit');
  }
  return context;
}

export function assertOutboxDispatchContext(context) {
  if (!isPlainObject(context)) throw new AppError('FORBIDDEN', 'OutboxDispatchContext is required');
  for (const key of ['notificationId', 'bindingId', 'payloadHash', 'permit']) {
    if (context[key] === undefined || context[key] === null || context[key] === '') {
      throw new AppError('FORBIDDEN', `OutboxDispatchContext.${key} is required`);
    }
  }
  if (context.permit !== 'dispatch-once') {
    throw new AppError('FORBIDDEN', 'invalid OutboxDispatchContext permit');
  }
  return context;
}

export const PLATFORM_CAPABILITY_KEYS = Object.freeze([
  'read.content',
  'read.comments',
  'write.comment',
  'dm.send',
  'dm.receive',
  'publish.manual',
  'publish.external'
]);

export function normalizeCapabilities(declaration = {}) {
  const output = {};
  for (const key of PLATFORM_CAPABILITY_KEYS) {
    const entry = declaration[key];
    if (entry === undefined) {
      output[key] = { supported: false, reason: 'not_declared', limits: {} };
    } else if (typeof entry === 'boolean') {
      output[key] = { supported: entry, reason: entry ? null : 'unsupported', limits: {} };
    } else if (isPlainObject(entry)) {
      output[key] = {
        supported: entry.supported === true,
        reason: entry.reason ?? (entry.supported ? null : 'unsupported'),
        limits: entry.limits || {}
      };
    } else {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'invalid capability declaration', {
        details: { capability: key }
      });
    }
  }
  return output;
}

export function assertCapability(capabilities, key) {
  if (!capabilities?.[key]?.supported) {
    throw new AppError('CAPABILITY_UNSUPPORTED', `capability ${key} is not supported`, {
      details: { capability: key, reason: capabilities?.[key]?.reason || 'unsupported' }
    });
  }
  return capabilities[key];
}

/* ------------------------------------------------------------------ *
 * Recovery / migration hold scopes (SPEC §27.5)
 * ------------------------------------------------------------------ */

export const SCOPE_KINDS = Object.freeze(['workspace', 'account_action', 'provider_budget', 'im_conversation']);
export const RECOVERY_ACTIONS = Object.freeze(['comment', 'dm', 'publish', 'external_publish']);

export function normalizeScope(scope, workspaceId = null) {
  if (!isPlainObject(scope) || !SCOPE_KINDS.includes(scope.kind)) {
    throw new AppError('RECOVERY_GAP', 'invalid recovery scope');
  }
  let normalized;
  const workspace = scope.workspaceId || workspaceId;
  if (!workspace) throw new AppError('RECOVERY_GAP', 'recovery scope workspaceId is required');
  switch (scope.kind) {
    case 'workspace':
      normalized = { kind: 'workspace', workspaceId: workspace };
      break;
    case 'account_action':
      if (
        typeof scope.platform !== 'string' ||
        scope.platform === '' ||
        typeof scope.accountId !== 'string' ||
        typeof scope.action !== 'string' ||
        (scope.action !== '*' && !RECOVERY_ACTIONS.includes(scope.action))
      ) {
        throw new AppError('RECOVERY_GAP', 'invalid account_action scope');
      }
      normalized = {
        kind: 'account_action',
        workspaceId: workspace,
        platform: scope.platform,
        accountId: scope.accountId,
        action: scope.action
      };
      break;
    case 'provider_budget':
      if (
        typeof scope.provider !== 'string' ||
        scope.provider === '' ||
        typeof scope.budgetId !== 'string' ||
        scope.budgetId === ''
      ) {
        throw new AppError('RECOVERY_GAP', 'invalid provider_budget scope');
      }
      normalized = {
        kind: 'provider_budget',
        workspaceId: workspace,
        provider: scope.provider,
        budgetId: scope.budgetId
      };
      break;
    case 'im_conversation':
      if (
        typeof scope.adapterId !== 'string' ||
        typeof scope.botAccountId !== 'string' ||
        typeof scope.conversationId !== 'string'
      ) {
        throw new AppError('RECOVERY_GAP', 'invalid im_conversation scope');
      }
      normalized = {
        kind: 'im_conversation',
        workspaceId: workspace,
        adapterId: scope.adapterId,
        botAccountId: scope.botAccountId,
        conversationId: scope.conversationId
      };
      break;
    default:
      throw new AppError('RECOVERY_GAP', 'invalid recovery scope kind');
  }
  return normalized;
}

export function scopeKeyFor(scope, workspaceId = null) {
  return jcsHash(normalizeScope(scope, workspaceId));
}

/**
 * Does `holdScope` cover `candidate`? Wildcards are only allowed at the
 * documented fields (action='*', provider budget='*', im '*'). Workspace covers
 * everything in that workspace.
 */
export function scopeCovers(holdScope, candidate, workspaceId = null) {
  const hold = normalizeScope(holdScope, workspaceId);
  const target = normalizeScope(candidate, workspaceId);
  if (hold.kind === 'workspace') return hold.workspaceId === target.workspaceId;
  if (target.kind === 'workspace') return false;
  if (hold.workspaceId !== target.workspaceId) return false;
  if (hold.kind !== target.kind) return false;
  switch (hold.kind) {
    case 'account_action':
      return (
        hold.platform === target.platform &&
        hold.accountId === target.accountId &&
        (hold.action === '*' || hold.action === target.action)
      );
    case 'provider_budget':
      return hold.provider === target.provider && (hold.budgetId === '*' || hold.budgetId === target.budgetId);
    case 'im_conversation':
      return (
        (hold.adapterId === '*' || hold.adapterId === target.adapterId) &&
        (hold.botAccountId === '*' || hold.botAccountId === target.botAccountId) &&
        (hold.conversationId === '*' || hold.conversationId === target.conversationId)
      );
    default:
      return false;
  }
}

export function scopeIntersects(a, b, workspaceId = null) {
  return scopeCovers(a, b, workspaceId) || scopeCovers(b, a, workspaceId);
}

export function makeRecoveryHold({ id, caseId, scope, revision = 1, evidenceRefs = [], createdAt }) {
  const normalized = normalizeScope(scope);
  return {
    id,
    caseId: caseId ?? null,
    kind: 'recovery',
    scope: normalized,
    scopeKey: scopeKeyFor(normalized),
    revision,
    status: 'active',
    evidenceRefs,
    createdAt,
    releasedAt: null,
    releaseDecisionRef: null
  };
}

export function makeMigrationHold({ id, scope, revision = 1, evidenceRefs = [], createdAt }) {
  const normalized = normalizeScope(scope);
  return {
    id,
    caseId: null,
    kind: 'migration',
    scope: normalized,
    scopeKey: scopeKeyFor(normalized),
    revision,
    status: 'active',
    evidenceRefs,
    createdAt,
    releasedAt: null,
    releaseDecisionRef: null
  };
}

export function findMatchingHolds(holds, candidate, workspaceId = null, { kinds = ['recovery', 'migration'] } = {}) {
  return (holds || []).filter(
    (hold) =>
      hold.status !== 'released' &&
      kinds.includes(hold.kind) &&
      scopeCovers(hold.scope, candidate, workspaceId)
  );
}

export function assertNoMatchingHold(state, candidate, { kinds = ['recovery'], code = 'RECOVERY_GAP' } = {}) {
  // Migration holds live on individual legacy tasks and are checked when that
  // task is resumed; the global migration phase is the dispatch-wide gate.
  const holds = [...(state.recovery?.holds || [])];
  const matches = findMatchingHolds(holds, candidate, state.workspaceId, { kinds });
  if (matches.length > 0) {
    throw new AppError(code, 'dispatch is frozen by a recovery/migration hold', {
      details: {
        scope: normalizeScope(candidate, state.workspaceId),
        holds: matches.map((hold) => ({ id: hold.id, kind: hold.kind, scopeKey: hold.scopeKey }))
      }
    });
  }
  return true;
}

export function assertUnknownExposure(exposure) {
  if (!isPlainObject(exposure)) throw new AppError('RECOVERY_GAP', 'invalid UnknownExposure');
  if (exposure.maxMinor !== null && (!Number.isSafeInteger(exposure.maxMinor) || exposure.maxMinor < 0)) {
    throw new AppError('RECOVERY_GAP', 'UnknownExposure.maxMinor must be null or a non-negative integer');
  }
  return exposure;
}

export function sanitizePathForState(relative) {
  return assertSafeRelativePath(relative);
}

export { canonicalize, jcsHash, normalizedTextHash, sha256Hex, sha256Base64Url };
