import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRuntime,
  createHttpHandler,
  plugin,
  HTTP_PREFIX,
  sanitizeErrorMessage
} from '../src/index.js';
import { CommandService, projectTask } from '../src/command-service.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { makePrincipal } from '../src/identity.js';
import { CommentsModule } from '../src/modules/comments.js';
import { DshImChannelAdapter, ImBridge } from '../src/adapters/channels/dsh-im.js';
import { createHarness, bindMockAccount, makeMockAdapter, mockCandidate } from './helpers/harness.js';
import { makeMockImHost } from './helpers/mock-channel.js';
import { main, describeBinding } from '../cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

async function withRuntime(fn, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-entry-'));
  const runtime = await createRuntime({
    dataDir: dir,
    env: {},
    config: { dataDir: dir, ...overrides },
    now: () => new Date(),
    logger: { warn() {}, info() {} }
  });
  const owner = await runtime.store.transaction(async (draft, tx) => runtime.identity.ensureLocalOwner(tx));
  try {
    return await fn({ dir, runtime, owner });
  } finally {
    await runtime.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function request(principal, { method = 'GET', url = '/status', body = {}, trusted = true, human = null } = {}) {
  return {
    method,
    url: `${HTTP_PREFIX}${url}`,
    body,
    trustedContext: trusted ? { trusted: true, principal } : null,
    trustedHumanContext: human
  };
}

async function hashFile(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

function makeFakeRuntime({ snapshot = null, execute = null, extra = {} } = {}) {
  const owner = {
    id: 'local_owner',
    kind: 'human',
    role: 'owner',
    sourceKind: 'local_cli',
    scopes: ['*'],
    revokedAt: null
  };
  const state = snapshot || { workspaceId: 'workspace_fake', historyEpoch: 'epoch_fake', principals: { [owner.id]: owner } };
  const base = {
    owner,
    calls: [],
    state,
    store: {
      async getSnapshot() {
        return state;
      },
      async transaction(fn) {
        const draft = structuredClone(state);
        const tx = { appendEvent() {}, state: draft };
        return fn(draft, tx);
      }
    },
    identity: { findLocalOwner: () => owner },
    humanProof: {
      verifier: { issue: () => ({ challengeId: 'challenge-1', phraseLength: 4 }) },
      async assert() {
        return owner;
      }
    },
    commandService: {
      async execute(envelope, principal, options) {
        base.calls.push({ envelope, principal, options });
        return { accepted: true, taskId: 'task_fake', status: 'queued', executionMode: envelope.mode, result: { ok: true } };
      }
    },
    configService: { get: () => ({ dryRun: true }), update: async () => ({}) },
    refreshConfig: async () => ({ refreshed: true }),
    async bindAccount() {
      return { accountRef: { platform: 'bilibili', accountId: '1001' } };
    },
    async close() {}
  };
  return Object.assign(base, extra);
}

async function runCli(argv, { fake = null, prompt = 'PHRASE', humanVerifier = null, stdout, stderr } = {}) {
  const out = stdout || collector();
  const err = stderr || collector();
  const proofOutput = collector();
  const code = await main(argv, {
    stdout: out,
    stderr: err,
    proofOutput,
    prompt: prompt === null ? undefined : async () => prompt,
    humanVerifier,
    createRuntime: fake ? async () => fake : undefined
  });
  return { code, stdout: out.text(), stderr: err.text(), proof: proofOutput.text(), fake };
}

const exists = async (file) => fs.access(file).then(() => true).catch(() => false);

test('HTTP mode contract requires explicit mode for writes and defaults browse to dry', async () => {
  await withRuntime(async ({ runtime, owner }) => {
    const captured = [];
    const original = runtime.commandService.execute.bind(runtime.commandService);
    runtime.commandService.execute = async (envelope, principal, options) => {
      captured.push({ envelope, options });
      if (envelope.action === 'browse.run') {
        return { accepted: true, taskId: 'task_browse', status: 'queued', executionMode: envelope.mode, result: {} };
      }
      return original(envelope, principal, options);
    };
    const browse = await runtime.http(request(owner, { method: 'POST', url: '/run/browse', body: {} }));
    assert.equal(browse.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].envelope.mode, 'dry');
    assert.equal(captured[0].options.sourceKind, 'http');

    for (const [url, body] of [
      ['/dm/send', { recipientMid: '1', text: 'x' }],
      ['/production', { input: {} }],
      ['/publish', { input: {} }],
      ['/tasks/task_missing/resume', {}],
      ['/approvals/decide', { approvalId: 'a', decision: 'approve' }],
      ['/comments/approve', { approvalId: 'a', decision: 'approve' }]
    ]) {
      const response = await runtime.http(request(owner, { method: 'POST', url, body }));
      assert.equal(response.status, 400, `${url} should reject missing mode`);
      assert.equal(response.body.code, 'CONFIG_INVALID');
      assert.equal(response.body.details.reason, 'mode_required');
    }
    const invalid = await runtime.http(request(owner, { method: 'POST', url: '/dm/send', body: { mode: 'sideways' } }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'CONFIG_INVALID');
  });
});

test('HTTP body accepts JSON strings and enforces the 1MiB limit', async () => {
  await withRuntime(async ({ runtime, owner }) => {
    const stringStatus = await runtime.http(request(owner, { url: '/status', body: '{}' }));
    assert.equal(stringStatus.status, 200);
    const invalid = await runtime.http(request(owner, { url: '/status', body: '{not json' }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'CONFIG_INVALID');
    const tooLarge = await runtime.http(request(owner, { method: 'POST', url: '/run/browse', body: `{"pad":"${'x'.repeat(1024 * 1024 + 10)}"}` }));
    assert.equal(tooLarge.status, 400);
    assert.equal(tooLarge.body.code, 'CONFIG_INVALID');
    const objectTooLarge = await runtime.http(request(owner, { method: 'POST', url: '/run/browse', body: { pad: 'x'.repeat(1024 * 1024 + 10) } }));
    assert.equal(objectTooLarge.status, 400);
  });
});

test('HTTP /comments/approve only converts comment approvals', async () => {
  await withRuntime(async ({ runtime, owner }) => {
    const seeded = await runtime.store.transaction(async (draft, tx) => {
      const task = runtime.taskManager.create(tx, {
        kind: 'production',
        principalId: owner.id,
        input: { brief: 'x' },
        inputHash: `jcs-sha256-v1:${'a'.repeat(64)}`
      });
      runtime.taskManager.transition(tx, task, 'running');
      runtime.taskManager.transition(tx, task, 'waiting_approval');
      const challenge = runtime.approvalService.create(tx, {
        task,
        action: 'production.run',
        inputHash: task.inputHash,
        principalId: owner.id,
        ttlSec: 600,
        source: 'test'
      });
      return { taskId: task.id, approvalId: challenge.approval.id, nonce: challenge.nonce };
    });
    const mismatch = await runtime.http(request(owner, {
      method: 'POST',
      url: '/comments/approve',
      body: { approvalId: seeded.approvalId, decision: 'approve', nonce: seeded.nonce, mode: 'go' },
      human: { principal: owner, proof: { kind: 'test', ok: true } }
    }));
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.code, 'CONFIG_INVALID');
    assert.equal(mismatch.body.details.reason, 'approval_kind_mismatch');
    const missing = await runtime.http(request(owner, {
      method: 'POST',
      url: '/comments/approve',
      body: { approvalId: 'approval_missing', decision: 'approve', mode: 'go' }
    }));
    assert.equal(missing.status, 409);
    assert.equal(missing.body.code, 'APPROVAL_STALE');
  });
});

test('comments draft entry no longer forwards caller platformData to the module', async () => {
  await withRuntime(async ({ runtime, owner }) => {
    let capturedCandidate = null;
    runtime.comments.createDraft = async (args) => {
      capturedCandidate = args.candidate;
      return { task: { id: 'task_draft', status: 'queued' }, dryRun: false };
    };
    const response = await runtime.http(request(owner, {
      method: 'POST',
      url: '/comments/draft',
      body: {
        input: {
          contentRef: { platform: 'bilibili', contentId: 'BV1xx411c7mD' },
          title: 'title',
          author: { accountId: '2002', name: 'author' },
          text: 'hello',
          platformData: { aid: 9999, cid: 1111 }
        }
      }
    }));
    assert.equal(response.status, 200);
    assert.ok(capturedCandidate);
    assert.equal(capturedCandidate.platformData, undefined);
    assert.equal(capturedCandidate.contentRef.contentId, 'BV1xx411c7mD');
  });
});

test('task detail projection hides internal delivery pointers and redacts input', async () => {
  await withRuntime(async ({ runtime, owner }) => {
    const taskId = await runtime.store.transaction(async (draft, tx) => {
      const task = runtime.taskManager.create(tx, {
        kind: 'comment',
        principalId: owner.id,
        input: { text: 'hello', cookie: 'SESSDATA=secretvalue' },
        inputHash: `jcs-sha256-v1:${'b'.repeat(64)}`
      });
      task.notificationTarget = { bindingId: 'binding_1', conversationId: 'conversation_1', inboxKey: 'inbox_1' };
      task.inboxKey = 'inbox_1';
      return task.id;
    });
    const projected = await runtime.commandService.getTask(taskId, owner);
    assert.equal(projected.id, taskId);
    assert.equal(projected.notificationTarget, undefined);
    assert.equal(projected.inboxKey, undefined);
    assert.equal(projected.input.cookie, '[redacted]');
    assert.equal(projected.input.text, 'hello');
    const response = await runtime.http(request(owner, { url: `/tasks/${taskId}` }));
    assert.equal(response.status, 200);
    assert.equal(response.body.result.notificationTarget, undefined);
    assert.equal(response.body.result.input.cookie, '[redacted]');
  });
});

test('tool calls require explicit mode for write-capable tools', async () => {
  await withRuntime(async ({ runtime, owner }) => {
    const captured = [];
    runtime.commandService.execute = async (envelope, principal) => {
      captured.push({ envelope, principal });
      return { accepted: true, acceptedMode: envelope.mode, taskId: 'task_tool', status: 'queued', result: {} };
    };
    const dmTool = runtime.tools.find((tool) => tool.name === 'bili_unified_dm');
    await assert.rejects(() => dmTool.execute({ recipientMid: '1', text: 'x' }, owner), { code: 'CONFIG_INVALID' });
    const result = await dmTool.execute({ recipientMid: '1', text: 'x', mode: 'dry' }, owner);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].envelope.mode, 'dry');
    assert.equal(captured[0].envelope.action, 'dm.send');
    assert.equal(result.acceptedMode, 'dry');
  });
});

test('plugin apply consumes mount enabled and httpPrefix', async () => {
  const disabled = await plugin.apply({ config: { enabled: false }, dataDir: null, createRuntime: async () => assert.fail('must not create runtime') });
  assert.equal(disabled, null);
  await assert.rejects(
    () => plugin.apply({ config: { enabled: true, httpPrefix: '/wrong-prefix' }, dataDir: null, createRuntime: async () => null }),
    { code: 'CONFIG_INVALID' }
  );
  await assert.rejects(
    () => plugin.apply({ config: { enabled: 'yes' }, dataDir: null, createRuntime: async () => null }),
    { code: 'CONFIG_INVALID' }
  );
});

test('plugin apply mounts with host trust, unregisters on dispose and tolerates lifecycle path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-mount-'));
  const owner = { id: 'host_owner', kind: 'human', role: 'owner', scopes: ['*'] };
  const registered = { handler: null, tools: [], lifecycle: null, disposedTools: 0 };
  const host = {
    config: { schemaVersion: 1, enabled: true, httpPrefix: HTTP_PREFIX },
    dataDir: null,
    env: { DSH_HOME: root },
    logger: { warn() {}, info() {} },
    connection: {
      async requestRejection() {
        return false;
      },
      async resolvePrincipal() {
        return owner;
      }
    },
    webServer: {
      async registerHandler(options) {
        assert.equal(options.prefix, HTTP_PREFIX);
        registered.handler = options.handler;
        return () => {
          registered.handler = null;
        };
      }
    },
    tools: {
      async register(tool) {
        registered.tools.push(tool.name);
        return () => {
          registered.disposedTools += 1;
        };
      }
    },
    lifecycle: {
      onDispose(fn) {
        registered.lifecycle = fn;
        return () => {};
      }
    }
  };
  const applied = await plugin.apply(host);
  try {
    assert.ok(applied.runtime);
    assert.equal(applied.mounted, true);
    assert.equal(registered.tools.length, 9);
    const runtime = applied.runtime;
    assert.equal(runtime.paths.dataDir, path.join(root, 'dsh-bili-unified'));
    const status = await registered.handler({ method: 'GET', url: `${HTTP_PREFIX}/status`, body: {} });
    assert.equal(status.status, 200);
    assert.equal(status.body.result.instance.status, 'active');
    assert.equal(status.body.result.components.im.moduleAvailable, false);
    const noMode = await registered.handler({
      method: 'POST',
      url: `${HTTP_PREFIX}/dm/send`,
      body: { recipientMid: '1', text: 'x' }
    });
    assert.equal(noMode.status, 400);
    assert.equal(noMode.body.code, 'CONFIG_INVALID');
  } finally {
    await applied.dispose();
    assert.equal(registered.handler, null);
    assert.equal(registered.disposedTools, 9);
    assert.equal(typeof registered.lifecycle, 'function');
    await registered.lifecycle();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('plugin apply fails closed without host trust service and accepts host requestRejection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-trust-'));
  const owner = { id: 'host_owner', kind: 'human', role: 'owner', scopes: ['*'] };
  try {
    const host = {
      config: { schemaVersion: 1, enabled: true },
      dataDir: null,
      env: { DSH_HOME: root },
      logger: { warn() {}, info() {} },
      webServer: {
        async registerHandler(options) {
          host.handler = options.handler;
          return () => {};
        }
      }
    };
    const applied = await plugin.apply(host);
    try {
      const denied = await host.handler({
        method: 'GET',
        url: `${HTTP_PREFIX}/status`,
        trustedContext: { trusted: true, principal: owner }
      });
      assert.equal(denied.status, 503);
      assert.equal(denied.body.code, 'TRUST_UNAVAILABLE');
    } finally {
      await applied.dispose();
    }
    const rejectingHost = {
      config: { schemaVersion: 1, enabled: true },
      dataDir: null,
      env: { DSH_HOME: root },
      logger: { warn() {}, info() {} },
      connection: {
        async requestRejection() {
          return { rejected: true, reason: 'host rejected' };
        },
        async resolvePrincipal() {
          return owner;
        }
      },
      webServer: {
        async registerHandler(options) {
          rejectingHost.handler = options.handler;
          return () => {};
        }
      }
    };
    const applied2 = await plugin.apply(rejectingHost);
    try {
      const rejected = await rejectingHost.handler({ method: 'GET', url: `${HTTP_PREFIX}/status`, body: {} });
      assert.equal(rejected.status, 503);
      assert.equal(rejected.body.code, 'TRUST_UNAVAILABLE');
    } finally {
      await applied2.dispose();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('index avoids static imports of optional IM/migration modules', async () => {
  const source = await fs.readFile(path.join(HERE, '..', 'src', 'index.js'), 'utf8');
  assert.equal(/from\s+['"]\.\/migration\.js['"]/.test(source), false);
  assert.equal(/from\s+['"]\.\/adapters\/channels\/dsh-im\.js['"]/.test(source), false);
  assert.match(source, /await import\('\.\/migration\.js'\)/);
  assert.match(source, /await import\('\.\/adapters\/channels\/dsh-im\.js'\)/);
});

test('status reports optional component state and startup failures', async () => {
  await withRuntime(async ({ runtime, owner, dir }) => {
    const failedImHost = {
      async describeCapabilities() {
        throw new Error('host probe failed');
      }
    };
    runtime.imHostValue = failedImHost;
    const withIm = await createRuntime({
      dataDir: dir,
      env: {},
      imHost: failedImHost,
      config: { dataDir: dir, im: { enabled: true, notifications: { enabled: true } } },
      logger: { warn() {}, info() {} }
    });
    try {
      const started = await withIm.start();
      assert.equal(started.im.started, false);
      const target = await withIm.store.transaction(async (draft, tx) => withIm.identity.ensureLocalOwner(tx));
      const status = await withIm.status(target);
      assert.equal(status.components.im.enabled, true);
      assert.equal(status.components.im.started, false);
      assert.equal(status.components.im.error.code, 'DEPENDENCY_UNAVAILABLE');
      assert.equal(status.components.execution.remote.supported, false);
      assert.equal(status.components.coordinator.schedulerEnabled, false);
      assert.equal(JSON.stringify(status.components).includes(dir), false);
    } finally {
      await withIm.close().catch(() => {});
    }
  }, { im: { enabled: false } });
});

test('config refresh restarts coordinator timer and maintenance', async () => {
  await withRuntime(async ({ runtime }) => {
    await runtime.start();
    assert.equal(runtime.coordinator.timer, null);
    const previous = structuredClone(runtime.configService.get());
    await runtime.configService.update({ scheduler: { enabled: true } }, { source: 'cli' });
    await runtime.refreshConfig({ config: runtime.configService.get(), previous });
    assert.ok(runtime.coordinator.timer, 'coordinator timer should start');
    const previous2 = structuredClone(runtime.configService.get());
    await runtime.configService.update({ scheduler: { enabled: false } }, { source: 'cli' });
    await runtime.refreshConfig({ config: runtime.configService.get(), previous: previous2 });
    assert.equal(runtime.coordinator.timer, null);
  });
});

test('maintenance runs store.prune every 30 ticks', async () => {
  await withRuntime(async ({ runtime }) => {
    let pruned = 0;
    const original = runtime.store.prune.bind(runtime.store);
    runtime.store.prune = async (...args) => {
      pruned += 1;
      return original(...args);
    };
    for (let index = 0; index < 29; index += 1) await runtime.maintenance.tick();
    assert.equal(pruned, 0);
    await runtime.maintenance.tick();
    assert.equal(pruned, 1);
  }, { diary: { enabled: true } });
});

test('CLI status stays read-only across runs and reports components', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cli-ro-'));
  try {
    await runCli(['status', '--data-dir', dir]);
    const stateFile = path.join(dir, 'state.json');
    const first = await hashFile(stateFile);
    const secondRun = await runCli(['status', '--data-dir', dir]);
    assert.equal(secondRun.code, 0);
    const second = await hashFile(stateFile);
    assert.equal(first, second, 'repeated status must not rewrite the ledger');
    const parsed = JSON.parse(secondRun.stdout);
    assert.equal(parsed.instance.status, 'active');
    assert.equal(parsed.components.im.moduleAvailable, false);
    assert.equal(parsed.components.execution.remote.supported, false);
    assert.equal(parsed.loginProbe, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI write commands dispatch through CommandService with sourceKind cli', async () => {
  const fake = makeFakeRuntime();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cli-dispatch-'));
  try {
    const jobFile = path.join(dir, 'job.json');
    await fs.writeFile(jobFile, JSON.stringify({ profileId: 'local-slideshow-v1', brief: 'x' }));
    const browse = await runCli(['browse', '--dry', '--data-dir', dir], { fake });
    assert.equal(browse.code, 0);
    const production = await runCli(['production', '--job', jobFile, '--go', '--data-dir', dir], { fake });
    assert.equal(production.code, 0);
    const diary = await runCli(['diary', '--date', '2026-11-07', '--data-dir', dir], { fake });
    assert.equal(diary.code, 0);
    const actions = fake.calls.map((call) => call.envelope.action);
    assert.deepEqual(actions, ['browse.run', 'production.create', 'diary.generate']);
    for (const call of fake.calls) {
      assert.equal(call.options.sourceKind, 'cli');
      assert.equal(call.options.trusted, true);
      assert.match(call.envelope.requestId, /^cli-[a-z0-9-]+-[a-z0-9]+$/i);
    }
    assert.equal(fake.calls[0].envelope.mode, 'dry');
    assert.equal(fake.calls[1].envelope.mode, 'go');
    assert.equal(fake.calls[2].envelope.mode, 'go');
    assert.equal(fake.calls[2].envelope.input.date, '2026-11-07');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI human proof shows bound content and fails closed without a TTY', async () => {
  const lines = describeBinding({
    action: 'dm.send',
    to: '42',
    text: 'hello world',
    taskId: 'task_1'
  });
  const rendered = lines.join('\n');
  assert.match(rendered, /Action: "dm\.send"/);
  assert.match(rendered, /Recipient: "42"/);
  assert.match(rendered, /Text preview: "hello world"/);
  assert.match(rendered, /Task: "task_1"/);

  const fake = makeFakeRuntime();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cli-proof-'));
  try {
    const result = await runCli(['dm', '--to', '42', '--text', 'hello world', '--go', '--data-dir', dir], { fake });
    assert.equal(result.code, 0);
    assert.match(result.proof, /Human confirmation requested/);
    assert.match(result.proof, /Recipient: "42"/);
    assert.match(result.proof, /Text preview: "hello world"/);
    assert.equal(fake.calls[0].envelope.action, 'dm.send');

    const untrusted = makeFakeRuntime();
    await assert.rejects(
      () => runCli(['dm', '--to', '42', '--text', 'hi', '--go', '--data-dir', dir], { fake: untrusted, prompt: null }),
      (error) => error.code === 'TRUST_UNAVAILABLE'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI enforces --confirm and rejects --go as a migration import confirmation', async () => {
  const fake = makeFakeRuntime();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cli-confirm-'));
  try {
    await assert.rejects(
      () => runCli(['approval', 'decide', 'approval_1', 'approve', '--go', '--data-dir', dir], { fake }),
      (error) => error.code === 'CONFIG_INVALID' && /requires --confirm/.test(error.message)
    );
    await assert.rejects(
      () => runCli(['migration', 'prepare', '--target', 'instance_2', '--data-dir', dir], { fake }),
      (error) => error.code === 'CONFIG_INVALID' && /requires --confirm/.test(error.message)
    );
    await assert.rejects(
      () => runCli(['migration', 'release', 'migration_1', '--data-dir', dir], { fake }),
      (error) => error.code === 'CONFIG_INVALID' && /requires --confirm/.test(error.message)
    );
    await assert.rejects(
      () => runCli(['migration', 'import', '--from', dir, '--data-dir', dir, '--go'], {}),
      (error) => error.code === 'CONFIG_INVALID' && /requires --confirm/.test(error.message)
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI migration prepare does not require --data-dir and never leaks a path TypeError', async () => {
  const calls = [];
  const fake = makeFakeRuntime({
    extra: {
      migration: {
        async prepare(payload, context) {
          calls.push({ payload, principalId: context?.principal?.id });
          return {
            migration: { id: 'migration_fake', phase: 'quiescing', targetInstanceId: payload.targetInstanceId },
            sealed: false
          };
        }
      }
    }
  });
  const result = await runCli(['migration', 'prepare', '--target', 'instance_2', '--confirm'], { fake });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.targetInstanceId, 'instance_2');
  assert.equal(calls[0].payload.executorStopEvidence, null);
  assert.equal(calls[0].principalId, 'local_owner');
  assert.equal(JSON.parse(result.stdout).migration.phase, 'quiescing');
  assert.match(result.proof, /Target instance: "instance_2"/);

  // A subcommand that truly owns the flag must fail with usage, not DEPENDENCY_UNAVAILABLE.
  await assert.rejects(
    () => runCli(['migration', 'validate', 'migration_1'], { fake }),
    (error) =>
      error.code === 'CONFIG_INVALID' &&
      /migration validate requires --data-dir/.test(error.message)
  );
});

test('CLI required-flag guards return usage errors instead of path/JSON TypeErrors', async () => {
  const fake = makeFakeRuntime();

  // Standalone entries fail before any runtime is created.
  await assert.rejects(
    () => runCli(['migration', 'import', '--confirm'], {}),
    (error) => error.code === 'CONFIG_INVALID' && /requires --from/.test(error.message)
  );
  await assert.rejects(
    () => runCli(['migration', 'import', '--from', '.', '--confirm'], {}),
    (error) => error.code === 'CONFIG_INVALID' && /requires --data-dir/.test(error.message)
  );
  await assert.rejects(
    () => runCli(['recovery', 'restore', '--confirm'], {}),
    (error) => error.code === 'CONFIG_INVALID' && /requires --from/.test(error.message)
  );
  await assert.rejects(
    () => runCli(['recovery', 'restore', '--from', '.', '--confirm'], {}),
    (error) => error.code === 'CONFIG_INVALID' && /requires --to/.test(error.message)
  );

  // Runtime entries reject the missing flag before the human challenge is issued.
  await assert.rejects(
    () => runCli(['artifact', 'import', '--confirm'], { fake }),
    (error) => error.code === 'CONFIG_INVALID' && /requires --file/.test(error.message)
  );
  await assert.rejects(
    () => runCli(['recovery', 'authorize', '--confirm'], { fake }),
    (error) => error.code === 'CONFIG_INVALID' && /requires --scope/.test(error.message)
  );
  await assert.rejects(
    () => runCli(['recovery', 'authorize', '--scope', '{not json', '--confirm'], { fake }),
    (error) => error.code === 'CONFIG_INVALID' && /must be valid JSON/.test(error.message)
  );
});

test('CLI approval go path dispatches approval.decide with trusted human context', async () => {
  const approval = {
    id: 'approval_1',
    taskId: 'task_1',
    action: 'production.run',
    inputHash: `jcs-sha256-v1:${'c'.repeat(64)}`,
    taskRevision: 1
  };
  const fake = makeFakeRuntime({
    snapshot: {
      workspaceId: 'workspace_fake',
      historyEpoch: 'epoch_fake',
      principals: {},
      approvals: { approval_1: approval }
    }
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cli-approval-'));
  try {
    const result = await runCli([
      'approval', 'decide', 'approval_1', 'approve', '--go', '--confirm', '--nonce', 'n1', '--data-dir', dir
    ], { fake });
    assert.equal(result.code, 0);
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.envelope.action, 'approval.decide');
    assert.equal(call.envelope.mode, 'go');
    assert.equal(call.envelope.input.approvalId, 'approval_1');
    assert.equal(call.envelope.input.nonce, 'n1');
    assert.ok(call.options.humanContext);
    assert.equal(call.options.humanContext.principal.id, 'local_owner');
    assert.match(result.proof, /Approval: "approval_1"/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI new management commands call owner interfaces or report waiting dependency', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cli-manage-'));
  try {
    let voided = null;
    const publishFake = makeFakeRuntime({
      snapshot: {
        workspaceId: 'workspace_fake',
        historyEpoch: 'epoch_fake',
        principals: {},
        tasks: {
          task_9: { id: 'task_9', kind: 'publish', status: 'awaiting_manual', inputHash: `jcs-sha256-v1:${'d'.repeat(64)}` }
        }
      },
      extra: {
        publisher: {
          async markNotPublished(payload, context) {
            voided = { payload, context };
            return { voided: true, taskId: payload.taskId };
          }
        }
      }
    });
    const publishVoid = await runCli(['publish', 'void', 'task_9', '--reason', 'owner request', '--confirm', '--data-dir', dir], { fake: publishFake });
    assert.equal(publishVoid.code, 0);
    assert.equal(voided.payload.taskId, 'task_9');
    assert.equal(voided.payload.reason, 'owner request');

    const missingPublish = makeFakeRuntime({
      snapshot: {
        workspaceId: 'workspace_fake',
        historyEpoch: 'epoch_fake',
        principals: {},
        tasks: {
          task_9: { id: 'task_9', kind: 'publish', status: 'awaiting_manual', inputHash: `jcs-sha256-v1:${'d'.repeat(64)}` }
        }
      }
    });
    await assert.rejects(
      () => runCli(['publish', 'void', 'task_9', '--confirm', '--data-dir', dir], { fake: missingPublish }),
      (error) => error.code === 'DEPENDENCY_UNAVAILABLE' && error.details.waitingFor === 'PublisherModule.markNotPublished'
    );

    let cancelled = null;
    const cancelFake = makeFakeRuntime({
      snapshot: {
        workspaceId: 'workspace_fake',
        historyEpoch: 'epoch_fake',
        principals: {},
        operations: {
          operation_1: {
            id: 'operation_1',
            status: 'reserved',
            businessKey: 'bk_1',
            inputHash: `jcs-sha256-v1:${'e'.repeat(64)}`
          }
        }
      },
      extra: {
        effectGateway: {
          async cancelOperation(payload, context) {
            cancelled = { payload, context };
            return { cancelled: true };
          }
        }
      }
    });
    const cancelResult = await runCli(['operation', 'cancel', 'operation_1', '--reason', 'not sent', '--confirm', '--data-dir', dir], { fake: cancelFake });
    assert.equal(cancelResult.code, 0);
    assert.equal(cancelled.payload.operationId, 'operation_1');

    let released = null;
    const holdFake = makeFakeRuntime({
      extra: {
        migration: {
          async releaseTaskHold(payload, context) {
            released = { payload, context };
            return { released: true };
          }
        }
      }
    });
    const holdResult = await runCli(['migration', 'release-hold', 'hold_1', '--task', 'task_1', '--note', 'checked', '--confirm', '--data-dir', dir], { fake: holdFake });
    assert.equal(holdResult.code, 0);
    assert.equal(released.payload.holdId, 'hold_1');
    assert.equal(released.payload.taskId, 'task_1');

    let resumed = null;
    const accountState = {
      workspaceId: 'workspace_fake',
      historyEpoch: 'epoch_fake',
      principals: {},
      activeAccountRef: { platform: 'bilibili', accountId: '1001' }
    };
    const accountFake = makeFakeRuntime({
      snapshot: accountState,
      extra: {
        rateLimiter: {
          async clearAuthPause(tx, key) {
            resumed = key;
            return true;
          }
        }
      }
    });
    const accountResult = await runCli(['account', 'resume', '--platform', 'bilibili', '--note', 'fixed network', '--confirm', '--data-dir', dir], { fake: accountFake });
    assert.equal(accountResult.code, 0);
    assert.equal(resumed, 'bilibili:1001');

    const missingAccount = makeFakeRuntime({ snapshot: accountState });
    await assert.rejects(
      () => runCli(['account', 'resume', '--platform', 'bilibili', '--confirm', '--data-dir', dir], { fake: missingAccount }),
      (error) => error.code === 'DEPENDENCY_UNAVAILABLE' && error.details.waitingFor === 'clearAuthPause'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CLI recovery preserve snapshots a corrupt source through the recovery service', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-cli-preserve-'));
  const sourceDir = path.join(dir, 'source');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'state.json'), '{broken');
  try {
    const verifier = {
      issue: () => ({ challengeId: 'c1', phraseLength: 4 }),
      calls: 0,
      async verify() {
        this.calls += 1;
        return true;
      }
    };
    const result = await runCli(
      ['recovery', 'preserve', '--data-dir', sourceDir, '--note', 'keep evidence', '--confirm'],
      { humanVerifier: verifier }
    );
    assert.equal(result.code, 0);
    assert.equal(verifier.calls, 1);
    const preserved = JSON.parse(result.stdout);
    assert.equal(preserved.recoveredFrom, path.resolve(sourceDir));
    assert.ok(preserved.files >= 1);
    assert.ok(preserved.snapshotDir.includes('corrupt-'));
    assert.ok(await exists(path.join(preserved.snapshotDir, 'manifest.json')));
    assert.ok(await exists(path.join(preserved.snapshotDir, 'state.json')));
    assert.match(result.proof, /Data directory: /);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('IM pump timer drives pending notification delivery without manual pump', async () => {
  const harness = await createHarness({
    overrides: {
      im: {
        enabled: true,
        adapterId: 'dsh-im',
        maxMessageAgeSec: 600,
        approvalTtlSec: 600,
        groupReplies: 'summary',
        notifications: { enabled: true, minGapMs: 1000, perMinute: 20 }
      }
    }
  });
  let bridge = null;
  try {
    const imPrincipal = await harness.store.transaction(async (draft) => {
      const principal = makePrincipal({
        id: 'im_user',
        kind: 'human',
        role: 'user',
        sourceKind: 'host_human_challenge',
        scopes: ['comment.draft'],
        workspaceId: draft.workspaceId
      });
      draft.principals[principal.id] = principal;
      return principal;
    });
    await harness.store.transaction(async (draft, tx) => harness.identity.bindIm(tx, {
      adapterId: 'dsh-im',
      botAccountId: 'bot1',
      senderRef: 'sender1',
      conversationIds: ['conv1'],
      principalId: imPrincipal.id,
      scopes: ['production.create', 'task.read.own']
    }));
    const stubService = {
      async execute() {
        return { accepted: true, taskId: 'task_im_1', status: 'queued', executionMode: 'dry', result: { dryRun: true } };
      }
    };
    const host = makeMockImHost();
    const adapter = new DshImChannelAdapter({ host, config: harness.configService.get(), now: harness.now });
    bridge = new ImBridge({
      store: harness.store,
      identity: harness.identity,
      commandService: stubService,
      effectGateway: harness.effectGateway,
      configService: harness.configService,
      channel: adapter,
      now: harness.now
    });
    await bridge.start();
    await bridge.ingest({
      adapterId: 'dsh-im',
      botAccountId: 'bot1',
      conversationId: 'conv1',
      senderRef: 'sender1',
      eventId: 'evt-pump',
      occurredAt: harness.now().toISOString(),
      command: { action: 'production.create', input: { requestId: 'pump' }, mode: 'dry' }
    }, { trusted: true, humanAssurance: 'verified', hostProof: { kind: 'test', ok: true } });
    const deadline = Date.now() + 4000;
    while (host.calls.send.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(host.calls.send.length, 1);
    assert.match(host.calls.send[0].text, /Task task_im_1/);
  } finally {
    if (bridge) await bridge.stop();
    await harness.cleanup();
  }
});

test('IM approval chain uses the real CommandService and executes the original task once', async () => {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      comments: { enabled: true, mode: 'approval', allowTemplate: true, maxLength: 300 },
      im: {
        enabled: true,
        adapterId: 'dsh-im',
        maxMessageAgeSec: 600,
        approvalTtlSec: 600,
        groupReplies: 'summary',
        notifications: { enabled: true, minGapMs: 1000, perMinute: 20 }
      }
    }
  });
  try {
    await bindMockAccount(harness);
    const imPrincipal = await harness.store.transaction(async (draft) => {
      const principal = makePrincipal({
        id: 'im_user',
        kind: 'human',
        role: 'user',
        sourceKind: 'host_human_challenge',
        scopes: ['comment.draft'],
        workspaceId: draft.workspaceId
      });
      draft.principals[principal.id] = principal;
      return principal;
    });
    await harness.store.transaction(async (draft, tx) => harness.identity.bindIm(tx, {
      adapterId: 'dsh-im',
      botAccountId: 'bot1',
      senderRef: 'sender1',
      conversationIds: ['conv1'],
      principalId: imPrincipal.id,
      scopes: ['approval.decide.own']
    }));
    const adapter = makeMockAdapter({ candidates: [mockCandidate()] });
    const comments = new CommentsModule({ ...harness, adapter });
    const command = new CommandService({ ...harness, services: { comments } });
    const draft = await comments.createDraft({
      candidate: mockCandidate(),
      text: 'entry audit comment',
      principal: imPrincipal
    });
    const bridge = new ImBridge({
      store: harness.store,
      identity: harness.identity,
      commandService: command,
      effectGateway: harness.effectGateway,
      configService: harness.configService,
      channel: new DshImChannelAdapter({ host: makeMockImHost(), config: harness.configService.get(), now: harness.now }),
      now: harness.now
    });
    const event = {
      adapterId: 'dsh-im',
      botAccountId: 'bot1',
      conversationId: 'conv1',
      senderRef: 'sender1',
      eventId: 'evt-approve',
      occurredAt: harness.now().toISOString(),
      command: {
        action: 'approval.decide',
        input: { approvalId: draft.approval.id, decision: 'approve', nonce: draft.nonce },
        mode: 'go'
      }
    };
    const trusted = { trusted: true, humanAssurance: 'verified', hostProof: { kind: 'test', ok: true } };
    const result = await bridge.ingest(event, trusted);
    assert.equal(result.accepted, true);
    assert.equal(adapter.calls.writeComment.length, 1);
    const state = await harness.snapshot();
    assert.equal(state.tasks[draft.task.id].status, 'succeeded');
    const replay = await bridge.ingest(event, trusted);
    assert.equal(replay.deduplicated, true);
    assert.equal(adapter.calls.writeComment.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('HTTP error handler maps representative stable codes and hides unknown management routes', async () => {
  const { AppError } = await import('../src/errors.js');
  const service = {
    async execute() {
      throw new Error('not used');
    }
  };
  const handler = createHttpHandler({
    commandService: service,
    status: async () => ({})
  });
  const cases = [
    ['CONFIG_INVALID', 400],
    ['FORBIDDEN', 403],
    ['OPERATION_UNKNOWN', 409],
    ['RATE_LIMITED', 429],
    ['CAPABILITY_UNSUPPORTED', 501],
    ['BACKUP_UNPROTECTED', 503],
    ['TRUST_UNAVAILABLE', 503]
  ];
  for (const [code, expected] of cases) {
    service.execute = async () => {
      throw new AppError(code, `representative ${code}`);
    };
    const response = await handler({
      method: 'POST',
      url: `${HTTP_PREFIX}/run/browse`,
      body: { mode: 'dry' },
      trustedContext: { trusted: true, principal: { id: 'p1', kind: 'human', role: 'user', scopes: [] } }
    });
    assert.equal(response.status, expected, `${code} must map to ${expected}`);
    assert.equal(response.body.code, code);
  }
  service.execute = async () => {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'task not found', { details: { reason: 'task_not_found' } });
  };
  const taskMissing = await handler({
    method: 'GET',
    url: `${HTTP_PREFIX}/tasks/task_missing`,
    trustedContext: { trusted: true, principal: { id: 'p1', kind: 'human', role: 'owner', scopes: ['*'] } }
  });
  assert.equal(taskMissing.status, 404);
  const unknownRoute = await handler({
    method: 'GET',
    url: `${HTTP_PREFIX}/does-not-exist`,
    trustedContext: { trusted: true, principal: { id: 'p1', kind: 'human', role: 'owner', scopes: ['*'] } }
  });
  assert.equal(unknownRoute.status, 404);
  assert.equal(unknownRoute.body.details.reason, 'route_not_found');

  await withRuntime(async ({ runtime, owner }) => {
    for (const [method, url] of [
      ['POST', '/operation/cancel'],
      ['POST', '/publish/void'],
      ['POST', '/migration/release-hold'],
      ['POST', '/account/resume'],
      ['POST', '/recovery/preserve']
    ]) {
      const response = await runtime.http(request(owner, { method, url, body: { mode: 'go' } }));
      assert.equal(response.status, 404, `${method} ${url} must not be exposed over HTTP`);
      assert.equal(response.body.code, 'CAPABILITY_UNSUPPORTED');
    }
  });
});

test('status exposes credential binding without secret material', async () => {
  await withRuntime(async ({ runtime, owner }) => {
    const status = await runtime.status(owner);
    assert.ok(status.credentials);
    for (const key of ['bound', 'accountId', 'verifiedAt', 'mismatch', 'credentialRevision']) {
      assert.ok(Object.prototype.hasOwnProperty.call(status.credentials, key), `credentials.${key} missing`);
    }
    assert.equal(status.credentials.bound, false);
    assert.equal(JSON.stringify(status.credentials).includes('SESSDATA'), false);
  });
});

test('error message sanitization redacts secret shapes and local paths', () => {
  const message = sanitizeErrorMessage('failed with SESSDATA=abc123; see C:\\Users\\owner\\secret-file.json for detail');
  assert.match(message, /SESSDATA=\[redacted\]/);
  assert.equal(message.includes('C:\\Users\\owner'), false);
  assert.match(message, /\[path\]/);
  assert.equal(sanitizeErrorMessage('plain message'), 'plain message');
  assert.equal(sanitizeErrorMessage('x'.repeat(600)).length <= 501, true);
});

test('projectTask allow-list omits internal pointers even when present', () => {
  const projected = projectTask({
    id: 'task_1',
    kind: 'dm',
    status: 'running',
    principalId: 'p1',
    notificationTarget: { bindingId: 'b', inboxKey: 'i', conversationId: 'c' },
    inboxKey: 'i',
    bindingId: 'b',
    input: { text: 'hello', token: 'abc' },
    result: { readyForPublish: false }
  });
  assert.equal(projected.notificationTarget, undefined);
  assert.equal(projected.inboxKey, undefined);
  assert.equal(projected.bindingId, undefined);
  assert.equal(projected.input.token, '[redacted]');
  assert.equal(projected.input.text, 'hello');
  assert.deepEqual(projected.result, { readyForPublish: false });
});
