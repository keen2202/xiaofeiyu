import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime, HTTP_PREFIX, plugin } from '../src/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { makePrincipal } from '../src/identity.js';
import { AlwaysHumanVerifier } from './helpers/harness.js';

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-dsh-'));
  const config = structuredClone(DEFAULT_CONFIG);
  config.dataDir = dir;
  let fetchCalls = 0;
  const runtime = await createRuntime({
    config,
    dataDir: dir,
    env: {},
    now: () => new Date('2026-11-07T00:00:00Z'),
    humanVerifier: new AlwaysHumanVerifier(),
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('unexpected network');
    },
    logger: { warn() {}, info() {} }
  });
  const owner = await runtime.store.transaction(async (draft, tx) => runtime.identity.ensureLocalOwner(tx));
  const agent = await runtime.store.transaction(async (draft, tx) =>
    runtime.identity.create(tx, { kind: 'agent', role: 'assistant', sourceKind: 'agent', scopes: [] })
  );
  return { dir, runtime, owner, agent, fetchCalls: () => fetchCalls };
}

function request(principal, { method = 'GET', url = '/status', body = {}, trusted = true } = {}) {
  return {
    method,
    url: `${HTTP_PREFIX}${url}`,
    body,
    trustedContext: trusted ? { trusted: true, principal } : null
  };
}

test('HTTP status/read routes require trust and never probe platform login', async () => {
  const { dir, runtime, owner, fetchCalls } = await setup();
  try {
    const status = await runtime.http(request(owner));
    assert.equal(status.status, 200);
    assert.equal(status.body.accepted, true);
    assert.equal(status.body.result.instance.status, 'active');
    assert.equal(fetchCalls(), 0);
    const untrusted = await runtime.http(request(owner, { trusted: false }));
    assert.equal(untrusted.status, 503);
    assert.equal(untrusted.body.code, 'TRUST_UNAVAILABLE');
    const missing = await runtime.http(request(owner, { url: '/does-not-exist' }));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'CAPABILITY_UNSUPPORTED');
    const tooLarge = await runtime.http(request(owner, { method: 'POST', url: '/run/browse', body: { pad: 'x'.repeat(1024 * 1024 + 10) } }));
    assert.equal(tooLarge.status, 400);
    assert.equal(tooLarge.body.code, 'CONFIG_INVALID');
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('HTTP config is owner-only, redacted and cannot change privileged fields', async () => {
  const { dir, runtime, owner, agent } = await setup();
  try {
    const forbidden = await runtime.http(request(agent, { url: '/config' }));
    assert.equal(forbidden.status, 403);
    const config = await runtime.http(request(owner, { url: '/config' }));
    assert.equal(config.status, 200);
    const patch = await runtime.http(
      request(owner, { method: 'PATCH', url: '/config', body: { patch: { browse: { enabled: true } } } })
    );
    assert.equal(patch.status, 200);
    assert.equal(patch.body.browse.enabled, true);
    const privileged = await runtime.http(
      request(owner, { method: 'PATCH', url: '/config', body: { patch: { timeZone: 'UTC' } } })
    );
    assert.equal(privileged.status, 403);
    const nonOwnerPatch = await runtime.http(
      request(agent, { method: 'PATCH', url: '/config', body: { patch: { browse: { enabled: false } } } })
    );
    assert.equal(nonOwnerPatch.status, 403);
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('HTTP disabled feature and task not found map to stable statuses', async () => {
  const { dir, runtime, owner } = await setup();
  try {
    const browse = await runtime.http(request(owner, { method: 'POST', url: '/run/browse', body: { mode: 'go' } }));
    assert.equal(browse.status, 409);
    assert.equal(browse.body.code, 'FEATURE_DISABLED');
    const task = await runtime.http(request(owner, { url: '/tasks/missing' }));
    assert.equal(task.status, 404);
    const list = await runtime.http(request(owner, { url: '/tasks' }));
    assert.equal(list.status, 200);
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tools expose only the non-sensitive command surface', async () => {
  const { dir, runtime } = await setup();
  try {
    const names = runtime.tools.map((tool) => tool.name);
    assert.ok(names.includes('bili_unified_status'));
    assert.ok(names.includes('bili_unified_comment_draft'));
    for (const forbidden of ['approve', 'resolve', 'complete', 'config', 'migration', 'backup']) {
      assert.equal(names.some((name) => name.includes(forbidden)), false);
    }
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('cordis patch declares the required plugin identity and HTTP prefix', async () => {
  const text = await fs.readFile(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8');
  assert.match(text, /id:\s*dsh-bili-unified/);
  assert.match(text, /name:\s*dsh-bili-unified/);
  assert.match(text, /enabled:\s*true/);
  assert.match(text, /exports:\s*dsh-bili-unified/);
  assert.match(text, /httpPrefix:\s*\/dsh-bili-unified\/api/);
  assert.equal(plugin.name, 'dsh-bili-unified');
  assert.equal(typeof plugin.apply, 'function');
});

test('plugin apply tolerates missing host services and disposes cleanly', async () => {
  const host = {
    disposers: [],
    tools: {
      async register(tool) {
        this.toolsList = this.toolsList || [];
        this.toolsList.push(tool.name);
        return () => {};
      }
    },
    webServer: {
      async registerHandler(options) {
        assert.equal(options.prefix, HTTP_PREFIX);
        return () => {};
      }
    },
    lifecycle: {
      onDispose(fn) {
        host.disposers.push(fn);
        return () => {};
      }
    }
  };
  const result = await plugin.apply({ ...host, dataDir: null, config: null });
  assert.equal(result.runtime, null);
  await result.dispose();
});
