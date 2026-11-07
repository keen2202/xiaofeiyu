import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyMigrationPackage } from '../src/migration.js';
import { jcsHash } from '../src/utils.js';

async function syntheticPackage({ extraEntry = null, extraFile = null, symlink = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-mig-path-'));
  const state = { version: 3, workspaceId: 'w', historyEpoch: 'e' };
  const stateText = JSON.stringify(state);
  await fs.writeFile(path.join(dir, 'state.json'), stateText);
  const files = [
    {
      path: 'state.json',
      role: 'state',
      sizeBytes: Buffer.byteLength(stateText),
      sha256: (await import('../src/utils.js')).sha256Hex(stateText),
      required: true
    }
  ];
  if (extraEntry) files.push(extraEntry);
  const manifest = {
    schemaVersion: 1,
    kind: 'migration',
    stateVersion: 3,
    migrationId: 'm1',
    workspaceId: 'w',
    historyEpoch: 'e',
    sourceInstanceId: 's',
    targetInstanceId: 't',
    files
  };
  manifest.snapshotHash = jcsHash({ manifestWithoutSnapshotHash: manifest, files });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (extraFile) await fs.writeFile(path.join(dir, extraFile), 'extra');
  if (symlink) {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-mig-outside-'));
    const target = path.join(outside, 'target.txt');
    await fs.writeFile(target, 'target');
    await fs.symlink(target, path.join(dir, 'link.txt'));
  }
  return dir;
}

test('migration verification rejects traversal, absolute paths and symlinks', async () => {
  const unsafe = await syntheticPackage({
    extraEntry: { path: '../escape', role: 'file', sizeBytes: 1, sha256: 'a'.repeat(64), required: true }
  });
  try {
    await assert.rejects(() => verifyMigrationPackage(unsafe), (error) => error.code === 'MIGRATION_BLOCKED');
  } finally {
    await fs.rm(unsafe, { recursive: true, force: true });
  }
  const absolute = await syntheticPackage({
    extraEntry: { path: '/etc/passwd', role: 'file', sizeBytes: 1, sha256: 'a'.repeat(64), required: true }
  });
  try {
    await assert.rejects(() => verifyMigrationPackage(absolute), (error) => error.code === 'MIGRATION_BLOCKED');
  } finally {
    await fs.rm(absolute, { recursive: true, force: true });
  }
  const linked = await syntheticPackage({ symlink: true });
  try {
    // Add the symlink to the manifest as if it were a required file.
    const manifest = JSON.parse(await fs.readFile(path.join(linked, 'manifest.json'), 'utf8'));
    const { fileSha256 } = await import('../src/utils.js');
    const target = await fs.realpath(path.join(linked, 'link.txt'));
    const hash = await fileSha256(target);
    manifest.files.push({
      path: 'link.txt',
      role: 'file',
      sizeBytes: hash.sizeBytes,
      sha256: hash.sha256,
      required: true
    });
    manifest.snapshotHash = jcsHash({ manifestWithoutSnapshotHash: manifest, files: manifest.files });
    await fs.writeFile(path.join(linked, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(() => verifyMigrationPackage(linked), (error) => error.code === 'MIGRATION_BLOCKED');
  } finally {
    await fs.rm(linked, { recursive: true, force: true });
  }
});

test('unlisted extra files in a migration package are rejected', async () => {
  const dir = await syntheticPackage({ extraFile: 'unlisted.bin' });
  try {
    await assert.rejects(() => verifyMigrationPackage(dir), (error) => error.code === 'MIGRATION_BLOCKED');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
