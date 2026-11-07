import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from './errors.js';
import {
  canonicalize,
  deepClone,
  deepMerge,
  ensureDir,
  isPlainObject,
  isValidTimeZone,
  jcsHash,
  nowIso,
  pathExists,
  sha256Hex,
  isSafeRelativePath
} from './utils.js';

const configExample = JSON.parse(
  fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')
);
export const DEFAULT_CONFIG = deepClone(configExample);
export const CONFIG_SCHEMA_VERSION = 1;

const BOOLEAN_FIELDS = [
  ['browse', 'enabled'],
  ['browse', 'markWatchHistory'],
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
    'markWatchHistory'
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
    'maxMessageAgeSec',
    'approvalTtlSec',
    'groupReplies',
    'notifications'
  ]),
  'im.notifications': new Set(['enabled', 'minGapMs', 'perMinute']),
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

const ABSOLUTE_OR_EMPTY = new Set([
  'dataDir',
  'credentialsFile',
  'production.profilesFile',
  'production.workDir',
  'diary.directory',
  'artifacts.directory',
  'migration.directory',
  'publishing.outputDir',
  'publishing.external.command'
]);

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
  requireInteger(input.im.maxMessageAgeSec, 'im.maxMessageAgeSec', 60, 3600);
  requireInteger(input.im.approvalTtlSec, 'im.approvalTtlSec', 60, 3600);
  requireEnum(input.im.groupReplies, 'im.groupReplies', ['summary', 'none']);
  requireInteger(input.im.notifications.minGapMs, 'im.notifications.minGapMs', 1000, 86400000);
  requireInteger(input.im.notifications.perMinute, 'im.notifications.perMinute', 0, 60, { allowZero: true });

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
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, options.injected || {}), raw);
  const withEnv = applyEnvOverrides(merged, env);
  return validateConfig(withEnv);
}

export class ConfigService {
  constructor({ dataDir, file, store, injected, env = process.env, now = () => new Date(), logger } = {}) {
    this.env = env;
    this.injected = injected || {};
    this.store = store;
    this.now = now;
    this.logger = logger;
    this.dataDir = dataDir;
    this.file = file;
    this.config = null;
    this.paths = null;
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
    return { version: this.revisionVersion || 1, sha256: computeConfigHash(config) };
  }

  redacted() {
    return redactConfig(this.get());
  }

  async syncRevision({ bootstrap = false } = {}) {
    const config = this.get();
    const hash = computeConfigHash(config);
    const snapshot = await this.store.getSnapshot();
    const current = snapshot.configRevision || { version: 0, sha256: '' };
    if (current.sha256 === hash) {
      this.revisionVersion = current.version;
      return current;
    }
    if (!bootstrap && current.sha256 !== '' && !this.allowForeignRevision) {
      // A changed file is an owner action, but dispatch must fail-closed until
      // the revision is committed. Startup sync is explicit and audited.
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
        payload: { version: revision.version, sha256: hash, timeZone: config.timeZone }
      });
      return revision;
    });
    this.revisionVersion = next.version;
    return next;
  }

  async update(patch, { source = 'http', expectedRevision } = {}) {
    if (source === 'http') assertHttpPatch(patch);
    else if (!['cli', 'local', 'system'].includes(source)) {
      throw new AppError('FORBIDDEN', 'unknown configuration update source');
    }
    const current = this.get();
    if (source === 'http') {
      if (current.dryRun === true && patch.dryRun === false) {
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
    const merged = deepPatch(current, patch);
    if (merged.production.requireApproval !== true) {
      throw new AppError('CONFIG_INVALID', 'production.requireApproval cannot be disabled');
    }
    if (merged.publishing.requireApproval !== true || merged.publishing.autoPublish !== false) {
      throw new AppError('CONFIG_INVALID', 'publishing human approval is mandatory');
    }
    validateConfig(merged);
    const hash = computeConfigHash(merged);
    const paths = resolvePaths(merged, this.env);
    if (this.store) {
      const snapshot = await this.store.getSnapshot();
      if (expectedRevision && snapshot.configRevision?.version !== expectedRevision) {
        throw new AppError('APPROVAL_STALE', 'configuration revision changed');
      }
      if (snapshot.migration?.phase !== 'active') {
        throw new AppError('MIGRATION_BLOCKED', 'configuration cannot be changed while migration is quiescing/sealed');
      }
      if (snapshot.recovery?.phase && !['normal', 'restricted'].includes(snapshot.recovery.phase)) {
        throw new AppError('RECOVERY_GAP', 'configuration update is blocked during recovery');
      }
    }
    await ensureDir(path.dirname(paths.configFile));
    const { atomicWriteJson } = await import('./utils.js');
    await atomicWriteJson(paths.configFile, merged, { mode: 0o600 });
    this.config = merged;
    this.paths = paths;
    if (this.store) {
      const revision = await this.store.transaction(async (draft, tx) => {
        const next = {
          version: (draft.configRevision?.version || 0) + 1,
          sha256: hash,
          updatedAt: nowIso(this.now),
          timeZone: merged.timeZone
        };
        draft.configRevision = next;
        tx.appendEvent({
          type: 'config.updated',
          actor: source,
          payload: { version: next.version, sha256: hash, patch: redactConfig(patch) }
        });
        return next;
      });
      this.revisionVersion = revision.version;
    }
    return this.redacted();
  }

  assertCurrentState(state) {
    const hash = computeConfigHash(this.get());
    if (!state.configRevision || state.configRevision.sha256 !== hash) {
      throw new AppError('CONFIG_INVALID', 'dispatching configuration revision is stale', {
        details: { expected: hash, actual: state.configRevision?.sha256 || null }
      });
    }
  }
}

export default ConfigService;
