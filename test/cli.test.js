import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli.mjs';

function collector() {
  return {
    chunks: [],
    write(value) {
      this.chunks.push(String(value));
    },
    text() {
      return this.chunks.join('');
    }
  };
}

test('config validate and --help are non-sensitive and emit JSON', async () => {
  const stdout = collector();
  const stderr = collector();
  const help = await main(['--help'], { stdout, stderr });
  assert.equal(help, 0);
  assert.match(stdout.text(), /dsh-bili-unified CLI/);
  const validateOut = collector();
  const code = await main(
    ['config', 'validate', '--config', fileURLToPath(new URL('../config.example.json', import.meta.url))],
    { stdout: validateOut, stderr: collector() }
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(validateOut.text());
  assert.equal(parsed.valid, true);
  assert.equal(parsed.config.dryRun, true);
});

test('status works in an isolated data dir without network and exits zero', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cli-'));
  try {
    const stdout = collector();
    const code = await main(['status', '--data-dir', dir], { stdout, stderr: collector() });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.text());
    assert.equal(parsed.instance.status, 'active');
    assert.equal(parsed.counts.tasks, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sensitive CLI actions fail closed without an interactive TTY', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cli-'));
  try {
    await assert.rejects(
      () => main(['artifact', 'import', '--file', '/tmp/x', '--role', 'script', '--confirm', '--data-dir', dir], {
        stdout: collector(),
        stderr: collector()
      }),
      (error) => error.code === 'TRUST_UNAVAILABLE'
    );
    await assert.rejects(
      () => main(['task', 'cancel', 'task_missing', '--confirm', '--data-dir', dir], {
        stdout: collector(),
        stderr: collector()
      }),
      (error) => error.code === 'TRUST_UNAVAILABLE'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unknown command is a usage error after runtime initialization', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cli-'));
  try {
    await assert.rejects(
      () => main(['not-a-command', '--data-dir', dir], { stdout: collector(), stderr: collector() }),
      (error) => error.code === 'CONFIG_INVALID'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
