import { AppError, redactSecrets } from './errors.js';
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
import { ensureDir, randomId } from './utils.js';

export const HTTP_PREFIX = '/dsh-bili-unified/api';
export const MOUNT_SCHEMA_VERSION = 1;
const MAX_HTTP_BODY = 1024 * 1024;
const MODES = new Set(['dry', 'go']);

export function sanitizeErrorMessage(message) {
  let text = String(message ?? '');
  text = text.replace(
    /((?:sessdata|bili_jct|dedeuserid|buvid3|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|cookie)\s*[=:]\s*)[^\s,;&]+/gi,
    '$1[redacted]'
  );
  text = text.replace(/(?:[A-Za-z]:\\[^\s'"]+|\/(?:home|Users|tmp|var|etc|root|mnt)\/[^\s'"]+)/g, '[path]');
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function explicitMode(body, { required = true, defaultMode = null } = {}) {
  const mode = body?.mode;
  if (mode === undefined) {
    if (defaultMode !== null) return defaultMode;
    if (required) {
      throw new AppError('CONFIG_INVALID', 'mode is required and must be dry or go', {
        details: { reason: 'mode_required' }
      });
    }
    return null;
  }
  if (!MODES.has(mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
  return mode;
}

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

  const rateLimiter = new RateLimiter({
    now,
    getTimeZone: () => configService.get().timeZone,
    circuitBaseMs: config.rateLimit?.circuitBaseMs,
    circuitMaxMs: config.rateLimit?.circuitMaxMs
  });
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
  // Optional wiring consumed by newer BackupService versions: finish provable
  // pending multi-file commits before capturing, and expose filesystem capacity
  // for the pre-flight check. Older implementations ignore unknown options.
  const prepareCapture = async () => {
    await artifactStore.recoverPendingImports().catch((error) => logger?.warn?.('artifact recovery failed', { code: error.code }));
    await diary.recoverPending().catch((error) => logger?.warn?.('diary recovery failed', { code: error.code }));
    await production.recoverInterrupted().catch((error) => logger?.warn?.('execution recovery failed', { code: error.code }));
  };
  const statfs = async (targetPath) => {
    const fsp = await import('node:fs/promises');
    try {
      const stats = await fsp.statfs(targetPath);
      const blockSize = Number(stats.bsize);
      return {
        path: targetPath,
        bsize: blockSize,
        bavail: Number(stats.bavail),
        blockSize,
        blocks: Number(stats.blocks),
        freeBlocks: Number(stats.bavail),
        freeBytes: Number(stats.bavail) * blockSize,
        availableBytes: Number(stats.bavail) * blockSize
      };
    } catch (error) {
      logger?.warn?.('filesystem capacity probe failed', { code: error.code });
      return null;
    }
  };
  const backupService = new BackupService({
    store,
    configService,
    policyService,
    artifactStore,
    journalDir: paths.journalDir,
    dataDir: paths.dataDir,
    humanProof,
    prepareCapture,
    statfs,
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
    // Reconcile a persisted credential/cookie change with the bound account so
    // platform writes fail closed until the owner re-runs account verify.
    if (typeof credentials.reconcileCredentialBinding === 'function') {
      await credentials.reconcileCredentialBinding({ actor: 'system' }).catch((error) =>
        logger?.warn?.('credential reconcile failed', { code: error.code, message: error.message }));
    }
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
    store,
    rateLimiter,
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
      executionBackend = new LocalExecutionBackend({
        now,
        logger,
        hooks: hooks.execution,
        // Optional: newer backends verify a gateway-issued dispatch context.
        // The getter is evaluated lazily so construction order stays compatible.
        executionContextVerifier: effectGateway?.executionContextVerifier
      });
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

  // Late-bound service references consumed by the gateway in newer versions
  // (migration late receipts / diary rebuild markers). Getter keeps construction
  // order compatible because migration/diary are created after the gateway.
  const gatewayServiceRefs = { migration: null, diary: null };
  const gatewayServices = {
    get migration() {
      return gatewayServiceRefs.migration;
    },
    get diary() {
      return gatewayServiceRefs.diary;
    }
  };
  effectGateway = new EffectGateway({
    store,
    taskManager,
    approvalService,
    identity,
    humanProof,
    rateLimiter,
    configService,
    credentials,
    services: gatewayServices,
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
    adapter: bilibiliAdapter,
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
      coordinator,
      browse,
      comments,
      directMessages,
      diary,
      production,
      publisher,
      configService
    }
  });
  // Optional IM bridge: loaded dynamically (and only when an IM host/enablement
  // exists) so the default core does not import the channel adapter module.
  let imAdapter = null;
  let imBridge = null;
  if (config.im.enabled || imHost) {
    try {
      const { DshImChannelAdapter, ImBridge } = await import('./adapters/channels/dsh-im.js');
      imAdapter = new DshImChannelAdapter({ host: imHost, config, now, logger });
      imBridge = new ImBridge({
        store,
        identity,
        commandService,
        effectGateway,
        configService,
        channel: imAdapter,
        now,
        logger
      });
    } catch (error) {
      logger?.warn?.('IM bridge module unavailable', { code: error.code, message: error.message });
    }
  }
  const recovery = new RecoveryService({
    store,
    configService,
    recoveryDir: paths.recoveryDir,
    humanProof,
    effectGateway,
    taskManager,
    protection: backupService,
    restoreRecorder: (info) => backupService.noteRestoreTest(info),
    now,
    hooks: hooks.recovery,
    logger
  });
  store.recoveryDir = paths.recoveryDir;
  let migration = null;
  try {
    const { MigrationService } = await import('./migration.js');
    migration = new MigrationService({
      store,
      configService,
      artifactStore,
      journal,
      humanProof,
      protection: backupService,
      taskManager,
      diary,
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
    gatewayServiceRefs.migration = migration;
  } catch (error) {
    logger?.warn?.('migration module unavailable', { code: error.code, message: error.message });
  }
  gatewayServiceRefs.diary = diary;

  // Safe, local-only startup repair: finish provable pending imports, mark
  // orphaned executions interrupted. No external action is replayed. Each step
  // is gated by the presence of relevant pending state so that an idle startup
  // (for example a CLI status read) does not rewrite the ledger.
  const startupState = await store.getSnapshot();
  if (Object.keys(startupState.artifactPendingImports || {}).length > 0) {
    await artifactStore.recoverPendingImports().catch((error) => logger?.warn?.('artifact recovery failed', { message: error.message }));
  }
  if (Object.values(startupState.diaries || {}).some((entry) => entry.pendingCommit)) {
    await diary.recoverPending().catch((error) => logger?.warn?.('diary recovery failed', { message: error.message }));
  }
  if (Object.values(startupState.executions || {}).some((execution) =>
    ['accepted', 'running', 'cancel_requested'].includes(execution.status))) {
    await production.recoverInterrupted().catch((error) => logger?.warn?.('execution recovery failed', { message: error.message }));
  }
  if (Object.values(startupState.operations || {}).some((operation) =>
    ['reserved', 'dispatching'].includes(operation.status))) {
    await effectGateway.recoverOrphanedOperations().catch((error) => logger?.warn?.('operation recovery failed', { message: error.message }));
  }
  if (Object.values(startupState.requests || {}).some((request) => request.status === 'pending') ||
    Object.values(startupState.approvals || {}).some((approval) => approval.continuation?.status === 'dispatching')) {
    await commandService.recoverInterruptedRequests().catch((error) => logger?.warn?.('command recovery failed', { message: error.message }));
  }

  const maintenance = {
    timer: null,
    pending: null,
    ticks: 0,
    start() {
      const current = configService.get();
      if (this.timer || !['browse', 'comments', 'directMessages', 'diary', 'production', 'publishing', 'im'].some(key => current[key].enabled)) return;
      this.timer = setInterval(() => this.tick().catch(error => logger?.warn?.('journal maintenance failed', { code: error.code })), 1000);
      this.timer.unref?.();
    },
    async tick() {
      this.ticks += 1;
      // Every ~30s run the ordinary settled-record prune (F08/I11). Failures are
      // logged only; they must never stop archival or business settlement.
      if (this.ticks % 30 === 0) {
        try {
          await store.prune();
        } catch (error) {
          logger?.warn?.('store prune failed', { code: error.code, message: error.message });
        }
      }
      if (this.pending) return this.pending;
      this.pending = (async () => {
        const state = await store.getSnapshot();
        const instance = await store.getInstance();
        if (state.migration.phase !== 'active' || instance.status !== 'active' || state.checkpointFence) return { skipped: true };
        return journal.flush({ maxEvents: 2000 });
      })().finally(() => { this.pending = null; });
      return this.pending;
    },
    async stop() {
      clearInterval(this.timer);
      this.timer = null;
      await this.pending?.catch(() => {});
    }
  };

  const runtime = {
    maintenance,
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
      maintenance.start();
      const started = await coordinator.start();
      runtime.componentStatus.coordinator = {
        started: true,
        scheduler: started?.scheduler === true,
        schedulerDisabledByInstance: started?.schedulerDisabledByInstance === true,
        error: null
      };
      let im = null;
      let backup = null;
      try {
        backup = await backupScheduler.start();
        runtime.componentStatus.backup = { started: true, error: null };
      } catch (error) {
        backup = { started: false, error: { code: error.code, message: error.message } };
        runtime.componentStatus.backup = { started: false, error: { code: error.code, message: sanitizeErrorMessage(error.message) } };
      }
      const imConfig = configService.get().im;
      if (imConfig.enabled && imHost && imBridge) {
        try {
          im = await imBridge.start();
          runtime.componentStatus.im = { started: true, error: null };
        } catch (error) {
          im = { started: false, error: { code: error.code, message: error.message } };
          runtime.componentStatus.im = { started: false, error: { code: error.code, message: sanitizeErrorMessage(error.message) } };
        }
      } else {
        runtime.componentStatus.im = {
          started: false,
          enabled: imConfig.enabled,
          configured: Boolean(imHost),
          reason: !imConfig.enabled ? 'disabled' : !imHost ? 'host_not_provided' : 'module_unavailable',
          error: null
        };
      }
      return { ...started, im, backup };
    },
    /** Refresh runtime components after an accepted configuration change. */
    async refreshConfig(payload = {}) {
      const current = payload?.config || configService.get();
      const previous = payload?.previous || current;
      if (typeof agent?.reconfigure === 'function') {
        try {
          agent.reconfigure(current);
        } catch (error) {
          logger?.warn?.('agent reconfigure failed', { code: error.code, message: error.message });
        }
      }
      if (typeof client?.reconfigure === 'function') {
        try {
          client.reconfigure(current);
        } catch (error) {
          logger?.warn?.('client reconfigure failed', { code: error.code, message: error.message });
        }
      }
      const schedulerChanged = Boolean(previous?.scheduler?.enabled) !== Boolean(current?.scheduler?.enabled);
      if (schedulerChanged) {
        try {
          await coordinator.stop();
          if (current?.scheduler?.enabled === true) await coordinator.start();
        } catch (error) {
          logger?.warn?.('coordinator refresh failed', { code: error.code, message: error.message });
        }
        runtime.componentStatus.coordinator = {
          started: Boolean(coordinator.started),
          scheduler: Boolean(coordinator.timer),
          schedulerEnabled: current?.scheduler?.enabled === true,
          error: null
        };
      }
      const featureKeys = ['browse', 'comments', 'directMessages', 'diary', 'production', 'publishing', 'im'];
      const enabledChanged = featureKeys.some((key) => Boolean(previous?.[key]?.enabled) !== Boolean(current?.[key]?.enabled));
      if (enabledChanged) {
        await maintenance.stop();
        maintenance.start();
      }
      runtime.config = current;
      return { refreshed: true, schedulerChanged, enabledChanged };
    },
    async stop() {
      await maintenance.stop();
      const backup = await backupScheduler.stop().catch((error) => ({ stopped: false, error: error.message }));
      const coordinatorResult = await coordinator.stop();
      let im = null;
      try {
        im = imBridge ? await imBridge.stop() : { stopped: true, skipped: true };
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
      if (typeof unsubscribeConfigChange === 'function') unsubscribeConfigChange();
      await pendingConfigRefresh.catch(() => {});
      await maintenance.stop();
      await imBridge?.stop().catch(() => {});
      await backupScheduler.stop().catch(() => {});
      await coordinator.stop().catch(() => {});
      if (executionBackend) await executionBackend.close().catch(() => {});
      try {
        const instance = await store.getInstance();
        if (instance?.status === 'active') await journal.archiveAll();
      } catch {
        // Shutdown archival is best-effort; it must never block store close.
      }
      await store.close();
    }
  };
  runtime.componentStatus = { coordinator: null, backup: null, im: null };
  let unsubscribeConfigChange = null;
  let pendingConfigRefresh = Promise.resolve();
  if (typeof configService.onChange === 'function') {
    try {
      unsubscribeConfigChange = configService.onChange((event) => {
        pendingConfigRefresh = Promise.resolve(runtime.refreshConfig(event && typeof event === 'object' ? event : {}))
          .catch((error) => logger?.warn?.('config refresh failed', { code: error.code, message: error.message }));
        return pendingConfigRefresh;
      });
      runtime.awaitConfigRefresh = () => pendingConfigRefresh;
    } catch (error) {
      logger?.warn?.('config change subscription unavailable', { code: error.code, message: error.message });
    }
  } else {
    runtime.onConfigChanged = (event) => runtime.refreshConfig(event || {});
  }
  runtime.http = createHttpHandler(runtime);
  runtime.tools = createTools(runtime);
  runtime.status = async (principal) => {
    const status = await commandService.status(principal);
    let protection = { status: 'invalid', reason: 'unavailable' };
    let stateForStatus = null;
    try {
      stateForStatus = await store.getSnapshot();
      protection = await backupService.getProtection({
        kind: 'workspace',
        workspaceId: stateForStatus.workspaceId
      });
    } catch (error) {
      protection = { status: 'invalid', reason: error.code || 'BACKUP_INVALID' };
    }
    let credentialBinding = null;
    try {
      if (typeof credentials.describeBinding === 'function' && stateForStatus) {
        const binding = credentials.describeBinding(stateForStatus);
        credentialBinding = {
          bound: binding.bound === true,
          accountId: binding.accountId || null,
          verifiedAt: binding.verifiedAt || null,
          mismatch: binding.mismatch === true,
          credentialRevision: binding.credentialRevision ? 'recorded' : null
        };
      }
    } catch (error) {
      credentialBinding = { bound: false, mismatch: true, reason: error.code || 'CREDENTIAL_MISSING' };
    }
    const scheduler = await backupScheduler.status().catch((error) => ({
      configured: false,
      scheduleEnabled: false,
      started: false,
      lastError: { code: error.code || 'BACKUP_INVALID', message: sanitizeErrorMessage(error.message) }
    }));
    const currentConfig = configService.get();
    return {
      ...status,
      capacity: await store.capacityStatus(),
      credentials: credentialBinding,
      components: {
        coordinator: {
          started: Boolean(coordinator.started),
          schedulerEnabled: currentConfig.scheduler.enabled === true,
          timer: Boolean(coordinator.timer),
          ...(runtime.componentStatus.coordinator || {})
        },
        im: {
          enabled: currentConfig.im.enabled === true,
          configured: Boolean(imHost),
          moduleAvailable: Boolean(imBridge),
          started: Boolean(imBridge?.started),
          capabilities: imAdapter?.capabilities || null,
          ...(runtime.componentStatus.im || {})
        },
        execution: {
          local: { supported: true, active: executionBackend?.active ?? 0 },
          remote: { supported: false, reason: 'not_registered' }
        },
        production: {
          enabled: currentConfig.production.enabled === true,
          dryRun: currentConfig.production.dryRun === true
        },
        publishing: {
          enabled: currentConfig.publishing.enabled === true,
          dryRun: currentConfig.publishing.dryRun === true
        },
        migration: {
          available: typeof migration?.status === 'function',
          phase: status.migration?.phase || null
        },
        backup: {
          ...(runtime.componentStatus.backup || {}),
          scheduler
        }
      },
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

/**
 * Normalize the host-provided body. Accepts an already-parsed object, a raw
 * JSON string, or a Buffer; the 1MiB limit is enforced in all three shapes.
 */
export function normalizeRequestBody(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    const size = Buffer.byteLength(text);
    if (size > MAX_HTTP_BODY) throw new AppError('CONFIG_INVALID', 'request body exceeds 1MiB');
    if (text.trim() === '') return {};
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object') {
        throw new AppError('CONFIG_INVALID', 'request body must be a JSON object');
      }
      return parsed;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('CONFIG_INVALID', 'request body must be valid JSON');
    }
  }
  assertBodySize(raw);
  return raw;
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

/**
 * The compatibility /comments/approve route only converts comment approvals;
 * other approval actions must use /approvals/decide.
 */
async function assertApprovalRouteKind(runtime, approvalId, kind) {
  if (!runtime?.store || !approvalId) return;
  const state = await runtime.store.getSnapshot();
  const approval = state.approvals[approvalId];
  if (!approval) throw new AppError('APPROVAL_STALE', 'approval not found');
  const task = state.tasks[approval.taskId];
  if (!task) throw new AppError('APPROVAL_STALE', 'approval task not found');
  if (task.kind !== kind) {
    throw new AppError('CONFIG_INVALID', `this route only accepts ${kind} approvals`, {
      details: { reason: 'approval_kind_mismatch', approvalId, taskKind: task.kind }
    });
  }
}

export function createHttpHandler(runtime) {
  return async function handle(request) {
    try {
      const method = String(request.method || 'GET').toUpperCase();
      const pathname = normalizePath(request.url || request.path);
      const body = normalizeRequestBody(request.body);
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
        if (body.expectedRevision === undefined || body.expectedRevision === null) {
          throw new AppError('INPUT_REQUIRED', 'expectedRevision is required for configuration updates', {
            details: { reason: 'expected_revision_required' }
          });
        }
        const previous = runtime.configService.get();
        const updated = await runtime.configService.update(body.patch || body, {
          source: 'http',
          expectedRevision: body.expectedRevision
        });
        // onChange subscribers (when available) already refresh components; in
        // that case just await the pending refresh instead of doing it twice.
        if (typeof runtime.awaitConfigRefresh === 'function') {
          await runtime.awaitConfigRefresh();
        } else {
          await runtime.refreshConfig({ config: runtime.configService.get(), previous });
        }
        return { status: 200, body: updated };
      }
      if (method === 'POST' && pathname === '/run/browse') {
        const mode = explicitMode(body, { required: false, defaultMode: 'dry' });
        const result = await runtime.commandService.execute(
          envelope('browse.run', body.input || {}, mode),
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
        const mode = explicitMode(body);
        await assertApprovalRouteKind(runtime, body.approvalId, 'comment');
        const result = await runtime.commandService.execute(
          envelope(
            'approval.decide',
            { approvalId: body.approvalId, decision: body.decision, nonce: body.nonce },
            mode
          ),
          principal,
          { trusted: true, sourceKind: 'http', humanContext: trustedHumanContext }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/dm/send') {
        const mode = explicitMode(body);
        const result = await runtime.commandService.execute(
          envelope('dm.send', body.input || body, mode),
          principal,
          { trusted: true, sourceKind: 'http' }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/production') {
        const mode = explicitMode(body);
        const result = await runtime.commandService.execute(
          envelope('production.create', body.input || body, mode),
          principal,
          { trusted: true, sourceKind: 'http' }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/publish') {
        const mode = explicitMode(body);
        const result = await runtime.commandService.execute(
          envelope('publish.create', body.input || body, mode),
          principal,
          { trusted: true, sourceKind: 'http' }
        );
        return { status: 200, body: result };
      }
      if (method === 'POST' && pathname === '/approvals/decide') {
        const mode = explicitMode(body);
        const result = await runtime.commandService.execute(
          envelope(
            'approval.decide',
            { approvalId: body.approvalId, decision: body.decision, nonce: body.nonce },
            mode
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
          const mode = explicitMode(body);
          const result = await runtime.commandService.execute(
            envelope('task.resume', { taskId }, mode),
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
      const body = appError.toJSON();
      body.message = sanitizeErrorMessage(body.message);
      body.details = redactSecrets(body.details);
      return { status, body };
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
        if (input.mode === undefined) {
          throw new AppError('CONFIG_INVALID', 'mode is required and must be dry or go', {
            details: { reason: 'mode_required', action }
          });
        }
        if (!MODES.has(input.mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
        mode = input.mode;
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
 * Split the Cordis mount configuration from an optional embedded business
 * configuration. The mount `enabled` switch is consumed here only; it never
 * enables business features (SPEC §3.3).
 */
export function resolveMountConfig(ctx = {}) {
  const raw = ctx.config;
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    throw new AppError('CONFIG_INVALID', 'plugin mount config must be an object');
  }
  if (raw && raw.enabled === false) return { disabled: true, mountPresent: Boolean(raw) };
  const httpPrefix = raw?.httpPrefix;
  if (httpPrefix !== undefined && httpPrefix !== HTTP_PREFIX) {
    throw new AppError('CONFIG_INVALID', `httpPrefix must be ${HTTP_PREFIX}`, {
      details: { reason: 'http_prefix_mismatch' }
    });
  }
  if (raw?.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new AppError('CONFIG_INVALID', 'plugin mount enabled must be a boolean');
  }
  let businessConfig = null;
  if (ctx.businessConfig && typeof ctx.businessConfig === 'object' && ctx.businessConfig.schemaVersion === 1) {
    businessConfig = ctx.businessConfig;
  } else if (raw?.business && typeof raw.business === 'object' && raw.business.schemaVersion === 1) {
    businessConfig = raw.business;
  } else if (raw?.config && typeof raw.config === 'object' && raw.config.schemaVersion === 1) {
    businessConfig = raw.config;
  } else if (raw && raw.schemaVersion === 1 && raw.enabled === undefined && raw.httpPrefix === undefined) {
    businessConfig = raw;
  }
  return {
    disabled: false,
    enabled: raw?.enabled === undefined ? true : raw.enabled === true,
    httpPrefix: httpPrefix || HTTP_PREFIX,
    dataDir: ctx.dataDir || raw?.dataDir || null,
    businessConfig,
    mountPresent: Boolean(raw)
  };
}

/**
 * Establish a trusted request from host-provided trust services. Without a
 * host trust service the entry fails closed instead of trusting raw request
 * fields (SPEC §17.1).
 */
export async function establishTrustedRequest(ctx = {}, hostRequest = {}) {
  const sources = [ctx.connection, ctx.trust].filter((source) => source && (typeof source === 'object' || typeof source === 'function'));
  if (sources.length === 0) {
    throw new AppError('TRUST_UNAVAILABLE', 'host trust service is required for HTTP access', {
      details: { reason: 'host_trust_service_missing' }
    });
  }
  let rejection = null;
  for (const source of sources) {
    if (typeof source.requestRejection !== 'function') continue;
    const result = await source.requestRejection(hostRequest);
    if (result === undefined || result === null || result === false) continue;
    if (result?.rejected === true || typeof result === 'string') {
      rejection = typeof result === 'string' ? result : result.reason || 'request rejected by host trust service';
      break;
    }
  }
  if (rejection) {
    throw new AppError('TRUST_UNAVAILABLE', String(rejection));
  }
  let principal = hostRequest?.trustedContext?.trusted === true ? hostRequest.trustedContext.principal || null : null;
  let humanContext = hostRequest?.trustedHumanContext || null;
  for (const source of sources) {
    if (principal) break;
    if (typeof source.resolvePrincipal === 'function') {
      principal = await source.resolvePrincipal(hostRequest);
      continue;
    }
    if (typeof source.getPrincipal === 'function') {
      principal = await source.getPrincipal(hostRequest);
      continue;
    }
    if (typeof source.verifyRequest === 'function') {
      const verified = await source.verifyRequest(hostRequest);
      if (verified?.rejected === true) {
        throw new AppError('TRUST_UNAVAILABLE', verified.reason || 'host rejected the request');
      }
      if (verified?.trusted === true || verified?.principal) {
        principal = verified.principal || null;
        humanContext = humanContext || verified.humanContext || null;
      }
    }
  }
  if (!principal || typeof principal !== 'object' || !principal.id) {
    throw new AppError('TRUST_UNAVAILABLE', 'host could not establish a trusted principal', {
      details: { reason: 'trusted_principal_unavailable' }
    });
  }
  if (!humanContext) {
    for (const source of sources) {
      if (typeof source.resolveHumanContext === 'function') {
        humanContext = await source.resolveHumanContext(hostRequest, principal);
        if (humanContext) break;
      }
      if (typeof source.resolveHuman === 'function') {
        humanContext = await source.resolveHuman(hostRequest, principal);
        if (humanContext) break;
      }
    }
  }
  return {
    ...hostRequest,
    trustedContext: { trusted: true, principal, reason: 'host_verified' },
    trustedHumanContext: humanContext
  };
}

function errorResponse(error) {
  const appError = error instanceof AppError
    ? error
    : new AppError('DEPENDENCY_UNAVAILABLE', error?.message || String(error));
  const body = appError.toJSON();
  body.message = sanitizeErrorMessage(body.message);
  body.details = redactSecrets(body.details);
  return { status: appError.httpStatus, body };
}

/**
 * Cordis plugin entry. The host service names below are a deliberately thin
 * adapter contract; unsupported services are ignored rather than failing the
 * whole host. Trust for HTTP requests must be established through the host
 * `connection`/`trust` service; missing trust fails closed.
 */
export const plugin = {
  name: 'dsh-bili-unified',
  async apply(ctx = {}) {
    if (!ctx || typeof ctx !== 'object') return null;
    if (ctx.__biliUnifiedRuntime) return ctx.__biliUnifiedRuntime;
    const logger = ctx.logger || console;
    const mount = resolveMountConfig(ctx);
    if (mount.disabled) return null;
    let runtime = null;
    const factory = ctx.createRuntime || createRuntime;
    const shouldCreateRuntime = Boolean(mount.dataDir || mount.businessConfig || mount.mountPresent);
    if (shouldCreateRuntime) {
      runtime = await factory({
        dataDir: mount.dataDir,
        config: mount.businessConfig,
        env: ctx.env || process.env,
        humanVerifier: ctx.humanVerifier || null,
        imHost: ctx.imHost || null,
        logger
      });
      ctx.__biliUnifiedRuntime = runtime;
      await runtime.start();
    }
    const disposers = [];
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      for (const disposer of disposers.splice(0).reverse()) {
        if (typeof disposer !== 'function') continue;
        try {
          await disposer();
        } catch (error) {
          logger?.warn?.('plugin disposer failed', { code: error.code, message: sanitizeErrorMessage(error.message) });
        }
      }
      if (runtime) {
        try {
          await runtime.close();
        } catch (error) {
          logger?.warn?.('plugin close failed', { code: error.code, message: sanitizeErrorMessage(error.message) });
        }
      }
      ctx.__biliUnifiedRuntime = null;
    };
    if (runtime && typeof ctx.webServer?.registerHandler === 'function') {
      disposers.push(
        await ctx.webServer.registerHandler({
          prefix: mount.httpPrefix,
          handler: async (hostRequest) => {
            try {
              const trusted = await establishTrustedRequest(ctx, hostRequest || {});
              return await runtime.http(trusted);
            } catch (error) {
              return errorResponse(error);
            }
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
            sensitive: tool.sensitive === true,
            execute: (args, principal) => tool.execute(args, principal)
          })
        );
      }
    }
    if (typeof ctx.lifecycle?.onDispose === 'function') {
      const result = ctx.lifecycle.onDispose(dispose);
      if (typeof result === 'function') disposers.push(result);
    }
    return { runtime, dispose, mounted: runtime !== null, httpPrefix: mount.httpPrefix };
  }
};

export default plugin;
