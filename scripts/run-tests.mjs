#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const coverage = process.argv.includes('--coverage');
const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.test\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
}
walk(path.join(root, 'test'));
files.sort();
if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}
const args = ['--test', '--test-reporter=spec'];
if (coverage) args.push('--experimental-test-coverage');
args.push(...files);
const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
