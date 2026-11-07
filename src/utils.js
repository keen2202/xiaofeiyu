import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError, redactSecrets } from './errors.js';

export const SCHEMA_VERSION = 1;
export const STATE_VERSION = 3;

/** RFC 8785-style JSON canonicalization. Arrays keep order. */
export function canonicalize(value) {
  return canonicalizeValue(value, new WeakSet());
}

function canonicalizeValue(value, stack) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS cannot encode a non-finite number');
    if (Object.is(value, -0)) return '0';
    return JSON.stringify(value);
  }
  if (type === 'bigint' || type === 'undefined' || type === 'function' || type === 'symbol') {
    throw new TypeError(`JCS cannot encode ${type}`);
  }
  if (type !== 'object') throw new TypeError(`JCS cannot encode ${type}`);
  if (stack.has(value)) throw new TypeError('JCS cannot encode a circular structure');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalizeValue(entry, stack)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JCS only accepts plain objects and arrays');
    }
    const keys = Object.keys(value).sort();
    const entries = [];
    for (const key of keys) {
      if (value[key] === undefined) {
        throw new TypeError(`JCS cannot encode undefined at key ${key}`);
      }
      entries.push(`${JSON.stringify(key)}:${canonicalizeValue(value[key], stack)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

export function md5Hex(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

export function jcsHash(value) {
  return `jcs-sha256-v1:${sha256Hex(canonicalize(value))}`;
}

export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function normalizedTextHash(text) {
  return jcsHash(normalizeText(text));
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepClone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function deepMerge(base, override) {
  if (override === undefined) return deepClone(base);
  if (!isPlainObject(base) || !isPlainObject(override)) return deepClone(override);
  const output = deepClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = deepClone(value);
    }
  }
  return output;
}

export function randomId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomPhrase(words = 3) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
  const pick = () => alphabet[crypto.randomInt(0, alphabet.length)];
  return Array.from({ length: words }, () => {
    let word = '';
    for (let i = 0; i < 5; i += 1) word += pick();
    return word;
  }).join('-');
}

export function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function nowIso(clock = () => new Date()) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

export function formatDateInZone(value, timeZone) {
  const parts = zonedParts(toDate(value), timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function formatDateTimeInZone(value, timeZone) {
  const parts = zonedParts(toDate(value), timeZone);
  return `${formatDateInZone(value, timeZone)} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
}

export function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** UTC offset (ms) of `timeZone` at the given instant. */
export function zoneOffsetMs(value, timeZone) {
  const date = toDate(value);
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - whole;
}

/** Start/end instants of a local calendar date in an IANA zone. */
export function zonedDateRange(dateString, timeZone) {
  if (!isValidDateString(dateString)) {
    throw new AppError('CONFIG_INVALID', `invalid date: ${dateString}`);
  }
  const [year, month, day] = dateString.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDay = next.toISOString().slice(0, 10);
  const startOf = (date) => {
    let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
    for (let i = 0; i < 3; i += 1) {
      const offset = zoneOffsetMs(guess, timeZone);
      guess = Date.UTC(year, month - 1, day, 0, 0, 0) - offset;
    }
    return guess;
  };
  const startMs = startOf(dateString);
  const nextMs = (() => {
    const [ny, nm, nd] = nextDay.split('-').map(Number);
    let guess = Date.UTC(ny, nm - 1, nd, 0, 0, 0);
    for (let i = 0; i < 3; i += 1) {
      const offset = zoneOffsetMs(guess, timeZone);
      guess = Date.UTC(ny, nm - 1, nd, 0, 0, 0) - offset;
    }
    return guess;
  })();
  return { startMs, endMs: nextMs };
}

export function isWithinZonedDate(value, dateString, timeZone) {
  const ms = toDate(value).getTime();
  const { startMs, endMs } = zonedDateRange(dateString, timeZone);
  return ms >= startMs && ms < endMs;
}

export function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function truncateText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function ensureWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveInside(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new AppError('ARTIFACT_INVALID', 'unsafe relative path', { details: { path: relativePath } });
  }
  const resolved = path.resolve(root, relativePath);
  if (!ensureWithin(root, resolved)) {
    throw new AppError('ARTIFACT_INVALID', 'path escapes controlled root', {
      details: { path: relativePath }
    });
  }
  return resolved;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (value.includes('\0')) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('//')) return false;
  if (path.isAbsolute(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  for (const segment of segments) {
    if (WINDOWS_RESERVED.test(segment)) return false;
    if (/[. ]$/.test(segment)) return false;
    if (/[<>:"|?*]/.test(segment)) return false;
  }
  return true;
}

export function assertSafeRelativePath(value, code = 'ARTIFACT_INVALID') {
  if (!isSafeRelativePath(value)) {
    throw new AppError(code, 'unsafe relative path', { details: { path: value } });
  }
  return value.replaceAll('\\', '/');
}

export function platformPathCollision(paths) {
  const seen = new Map();
  for (const entry of paths) {
    const key = String(entry).normalize('NFC').toLowerCase();
    if (seen.has(key) && seen.get(key) !== entry) return { a: seen.get(key), b: entry };
    seen.set(key, entry);
  }
  return null;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(file, options = {}) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && options.missingOk) return undefined;
    throw new AppError(options.code || 'STORE_CORRUPTED', `cannot read ${path.basename(file)}`, {
      cause: error,
      details: { file: path.basename(file) }
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new AppError(options.code || 'STORE_CORRUPTED', `invalid JSON in ${path.basename(file)}`, {
      cause: error,
      details: { file: path.basename(file) }
    });
  }
}

async function syncDir(dir) {
  let handle;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function atomicWriteFile(file, data, options = {}) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomToken(6)}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temp, 'wx', options.mode ?? 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.hooks?.afterTempWrite?.({ file, temp });
    await options.hooks?.beforeRename?.({ file, temp });
    await fsp.rename(temp, file);
    if (options.syncDir !== false) await syncDir(dir);
    await options.hooks?.afterRename?.({ file });
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(file, value, options = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await atomicWriteFile(file, text, options);
}

export async function writeFileDurable(file, data, options = {}) {
  await atomicWriteFile(file, data, options);
}

export async function copyFileWithHash(source, destination, options = {}) {
  await ensureDir(path.dirname(destination));
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(source);
    const output = fs.createWriteStream(destination, { flags: 'wx', mode: options.mode ?? 0o600 });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      input.destroy();
      output.destroy();
      reject(error);
    };
    input.on('error', fail);
    output.on('error', fail);
    input.on('data', (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new AppError('ARTIFACT_INVALID', 'file exceeds allowed size'));
      }
    });
    output.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    input.pipe(output);
  });
  let handle;
  try {
    handle = await fsp.open(destination, 'r+');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  return { sha256: hash.digest('hex'), sizeBytes: bytes };
}

export async function fileSha256(file, maxBytes = Number.MAX_SAFE_INTEGER) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        stream.destroy(new AppError('ARTIFACT_INVALID', 'file exceeds allowed size'));
        return;
      }
      hash.update(chunk);
    });
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), sizeBytes: bytes };
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Best-effort process start time (Linux /proc); null when unknown. */
export function getProcessStartMs(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    const fields = stat.slice(closeParen + 2).split(' ');
    const startTicks = Number(fields[19]);
    const procStat = fs.readFileSync('/proc/stat', 'utf8');
    const btimeLine = procStat.split('\n').find((line) => line.startsWith('btime '));
    const btime = Number(btimeLine?.split(' ')[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
    // Linux reports starttime in USER_HZ; 100 is the overwhelmingly common value.
    return (btime + startTicks / 100) * 1000;
  } catch {
    return null;
  }
}

export function processStartIso(pid = process.pid) {
  const startMs = getProcessStartMs(pid);
  return startMs === null ? new Date().toISOString() : new Date(startMs).toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeErrorMessage(error) {
  if (error instanceof AppError) return error.message;
  return String(error?.message || error || 'unknown error');
}

export function publicError(error) {
  if (error instanceof AppError) return error.toJSON();
  return redactSecrets({
    code: 'DEPENDENCY_UNAVAILABLE',
    message: safeErrorMessage(error),
    retryable: false,
    details: {}
  });
}

export function hostnameId() {
  return os.hostname();
}

export function sortedEntries(object) {
  return Object.entries(object || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function asInt(value, fallback = undefined) {
  return Number.isInteger(value) ? value : fallback;
}

export function asNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function asPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function seconds(ms) {
  return Math.round(ms / 1000);
}
