#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'test', 'scripts'];
const files = ['cli.mjs'];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
}
for (const root of roots) walk(root);
let failed = false;
for (const file of files.sort()) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  } catch {
    failed = true;
  }
}
console.log(`${files.length} files syntax-checked; ${failed ? 'FAILED' : 'OK'}`);
if (failed) process.exitCode = 1;
