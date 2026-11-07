import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHarness } from './helpers/harness.js';
import { ArtifactStore } from '../src/artifact-store.js';
import { AppError } from '../src/errors.js';

async function withAllowed(harness, dirs, fn) {
  const original = harness.configService.config.security.allowedSourceDirs;
  harness.configService.config.security.allowedSourceDirs = dirs;
  try {
    return await fn();
  } finally {
    harness.configService.config.security.allowedSourceDirs = original;
  }
}

test('import hashes and copies a file without deleting the source', async () => {
  const harness = await createHarness();
  try {
    const file = await harness.makeSourceFile('script.txt', 'hello world');
    const ref = await withAllowed(harness, [harness.sourceDir], () =>
      harness.artifactStore.importFile({ sourcePath: file, role: 'script', principal: harness.owner })
    );
    assert.match(ref.artifactId, /^artifact_[A-Za-z0-9]+$/);
    assert.equal(ref.role, 'script');
    assert.equal(ref.mediaType, 'text/plain');
    assert.equal(ref.sizeBytes, 11);
    assert.match(ref.sha256, /^[a-f0-9]{64}$/);
    assert.equal(await fs.readFile(file, 'utf8'), 'hello world');
    const verified = await harness.artifactStore.verify(ref.artifactId, { principal: harness.owner });
    assert.equal(verified.available, true);
    const record = await harness.artifactStore.getArtifact(ref.artifactId);
    assert.equal(record.relativePath.includes('..'), false);
    assert.equal(path.isAbsolute(record.relativePath), false);
    assert.equal(Object.hasOwn(ref, 'relativePath'), false);
  } finally {
    await harness.cleanup();
  }
});

test('empty allowedSourceDirs, symlinks, hardlinks, traversal and oversize are rejected', async () => {
  const harness = await createHarness();
  try {
    const file = await harness.makeSourceFile('a.txt', 'x');
    await assert.rejects(
      () => harness.artifactStore.importFile({ sourcePath: file, role: 'script', principal: harness.owner }),
      (error) => error.code === 'ARTIFACT_INVALID'
    );
    await withAllowed(harness, [harness.sourceDir], async () => {
      const link = path.join(harness.sourceDir, 'link.txt');
      await fs.symlink(file, link);
      await assert.rejects(
        () => harness.artifactStore.importFile({ sourcePath: link, role: 'script', principal: harness.owner }),
        (error) => error.code === 'ARTIFACT_INVALID'
      );
      const hard = path.join(harness.sourceDir, 'hard.txt');
      await fs.link(file, hard);
      await assert.rejects(
        () => harness.artifactStore.importFile({ sourcePath: hard, role: 'script', principal: harness.owner }),
        (error) => error.code === 'ARTIFACT_INVALID'
      );
      await assert.rejects(
        () => harness.artifactStore.importFile({ sourcePath: '/etc/passwd', role: 'script', principal: harness.owner }),
        (error) => error.code === 'ARTIFACT_INVALID'
      );
      await assert.rejects(
        () => harness.artifactStore.importFile({ sourcePath: file, role: 'video', principal: harness.owner }),
        (error) => error.code === 'ARTIFACT_INVALID'
      );
      harness.configService.config.artifacts.maxImportBytes = 1;
      await assert.rejects(
        () => harness.artifactStore.importFile({ sourcePath: file, role: 'script', principal: harness.owner }),
        (error) => error.code === 'ARTIFACT_INVALID'
      );
      harness.configService.config.artifacts.maxImportBytes = 8589934592;
    });
  } finally {
    await harness.cleanup();
  }
});

test('tampered bytes fail verification and cross-workspace access is denied', async () => {
  const harness = await createHarness();
  try {
    const ref = await harness.importFile('x.txt', 'script', 'hello');
    const record = await harness.artifactStore.getArtifact(ref.artifactId);
    const managed = path.join(harness.paths.artifactsDir, record.relativePath);
    await fs.chmod(managed, 0o644);
    await fs.writeFile(managed, 'tampered');
    await assert.rejects(
      () => harness.artifactStore.verify(ref.artifactId, { principal: harness.owner }),
      (error) => error.code === 'ARTIFACT_INVALID'
    );
    const foreign = { ...harness.owner, workspaceId: 'other' };
    await assert.rejects(
      () => harness.artifactStore.verify(ref.artifactId, { principal: foreign }),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

test('export uses relative paths and actual verified bytes', async () => {
  const harness = await createHarness();
  try {
    const ref = await harness.importFile('x.txt', 'script', 'export me');
    const destination = path.join(harness.dir, 'export');
    const exported = await harness.artifactStore.exportArtifacts([ref.artifactId], destination);
    assert.equal(exported.length, 1);
    assert.match(exported[0].path, /^artifacts\/artifact_[A-Za-z0-9]+\//);
    assert.equal(path.isAbsolute(exported[0].path), false);
    const bytes = await fs.readFile(path.join(destination, exported[0].path), 'utf8');
    assert.equal(bytes, 'export me');
  } finally {
    await harness.cleanup();
  }
});

test('pending import crash is recovered by hash, not by deleting finalized data', async () => {
  const harness = await createHarness();
  let fail = true;
  const store = new ArtifactStore({
    store: harness.store,
    rootDir: harness.paths.artifactsDir,
    workDir: harness.paths.workDir,
    configService: harness.configService,
    now: harness.now,
    hooks: {
      beforeArtifactRename() {
        if (fail) {
          fail = false;
          throw new Error('simulated artifact crash');
        }
      }
    }
  });
  try {
    const file = await harness.makeSourceFile('a.txt', 'pending');
    await withAllowed(harness, [harness.sourceDir], async () => {
      await assert.rejects(
        () => store.importFile({ sourcePath: file, role: 'script', principal: harness.owner }),
        /simulated artifact crash/
      );
    });
    const pending = (await harness.snapshot()).artifactPendingImports;
    assert.equal(Object.keys(pending).length, 1);
    const recovered = await store.recoverPendingImports();
    assert.equal(recovered.recovered, 1);
    const artifacts = (await harness.snapshot()).artifacts;
    assert.equal(Object.keys(artifacts).length, 1);
    const artifact = Object.values(artifacts)[0];
    const verified = await store.verify(artifact.artifactId, { principal: harness.owner });
    assert.equal(verified.available, true);
  } finally {
    await harness.cleanup();
  }
});
