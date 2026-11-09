// Real-DSH host adapter probe (T16.2/T10): verifies the plugin's Cordis apply
// against the host service shapes read from the local DSH 0.2.2-rc.1 install
// (`ctx.webServer.register`, `ctx.connection.admit`, `ctx.tools.register`,
// `ctx.effect`). No real DSH process is started here; the live mount probe is
// scripts/dsh-host-probe.mjs (run by the Lead against a temporary profile).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { plugin, HTTP_PREFIX } from '../src/index.js';
import { AppError } from '../src/errors.js';

const OWNER_PRINCIPAL = Object.freeze({
  id: 'principal-owner',
  kind: 'human',
  role: 'owner',
  sourceKind: 'local_cli',
  scopes: ['*'],
  workspaceId: 'ws-probe',
  revokedAt: null
});

function makeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(text) { this.body = text; }
  };
}

function makeReq({ method = 'GET', url = '/', body = null, throwOnBody = null } = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:39777' };
  if (throwOnBody) req.on = () => { throw throwOnBody; };
  return req;
}

function baseCtx(overrides = {}) {
  const registered = { routes: [], tools: [], effects: [], disposers: [] };
  const ctx = {
    config: { enabled: true, httpPrefix: HTTP_PREFIX },
    connection: {
      browserPeer: { principal: { kind: 'owner' }, id: 'browser-peer' },
      async admit() { return { peer: this.browserPeer }; }
    },
    webServer: {
      register(route) { registered.routes.push(route); return () => registered.disposers.push('route'); }
    },
    tools: {
      register(definition) { registered.tools.push(definition); return () => registered.disposers.push('tool'); }
    },
    effect(callback) { registered.effects.push(callback()); return () => {}; },
    dshToolsModule: { defineTool: (definition) => definition },
    createRuntime: async () => overrides.runtime,
    ...overrides
  };
  return { ctx, registered };
}

function fakeRuntime(overrides = {}) {
  const calls = { http: [], start: 0, close: 0 };
  const runtime = {
    tools: [{
      name: 'bili_unified_status',
      description: 'status',
      async execute(args, principal) { return { ok: true, args, principalId: principal.id }; }
    }],
    calls,
    async start() { calls.start += 1; },
    async close() { calls.close += 1; },
    async http(request) {
      calls.http.push(request);
      return {
        status: 200,
        body: {
          accepted: true,
          principalId: request.trustedContext.principal.id,
          humanVerified: Boolean(request.trustedHumanContext),
          url: request.url
        }
      };
    },
    async resolveHostPrincipal(peer) {
      if (peer?.principal?.kind !== 'owner') throw new AppError('FORBIDDEN', 'not an owner peer');
      return OWNER_PRINCIPAL;
    },
    async resolveAgentPrincipal(agent) {
      return { id: `dsh-agent:${agent.id}`, kind: 'agent', scopes: [] };
    },
    ...overrides
  };
  return runtime;
}

async function invoke(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  return res;
}

test('real DSH mount registers a prefix HTTP route, typed tools and an effect', async () => {
  const runtime = fakeRuntime();
  const { ctx, registered } = baseCtx({ runtime });
  const mounted = await plugin.apply(ctx);
  assert.equal(mounted.mounted, true);
  assert.equal(typeof mounted, 'function', 'Cordis effects require a disposer function return');
  assert.equal(registered.routes.length, 1);
  assert.equal(registered.routes[0].kind, 'prefix');
  assert.equal(registered.routes[0].path, HTTP_PREFIX);
  assert.equal(registered.tools.length, 1);
  assert.equal(registered.tools[0].name, 'bili_unified_status');
  assert.equal(registered.effects.length, 0, 'the returned disposer is the effect');
  assert.equal(runtime.calls.start, 1);

  // Admitted browser owner peer -> trusted owner principal + host human context.
  const ok = await invoke(registered.routes[0], makeReq({ url: `${HTTP_PREFIX}/status` }));
  assert.equal(ok.status, 200);
  const payload = JSON.parse(ok.body);
  assert.equal(payload.principalId, OWNER_PRINCIPAL.id);
  assert.equal(payload.humanVerified, true);
  assert.equal(runtime.calls.http.length, 1);
  assert.equal(ok.headers['content-type'], 'application/json; charset=utf-8');

  // A rejected admission fails closed and never reaches the plugin handler.
  ctx.connection.admit = async () => ({ rejection: 401 });
  const rejected = await invoke(registered.routes[0], makeReq({ url: `${HTTP_PREFIX}/status` }));
  assert.equal(rejected.status, 401);
  assert.equal(JSON.parse(rejected.body).code, 'TRUST_UNAVAILABLE');
  assert.equal(runtime.calls.http.length, 1);

  // Non-owner peers are refused by principal resolution (403, fail closed).
  ctx.connection.admit = async () => ({ peer: { principal: { kind: 'api' }, id: 'api-peer' } });
  const forbidden = await invoke(registered.routes[0], makeReq({ url: `${HTTP_PREFIX}/status` }));
  assert.equal(forbidden.status, 403);
  assert.equal(runtime.calls.http.length, 1);

  // Effect disposal releases the runtime.
  await mounted();
  assert.equal(runtime.calls.close, 1);
});

test('real DSH tool definitions execute with a restricted agent principal', async () => {
  const runtime = fakeRuntime();
  const { ctx, registered } = baseCtx({ runtime });
  await plugin.apply(ctx);
  const definition = registered.tools[0];
  const result = await definition.execute({ request: { scope: 'self' } }, { agent: { id: 'agent-7' }, signal: null });
  assert.deepEqual(result.args, { scope: 'self' });
  assert.equal(result.principalId, 'dsh-agent:agent-7');
});

test('mount config enabled=false keeps the real host plugin unmounted', async () => {
  const runtime = fakeRuntime();
  const { ctx, registered } = baseCtx({ runtime, config: { enabled: false, httpPrefix: HTTP_PREFIX } });
  const mounted = await plugin.apply(ctx);
  assert.equal(mounted, null);
  assert.equal(registered.routes.length, 0);
  assert.equal(runtime.calls.start, 0);
});

test('oversized and malformed host bodies fail closed before the plugin handler', async () => {
  const runtime = fakeRuntime();
  const { ctx, registered } = baseCtx({ runtime });
  await plugin.apply(ctx);
  const route = registered.routes[0];
  const big = makeReq({ method: 'POST', body: null });
  big[Symbol.asyncIterator] = async function* generate() {
    yield Buffer.alloc(1024 * 1024 + 1, 0x20);
  };
  const tooBig = await invoke(route, big);
  assert.equal(tooBig.status, 400);
  assert.equal(runtime.calls.http.length, 0);

  const badJson = makeReq({ method: 'POST', body: null });
  badJson[Symbol.asyncIterator] = async function* generate() { yield Buffer.from('{not json'); };
  const malformed = await invoke(route, badJson);
  assert.equal(malformed.status, 400);
  assert.equal(runtime.calls.http.length, 0);
});

test('missing host trust service fails closed with 503', async () => {
  const runtime = fakeRuntime();
  const { ctx, registered } = baseCtx({ runtime });
  delete ctx.connection;
  await plugin.apply(ctx);
  const res = await invoke(registered.routes[0], makeReq({ url: `${HTTP_PREFIX}/status` }));
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body).code, 'TRUST_UNAVAILABLE');
  assert.equal(runtime.calls.http.length, 0);
});

test('host trust service is resolved per request instead of cached at mount', async () => {
  const runtime = fakeRuntime();
  const { ctx, registered } = baseCtx({ runtime });
  const savedConnection = ctx.connection;
  delete ctx.connection;
  await plugin.apply(ctx);
  const missing = await invoke(registered.routes[0], makeReq({ url: `${HTTP_PREFIX}/status` }));
  assert.equal(missing.status, 503);
  // A service provided after activation must become usable without a remount.
  ctx.connection = savedConnection;
  const restored = await invoke(registered.routes[0], makeReq({ url: `${HTTP_PREFIX}/status` }));
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(restored.body).principalId, OWNER_PRINCIPAL.id);
});

test('Cordis inject declaration defers activation until the mounted services exist', () => {
  assert.deepEqual(plugin.inject, ['webServer', 'tools']);
});

test('duplicate mount returns a Cordis-valid idempotent disposer', async () => {
  const runtime = fakeRuntime();
  const { ctx, registered } = baseCtx({ runtime });
  const first = await plugin.apply(ctx);
  assert.equal(typeof first, 'function');
  assert.equal(ctx.__biliUnifiedRuntime, runtime);
  const second = await plugin.apply(ctx);
  assert.equal(typeof second, 'function', 'a duplicate mount must still return an effect');
  assert.equal(second.runtime, runtime);
  assert.equal(registered.routes.length, 1, 'duplicate mount must not register a second route');
  assert.equal(runtime.calls.start, 1, 'duplicate mount must not start a second runtime');
  await second();
  assert.equal(runtime.calls.close, 0, 'the guard disposer must not close the owner runtime');
  await first();
  assert.equal(runtime.calls.close, 1);
});
