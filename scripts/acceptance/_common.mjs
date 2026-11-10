// Shared helpers for the interactive acceptance scripts.
// These scripts are run by the LOCAL HUMAN in a real terminal: steps that need
// the one-time TTY challenge are spawned with inherited stdio so the operator
// answers the challenge in the same terminal. Nothing here bypasses the human
// proof, backup protection or unknown-result rules.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const CLI = path.join(ROOT, 'cli.mjs');
export const WORK_DIR = path.join(ROOT, '.dsh-probe', 'acceptance');

export function fail(message, code = 1) {
  console.error(`\n[acceptance] ${message}\n`);
  process.exit(code);
}

export function info(message) {
  console.log(`\n[acceptance] ${message}`);
}

export function ensureWorkDir() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  return WORK_DIR;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split('=', 2);
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return { flags, positional };
}

export function requireString(flags, name, { max = 4096 } = {}) {
  const value = flags[name];
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    fail(`--${name} is required (non-empty string, <= ${max} chars)`);
  }
  return value.trim();
}

export function optionalString(flags, name, fallback = null) {
  const value = flags[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') fail(`--${name} must be a non-empty string when provided`);
  return value.trim();
}

export function requireUrl(flags, name, protocols) {
  const raw = requireString(flags, name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`--${name} must be an absolute URL`);
  }
  if (!protocols.includes(parsed.protocol)) fail(`--${name} must use ${protocols.join('|')}`);
  return raw;
}

export function requireEnvName(flags, name, fallback) {
  const value = optionalString(flags, name, fallback);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) fail(`--${name} must be an environment variable name`);
  return value;
}

export function cliArgsFor(flags, extra = []) {
  const dataDir = optionalString(flags, 'data-dir', null);
  return [...extra, ...(dataDir ? ['--data-dir', dataDir] : [])];
}

/** Run a CLI command with inherited stdio (used only for TTY challenge steps). */
export function runInherited(extra, flags, { required = true } = {}) {
  const args = cliArgsFor(flags, extra);
  console.log(`\n$ node cli.mjs ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) fail(`failed to spawn CLI: ${result.error.message}`);
  if (required && result.status !== 0) fail(`command failed with exit code ${result.status}`);
  return result.status;
}

/** Run a read-only CLI command and capture its JSON output. */
export function runCapture(extra, flags, { required = true } = {}) {
  const args = cliArgsFor(flags, extra);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) fail(`failed to spawn CLI: ${result.error.message}`);
  if (required && result.status !== 0) {
    fail(`command failed (${result.status}): ${String(result.stderr || result.stdout).trim().slice(0, 800)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`command did not return JSON: ${String(result.stdout).trim().slice(0, 800)}`);
  }
}

export function promptLine(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\n')) {
        process.stdin.off('data', onData);
        process.stdin.pause();
        resolve(buffer.split('\n')[0].trim());
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

export function printNextSteps(lines) {
  console.log(`\n${lines.join('\n')}\n`);
}
