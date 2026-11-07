/**
 * Stable error taxonomy (SPEC §18).
 * Every error crossing HTTP/CLI/IM must use one of these codes.
 */

export const ERROR_CODES = Object.freeze([
  'CONFIG_INVALID',
  'CREDENTIAL_MISSING',
  'FEATURE_DISABLED',
  'APPROVAL_REQUIRED',
  'DUPLICATE_OPERATION',
  'DUPLICATE_TARGET',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'RECIPIENT_NOT_ALLOWED',
  'MUTUAL_FOLLOW_REQUIRED',
  'AGENT_DISABLED',
  'AGENT_OUTPUT_INVALID',
  'BILI_API_ERROR',
  'OPERATION_UNKNOWN',
  'PUBLISH_INPUT_INVALID',
  'EXTERNAL_PUBLISH_DISABLED',
  'TRUST_UNAVAILABLE',
  'STORE_CORRUPTED',
  'SCHEMA_UNSUPPORTED',
  'IDENTITY_UNVERIFIED',
  'FORBIDDEN',
  'IDEMPOTENCY_CONFLICT',
  'APPROVAL_STALE',
  'CAPABILITY_UNSUPPORTED',
  'DEPENDENCY_UNAVAILABLE',
  'INPUT_REQUIRED',
  'ARTIFACT_INVALID',
  'BUDGET_EXCEEDED',
  'JOURNAL_CORRUPTED',
  'MIGRATION_BLOCKED',
  'BACKUP_UNPROTECTED',
  'BACKUP_STALE',
  'BACKUP_INVALID',
  'RECOVERY_REQUIRED',
  'RECOVERY_GAP',
  'RECOVERY_FENCING_REQUIRED'
]);

export const ERROR_HTTP = Object.freeze({
  CONFIG_INVALID: 400,
  PUBLISH_INPUT_INVALID: 400,
  INPUT_REQUIRED: 400,
  ARTIFACT_INVALID: 400,
  AGENT_OUTPUT_INVALID: 400,
  SCHEMA_UNSUPPORTED: 400,
  FORBIDDEN: 403,
  CREDENTIAL_MISSING: 403,
  RECIPIENT_NOT_ALLOWED: 403,
  MUTUAL_FOLLOW_REQUIRED: 403,
  EXTERNAL_PUBLISH_DISABLED: 403,
  IDENTITY_UNVERIFIED: 403,
  CAPABILITY_UNSUPPORTED: 501,
  FEATURE_DISABLED: 409,
  APPROVAL_REQUIRED: 409,
  APPROVAL_STALE: 409,
  DUPLICATE_OPERATION: 409,
  DUPLICATE_TARGET: 409,
  IDEMPOTENCY_CONFLICT: 409,
  OPERATION_UNKNOWN: 409,
  MIGRATION_BLOCKED: 409,
  BUDGET_EXCEEDED: 409,
  QUOTA_EXCEEDED: 409,
  RATE_LIMITED: 429,
  TRUST_UNAVAILABLE: 503,
  DEPENDENCY_UNAVAILABLE: 503,
  BILI_API_ERROR: 503,
  AGENT_DISABLED: 503,
  STORE_CORRUPTED: 503,
  JOURNAL_CORRUPTED: 503,
  BACKUP_UNPROTECTED: 503,
  BACKUP_STALE: 503,
  BACKUP_INVALID: 503,
  RECOVERY_REQUIRED: 503,
  RECOVERY_GAP: 503,
  RECOVERY_FENCING_REQUIRED: 503
});

/** Codes for which an unknown side effect must never be retried. */
export const NON_RETRYABLE_CODES = Object.freeze(
  new Set([
    'OPERATION_UNKNOWN',
    'RECOVERY_REQUIRED',
    'RECOVERY_GAP',
    'RECOVERY_FENCING_REQUIRED',
    'MIGRATION_BLOCKED',
    'BACKUP_UNPROTECTED',
    'BACKUP_STALE',
    'BACKUP_INVALID',
    'FORBIDDEN',
    'APPROVAL_STALE',
    'APPROVAL_REQUIRED',
    'DUPLICATE_OPERATION',
    'DUPLICATE_TARGET',
    'IDEMPOTENCY_CONFLICT',
    'EXTERNAL_PUBLISH_DISABLED',
    'CONFIG_INVALID',
    'PUBLISH_INPUT_INVALID',
    'INPUT_REQUIRED',
    'ARTIFACT_INVALID',
    'AGENT_DISABLED',
    'AGENT_OUTPUT_INVALID',
    'RECIPIENT_NOT_ALLOWED',
    'MUTUAL_FOLLOW_REQUIRED',
    'CREDENTIAL_MISSING',
    'IDENTITY_UNVERIFIED',
    'FEATURE_DISABLED',
    'CAPABILITY_UNSUPPORTED',
    'SCHEMA_UNSUPPORTED',
    'STORE_CORRUPTED',
    'JOURNAL_CORRUPTED',
    'TRUST_UNAVAILABLE'
  ])
);

/** Recursively remove credential-shaped keys from arbitrary values. */
export function redactSecrets(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, seen));
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      output[key] = entry === '' || entry === null || entry === undefined ? entry : '[redacted]';
    } else {
      output[key] = redactSecrets(entry, seen);
    }
  }
  return output;
}

export function isSecretKey(key) {
  const normalized = String(key).toLowerCase().replace(/[-_]/g, '');
  return (
    normalized.includes('apikey') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('cookie') ||
    normalized.includes('sessdata') ||
    normalized.includes('bilijct') ||
    normalized.includes('buvid3') ||
    normalized.includes('dedeuserid') ||
    normalized === 'authorization'
  );
}

export class AppError extends Error {
  constructor(code, message, options = {}) {
    if (!ERROR_CODES.includes(code)) {
      throw new Error(`unknown stable error code: ${code}`);
    }
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.retryable =
      options.retryable === undefined ? !NON_RETRYABLE_CODES.has(code) : Boolean(options.retryable);
    this.details = options.details === undefined ? {} : options.details;
    this.httpStatus = options.httpStatus || ERROR_HTTP[code] || 500;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: redactSecrets(this.details)
    };
  }
}

export function isAppError(error) {
  return error instanceof AppError && ERROR_CODES.includes(error.code);
}

export function toAppError(error, fallbackCode = 'DEPENDENCY_UNAVAILABLE', message) {
  if (isAppError(error)) return error;
  return new AppError(fallbackCode, message || (error && error.message) || String(error), {
    cause: error,
    retryable: false
  });
}

export function fail(code, message, details) {
  throw new AppError(code, message, { details });
}

export function assert(condition, code, message, details) {
  if (!condition) throw new AppError(code, message, { details });
}

export default AppError;
