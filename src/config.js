import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from './errors.js';
import {
  atomicWriteFile,
  atomicWriteJson,
  deepClone,
  deepMerge,
  ensureDir,
  isPlainObject,
  isValidTimeZone,
  jcsHash,
  nowIso,
  pathExists
} from './utils.js';

const configExample = JSON.parse(
  fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')
);
export const DEFAULT_CONFIG = deepClone(configExample);
export const CONFIG_SCHEMA_VERSION = 1;

const BOOLEAN_FIELDS = [
  ['browse', 'enabled'],
  ['browse', 'markWatchHistory'],
  ['browse', 'allowNoSubtitle'],
  ['comments', 'enabled'],
  ['comments', 'mentionOwner'],
  ['comments', 'allowTemplate'],
  ['directMessages', 'enabled'],
  ['directMessages', 'requireMutual'],
  ['diary', 'enabled'],
  ['diary', 'afterBrowse'],
  ['diary', 'daily'],
  ['diary', 'publicBook'],
  ['diary', 'privateBook'],
  ['im', 'enabled'],
  ['im', 'notifications', 'enabled'],
  ['production', 'enabled'],
  ['production', 'dryRun'],
  ['production', 'requireApproval'],
  ['publishing', 'enabled'],
  ['publishing', 'dryRun'],
  ['publishing', 'autoPublish'],
  ['publishing', 'requireApproval'],
  ['publishing', 'external', 'successJson'],
  ['agent', 'enabled'],
  ['security', 'allowExternalPublisher'],
  ['security', 'allowLocalProducer'],
  ['scheduler', 'enabled'],
  ['dryRun']
];

const TOP_LEVEL_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
const NESTED_KEYS = {
  platforms: new Set(['enabled']),
  owner: new Set(['mid', 'name']),
  scheduler: new Set(['enabled', 'tickSeconds', 'browseIntervalMinutes', 'diaryTime']),
  browse: new Set([
    'enabled',
    'sources',
    'keywords',
    'perRound',
    'candidatePool',
    'minSubtitleChars',
    'minScore',
    'maxDurationSec',
    'markWatchHistory',
    'failureCooldownMinutes',
    'allowNoSubtitle'
  ]),
  comments: new Set([
    'enabled',
    'mode',
    'perRound',
    'dailyLimit',
    'sameVideoDays',
    'maxLength',
    'mentionOwner',
    'allowTemplate'
  ]),
  directMessages: new Set([
    'enabled',
    'allowedRecipientMids',
    'requireMutual',
    'perRound',
    'dailyLimit',
    'sameVideoDays',
    'maxLength'
  ]),
  diary: new Set(['enabled', 'afterBrowse', 'daily', 'publicBook', 'privateBook', 'directory']),
  im: new Set([
    'enabled',
    'adapterId',
    'transport',
    'maxMessageAgeSec',
    'approvalTtlSec',
    'groupReplies',
    'notifications',
    'onebot'
  ]),
  'im.notifications': new Set(['enabled', 'minGapMs', 'perMinute']),
  'im.onebot': new Set(['baseUrl', 'websocketUrl', 'accessTokenEnv', 'timeoutMs', 'reconnectMs']),
  artifacts: new Set(['directory', 'maxImportBytes']),
  production: new Set([
    'enabled',
    'dryRun',
    'backend',
    'profileId',
    'profilesFile',
    'requireApproval',
    'maxConcurrent',
    'workDir',
    'limits'
  ]),
  'production.limits': new Set(['wallTimeSec', 'maxPaidCostMinor', 'currency', 'maxOutputBytes']),
  migration: new Set(['mode', 'directory', 'maxFiles', 'maxTotalBytes']),
  publishing: new Set([
    'enabled',
    'provider',
    'dryRun',
    'autoPublish',
    'requireApproval',
    'outputDir',
    'external'
  ]),
  'publishing.external': new Set(['command', 'args', 'timeoutMs', 'successJson']),
  agent: new Set(['enabled', 'baseUrl', 'apiKeyEnv', 'model', 'timeoutMs', 'persona']),
  rateLimit: new Set([
    'minGapMs',
    'writeGapMs',
    'readPerHour',
    'readPerDay',
    'writePerHour',
    'writePerDay',
    'requestTimeoutMs',
    'circuitBaseMs',
    'circuitMaxMs'
  ]),
  security: new Set([
    'allowExternalPublisher',
    'allowLocalProducer',
    'maxUploadBytes',
    'allowedVideoExtensions',
    'allowedSourceDirs'
  ])
};

/** HTTP PATCH allow-list (SPEC §4.5). Privileged/security fields are excluded. */
export const HTTP_CONFIG_PATHS = Object.freeze([
  'scheduler.enabled',
  'scheduler.tickSeconds',
  'scheduler.browseIntervalMinutes',
  'scheduler.diaryTime',
  'browse.enabled',
  'browse.sources',
  'browse.keywords',
  'browse.perRound',
  'browse.candidatePool',
  'browse.minSubtitleChars',
  'browse.minScore',
  'browse.maxDurationSec',
  'browse.failureCooldownMinutes',
  'browse.allowNoSubtitle',
  'comments.enabled',
  'comments.mode',
  'comments.perRound',
  'comments.dailyLimit',
  'comments.sameVideoDays',
  'comments.maxLength',
  'comments.mentionOwner',
  'comments.allowTemplate',
  'directMessages.enabled',
  'directMessages.allowedRecipientMids',
  'directMessages.requireMutual',
  'directMessages.perRound',
  'directMessages.dailyLimit',
  'directMessages.sameVideoDays',
  'directMessages.maxLength',
  'diary.enabled',
  'diary.afterBrowse',
  'diary.daily',
  'diary.publicBook',
  'diary.privateBook',
  'production.enabled',
  'production.limits.wallTimeSec',
  'production.limits.maxPaidCostMinor',
  'production.limits.maxOutputBytes',
  'publishing.enabled'
]);

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new AppError('CONFIG_INVALID', `${label} must be a boolean`, { details: { path: label } });
  }
}

function requireInteger(value, label, min, max, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError('CONFIG_INVALID', `${label} must be an integer between ${min} and ${max}`, {
      details: { path: label, value }
    });
  }
  if (!allowZero && value === 0) {
    throw new AppError('CONFIG_INVALID', `${label} must not be zero`, { details: { path: label } });
  }
}

function requireAbsoluteOrEmpty(value, label) {
  if (typeof value !== 'string') {
    throw new AppError('CONFIG_INVALID', `${label} must be a string`, { details: { path: label } });
  }
  if (value === '') return;
  if (!path.isAbsolute(value)) {
    throw new AppError('CONFIG_INVALID', `${label} must be an absolute path`, { details: { path: label } });
  }
}

/** Optional URL setting: empty is allowed, otherwise the protocol must match. */
function requireHttpsOrEmpty(value, label, protocols) {
  if (typeof value !== 'string') {
    throw new AppError('CONFIG_INVALID', `${label} must be a string`, { details: { path: label } });
  }
  if (value === '') return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError('CONFIG_INVALID', `${label} must be an absolute URL`, { details: { path: label } });
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new AppError('CONFIG_INVALID', `${label} must use ${protocols.join('|')}`, {
      details: { path: label, protocol: parsed.protocol }
    });
  }
}

function requireString(value, label, { allowEmpty = false, max = 4096 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '') || value.length > max) {
    throw new AppError('CONFIG_INVALID', `${label} must be a non-empty string`, { details: { path: label } });
  }
}

function requireEnum(value, label, values) {
  if (!values.includes(value)) {
    throw new AppError('CONFIG_INVALID', `${label} must be one of ${values.join('|')}`, {
      details: { path: label, value }
    });
  }
}

function requireArray(value, label, predicate, itemLabel) {
  if (!Array.isArray(value) || !value.every(predicate)) {
    throw new AppError('CONFIG_INVALID', `${label} must be an array of ${itemLabel}`, {
      details: { path: label }
    });
  }
}

function rejectUnknownKeys(object, prefix, allowed, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${prefix}${prefix ? '.' : ''}${key}`);
  }
}

/**
 * Full structural validation. Throws CONFIG_INVALID on the first problem;
 * details.unknownKeys lists every unknown path when relevant.
 */
export function validateConfig(input) {
  if (!isPlainObject(input)) {
    throw new AppError('CONFIG_INVALID', 'config must be a JSON object');
  }
  const unknown = [];
  rejectUnknownKeys(input, '', TOP_LEVEL_KEYS, unknown);
  for (const [key, allowed] of Object.entries(NESTED_KEYS)) {
    const value = getPath(input, key);
    if (isPlainObject(value)) rejectUnknownKeys(value, key, allowed, unknown);
  }
  if (unknown.length > 0) {
    throw new AppError('CONFIG_INVALID', 'unknown configuration keys', {
      details: { unknownKeys: unknown }
    });
  }

  if (input.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new AppError('CONFIG_INVALID', 'schemaVersion must be 1', {
      details: { path: 'schemaVersion' }
    });
  }
  for (const field of BOOLEAN_FIELDS) {
    requireBoolean(getPath(input, field.join('.')), field.join('.'));
  }
  if (!isValidTimeZone(input.timeZone)) {
    throw new AppError('CONFIG_INVALID', 'timeZone must be a valid IANA time zone', {
      details: { path: 'timeZone' }
    });
  }

  requireArray(input.platforms.enabled, 'platforms.enabled', (value) => value === 'bilibili', 'bilibili');
  if (input.owner.mid < 0 || !Number.isSafeInteger(input.owner.mid)) {
    throw new AppError('CONFIG_INVALID', 'owner.mid must be a non-negative safe integer');
  }
  if (typeof input.owner.name !== 'string') {
    throw new AppError('CONFIG_INVALID', 'owner.name must be a string');
  }

  requireInteger(input.scheduler.tickSeconds, 'scheduler.tickSeconds', 15, 86400);
  requireInteger(input.scheduler.browseIntervalMinutes, 'scheduler.browseIntervalMinutes', 1, 10080);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.scheduler.diaryTime)) {
    throw new AppError('CONFIG_INVALID', 'scheduler.diaryTime must be HH:mm');
  }

  requireArray(
    input.browse.sources,
    'browse.sources',
    (value) => value === 'popular' || value === 'search',
    'popular|search'
  );
  requireArray(input.browse.keywords, 'browse.keywords', (value) => typeof value === 'string' && value.length <= 100, 'short strings');
  requireInteger(input.browse.perRound, 'browse.perRound', 1, 20);
  requireInteger(input.browse.candidatePool, 'browse.candidatePool', 1, 100);
  requireInteger(input.browse.minSubtitleChars, 'browse.minSubtitleChars', 0, 100000, { allowZero: true });
  requireInteger(input.browse.minScore, 'browse.minScore', 0, 1000, { allowZero: true });
  requireInteger(input.browse.maxDurationSec, 'browse.maxDurationSec', 1, 86400);
  requireInteger(input.browse.failureCooldownMinutes, 'browse.failureCooldownMinutes', 0, 10080, { allowZero: true });
  if (input.browse.markWatchHistory) {
    throw new AppError('CONFIG_INVALID', 'browse.markWatchHistory is not implemented in this release', {
      details: { path: 'browse.markWatchHistory' }
    });
  }

  requireEnum(input.comments.mode, 'comments.mode', ['approval', 'auto']);
  requireInteger(input.comments.perRound, 'comments.perRound', 0, 20, { allowZero: true });
  requireInteger(input.comments.dailyLimit, 'comments.dailyLimit', 0, 20, { allowZero: true });
  requireInteger(input.comments.sameVideoDays, 'comments.sameVideoDays', 0, 365, { allowZero: true });
  requireInteger(input.comments.maxLength, 'comments.maxLength', 1, 2000);
  if (input.comments.mentionOwner && input.owner.name.trim() === '') {
    throw new AppError('CONFIG_INVALID', 'comments.mentionOwner requires owner.name');
  }

  requireArray(
    input.directMessages.allowedRecipientMids,
    'directMessages.allowedRecipientMids',
    (value) => Number.isSafeInteger(value) && value > 0,
    'positive integers'
  );
  requireInteger(input.directMessages.perRound, 'directMessages.perRound', 0, 20, { allowZero: true });
  requireInteger(input.directMessages.dailyLimit, 'directMessages.dailyLimit', 0, 20, { allowZero: true });
  requireInteger(input.directMessages.sameVideoDays, 'directMessages.sameVideoDays', 0, 365, { allowZero: true });
  requireInteger(input.directMessages.maxLength, 'directMessages.maxLength', 1, 2000);
  if (!input.diary.publicBook && !input.diary.privateBook) {
    // Allowed to be both off; only an explicit diary write is rejected.
  }
  requireAbsoluteOrEmpty(input.diary.directory, 'diary.directory');

  requireEnum(input.im.adapterId, 'im.adapterId', ['dsh-im']);
  requireEnum(input.im.transport, 'im.transport', ['dsh-im', 'onebot-v11']);
  requireInteger(input.im.maxMessageAgeSec, 'im.maxMessageAgeSec', 60, 3600);
  requireInteger(input.im.approvalTtlSec, 'im.approvalTtlSec', 60, 3600);
  requireEnum(input.im.groupReplies, 'im.groupReplies', ['summary', 'none']);
  requireInteger(input.im.notifications.minGapMs, 'im.notifications.minGapMs', 1000, 86400000);
  requireInteger(input.im.notifications.perMinute, 'im.notifications.perMinute', 0, 60, { allowZero: true });

  // Optional local QQ bridge over OneBot v11 (user-supplied implementation; no
  // QQ SDK is bundled by this plugin). Endpoint/token do not enable anything by
  // themselves: im.enabled, local bindings and human approval rules still apply.
  const onebot = input.im.onebot;
  requireHttpsOrEmpty(onebot.baseUrl, 'im.onebot.baseUrl', ['http:', 'https:']);
  requireHttpsOrEmpty(onebot.websocketUrl, 'im.onebot.websocketUrl', ['ws:', 'wss:']);
  if (typeof onebot.accessTokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(onebot.accessTokenEnv)) {
    throw new AppError('CONFIG_INVALID', 'im.onebot.accessTokenEnv must be an environment variable name', {
      details: { path: 'im.onebot.accessTokenEnv' }
    });
  }
  requireInteger(onebot.timeoutMs, 'im.onebot.timeoutMs', 1000, 60000);
  requireInteger(onebot.reconnectMs, 'im.onebot.reconnectMs', 1000, 600000);
  if (input.im.transport === 'onebot-v11' && input.im.enabled === true) {
    if (onebot.baseUrl === '') {
      throw new AppError('CONFIG_INVALID', 'im.onebot.baseUrl is required when im.transport is onebot-v11', {
        details: { path: 'im.onebot.baseUrl' }
      });
    }
    if (onebot.websocketUrl === '') {
      throw new AppError('CONFIG_INVALID', 'im.onebot.websocketUrl is required when im.transport is onebot-v11', {
        details: { path: 'im.onebot.websocketUrl' }
      });
    }
  }

  requireAbsoluteOrEmpty(input.artifacts.directory, 'artifacts.directory');
  requireInteger(input.artifacts.maxImportBytes, 'artifacts.maxImportBytes', 1, Number.MAX_SAFE_INTEGER);

  requireEnum(input.production.backend, 'production.backend', ['local', 'remote']);
  requireEnum(input.production.profileId, 'production.profileId', ['local-slideshow-v1']);
  requireAbsoluteOrEmpty(input.production.profilesFile, 'production.profilesFile');
  requireAbsoluteOrEmpty(input.production.workDir, 'production.workDir');
  requireInteger(input.production.maxConcurrent, 'production.maxConcurrent', 1, 1);
  if (input.production.requireApproval !== true) {
    throw new AppError('CONFIG_INVALID', 'production.requireApproval must be true in this release');
  }
  requireInteger(input.production.limits.wallTimeSec, 'production.limits.wallTimeSec', 1, 86400);
  if (!Number.isSafeInteger(input.production.limits.maxPaidCostMinor) || input.production.limits.maxPaidCostMinor < 0) {
    throw new AppError('CONFIG_INVALID', 'production.limits.maxPaidCostMinor must be a non-negative integer');
  }
  requireEnum(input.production.limits.currency, 'production.limits.currency', ['CNY']);
  requireInteger(input.production.limits.maxOutputBytes, 'production.limits.maxOutputBytes', 1, Number.MAX_SAFE_INTEGER);
  if (input.production.backend === 'remote') {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'remote execution backend is not implemented', {
      details: { capability: 'execution.remote' }
    });
  }

  requireEnum(input.migration.mode, 'migration.mode', ['offline']);
  requireAbsoluteOrEmpty(input.migration.directory, 'migration.directory');
  requireInteger(input.migration.maxFiles, 'migration.maxFiles', 1, Number.MAX_SAFE_INTEGER);
  requireInteger(input.migration.maxTotalBytes, 'migration.maxTotalBytes', 1, Number.MAX_SAFE_INTEGER);

  requireEnum(input.publishing.provider, 'publishing.provider', ['manual', 'external']);
  requireAbsoluteOrEmpty(input.publishing.outputDir, 'publishing.outputDir');
  if (input.publishing.autoPublish !== false) {
    throw new AppError('CONFIG_INVALID', 'publishing.autoPublish must be false in this release');
  }
  if (input.publishing.requireApproval !== true) {
    throw new AppError('CONFIG_INVALID', 'publishing.requireApproval must be true in this release');
  }
  requireInteger(input.publishing.external.timeoutMs, 'publishing.external.timeoutMs', 1000, 3600000);
  requireArray(input.publishing.external.args, 'publishing.external.args', (value) => typeof value === 'string' && value.length <= 4096, 'strings');
  requireAbsoluteOrEmpty(input.publishing.external.command, 'publishing.external.command');
  if (
    input.publishing.provider === 'external' &&
    input.publishing.dryRun === false &&
    (!input.security.allowExternalPublisher || input.publishing.external.command === '')
  ) {
    throw new AppError(
      'CONFIG_INVALID',
      'external publishing requires security.allowExternalPublisher=true and an absolute command'
    );
  }
  if (input.publishing.external.successJson === false && input.publishing.provider === 'external' && input.publishing.dryRun === false) {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'external publisher without successJson has no verified receipt protocol');
  }

  if (!/^https:\/\/[^/\s]+/.test(input.agent.baseUrl)) {
    throw new AppError('CONFIG_INVALID', 'agent.baseUrl must be an absolute HTTPS URL');
  }
  requireString(input.agent.apiKeyEnv, 'agent.apiKeyEnv', { max: 200 });
  requireString(input.agent.model, 'agent.model', { max: 200 });
  requireInteger(input.agent.timeoutMs, 'agent.timeoutMs', 1000, 600000);

  requireInteger(input.rateLimit.minGapMs, 'rateLimit.minGapMs', 500, 86400000);
  requireInteger(input.rateLimit.writeGapMs, 'rateLimit.writeGapMs', 30000, 86400000);
  requireInteger(input.rateLimit.readPerHour, 'rateLimit.readPerHour', 1, 100000);
  requireInteger(input.rateLimit.readPerDay, 'rateLimit.readPerDay', 1, 1000000);
  requireInteger(input.rateLimit.writePerHour, 'rateLimit.writePerHour', 1, 10000);
  requireInteger(input.rateLimit.writePerDay, 'rateLimit.writePerDay', 1, 100000);
  requireInteger(input.rateLimit.requestTimeoutMs, 'rateLimit.requestTimeoutMs', 1000, 300000);
  requireInteger(input.rateLimit.circuitBaseMs, 'rateLimit.circuitBaseMs', 1000, 86400000);
  requireInteger(input.rateLimit.circuitMaxMs, 'rateLimit.circuitMaxMs', input.rateLimit.circuitBaseMs, 86400000);

  requireArray(
    input.security.allowedSourceDirs,
    'security.allowedSourceDirs',
    (value) => typeof value === 'string' && path.isAbsolute(value),
    'absolute paths'
  );
  requireArray(
    input.security.allowedVideoExtensions,
    'security.allowedVideoExtensions',
    (value) => typeof value === 'string' && /^\.[A-Za-z0-9]+$/.test(value),
    'extensions'
  );
  requireInteger(input.security.maxUploadBytes, 'security.maxUploadBytes', 1, Number.MAX_SAFE_INTEGER);
  requireAbsoluteOrEmpty(input.dataDir, 'dataDir');
  requireAbsoluteOrEmpty(input.credentialsFile, 'credentialsFile');

  return input;
}

export function getPath(object, dotted) {
  let current = object;
  for (const key of dotted.split('.')) {
    if (!isPlainObject(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

export function setPath(object, dotted, value) {
  const parts = dotted.split('.');
  let current = object;
  for (const key of parts.slice(0, -1)) {
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key];
  }
  current[parts.at(-1)] = value;
}

export function maskForHash(config) {
  // No credential values are part of config; normalize only versioned fields.
  return deepClone(config);
}

export function computeConfigHash(config) {
  return jcsHash(maskForHash(config));
}

export function resolveDataDir(config, env = process.env) {
  if (config?.dataDir) return path.resolve(config.dataDir);
  if (env.DSH_BILI_UNIFIED_DATA_DIR) return path.resolve(env.DSH_BILI_UNIFIED_DATA_DIR);
  if (env.DSH_HOME) return path.resolve(env.DSH_HOME, 'dsh-bili-unified');
  return path.join(os.homedir(), '.dsh', 'dsh-bili-unified');
}

export function resolvePaths(config, env = process.env) {
  const dataDir = resolveDataDir(config, env);
  return {
    dataDir,
    configFile: env.DSH_BILI_UNIFIED_CONFIG
      ? path.resolve(env.DSH_BILI_UNIFIED_CONFIG)
      : path.join(dataDir, 'config.json'),
    stateFile: path.join(dataDir, 'state.json'),
    instanceFile: path.join(dataDir, 'instance.json'),
    credentialsFile: config.credentialsFile
      ? path.resolve(config.credentialsFile)
      : path.join(dataDir, 'credentials.json'),
    diaryDir: config.diary.directory ? path.resolve(config.diary.directory) : path.join(dataDir, 'diary'),
    postsDir: config.publishing.outputDir ? path.resolve(config.publishing.outputDir) : path.join(dataDir, 'posts'),
    artifactsDir: config.artifacts.directory
      ? path.resolve(config.artifacts.directory)
      : path.join(dataDir, 'artifacts'),
    workDir: config.production.workDir
      ? path.resolve(config.production.workDir)
      : path.join(dataDir, 'production-work'),
    journalDir: path.join(dataDir, 'journal'),
    migrationsDir: config.migration.directory
      ? path.resolve(config.migration.directory)
      : path.join(dataDir, 'migrations'),
    productionProfilesFile: config.production.profilesFile
      ? path.resolve(config.production.profilesFile)
      : path.join(dataDir, 'production-profiles.json'),
    backupPolicyFile: path.join(dataDir, 'backup-policy.json'),
    recoveryDir: path.join(dataDir, 'recovery')
  };
}

const ENV_OVERRIDES = [
  ['DSH_BILI_UNIFIED_DRY_RUN', 'dryRun', (value) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new AppError('CONFIG_INVALID', 'DSH_BILI_UNIFIED_DRY_RUN must be true or false');
  }],
  ['DSH_BILI_UNIFIED_TIME_ZONE', 'timeZone', (value) => value],
  ['DSH_BILI_UNIFIED_DATA_DIR', 'dataDir', (value) => path.resolve(value)]
];

export function applyEnvOverrides(config, env = process.env) {
  const output = deepClone(config);
  for (const [envKey, pathKey, parse] of ENV_OVERRIDES) {
    if (env[envKey] !== undefined) setPath(output, pathKey, parse(env[envKey]));
  }
  return output;
}

export function redactConfig(config) {
  return redactConfigRecursive(config);
}

function redactConfigRecursive(value) {
  if (Array.isArray(value)) return value.map(redactConfigRecursive);
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^(apikey|api_key|token|secret|password|cookie|sessdata|bili_jct)$/i.test(key)) {
      output[key] = entry ? '[redacted]' : entry;
    } else {
      output[key] = redactConfigRecursive(entry);
    }
  }
  return output;
}

function assertHttpPatch(patch) {
  if (!isPlainObject(patch)) throw new AppError('CONFIG_INVALID', 'patch must be an object');
  const allowed = new Set(HTTP_CONFIG_PATHS);
  const rejected = [];
  const walk = (value, prefix) => {
    if (isPlainObject(value)) {
      for (const [key, entry] of Object.entries(value)) {
        const next = prefix ? `${prefix}.${key}` : key;
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          walk(entry, next);
        } else if (!allowed.has(next)) {
          rejected.push(next);
        }
      }
    }
  };
  walk(patch, '');
  if (rejected.length > 0) {
    throw new AppError('FORBIDDEN', 'configuration fields are not writable over HTTP', {
      details: { rejected }
    });
  }
}

function deepPatch(base, patch) {
  const output = deepClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepPatch(output[key], value);
    } else {
      output[key] = deepClone(value);
    }
  }
  return output;
}

export async function loadConfigFile(file, options = {}) {
  const env = options.env || process.env;
  let raw = {};
  if (file && (await pathExists(file))) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      throw new AppError('CONFIG_INVALID', 'cannot read config file', { cause: error });
    }
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new AppError('CONFIG_INVALID', 'config file is not valid JSON', { cause: error });
    }
    if (!isPlainObject(raw)) throw new AppError('CONFIG_INVALID', 'config file must contain an object');
  }
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, raw), options.injected || {});
  const withEnv = applyEnvOverrides(merged, env);
  return validateConfig(withEnv);
}

/**
 * Read and fully validate a config JSON file without applying env overrides.
 * Used by intent reconciliation where the persisted bytes are authoritative.
 * Returns null when the file is missing, unparsable or fails validation.
 */
async function readValidatedConfigText(file) {
  try {
    if (!(await pathExists(file))) return null;
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    validateConfig(deepMerge(DEFAULT_CONFIG, parsed));
    return parsed;
  } catch {
    return null;
  }
}

export class ConfigService {
  constructor({ dataDir, file, store, injected, env = process.env, now = () => new Date(), logger, hooks = {} } = {}) {
    this.env = env;
    this.injected = injected || {};
    this.store = store;
    this.now = now;
    this.logger = logger;
    this.hooks = hooks || {};
    this.dataDir = dataDir;
    this.file = file;
    this.config = null;
    this.paths = null;
    this.revisionVersion = undefined;
    this.onChangeListeners = new Set();
  }

  async load({ bootstrap = false } = {}) {
    let dataDir = this.dataDir;
    let file = this.file;
    if (!dataDir) {
      // First pass needs a config to discover dataDir; the env override wins.
      const preliminary = validateConfig(
        applyEnvOverrides(deepMerge(DEFAULT_CONFIG, this.injected), this.env)
      );
      dataDir = resolveDataDir(preliminary, this.env);
      file = file || (this.env.DSH_BILI_UNIFIED_CONFIG
        ? path.resolve(this.env.DSH_BILI_UNIFIED_CONFIG)
        : path.join(dataDir, 'config.json'));
    } else if (!file && (await pathExists(path.join(dataDir, 'config.json')))) {
      // An explicit --data-dir may carry its own config.json; load it instead of
      // silently falling back to defaults (CLI inspection commands rely on it).
      file = path.join(dataDir, 'config.json');
    }
    this.dataDir = dataDir;
    this.file = file;
    this.config = await loadConfigFile(file, { env: this.env, injected: this.injected });
    // Explicit constructor dataDir overrides config/env.
    if (dataDir !== resolveDataDir(this.config, this.env)) {
      this.config.dataDir = dataDir;
    }
    this.paths = resolvePaths(this.config, this.env);
    if (this.store) {
      await this.syncRevision({ bootstrap });
    }
    return { config: this.config, paths: this.paths };
  }

  get() {
    if (!this.config) throw new AppError('CONFIG_INVALID', 'config has not been loaded');
    return this.config;
  }

  getPaths() {
    if (!this.paths) throw new AppError('CONFIG_INVALID', 'paths have not been resolved');
    return this.paths;
  }

  getRevision() {
    const config = this.get();
    return { version: this.revisionVersion ?? 1, sha256: computeConfigHash(config) };
  }

  redacted() {
    return redactConfig(this.get());
  }

  /**
   * Register a listener invoked after every successful update() commit, in
   * registration order, with `{config, previous, revision}`. Returns an
   * unsubscribe function. Listener failures never roll the commit back.
   */
  onChange(listener) {
    if (typeof listener !== 'function') {
      throw new AppError('CONFIG_INVALID', 'onChange listener must be a function');
    }
    this.onChangeListeners.add(listener);
    return () => this.onChangeListeners.delete(listener);
  }

  _notifyChange(event) {
    for (const listener of this.onChangeListeners) {
      try {
        const pending = listener(event);
        if (pending && typeof pending.catch === 'function') {
          pending.catch((error) => {
            this.logger?.warn?.('config.onChange listener failed', { code: error?.code || null });
          });
        }
      } catch (error) {
        this.logger?.warn?.('config.onChange listener failed', { code: error?.code || null });
      }
    }
  }

  _revisionEnforced(source) {
    return source === 'http' || source === 'command';
  }

  _effectiveConfig(raw) {
    const config = validateConfig(applyEnvOverrides(deepMerge(deepMerge(DEFAULT_CONFIG, raw), this.injected), this.env));
    if (this.dataDir) config.dataDir = this.dataDir;
    return config;
  }

  async _reloadConfigFromFile() {
    if (!this.file) return;
    this.config = await loadConfigFile(this.file, { env: this.env, injected: this.injected });
    // An explicit constructor dataDir keeps priority over the file value.
    if (this.dataDir && this.dataDir !== resolveDataDir(this.config, this.env)) {
      this.config.dataDir = this.dataDir;
    }
    this.paths = resolvePaths(this.config, this.env);
  }

  /**
   * Recover an interrupted update() commit protocol (SPEC §4.5).
   * Called from syncRevision so startup always resolves a prepared intent to
   * exactly one durable state: new file + new revision, or old file + old
   * revision. Never invents a third state.
   */
  async reconcileConfigIntent() {
    if (!this.store || !this.file) return { reconciled: false, action: 'none' };
    const snapshot = await this.store.getSnapshot();
    const intent = snapshot.configIntent || null;
    const nextFile = `${this.file}.next`;
    const hasNext = await pathExists(nextFile);
    if (!intent) {
      if (hasNext) {
        await fsp.rm(nextFile, { force: true });
        return { reconciled: false, action: 'removed_orphan_next' };
      }
      return { reconciled: false, action: 'none' };
    }
    if (
      !isPlainObject(intent) ||
      intent.phase !== 'prepared' ||
      !Number.isSafeInteger(intent.nextVersion) ||
      intent.nextVersion < 1 ||
      typeof intent.nextSha256 !== 'string'
    ) {
      return this._discardConfigIntent({ intent, nextFile, reason: 'invalid_intent' });
    }
    if (path.resolve(String(intent.nextFile || '')) !== path.resolve(nextFile)) {
      return this._discardConfigIntent({ intent, nextFile, reason: 'intent_file_mismatch' });
    }

    let candidate = null;
    let source = null;
    if (hasNext) {
      candidate = await readValidatedConfigText(nextFile);
      source = 'next_file';
    } else if (await pathExists(this.file)) {
      candidate = await readValidatedConfigText(this.file);
      source = 'config_file';
    }
    if (!candidate) {
      return this._discardConfigIntent({ intent, nextFile, reason: 'unreadable_candidate' });
    }
    const candidateHash = computeConfigHash(candidate);
    if (candidateHash !== (intent.fileSha256 || intent.nextSha256)) {
      return this._discardConfigIntent({ intent, nextFile, reason: 'hash_mismatch' });
    }
    if (source === 'next_file') {
      await fsp.rename(nextFile, this.file);
    }
    return this._commitReconciledRevision(intent, this._effectiveConfig(candidate), source);
  }

  async _commitReconciledRevision(intent, config, action) {
    const hash = computeConfigHash(config);
    const revision = await this.store.transaction(async (draft, tx) => {
      const currentVersion = draft.configRevision?.version || 0;
      const next = {
        version: Math.max(currentVersion + 1, intent.nextVersion),
        sha256: hash,
        updatedAt: nowIso(this.now),
        timeZone: config.timeZone
      };
      draft.configRevision = next;
      draft.configIntent = null;
      tx.appendEvent({
        type: 'config.updated',
        actor: 'system',
        payload: { version: next.version, sha256: hash, recovered: action }
      });
      return deepClone(next);
    });
    this.revisionVersion = revision.version;
    await this._reloadConfigFromFile();
    return { reconciled: true, action, revision };
  }

  async _discardConfigIntent({ intent, nextFile, reason }) {
    await fsp.rm(nextFile, { force: true }).catch(() => {});
    await this.store.transaction(async (draft, tx) => {
      if (!draft.configIntent) return;
      draft.configIntent = null;
      tx.appendEvent({
        type: 'config.update.discarded',
        actor: 'system',
        payload: { reason, nextVersion: intent?.nextVersion ?? null, at: nowIso(this.now) }
      });
    });
    return { reconciled: true, action: 'discarded', reason };
  }

  async syncRevision({ bootstrap = false } = {}) {
    if (this.store) await this.reconcileConfigIntent();
    const config = this.get();
    const hash = computeConfigHash(config);
    const snapshot = await this.store.getSnapshot();
    const current = snapshot.configRevision || { version: 0, sha256: '' };
    if (current.sha256 === hash) {
      this.revisionVersion = current.version;
      return current;
    }
    const next = await this.store.transaction(async (draft, tx) => {
      const revision = {
        version: (draft.configRevision?.version || 0) + 1,
        sha256: hash,
        updatedAt: nowIso(this.now),
        timeZone: config.timeZone
      };
      draft.configRevision = revision;
      tx.appendEvent({
        type: 'config.revision.updated',
        actor: 'system',
        payload: {
          version: revision.version,
          sha256: hash,
          previousSha256: current.sha256 || null,
          bootstrap: bootstrap === true,
          timeZone: config.timeZone
        }
      });
      return revision;
    });
    this.revisionVersion = next.version;
    return next;
  }

  /**
   * Apply a configuration patch with a recoverable, crash-safe commit protocol
   * (SPEC §4.5 / FIX_PLAN I2):
   *   1. validate the merged config and stage `<configFile>.next`;
   *   2. transaction: CAS expectedRevision, phase/instance gates, write intent;
   *   3. atomic rename `.next` -> config file;
   *   4. transaction: commit configRevision, clear intent, append config.updated.
   * A caught failure rolls back to "old file + old revision" and removes the
   * intent. A crash leaves the intent for reconcileConfigIntent() at the next
   * start. HTTP/command sources must pass expectedRevision.
   */
  async update(patch, { source = 'http', expectedRevision } = {}) {
    if (source === 'http') assertHttpPatch(patch);
    else if (!['cli', 'local', 'system', 'command'].includes(source)) {
      throw new AppError('FORBIDDEN', 'unknown configuration update source');
    }
    const revisionEnforced = this._revisionEnforced(source);
    if (revisionEnforced && expectedRevision === undefined) {
      throw new AppError('INPUT_REQUIRED', 'expectedRevision is required for remote configuration updates', {
        details: { path: 'expectedRevision' }
      });
    }
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new AppError('INPUT_REQUIRED', 'expectedRevision must be a non-negative integer', {
        details: { path: 'expectedRevision', value: expectedRevision }
      });
    }
    const previous = this.get();
    if (source === 'http') {
      if (previous.dryRun === true && patch.dryRun === false) {
        throw new AppError('FORBIDDEN', 'HTTP configuration update cannot disable dryRun');
      }
      const forbiddenFlags = [
        ['production', 'requireApproval'],
        ['publishing', 'requireApproval'],
        ['publishing', 'autoPublish'],
        ['security', 'allowExternalPublisher'],
        ['security', 'allowLocalProducer'],
        ['platforms', 'enabled'],
        ['im', 'enabled'],
        ['migration', 'mode']
      ];
      for (const [group, key] of forbiddenFlags) {
        if (patch[group] && Object.prototype.hasOwnProperty.call(patch[group], key)) {
          throw new AppError('FORBIDDEN', `HTTP configuration update cannot change ${group}.${key}`);
        }
      }
    }
    // Persist only the file layer. Host/env constraints remain authoritative
    // immediately, after restart and after recovery of an interrupted update.
    const raw = this.file ? (await readValidatedConfigText(this.file)) : null;
    const persisted = deepPatch(raw || {}, patch);
    const merged = this._effectiveConfig(persisted);
    if (merged.production.requireApproval !== true) {
      throw new AppError('CONFIG_INVALID', 'production.requireApproval cannot be disabled');
    }
    if (merged.publishing.requireApproval !== true || merged.publishing.autoPublish !== false) {
      throw new AppError('CONFIG_INVALID', 'publishing human approval is mandatory');
    }
    validateConfig(merged);
    const hash = computeConfigHash(merged);
    const paths = resolvePaths(merged, this.env);
    if (this.file) paths.configFile = this.file;
    await ensureDir(path.dirname(paths.configFile));
    const nextFile = `${paths.configFile}.next`;
    let intent = null;
    let renamed = false;
    let previousText = null;
    let committed = false;
    try {
      await atomicWriteJson(nextFile, persisted, { mode: 0o600 });
      if (this.store) {
        this.hooks.afterStageNext?.({ file: paths.configFile, nextFile });
        intent = await this.store.transaction(async (draft, tx) => {
          const currentVersion = draft.configRevision?.version || 0;
          if (expectedRevision !== undefined && currentVersion !== expectedRevision) {
            throw new AppError('APPROVAL_STALE', 'configuration revision changed', {
              details: { expectedRevision, actualRevision: currentVersion }
            });
          }
          if (draft.configIntent) {
            throw new AppError('APPROVAL_STALE', 'another configuration update is in progress');
          }
          this._assertConfigWritable(draft, tx);
          const prepared = {
            phase: 'prepared',
            nextVersion: currentVersion + 1,
            nextSha256: hash,
            fileSha256: computeConfigHash(persisted),
            nextFile: path.resolve(nextFile),
            prevSha256: draft.configRevision?.sha256 || '',
            at: nowIso(this.now)
          };
          draft.configIntent = prepared;
          tx.appendEvent({
            type: 'config.update.prepared',
            actor: source,
            payload: {
              version: prepared.nextVersion,
              sha256: hash,
              previousSha256: prepared.prevSha256
            }
          });
          return deepClone(prepared);
        });
        this.hooks.afterIntent?.({ intent });
        previousText = (await pathExists(paths.configFile)) ? await fsp.readFile(paths.configFile, 'utf8') : null;
        this.hooks.beforeRename?.({ file: paths.configFile, nextFile, intent });
        await fsp.rename(nextFile, paths.configFile);
        renamed = true;
        this.hooks.afterRename?.({ file: paths.configFile, intent });
        const revision = await this.store.transaction(async (draft, tx) => {
          const currentVersion = draft.configRevision?.version || 0;
          const next = {
            version: Math.max(currentVersion + 1, intent.nextVersion),
            sha256: hash,
            updatedAt: nowIso(this.now),
            timeZone: merged.timeZone
          };
          draft.configRevision = next;
          draft.configIntent = null;
          tx.appendEvent({
            type: 'config.updated',
            actor: source,
            payload: { version: next.version, sha256: hash, patch: redactConfig(patch) }
          });
          return deepClone(next);
        });
        committed = true;
        this.config = merged;
        this.paths = paths;
        this.revisionVersion = revision.version;
        this._notifyChange({ config: merged, previous, revision });
      } else {
        await fsp.rename(nextFile, paths.configFile);
        committed = true;
        this.config = merged;
        this.paths = paths;
        this._notifyChange({
          config: merged,
          previous,
          revision: { version: this.revisionVersion ?? 1, sha256: hash }
        });
      }
      return this.redacted();
    } catch (error) {
      if (!committed) {
        try {
          if (renamed) {
            if (previousText === null) await fsp.rm(paths.configFile, { force: true });
            else await atomicWriteFile(paths.configFile, previousText, { mode: 0o600 });
          }
          await fsp.rm(nextFile, { force: true });
          if (this.store && intent) {
            await this.store
              .transaction(async (draft, tx) => {
                if (!draft.configIntent) return;
                draft.configIntent = null;
                tx.appendEvent({
                  type: 'config.update.aborted',
                  actor: source,
                  payload: { reason: error?.code || 'unknown', nextVersion: intent.nextVersion }
                });
              })
              .catch((cleanupError) => {
                this.logger?.warn?.('config update rollback failed; intent kept for startup reconcile', {
                  code: cleanupError?.code || null
                });
              });
          }
        } catch (cleanupError) {
          this.logger?.warn?.('config update rollback failed', { code: cleanupError?.code || null });
        }
      }
      throw error;
    }
  }

  _assertConfigWritable(draft, tx) {
    if (draft.migration?.phase !== 'active') {
      throw new AppError('MIGRATION_BLOCKED', 'configuration cannot be changed while migration is quiescing/sealed');
    }
    if (draft.recovery?.phase && !['normal', 'restricted'].includes(draft.recovery.phase)) {
      throw new AppError('RECOVERY_GAP', 'configuration update is blocked during recovery');
    }
    const instanceStatus = tx.instance?.status || 'active';
    if (instanceStatus === 'recovery-readonly') {
      throw new AppError('RECOVERY_GAP', 'configuration update is blocked in recovery-readonly instances');
    }
    if (!['active', 'paused', 'validated'].includes(instanceStatus)) {
      throw new AppError('MIGRATION_BLOCKED', `configuration cannot be changed while instance status is ${instanceStatus}`);
    }
    return true;
  }

  assertCurrentState(state) {
    const config = this.get();
    const hash = computeConfigHash(config);
    if (!state.configRevision || state.configRevision.sha256 !== hash) {
      throw new AppError('CONFIG_INVALID', 'dispatching configuration revision is stale', {
        details: { expected: hash, actual: state.configRevision?.sha256 || null }
      });
    }
    if (this.revisionVersion !== undefined && state.configRevision.version !== this.revisionVersion) {
      throw new AppError('CONFIG_INVALID', 'dispatching configuration revision version is stale', {
        details: {
          expectedVersion: this.revisionVersion,
          actualVersion: state.configRevision.version ?? null
        }
      });
    }
  }
}

export default ConfigService;
