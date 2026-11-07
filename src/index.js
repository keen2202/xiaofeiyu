import { AppError } from './errors.js';
import { ConfigService, computeConfigHash } from './config.js';
import { JsonStore, DEFAULT_ALLOWED_CAPABILITIES } from './store.js';
import { EventJournal } from './event-journal.js';
import { TaskManager } from './task-manager.js';
import { IdentityService, HumanProofService, TtyHumanVerifier } from './identity.js';
import { ApprovalService } from './approval.js';
import { RateLimiter } from './rate-limiter.js';
import { EffectGateway } from './effect-gateway.js';
import { CredentialService } from './credentials.js';
import { BilibiliClient } from './bilibili.js';
import { BilibiliPlatformAdapter } from './adapters/platforms/bilibili.js';
import { AdapterRegistry } from './adapters/registry.js';
import { AgentClient } from './agent.js';
import { ArtifactStore } from './artifact-store.js';
import { BrowseModule } from './modules/browse.js';
import { CommentsModule } from './modules/comments.js';
import { DirectMessagesModule } from './modules/direct-messages.js';
import { DiaryModule } from './modules/diary.js';
import { ProductionModule } from './modules/production.js';
import { PublisherModule } from './modules/publisher.js';
import { CommandService } from './command-service.js';
import { Coordinator } from './coordinator.js';
import { LocalExecutionBackend } from './adapters/execution/local.js';
import { BackupPolicyService, BackupService, BackupScheduler, RecoveryService } from './backup-recovery.js';
import { MigrationService } from './migration.js';
import { DshImChannelAdapter, ImBridge } from './adapters/channels/dsh-im.js';
import { ensureDir, randomId } from './utils.js';

export const HTTP_PREFIX = '/dsh-bili-unified/api';
const MAX_HTTP_BODY = 1024 * 1024;

function buildEnvelope(action, input, mode = 'dry', requestId = null) {
  return {
    schemaVersion: 1,
    requestId: requestId || randomId('req'),
    action,
    input: input || {},
    mode
  };
}

export async function createRuntime(options = {}) {
  const {
    dataDir = null,
    configFile = null,
    config: injectedConfig = null,
    env = process.env,
    now = () => new Date(),
    fetchImpl = globalThis.fetch,
    humanVerifier = null,
    imHost = null,
    logger = console,
    bootstrap = true,
    bootstrapWorkspaceId = null,
    bootstrapHistoryEpoch = null,
    bootstrapInstanceId = null,
    hooks = {},
    lockTimeoutMs = 5000,
    staleLockMs = 30000
  } = options;

  const configService = new ConfigService({
    dataDir,
    file: configFile,
    injected: injectedConfig,
    env,
    now,
    logger
  });
  let loaded = await configService.load();
  const config = loaded.config;
  const paths = loaded.paths;
  const store = new JsonStore({
    file: paths.stateFile,
    instanceFile: paths.instanceFile,
    lockTimeoutMs,
    staleLockMs,
    now,
    logger,
    hooks: hooks.store,
    instanceId: bootstrapInstanceId || null
  });
  const boot = await store.init({
    bootstrap,
    workspaceId: bootstrapWorkspaceId,
    historyEpoch: bootstrapHistoryEpoch,
    instanceId: bootstrapInstanceId,
    configRevision: { version: 1, sha256: computeConfigHash(config) },
    timeZone: config.timeZone,
    allowedCapabilities: [...DEFAULT_ALLOWED_CAPABILITIES]
  });
  configService.store = store;
  await configService.syncRevision({ bootstrap: boot.bootstrapped });

  const rateLimiter = new RateLimiter({ now, getTimeZone: () => configService.get().timeZone });
  const taskManager = new TaskManager({ store, now });
  const journal = new EventJournal({ store, dir: paths.journalDir, now, hooks: hooks.journal, logger });
  const identity = new IdentityService({ store, now });
  const verifier = humanVerifier || new TtyHumanVerifier({ now });
  const humanProof = new HumanProofService({ verifier });
  const approvalService = new ApprovalService({ store, taskManager, identity, humanProof, now });
  const artifactStore = new ArtifactStore({
    store,
    rootDir: paths.artifactsDir,
    workDir: paths.workDir,
    configService,
    now,
    hooks: hooks.artifacts,
    logger
  });
  await ensureDir(paths.artifactsDir);
  await ensureDir(paths.workDir);
  await ensureDir(paths.diaryDir);
  await ensureDir(paths.journalDir);

  const policyService = new BackupPolicyService({ file: paths.backupPolicyFile, dataDir: paths.dataDir, now });
  const backupService = new BackupService({
    store,
    configService,
    policyService,
    artifactStore,
    journalDir: paths.journalDir,
    dataDir: paths.dataDir,
    humanProof,
    now,
    hooks: hooks.backup,
    logger
  });
  const backupScheduler = new BackupScheduler({
    backupService,
    policyService,
    now,
    logger,
    tickMs: hooks.backup?.schedulerTickMs || 60000
  });

  const credentials = new CredentialService({ file: paths.credentialsFile, env, store, now });
  let credentialsError = null;
  try {
    await credentials.load();
  } catch (error) {
    // Credentials are optional for status, diary, production and local
    // artifact work. A corrupt credential store only disables authenticated
    // platform operations until the owner repairs it.
    credentialsError = {
      code: error.code || 'CREDENTIAL_MISSING',
      message: error.message
    };
    credentials.credentials = {};
    logger?.warn?.('credentials unavailable', credentialsError);
  }

  let effectGateway = null;
  const client = new BilibiliClient({
    config,
    credentials: credentials.get(),
    fetchImpl,
    now,
    logger,
    operationContextVerifier: {
      verify: (context) => effectGateway.operationContextVerifier.verify(context)
    },
    deviceIdProvider: async () => {
      const state = await store.getSnapshot();
      if (!state.activeAccountRef) return null;
      return state.accounts[`bilibili:${state.activeAccountRef.accountId}`]?.devId || null;
    },
    beforeRead: async () => {
      const state = await store.getSnapshot();
      const key = state.activeAccountRef
        ? `bilibili:${state.activeAccountRef.accountId}`
        : 'bilibili:unverified';
      await store.transaction(async (draft) => {
        rateLimiter.reserveRead(draft, { key, limits: configService.get().rateLimit });
      });
    },
    onRisk: async ({ code, retryAfterMs }) => {
      const state = await store.getSnapshot();
      if (!state.activeAccountRef) return;
      const key = `bilibili:${state.activeAccountRef.accountId}`;
      await store.transaction(async (draft, tx) => {
        rateLimiter.recordRisk(draft, key, { code, retryAfterMs, reason: 'bilibili_risk_control' });
        tx.appendEvent({
          type: 'bilibili.circuit.opened',
          actor: 'system',
          accountRef: state.activeAccountRef,
          payload: { code, retryAfterMs }
        });
      });
    }
  });
  credentials.verifier = async () => client.whoami();
  const bilibiliAdapter = new BilibiliPlatformAdapter({
    client,
    store,
    configService,
    rateLimiter,
    config,
    logger,
    now
  });
  const registry = new AdapterRegistry();
  if (config.platforms.enabled.includes('bilibili')) {
    registry.registerPlatform({
      name: 'bilibili',
      enabled: true,
      declaration: bilibiliAdapter.capabilities,
      factory: async () => bilibiliAdapter
    });
  }
  let executionBackend = null;
  const getBackend = () => {
    if (!executionBackend) {
      executionBackend = new LocalExecutionBackend({ now, logger, hooks: hooks.execution });
    }
    return executionBackend;
  };
  registry.registerExecutionBackend({
    name: 'local',
    enabled: true,
    declaration: {
      backendId: 'local',
      schemaVersion: 1,
      supportedStages: ['render', 'validate'],
      supportsCancel: true,
      supportsCheckpoint: false
    },
    factory: async () => getBackend()
  });

  effectGateway = new EffectGateway({
    store,
    taskManager,
    approvalService,
    identity,
    humanProof,
    rateLimiter,
    configService,
    getConfig: () => configService.get(),
    protection: backupService,
    now,
    hooks: hooks.gateway,
    logger
  });

  const agent = new AgentClient({ config, fetchImpl, env, now, logger });
  const browse = new BrowseModule({ store, taskManager, adapter: bilibiliAdapter, configService, now, logger });
  const comments = new CommentsModule({
    store,
    taskManager,
    approvalService,
    adapter: bilibiliAdapter,
    configService,
    effectGateway,
    now,
    logger,
    approvalTtlSec: config.im.approvalTtlSec
  });
  const directMessages = new DirectMessagesModule({
    store,
    taskManager,
    adapter: bilibiliAdapter,
    configService,
    effectGateway,
    now,
    logger
  });
  const diary = new DiaryModule({
    store,
    journal,
    configService,
    identity,
    agent,
    diaryDir: paths.diaryDir,
    now,
    hooks: hooks.diary,
    logger
  });
  const production = new ProductionModule({
    store,
    taskManager,
    configService,
    artifactStore,
    effectGateway,
    approvalService,
    journal,
    backendFactory: getBackend,
    now,
    hooks: hooks.production,
    logger
  });
  const publisher = new PublisherModule({
    store,
    taskManager,
    approvalService,
    humanProof,
    artifactStore,
    configService,
    effectGateway,
    now,
    logger,
    hooks: hooks.publisher
  });
  const coordinator = new Coordinator({
    store,
    taskManager,
    identity,
    configService,
    browse,
    comments,
    directMessages,
    diary,
    production,
    publisher,
    agent,
    now,
    logger
  });
  const commandService = new CommandService({
    store,
    taskManager,
    identity,
    configService,
    approvalService,
    effectGateway,
    now,
    logger,
    services: {
      browse,
      comments,
      directMessages,
      diary,
      production,
      publisher,
      configService
    }
  });
  const imAdapter = new DshImChannelAdapter({ host: imHost, config, now, logger });
  const imBridge = new ImBridge({
    store,
    identity,
    commandService,
    effectGateway,
    configService,
    channel: imAdapter,
    now,
    logger
  });
  const recovery = new RecoveryService({
    store,
    configService,
    recoveryDir: paths.recoveryDir,
    humanProof,
    effectGateway,
    taskManager,
    restoreRecorder: (info) => backupService.noteRestoreTest(info),
    now,
    hooks: hooks.recovery,
    logger
  });
  const migration = new MigrationService({
    store,
    configService,
    artifactStore,
    journal,
    humanProof,
    protection: backupService,
    executorStatus: async () => {
      const active = executionBackend ? executionBackend.active : 0;
      return { stopped: active === 0, activeLocalExecutions: active };
    },
    dataDir: paths.dataDir,
    migrationsDir: paths.migrationsDir,
    journalDir: paths.journalDir,
    diaryDir: paths.diaryDir,
    postsDir: paths.postsDir,
    now,
    hooks: hooks.migration,
    logger
  });

  // Safe, local-only startup repair: finish provable pending imports, mark
  // orphaned executions interrupted. No external action is replayed.
  await artifactStore.recoverPendingImports().catch((error) => logger?.warn?.('artifact recovery failed', { message: error.message }));
  await diary.recoverPending().catch((error) => logger?.warn?.('diary recovery failed', { message: error.message }));
  await production.recoverInterrupted().catch((error) => logger?.warn?.('execution recovery failed', { message: error.message }));
  await effectGateway.recoverOrphanedOperations().catch((error) => logger?.warn?.('operation recovery failed', { message: error.message }));

  const runtime = {
    store,
    configService,
    paths,
    config,
    boot,
    journal,
    taskManager,
    identity,
    humanProof,
    approvalService,
    rateLimiter,
    effectGateway,
    credentials,
    credentialsError,
    client,
    bilibiliAdapter,
    registry,
    agent,
    artifactStore,
    browse,
    comments,
    directMessages,
    diary,
    production,
    publisher,
    coordinator,
    commandService,
    imAdapter,
    imBridge,
    backupService,
    backupScheduler,
    policyService,
    recovery,
    migration,
    getBackend,
    async bindAccount({ switchAccount = false, principal = null } = {}) {
      const owner = principal || (await store.transaction(async (draft, tx) => identity.ensureLocalOwner(tx)));
      return credentials.verifyAndBind({
        principal: owner,
        switchAccount,
        ownerMid: configService.get().owner.mid
      });
    },
    async start() {
      const started = await coordinator.start();
      let im = null;
      let backup = null;
      try {
        backup = await backupScheduler.start();
      } catch (error) {
        backup = { started: false, error: { code: error.code, message: error.message } };
      }
      if (configService.get().im.enabled && imHost) {
        try {
          im = await imBridge.start();
        } catch (error) {
          im = { started: false, error: { code: error.code, message: error.message } };
        }
      }
      return { ...started, im, backup };
    },
    async stop() {
      const backup = await backupScheduler.stop().catch((error) => ({ stopped: false, error: error.message }));
      const coordinatorResult = await coordinator.stop();
      let im = null;
      try {
        im = await imBridge.stop();
      } catch (error) {
        im = { stopped: false, error: error.message };
      }
      const backend = executionBackend;
      let execution = null;
      if (backend) execution = await backend.close();
      await store.close();
      return { backup, coordinator: coordinatorResult, im, execution };
    },
    async close() {
      await backupScheduler.stop().catch(() => {});
      await coordinator.stop().catch(() => {});
      if (executionBackend) await executionBackend.close().catch(() => {});
      try {
        const instance = await store.getInstance();
        if (instance?.status === 'active') await journal.flush();
      } catch {
        // Shutdown archival is best-effort; it must never block store close.
      }
      await store.close();
    }
  };
  runtime.http = createHttpHandler(runtime);
  runtime.tools = createTools(runtime);
  runtime.status = async (principal) => {
    const status = await commandService.status(principal);
    let protection = { status: 'invalid', reason: 'unavailable' };
    try {
      const state = await store.getSnapshot();
      protection = await backupService.getProtection({
        kind: 'workspace',
        workspaceId: state.workspaceId
      });
    } catch (error) {
      protection = { status: 'invalid', reason: error.code || 'BACKUP_INVALID' };
    }
    const scheduler = await backupScheduler.status().catch((error) => ({
      configured: false,
      scheduleEnabled: false,
      started: false,
      lastError: { code: error.code || 'BACKUP_INVALID', message: error.message }
    }));
    return {
      ...status,
      backup: {
        status: protection.status,
        reason: protection.reason || null,
        ageMs: protection.ageMs ?? null,
        cutAt: protection.cutAt || null,
        mediaCoverage: protection.mediaCoverage || null,
        scheduler
      }
    };
  };
  return runtime;
}

function requireTrusted(request) {
  if (!request?.trustedContext || request.trustedContext.trusted !== true) {
    throw new AppError('TRUST_UNAVAILABLE', 'trusted host context is required');
  }
  const principal = request.trustedContext.principal;
  if (!principal || !principal.id) throw new AppError('TRUST_UNAVAILABLE', 'trusted principal is required');
  return principal;
}

function assertBodySize(body) {
  const size = Buffer.byteLength(JSON.stringify(body ?? {}));
  if (size > MAX_HTTP_BODY) throw new AppError('CONFIG_INVALID', 'request body exceeds 1MiB');
}

function normalizePath(rawPath) {
  const pathname = String(rawPath || '').split('?')[0];
  if (pathname === '/dsh-bili-unified/api') return '/';
  if (pathname.startsWith(HTTP_PREFIX)) return pathname.slice(HTTP_PREFIX.length) || '/';
  if (pathname.startsWith('/dsh-bili-unified/')) return pathname.slice('/dsh-bili-unified'.length);
  return pathname;
}

function isOwner(principal) {
  return principal?.kind === 'human' && principal.role === 'owner' && principal.scopes?.includes('*');
}

export function createHttpHandler(runtime) {
  return async function handle(request) {
    try {
      const method = String(request.method || 'GET').toUpperCase();
      const pathname = normalizePath(request.url || request.path);
      const body = request.body || {};
      assertBodySize(body);
      const principal = requireTrusted(request);
      const trustedHumanContext = request.trustedHumanContext || null;
      const envelope = (action, input, mode = 'dry') =>
        buildEnvelope(action, input, mode, body.requestId || null);
      if (method === 'GET' && pathname === '/status') {
        return { status: 200, body: { accepted: true, result: await runtime.status(principal) } };
      }
      if (method === 'GET' && pathname === '/config') {
        if (!isOwner(principal)) throw new AppError('FORBIDDEN', 'admin access required');
        return { status: 200, body: runtime.configService.redacted() };
      }
      if (method === 'PATCH' && pathname === '/config') {
        if (!isOwner(principal)) throw new AppError('FORBIDDEN', 'admin access required');
        const updated = await runtime.configService.update(body.patch || body, {
          source: 'http',
          expectedRevision: body.expectedRevision
        });
        return { status: 200, body: updated };
      }
      if (method === 'POST' && pathname === '/run/browse') {
        const result = await runtime.commandService.execute(
          envelope('browse.run', body.input || {}, body.mode || 'go'),
          principal,
          { trusted: true, sourceKind: 'http' }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/run/diary') {
        const result = await runtime.commandService.execute(
          envelope(
            'diary.generate',
            { date: body.date, scope: body.scope, book: body.book || null, force: body.force === true },
            'dry'
          ),
          principal,
          { trusted: true, sourceKind: 'http' }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/comments/draft') {
        const result = await runtime.commandService.execute(
          envelope('comment.draft', body.input || body, 'dry'),
          principal,
          { trusted: true, sourceKind: 'http' }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/comments/approve') {
        const result = await runtime.commandService.execute(
          envelope(
            'approval.decide',
            { approvalId: body.approvalId, decision: body.decision, nonce: body.nonce },
            body.mode || 'go'
          ),
          principal,
          { trusted: true, sourceKind: 'http', humanContext: trustedHumanContext }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/dm/send') {
        const result = await runtime.commandService.execute(
          envelope('dm.send', body.input || body, body.mode),
          principal,
          { trusted: true, sourceKind: 'http' }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/production') {
        const result = await runtime.commandService.execute(
          envelope('production.create', body.input || body, body.mode),
          principal,
          { trusted: true, sourceKind: 'http' }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/publish') {
        const result = await runtime.commandService.execute(
          envelope('publish.create', body.input || body, body.mode),
          principal,
          { trusted: true, sourceKind: 'http' }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/approvals/decide') {
        const result = await runtime.commandService.execute(
          envelope(
            'approval.decide',
            { approvalId: body.approvalId, decision: body.decision, nonce: body.nonce },
            body.mode || 'go'
          ),
          principal,
          { trusted: true, sourceKind: 'http', humanContext: trustedHumanContext }
        );
        return { status: 200, body: result };
      }
      if (method === 'GET' && pathname === '/tasks') {
        const result = await runtime.commandService.execute(
          envelope('task.list', { limit: Number(request.query?.limit) || 50 }, 'dry'),
          principal,
          { trusted: true, sourceKind: 'http' }
        );
        return { status: 200, body: result };
      }
      const taskMatch = pathname.match(/^\/tasks\/([^/]+)(?:\/(cancel|resume))?$/);
      if (taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]);
        const suffix = taskMatch[2] || null;
        if (method === 'GET' && !suffix) {
          const result = await runtime.commandService.execute(
            envelope('task.get', { taskId }, 'dry'),
            principal,
            { trusted: true, sourceKind: 'http' }
          );
          return { status: 200, body: result };
        }
        if (method === 'POST' && suffix === 'cancel') {
          const result = await runtime.commandService.execute(
            envelope('task.cancel', { taskId }, 'dry'),
            principal,
            { trusted: true, sourceKind: 'http' }
          );
          return { status: 200, body: result };
        }
        if (method === 'POST' && suffix === 'resume') {
          const result = await runtime.commandService.execute(
            envelope('task.resume', { taskId }, body.mode || 'go'),
            principal,
            { trusted: true, sourceKind: 'http' }
          );
          return { status: 200, body: result };
        }
      }
      throw new AppError('CAPABILITY_UNSUPPORTED', 'route not found', {
        httpStatus: 404,
        details: { reason: 'route_not_found' }
      });
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError('DEPENDENCY_UNAVAILABLE', error.message || String(error));
      const status =
        appError.code === 'CAPABILITY_UNSUPPORTED' && appError.details?.reason === 'task_not_found'
          ? 404
          : appError.httpStatus;
      return { status, body: appError.toJSON() };
    }
  };
}

export function createTools(runtime) {
  const tool = (name, description, action, sensitive = false) => ({
    name: `bili_unified_${name}`,
    description,
    sensitive,
    async execute(args, principal, options = {}) {
      if (!principal?.id) throw new AppError('TRUST_UNAVAILABLE', 'tool principal is missing');
      if (action === 'status.get') return JSON.parse(JSON.stringify(await runtime.status(principal)));
      const input = args || {};
      let mode = 'dry';
      if (['browse.run', 'dm.send', 'production.create', 'publish.create'].includes(action)) {
        mode = input.mode || 'dry';
      }
      const result = await runtime.commandService.execute(
        buildEnvelope(action, input, mode),
        principal,
        { trusted: true, sourceKind: 'agent' }
      );
      return JSON.parse(JSON.stringify(result));
    }
  });
  return [
    tool('status', 'Read-only plugin status and task counters', 'status.get'),
    tool('browse', 'Run one browsing round', 'browse.run'),
    tool('comment_draft', 'Create a comment draft / approval request', 'comment.draft'),
    tool('dm', 'Send a whitelisted direct message', 'dm.send'),
    tool('diary', 'Generate a scope diary', 'diary.generate'),
    tool('production', 'Create a production task or dry-run plan', 'production.create'),
    tool('publish', 'Create an independent publish task', 'publish.create'),
    tool('task_get', 'Read one task owned by the caller', 'task.get'),
    tool('task_cancel', 'Request cancellation of one owned task', 'task.cancel')
  ];
}

/**
 * Cordis plugin entry. The host service names below are a deliberately thin
 * adapter contract; unsupported services are ignored rather than failing the
 * whole host. Real DSH wiring remains a verification item (T16.2/T10).
 */
export const plugin = {
  name: 'dsh-bili-unified',
  async apply(ctx = {}) {
    if (!ctx || typeof ctx !== 'object') return null;
    if (ctx.__biliUnifiedRuntime) return ctx.__biliUnifiedRuntime;
    let runtime = null;
    const factory = ctx.createRuntime || createRuntime;
    const businessConfig =
      ctx.config && typeof ctx.config === 'object' && ctx.config.schemaVersion === 1
        ? ctx.config
        : null;
    if (ctx.dataDir || businessConfig) {
      runtime = await factory({
        dataDir: ctx.dataDir || null,
        config: businessConfig,
        env: ctx.env || process.env,
        humanVerifier: ctx.humanVerifier || null,
        imHost: ctx.imHost || null,
        logger: ctx.logger || console
      });
      ctx.__biliUnifiedRuntime = runtime;
      await runtime.start();
    }
    const disposers = [];
    if (runtime && typeof ctx.webServer?.registerHandler === 'function') {
      const handler = runtime.http;
      disposers.push(
        await ctx.webServer.registerHandler({
          prefix: HTTP_PREFIX,
          handler: async (hostRequest) => {
            const result = await handler(hostRequest);
            return result;
          }
        })
      );
    }
    if (runtime && typeof ctx.tools?.register === 'function') {
      for (const tool of runtime.tools) {
        disposers.push(
          await ctx.tools.register({
            name: tool.name,
            description: tool.description,
            execute: (args, principal) => tool.execute(args, principal)
          })
        );
      }
    }
    if (runtime && typeof ctx.lifecycle?.onDispose === 'function') {
      disposers.push(ctx.lifecycle.onDispose(() => runtime.close()));
    }
    return {
      runtime,
      dispose: async () => {
        for (const disposer of disposers.reverse()) {
          if (typeof disposer === 'function') await disposer();
        }
        if (runtime) await runtime.close();
        ctx.__biliUnifiedRuntime = null;
      }
    };
  }
};

export default plugin;
