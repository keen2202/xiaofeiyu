import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../src/utils.js';

function sharingViolation() {
  const error = new Error("EPERM: operation not permitted, rename 'x' -> 'y'");
  error.code = 'EPERM';
  return error;
}

test('atomicWriteFile retries transient sharing violations and keeps the new content', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rename-retry-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  await fsp.writeFile(file, '{"old":true}\n');
  const original = fs.promises.rename;
  let calls = 0;
  fs.promises.rename = async (from, to) => {
    calls += 1;
    if (calls <= 2) throw sharingViolation();
    return original.call(fs.promises, from, to);
  };
  try {
    await atomicWriteFile(file, '{"new":true}\n');
  } finally {
    fs.promises.rename = original;
  }
  assert.equal(calls, 3);
  assert.equal(await fsp.readFile(file, 'utf8'), '{"new":true}\n');
});

test('atomicWriteFile reports the original error, keeps old content and cleans temp files', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-rename-fail-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  await fsp.writeFile(file, '{"old":true}\n');
  const original = fs.promises.rename;
  let calls = 0;
  fs.promises.rename = async () => {
    calls += 1;
    throw sharingViolation();
  };
  try {
    await assert.rejects(() => atomicWriteFile(file, '{"new":true}\n'), (error) => error.code === 'EPERM');
  } finally {
    fs.promises.rename = original;
  }
  assert.equal(calls, 6);
  assert.equal(await fsp.readFile(file, 'utf8'), '{"old":true}\n');
  const leftovers = (await fsp.readdir(dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
