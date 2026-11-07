import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { assertWritablePhase, computeInputHash, effectiveDryRun } from '../contracts.js';
import {
  deepClone,
  ensureWithin,
  getProcessStartMs,
  isProcessAlive,
  processStartIso,
  isSafeRelativePath,
  nowIso,
  pathExists,
  randomId,
  resolveInside,
  sha256Hex,
  truncateText
} from '../utils.js';
import {
  LOCAL_SLIDESHOW_PROFILE,
  defaultRunTool,
  loadLocalSlideshowProfile,
  preflightProfile,
  probeAudioDuration,
  validateLocalMedia,
  validateOutputSpec
} from '../production/profiles/local-slideshow.js';

export const PRODUCTION_STAGES = Object.freeze(['script', 'assets', 'voice', 'render', 'validate']);

export class ProductionModule {
  constructor({
    store,
    taskManager,
    configService,
    artifactStore,
    effectGateway,
    approvalService,
    journal,
    backend = null,
    backendFactory = null,
    profileLoader = loadLocalSlideshowProfile,
    preflight = preflightProfile,
    mediaValidator = validateLocalMedia,
    audioProbe = probeAudioDuration,
    runTool = defaultRunTool,
    paidProvider = null,
    now = () => new Date(),
    hooks = {},
    logger
  } = {}) {
    this.store = store;
    this.taskManager = taskManager;
    this.configService = configService;
    this.artifactStore = artifactStore;
    this.effectGateway = effectGateway;
    this.approvalService = approvalService;
    this.journal = journal;
    this.backend = backend;
    this.backendFactory = backendFactory;
    this.profileLoader = profileLoader;
    this.preflight = preflight;
    this.mediaValidator = mediaValidator;
    this.audioProbe = audioProbe;
    this.runTool = runTool;
    this.paidProvider = paidProvider;
    this.now = now;
    this.hooks = hooks;
    this.logger = logger;
  }

  _config() {
    return this.configService.get();
  }

  _backend() {
    if (this.backend) return this.backend;
    if (this.backendFactory) {
      this.backend = this.backendFactory();
      return this.backend;
    }
    throw new AppError('DEPENDENCY_UNAVAILABLE', 'local execution backend is not configured');
  }

  async _loadProfile(profileId = null) {
    const config = this._config();
    return this.profileLoader({
      profilesFile: config.production.profilesFile,
      profileId: profileId || config.production.profileId,
      config
    });
  }

  _limits(inputLimits, output) {
    const config = this._config();
    const limits = inputLimits || {};
    const wallTimeSec = limits.wallTimeSec ?? config.production.limits.wallTimeSec;
    if (!Number.isSafeInteger(wallTimeSec) || wallTimeSec < 1 || wallTimeSec > config.production.limits.wallTimeSec) {
      throw new AppError('BUDGET_EXCEEDED', 'wallTimeSec exceeds the configured limit');
    }
    const maxPaidCostMinor = limits.maxPaidCostMinor ?? config.production.limits.maxPaidCostMinor;
    if (!Number.isSafeInteger(maxPaidCostMinor) || maxPaidCostMinor < 0) {
      throw new AppError('BUDGET_EXCEEDED', 'maxPaidCostMinor must be a non-negative integer');
    }
    if (maxPaidCostMinor > config.production.limits.maxPaidCostMinor) {
      throw new AppError('BUDGET_EXCEEDED', 'maxPaidCostMinor exceeds the configured ceiling');
    }
    const currency = limits.currency || config.production.limits.currency;
    if (currency !== config.production.limits.currency) {
      throw new AppError('BUDGET_EXCEEDED', 'currency conversion is not supported');
    }
    if (maxPaidCostMinor > 0 && !this.paidProvider) {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'paid production provider is not configured');
    }
    return {
      wallTimeSec,
      maxPaidCostMinor,
      currency,
      maxOutputBytes: output.maxOutputBytes
    };
  }

  async _resolveInputs(inputs, principal) {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new AppError('INPUT_REQUIRED', 'inputs are required');
    const state = await this.store.getSnapshot();
    const artifacts = [];
    for (const entry of inputs) {
      if (!entry || typeof entry.artifactId !== 'string') {
        throw new AppError('INPUT_REQUIRED', 'every input needs an artifactId');
      }
      const record = state.artifacts[entry.artifactId];
      if (!record) throw new AppError('ARTIFACT_INVALID', `artifact ${entry.artifactId} is not imported`);
      if (entry.sha256 && entry.sha256 !== record.sha256) {
        throw new AppError('ARTIFACT_INVALID', 'input artifact hash does not match');
      }
      this.artifactStore.assertAccess(principal, record);
      await this.artifactStore.resolveManagedPath(record.artifactId, { verify: true });
      artifacts.push(record);
    }
    const byRole = (role) => artifacts.filter((artifact) => artifact.role === role);
    const scripts = byRole('script');
    const visuals = [...byRole('image'), ...byRole('clip')];
    const audio = byRole('audio');
    const subtitle = byRole('subtitle');
    if (scripts.length !== 1) throw new AppError('INPUT_REQUIRED', 'exactly one script artifact is required');
    if (visuals.length === 0) throw new AppError('INPUT_REQUIRED', 'at least one image or clip is required');
    if (audio.length > 1) throw new AppError('INPUT_REQUIRED', 'at most one audio artifact is supported');
    if (subtitle.length > 1) throw new AppError('INPUT_REQUIRED', 'at most one subtitle artifact is supported');
    const scriptPath = await this.artifactStore.resolveManagedPath(scripts[0].artifactId, { verify: true });
    const scriptText = await fsp.readFile(scriptPath.absolute, 'utf8');
    if (scriptText.trim() === '') throw new AppError('INPUT_REQUIRED', 'script artifact is empty');
    if (Buffer.byteLength(scriptText) > 1024 * 1024) {
      throw new AppError('INPUT_REQUIRED', 'script artifact exceeds 1MiB');
    }
    return { artifacts, script: scripts[0], visuals, audio: audio[0] || null, subtitle: subtitle[0] || null, scriptText };
  }

  async create(input, principal) {
    if (!principal?.id) throw new AppError('FORBIDDEN', 'production requires a trusted principal');
    if (!input || typeof input !== 'object') throw new AppError('CONFIG_INVALID', 'production input is required');
    if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
      throw new AppError('SCHEMA_UNSUPPORTED', 'production schemaVersion must be 1');
    }
    if (typeof input.requestId !== 'string' || input.requestId.trim() === '') {
      throw new AppError('CONFIG_INVALID', 'requestId is required');
    }
    if (!['dry', 'go'].includes(input.mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
    const config = this._config();
    if (input.output === undefined) throw new AppError('INPUT_REQUIRED', 'output spec is required');
    const profileId = input.profileId || config.production.profileId;
    const profile = await this._loadProfile(profileId);
    const output = validateOutputSpec(input.output, { profile, config });
    const resolved = await this._resolveInputs(input.inputs, principal);
    const limits = this._limits(input.limits, output);
    if (input.providerRefs && Object.keys(input.providerRefs).length > 0) {
      if (!this.paidProvider) throw new AppError('CAPABILITY_UNSUPPORTED', 'paid providers are not configured');
      if (limits.maxPaidCostMinor === 0) throw new AppError('BUDGET_EXCEEDED', 'paid provider requires a positive cost ceiling');
      const unknownProviders = Object.keys(input.providerRefs).filter((key) => key !== 'text');
      if (unknownProviders.length > 0) {
        throw new AppError('CAPABILITY_UNSUPPORTED', 'unsupported paid provider refs', {
          details: { refs: unknownProviders }
        });
      }
      const textRef = input.providerRefs.text;
      if (
        !textRef ||
        typeof textRef.providerId !== 'string' ||
        typeof textRef.budgetId !== 'string'
      ) {
        throw new AppError('INPUT_REQUIRED', 'providerRefs.text requires providerId and budgetId');
      }
      if (textRef.providerId !== this.paidProvider.id) {
        throw new AppError('CAPABILITY_UNSUPPORTED', 'paid provider id does not match the configured provider');
      }
    }
    const inputHash = computeInputHash({
      action: 'production.run',
      input: {
        brief: String(input.brief || ''),
        profileId,
        output,
        voiceMode: profile.voiceMode,
        limits
      },
      artifacts: resolved.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        sha256: artifact.sha256,
        role: artifact.role
      })),
      outputSpec: output,
      profileVersion: profile.version,
      target: { workspaceId: (await this.store.getSnapshot()).workspaceId },
      feeCapMinor: limits.maxPaidCostMinor
    });
    const effective = effectiveDryRun({ config, feature: 'production', invocationMode: input.mode });
    const blockedBy = [...new Set(profile.blocked || [])];
    if (!config.production.enabled) blockedBy.push('production_disabled');
    if (config.security.allowLocalProducer !== true) blockedBy.push('allowLocalProducer_false');
    if (!profile.bound) blockedBy.push('tools_not_bound');
    if (input.mode === 'go' && !effective.dryRun) {
      if (!config.production.enabled) throw new AppError('FEATURE_DISABLED', 'production is disabled');
      if (config.security.allowLocalProducer !== true) {
        throw new AppError('DEPENDENCY_UNAVAILABLE', 'security.allowLocalProducer is false');
      }
      const check = await this.preflight(profile, { runTool: this.runTool });
      if (!check.ok) {
        throw new AppError('DEPENDENCY_UNAVAILABLE', 'production profile is not ready', {
          details: { blockedBy: check.blockedBy, capability: 'production.local' }
        });
      }
    }
    const inputRecord = {
      requestId: input.requestId,
      brief: String(input.brief || ''),
      profileId,
      profileVersion: profile.version,
      output,
      limits,
      voiceMode: profile.voiceMode,
      artifactIds: resolved.artifacts.map((artifact) => artifact.artifactId),
      scriptArtifactId: resolved.script.artifactId,
      visualArtifactIds: resolved.visuals.map((artifact) => artifact.artifactId),
      audioArtifactId: resolved.audio?.artifactId || null,
      subtitleArtifactId: resolved.subtitle?.artifactId || null,
      providerRefs: input.providerRefs ? deepClone(input.providerRefs) : null
    };
    const creation = await this.store.transaction(async (draft, tx) => {
      tx.assertBusinessAcceptance();
      assertWritablePhase(draft);
      const task = this.taskManager.create(tx, {
        kind: 'production',
        principalId: principal.id,
        trigger: 'manual',
        sourceKind: principal.sourceKind,
        input: inputRecord,
        inputHash
      });
      task.stages = PRODUCTION_STAGES.map((stage) => ({
        stage,
        status: 'pending',
        attempts: 0,
        executionId: null,
        checkpoint: null,
        evidence: null,
        error: null,
        startedAt: null,
        finishedAt: null
      }));
      tx.appendEvent({
        type: 'production.task.created',
        actor: principal.id,
        taskId: task.id,
        payload: {
          profileId,
          profileVersion: profile.version,
          executionMode: effective.executionMode,
          blockedBy,
          inputHash
        }
      });
      if (input.mode === 'go' && !effective.dryRun) {
        this.taskManager.transition(tx, task, 'waiting_approval');
        const challenge = this.approvalService.create(tx, {
          task,
          action: 'production.run',
          inputHash,
          principalId: principal.id,
          ttlSec: config.im.approvalTtlSec,
          source: principal.sourceKind
        });
        task.input.approvalId = challenge.approval.id;
        return { task, challenge };
      }
      const plan = {
        profileId,
        profileVersion: profile.version,
        stages: PRODUCTION_STAGES,
        blockedBy,
        toolsBound: profile.bound,
        readyForPublish: false
      };
      this.taskManager.transition(tx, task, 'running', { actor: principal.id, reason: 'dry run preflight' });
      this.taskManager.transition(tx, task, 'succeeded', {
        actor: principal.id,
        reason: 'production dry run',
        result: { executionMode: 'dry', readyForPublish: false, blockedBy, plan }
      });
      return { task, challenge: null };
    });
    return {
      task: deepClone(creation.task),
      approval: creation.challenge?.approval || null,
      nonce: creation.challenge?.nonce || null,
      expiresAt: creation.challenge?.expiresAt || null,
      dryRun: effective.dryRun || input.mode === 'dry',
      executionMode: effective.executionMode,
      blockedBy,
      plan: {
        profileId,
        profileVersion: profile.version,
        stages: PRODUCTION_STAGES,
        blockedBy,
        toolsBound: profile.bound,
        readyForPublish: false
      }
    };
  }

  async run({ taskId, mode = 'go', principal = null }) {
    if (!['dry', 'go'].includes(mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
    const config = this._config();
    let state = await this.store.getSnapshot();
    let task = state.tasks[taskId];
    if (!task) throw new AppError('FORBIDDEN', 'production task not found');
    if (task.kind !== 'production') throw new AppError('INPUT_REQUIRED', 'task is not a production task');
    if (['succeeded', 'cancelled', 'failed', 'unknown'].includes(task.status)) {
      return { task: deepClone(task), skipped: true, executionMode: 'go' };
    }
    const effective = effectiveDryRun({ config, feature: 'production', invocationMode: mode });
    if (effective.dryRun) {
      return {
        task: deepClone(task),
        dryRun: true,
        executionMode: 'dry',
        blockedBy: effective.blockedBy,
        plan: { stages: PRODUCTION_STAGES, readyForPublish: false }
      };
    }
    if (task.status === 'waiting_approval') throw new AppError('APPROVAL_REQUIRED', 'production is waiting for human approval');
    if (!config.production.enabled) throw new AppError('FEATURE_DISABLED', 'production is disabled');
    if (config.security.allowLocalProducer !== true) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'security.allowLocalProducer is false');
    }
    if (task.input.approvalId) {
      this.approvalService.assertApproved(state, {
        taskId,
        action: 'production.run',
        inputHash: task.inputHash
      });
    } else {
      throw new AppError('APPROVAL_REQUIRED', 'production requires an approved challenge');
    }
    const profile = await this._loadProfile(task.input.profileId);
    if (profile.version !== task.input.profileVersion) {
      throw new AppError('APPROVAL_STALE', 'production profile version changed; re-approval is required');
    }
    const check = await this.preflight(profile, { runTool: this.runTool });
    if (!check.ok) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'production profile is not ready', {
        details: { blockedBy: check.blockedBy, capability: 'production.local' }
      });
    }
    if (task.status === 'queued') {
      await this.store.transaction(async (draft, tx) => {
        this.taskManager.transition(tx, draft.tasks[taskId], 'running', {
          approved: true,
          actor: principal?.id || 'system',
          reason: 'production approved and started'
        });
      });
    }
    if (task.status !== 'running') {
      throw new AppError('FORBIDDEN', `production task cannot run from ${task.status}`);
    }
    await this._executePipeline({ taskId, principal, profile });
    return { task: (await this.store.getSnapshot()).tasks[taskId], executionMode: 'go' };
  }

  async resume({ taskId, mode = 'go', principal }) {
    if (!['dry', 'go'].includes(mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
    const config = this._config();
    const effective = effectiveDryRun({ config, feature: 'production', invocationMode: mode });
    if (effective.dryRun) return { task: deepClone((await this.store.getSnapshot()).tasks[taskId]), dryRun: true, executionMode: 'dry' };
    if (!principal?.id) throw new AppError('FORBIDDEN', 'resume requires a trusted principal');
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task) throw new AppError('FORBIDDEN', 'production task not found');
    if (!['interrupted', 'failed', 'partial', 'unknown'].includes(task.status)) {
      throw new AppError('FORBIDDEN', `task status ${task.status} cannot be resumed`);
    }
    for (const executionId of task.executionIds || []) {
      const execution = state.executions[executionId];
      if (!execution || ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(execution.status)) continue;
      if (execution.ownerPid && isProcessAlive(execution.ownerPid)) {
        const actualStart = getProcessStartMs(execution.ownerPid);
        const recordedStart = Date.parse(execution.processStartedAt || '');
        const sameOwner =
          actualStart === null ||
          (Number.isFinite(recordedStart) && Math.abs(actualStart - recordedStart) <= 5000);
        if (sameOwner) {
          throw new AppError('OPERATION_UNKNOWN', 'previous execution may still be running');
        }
      }
    }
    const challenge = await this.store.transaction(async (draft, tx) => {
      const current = draft.tasks[taskId];
      for (const entry of current.stages || []) {
        if (entry.status === 'running') {
          entry.status = 'interrupted';
          entry.finishedAt = nowIso(this.now);
        }
      }
      this.taskManager.transition(tx, current, 'running', {
        manual: true,
        verified: true,
        actor: principal.id,
        reason: 'human resume verified old executions stopped'
      });
      current.attempts += 1;
      this.taskManager.transition(tx, current, 'waiting_approval', {
        actor: principal.id,
        reason: 'resume requires fresh approval'
      });
      const created = this.approvalService.create(tx, {
        task: current,
        action: 'production.run',
        inputHash: current.inputHash,
        principalId: principal.id,
        ttlSec: config.im.approvalTtlSec,
        source: principal.sourceKind
      });
      current.input.approvalId = created.approval.id;
      tx.appendEvent({
        type: 'production.resume.requested',
        actor: principal.id,
        taskId,
        payload: { approvalId: created.approval.id }
      });
      return created;
    });
    return {
      task: (await this.store.getSnapshot()).tasks[taskId],
      approval: challenge.approval,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      executionMode: 'go'
    };
  }

  async _executePipeline({ taskId, principal, profile }) {
    for (const stage of PRODUCTION_STAGES) {
      const state = await this.store.getSnapshot();
      const task = state.tasks[taskId];
      if (!task || ['succeeded', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(task.status)) {
        return;
      }
      if (task.cancelRequestedAt) {
        await this._cancelTask(taskId, 'cancel requested before stage');
        return;
      }
      const entry = (task.stages || []).find((item) => item.stage === stage);
      if (entry && ['succeeded', 'skipped'].includes(entry.status) && entry.checkpoint?.inputHash === task.inputHash) {
        continue;
      }
      try {
        const result = await this._runStage({ taskId, stage, principal, profile });
        if (result?.stop) return;
      } catch (error) {
        const outcome = error.code === 'OPERATION_UNKNOWN' ? 'unknown' : 'failed';
        await this._failStage(taskId, stage, error, outcome);
        return;
      }
    }
    const finalState = await this.store.getSnapshot();
    const task = finalState.tasks[taskId];
    if (task && task.status === 'running') {
      const incomplete = (task.stages || []).filter((entry) => !['succeeded', 'skipped'].includes(entry.status));
      if (incomplete.length > 0) {
        await this._failStage(taskId, incomplete[0].stage, new AppError('INPUT_REQUIRED', 'required stage did not complete'));
      } else {
        await this.store.transaction(async (draft, tx) => {
          const current = draft.tasks[taskId];
          this.taskManager.transition(tx, current, 'succeeded', {
            actor: 'system',
            reason: 'all required production stages completed',
            result: { readyForPublish: true }
          });
        });
      }
    }
  }

  _stageEntry(task, stage) {
    let entry = (task.stages || []).find((item) => item.stage === stage);
    if (!entry) {
      entry = {
        stage,
        status: 'pending',
        attempts: 0,
        executionId: null,
        checkpoint: null,
        evidence: null,
        error: null,
        startedAt: null,
        finishedAt: null
      };
      task.stages = [...(task.stages || []), entry];
    }
    return entry;
  }

  async _runStage({ taskId, stage, principal, profile }) {
    await this.store.transaction(async (draft, tx) => {
      const task = draft.tasks[taskId];
      if (task.cancelRequestedAt) throw new AppError('FORBIDDEN', 'task was cancelled');
      const entry = this._stageEntry(task, stage);
      entry.status = 'running';
      entry.attempts += 1;
      entry.startedAt = nowIso(this.now);
      entry.finishedAt = null;
      entry.error = null;
      task.executionActive = true;
      tx.appendEvent({
        type: 'production.stage.started',
        actor: principal?.id || 'system',
        taskId,
        payload: { stage, attempt: entry.attempts }
      });
    });
    let result;
    switch (stage) {
      case 'script':
        result = await this._stageScript({ taskId, profile });
        break;
      case 'assets':
        result = await this._stageAssets({ taskId });
        break;
      case 'voice':
        result = await this._stageVoice({ taskId, profile });
        break;
      case 'render':
        result = await this._stageRender({ taskId, profile, principal });
        break;
      case 'validate':
        result = await this._stageValidate({ taskId, profile, principal });
        break;
      default:
        throw new AppError('CAPABILITY_UNSUPPORTED', `unknown production stage ${stage}`);
    }
    const snapshot = await this.store.getSnapshot();
    const state = snapshot.tasks[taskId];
    if (result?.cancelled) {
      await this._cancelTask(taskId, result.reason || 'stage cancelled');
      return { stop: true };
    }
    if (result?.unknown) {
      await this._failStage(taskId, stage, result.error || new AppError('OPERATION_UNKNOWN', 'production stage unknown'), 'unknown');
      return { stop: true };
    }
    await this.store.transaction(async (draft, tx) => {
      const task = draft.tasks[taskId];
      const entry = this._stageEntry(task, stage);
      entry.status = result.skipped ? 'skipped' : 'succeeded';
      entry.checkpoint = result.checkpoint || null;
      entry.evidence = result.evidence || null;
      entry.finishedAt = nowIso(this.now);
      task.executionActive = false;
      if (result.finalize) await result.finalize(tx, task);
      tx.appendEvent({
        type: result.skipped ? 'production.stage.skipped' : 'production.stage.succeeded',
        actor: principal?.id || 'system',
        taskId,
        payload: {
          stage,
          attempt: entry.attempts,
          executionId: entry.executionId || null,
          checkpointHash: entry.checkpoint?.inputHash || null,
          evidence: entry.evidence || null
        }
      });
    });
    return { stop: false };
  }

  async _stageScript({ taskId, profile }) {
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    const scriptPath = await this.artifactStore.resolveManagedPath(task.input.scriptArtifactId, { verify: true });
    const text = (await fsp.readFile(scriptPath.absolute, 'utf8')).trim();
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    let providerResult = null;
    if (task.input.providerRefs?.text) {
      providerResult = await this._runPaidTextProvider({ task, text, profile });
    }
    return {
      checkpoint: {
        inputHash: task.inputHash,
        profileVersion: profile.version,
        scriptArtifactId: task.input.scriptArtifactId,
        paragraphs: paragraphs.slice(0, 100),
        paragraphCount: paragraphs.length,
        preferredDurationSec: task.input.output.maxDurationSec,
        providerText: providerResult ? truncateText(providerResult.text, 2000) : null,
        providerOperationId: providerResult?.operationId || null
      }
    };
  }

  async _stageAssets({ taskId }) {
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    const visuals = [];
    for (const artifactId of task.input.visualArtifactIds || []) {
      const artifact = await this.artifactStore.getArtifact(artifactId);
      if (!['image', 'clip'].includes(artifact.role)) {
        throw new AppError('ARTIFACT_INVALID', 'visual input must be an image or clip');
      }
      await this.artifactStore.resolveManagedPath(artifactId, { verify: true });
      visuals.push({
        artifactId,
        role: artifact.role,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes
      });
    }
    if (visuals.length === 0) throw new AppError('INPUT_REQUIRED', 'at least one visual is required');
    return {
      checkpoint: {
        inputHash: task.inputHash,
        profileVersion: task.input.profileVersion,
        visuals
      }
    };
  }

  _lastSubtitleTimestamp(text) {
    const matches = [...String(text).matchAll(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g)];
    let last = 0;
    for (const match of matches) {
      last = Math.max(last, Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000);
    }
    if (last === 0) {
      const short = [...String(text).matchAll(/(\d{2}):(\d{2})[,.](\d{3})/g)];
      for (const match of short) {
        last = Math.max(last, Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000);
      }
    }
    return last;
  }

  async _runPaidTextProvider({ task, text, profile }) {
    if (!this.paidProvider) throw new AppError('CAPABILITY_UNSUPPORTED', 'paid provider is not configured');
    const config = this._config();
    const ref = task.input.providerRefs.text;
    if (ref.providerId !== this.paidProvider.id) {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'paid provider id mismatch');
    }
    let quote;
    try {
      quote = await this.paidProvider.quote({
        taskId: task.id,
        brief: task.input.brief,
        providerRefs: task.input.providerRefs
      });
    } catch (error) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'paid provider quote failed', { cause: error });
    }
    const amountMinor = quote?.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new AppError('BUDGET_EXCEEDED', 'paid provider must return a finite integer amountMinor');
    }
    if (amountMinor > task.input.limits.maxPaidCostMinor) {
      throw new AppError('BUDGET_EXCEEDED', 'paid provider quote exceeds the authorized cost ceiling');
    }
    const currency = quote?.currency || config.production.limits.currency;
    if (currency !== config.production.limits.currency) {
      throw new AppError('BUDGET_EXCEEDED', 'paid provider currency conversion is not supported');
    }
    const stageEntry = task.stages.find((entry) => entry.stage === 'script');
    const attempt = stageEntry?.attempts || 1;
    const businessKey = `production-provider:${task.id}:text:${attempt}`;
    let generatedText = null;
    let receipt = null;
    const reserved = await this.effectGateway.reserveOperation({
      namespace: 'provider',
      action: 'provider_call',
      receiptAction: 'provider_call',
      recoveryAction: 'provider_call',
      accountRef: null,
      businessKey,
      taskIds: [task.id],
      inputHash: task.inputHash,
      approvalId: task.input.approvalId || null,
      approvalAction: 'production.run',
      protected: true,
      budget: {
        provider: ref.providerId,
        budgetId: ref.budgetId,
        currency,
        amountMinor,
        capMinor: task.input.limits.maxPaidCostMinor
      },
      metadata: { stage: 'script', providerRefs: task.input.providerRefs }
    });
    if (reserved.deduplicated && ['confirmed', 'unknown', 'dispatching'].includes(reserved.operation.status)) {
      return {
        text: reserved.operation.metadata?.providerText || '',
        operationId: reserved.operation.id
      };
    }
    const dispatched = await this.effectGateway.dispatchOperation(
      reserved.operation.id,
      async (operationContext) => {
        const generated = await this.paidProvider.generateText({
          taskId: task.id,
          brief: task.input.brief,
          scriptText: text,
          providerRefs: task.input.providerRefs,
          operationContext
        });
        if (!generated || typeof generated.text !== 'string' || generated.text.trim() === '') {
          throw new AppError('OPERATION_UNKNOWN', 'paid provider returned no text');
        }
        generatedText = generated.text;
        receipt =
          generated.receipt ||
          makeReceipt({
            platform: 'provider',
            accountId: ref.providerId,
            action: 'provider_call',
            externalId: generated.externalId || `provider_${reserved.operation.id}`,
            url: null,
            verification: 'publisher_receipt',
            receivedAt: nowIso(this.now)
          });
        return { status: 'confirmed', receipt };
      }
    );
    if (dispatched.operation.status === 'unknown') {
      throw new AppError('OPERATION_UNKNOWN', 'paid provider result is unknown');
    }
    if (dispatched.operation.status !== 'confirmed') {
      throw new AppError(
        dispatched.operation.error?.code || 'DEPENDENCY_UNAVAILABLE',
        dispatched.operation.error?.message || 'paid provider call failed'
      );
    }
    return { text: generatedText || '', operationId: dispatched.operation.id };
  }

  async _stageVoice({ taskId, profile }) {
    const config = this._config();
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    let durationSec = task.input.output.maxDurationSec;
    let audioDurationSec = null;
    let audioPath = null;
    if (task.input.audioArtifactId) {
      const resolved = await this.artifactStore.resolveManagedPath(task.input.audioArtifactId, { verify: true });
      audioPath = resolved.absolute;
      if (!profile.bound) {
        // Audio probing requires the trusted ffprobe; dry preflight never reaches here.
        throw new AppError('DEPENDENCY_UNAVAILABLE', 'ffprobe is not bound in the local profile');
      }
      const probed = await this.audioProbe({
        ffprobe: profile.tools.ffprobe,
        file: audioPath,
        runTool: this.runTool,
        timeoutMs: Math.min(config.rateLimit.requestTimeoutMs, 120000)
      });
      audioDurationSec = probed.durationSec;
      durationSec = Math.min(task.input.output.maxDurationSec, Math.max(1, probed.durationSec));
    } else if (profile.voiceMode === 'required') {
      throw new AppError('INPUT_REQUIRED', 'this profile requires a voice/audio input');
    }
    let subtitlePath = null;
    if (task.input.subtitleArtifactId) {
      const resolved = await this.artifactStore.resolveManagedPath(task.input.subtitleArtifactId, { verify: true });
      subtitlePath = resolved.absolute;
      const text = await fsp.readFile(subtitlePath, 'utf8');
      if (text.trim() === '') throw new AppError('INPUT_REQUIRED', 'subtitle artifact is empty');
      const last = this._lastSubtitleTimestamp(text);
      if (last > durationSec + 1) {
        throw new AppError('INPUT_REQUIRED', 'subtitle timestamps exceed the planned video duration');
      }
    }
    const skipped = !task.input.audioArtifactId;
    return {
      skipped,
      evidence: skipped
        ? { reason: 'no_audio_provided', profileVoiceMode: profile.voiceMode, allowed: true }
        : null,
      checkpoint: {
        inputHash: task.inputHash,
        profileVersion: profile.version,
        audioArtifactId: task.input.audioArtifactId,
        audioDurationSec,
        subtitleArtifactId: task.input.subtitleArtifactId,
        durationSec,
        voiceSkipped: skipped,
        voiceEvidence: skipped
          ? { reason: 'no_audio_provided', profileVoiceMode: profile.voiceMode }
          : null
      }
    };
  }

  async _stageRender({ taskId, profile, principal }) {
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!profile.bound) throw new AppError('DEPENDENCY_UNAVAILABLE', 'ffmpeg/ffprobe are not bound');
    const assets = task.stages.find((entry) => entry.stage === 'assets')?.checkpoint;
    const voice = task.stages.find((entry) => entry.stage === 'voice')?.checkpoint;
    if (!assets || !voice) throw new AppError('INPUT_REQUIRED', 'assets/voice checkpoints are missing');
    const visuals = assets.visuals;
    if (!visuals.length) throw new AppError('INPUT_REQUIRED', 'no visual segments');
    const durationSec = Number(voice.durationSec) || task.input.output.maxDurationSec;
    const segBase = Math.floor((durationSec / visuals.length) * 1000) / 1000;
    const segments = [];
    for (let index = 0; index < visuals.length; index += 1) {
      const visual = visuals[index];
      const resolved = await this.artifactStore.resolveManagedPath(visual.artifactId, { verify: true });
      const segmentDuration =
        index === visuals.length - 1
          ? Number((durationSec - segBase * (visuals.length - 1)).toFixed(3))
          : segBase;
      segments.push({
        type: visual.role === 'image' ? 'image' : 'clip',
        path: resolved.absolute,
        startSec: 0,
        durationSec: segmentDuration
      });
    }
    const audioPath = voice.audioArtifactId
      ? (await this.artifactStore.resolveManagedPath(voice.audioArtifactId, { verify: true })).absolute
      : null;
    const subtitlePath = voice.subtitleArtifactId
      ? (await this.artifactStore.resolveManagedPath(voice.subtitleArtifactId, { verify: true })).absolute
      : null;
    const executionId = randomId('exec');
    const attempt =
      Object.values(state.executions).filter((exec) => exec.taskId === taskId && exec.stageId === 'render').length + 1;
    const workDirRel = path.posix.join(taskId, executionId);
    const workDir = resolveInside(this.artifactStore.workDir, workDirRel);
    await fsp.mkdir(workDir, { recursive: true });
    const stageRequest = {
      executionId,
      taskId,
      stageId: 'render',
      attempt,
      inputHash: task.inputHash,
      profileId: profile.id,
      profile: { id: profile.id, version: profile.version },
      tools: { ffmpeg: profile.tools.ffmpeg, ffprobe: profile.tools.ffprobe },
      workDir,
      allowedInputRoots: [this.artifactStore.rootDir, this.artifactStore.workDir],
      limits: { wallTimeSec: task.input.limits.wallTimeSec },
      plan: {
        width: task.input.output.width,
        height: task.input.output.height,
        fps: task.input.output.fps,
        durationSec,
        segments,
        audioPath,
        subtitlePath,
        videoFile: 'render.mp4',
        coverFile: 'cover.jpg',
        maxOutputBytes: task.input.limits.maxOutputBytes
      }
    };
    await this.store.transaction(async (draft, tx) => {
      this.effectGateway.assertLocalDispatchInTransaction(tx, { capability: 'production:local' });
      const current = draft.tasks[taskId];
      if (current.cancelRequestedAt) throw new AppError('FORBIDDEN', 'task was cancelled');
      const entry = this._stageEntry(current, 'render');
      entry.executionId = executionId;
      current.executionIds.push(executionId);
      current.attempts += 1;
      draft.executions[executionId] = {
        executionId,
        taskId,
        stageId: 'render',
        attempt,
        status: 'accepted',
        inputHash: task.inputHash,
        profileId: profile.id,
        profileVersion: profile.version,
        historyEpoch: draft.historyEpoch,
        eventSeq: draft.eventSeq,
        workDirRel,
        ownerPid: process.pid,
        processStartedAt: processStartIso(),
        createdAt: nowIso(this.now),
        startedAt: nowIso(this.now),
        finishedAt: null,
        seq: 0,
        outputs: null,
        error: null
      };
      tx.appendEvent({
        type: 'production.execution.persisted',
        actor: principal?.id || 'system',
        taskId,
        payload: { executionId, stage: 'render', attempt }
      });
    });
    const backend = this._backend();
    let final;
    try {
      await backend.submit(stageRequest);
      final = await backend.wait(executionId);
    } catch (error) {
      await this.store.transaction(async (draft, tx) => {
        const execution = draft.executions[executionId];
        if (execution) {
          execution.status = 'failed';
          execution.error = { code: error.code || 'DEPENDENCY_UNAVAILABLE', message: truncateText(error.message, 500) };
          execution.finishedAt = nowIso(this.now);
        }
        const taskEntry = this._stageEntry(draft.tasks[taskId], 'render');
        taskEntry.error = execution?.error || null;
        tx.appendEvent({
          type: 'production.execution.failed',
          actor: 'system',
          taskId,
          payload: { executionId, code: error.code || 'DEPENDENCY_UNAVAILABLE' }
        });
      });
      throw error;
    }
    await this.store.transaction(async (draft, tx) => {
      const execution = draft.executions[executionId];
      if (execution) {
        execution.status = final.status;
        execution.seq = final.seq;
        execution.outputs = final.outputs || null;
        execution.error = final.error || null;
        execution.finishedAt = final.finishedAt || nowIso(this.now);
        execution.exitCode = final.exitCode ?? null;
      }
      const current = draft.tasks[taskId];
      const entry = this._stageEntry(current, 'render');
      entry.error = final.error || null;
      tx.appendEvent({
        type: `production.execution.${final.status}`,
        actor: 'system',
        taskId,
        payload: { executionId, status: final.status, seq: final.seq }
      });
    });
    if (final.status === 'succeeded') {
      // Verify the runner's manifest is structurally honest before recording it.
      const outputs = final.outputs || {};
      if (!isSafeRelativePath(outputs.video || 'render.mp4') || !isSafeRelativePath(outputs.cover || 'cover.jpg')) {
        throw new AppError('ARTIFACT_INVALID', 'runner output paths are unsafe');
      }
      return {
        checkpoint: {
          inputHash: task.inputHash,
          profileVersion: profile.version,
          executionId,
          workDirRel,
          videoRel: outputs.video || 'render.mp4',
          coverRel: outputs.cover || 'cover.jpg',
          durationSec,
          hasAudio: Boolean(audioPath),
          hasSubtitle: Boolean(subtitlePath)
        }
      };
    }
    if (final.status === 'cancelled') return { cancelled: true, reason: 'render cancelled' };
    if (final.status === 'unknown') {
      return { unknown: true, error: final.error || new AppError('OPERATION_UNKNOWN', 'render execution unknown') };
    }
    throw new AppError('DEPENDENCY_UNAVAILABLE', final.error?.message || 'render execution failed');
  }

  async _stageValidate({ taskId, profile, principal }) {
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    const render = task.stages.find((entry) => entry.stage === 'render')?.checkpoint;
    if (!render) throw new AppError('INPUT_REQUIRED', 'render checkpoint is missing');
    if (!isSafeRelativePath(render.workDirRel)) throw new AppError('ARTIFACT_INVALID', 'render workDir is unsafe');
    const workDir = resolveInside(this.artifactStore.workDir, render.workDirRel);
    const videoFile = resolveInside(workDir, render.videoRel);
    const coverFile = resolveInside(workDir, render.coverRel);
    const result = await this.mediaValidator({
      ffmpeg: profile.tools.ffmpeg,
      ffprobe: profile.tools.ffprobe,
      workDir,
      videoFile,
      coverFile,
      expected: {
        width: task.input.output.width,
        height: task.input.output.height,
        fps: task.input.output.fps,
        durationSec: render.durationSec,
        audioPath: render.hasAudio,
        subtitlePath: render.hasSubtitle,
        maxOutputBytes: task.input.limits.maxOutputBytes
      },
      runTool: this.runTool
    });
    if (!result?.ok) throw new AppError('ARTIFACT_INVALID', 'media validation failed');
    const systemPrincipal = {
      id: 'system',
      kind: 'system',
      sourceKind: 'system',
      workspaceId: state.workspaceId,
      scopes: [],
      revokedAt: null
    };
    const video = await this.artifactStore.importManagedOutput({
      sourcePath: videoFile,
      role: 'video',
      principal: systemPrincipal
    });
    const cover = await this.artifactStore.importManagedOutput({
      sourcePath: coverFile,
      role: 'cover',
      principal: systemPrincipal
    });
    const manifest = {
      schemaVersion: 1,
      profileId: profile.id,
      profileVersion: profile.version,
      inputHash: task.inputHash,
      stages: (task.stages || []).map((entry) => ({
        stage: entry.stage,
        status: entry.stage === 'validate' ? 'succeeded' : entry.status,
        skipped: entry.status === 'skipped',
        executionId: entry.executionId || null,
        checkpointHash: entry.checkpoint?.inputHash || null
      })),
      artifacts: {
        video: { artifactId: video.artifactId, sha256: video.sha256, role: 'video' },
        cover: { artifactId: cover.artifactId, sha256: cover.sha256, role: 'cover' }
      },
      media: result.media,
      validatedAt: nowIso(this.now)
    };
    return {
      checkpoint: {
        inputHash: task.inputHash,
        profileVersion: profile.version,
        videoArtifactId: video.artifactId,
        coverArtifactId: cover.artifactId,
        videoSha256: video.sha256,
        coverSha256: cover.sha256,
        media: result.media,
        manifestHash: sha256Hex(JSON.stringify(manifest))
      },
      finalize: (tx, current) => {
        tx.state.productions[taskId] = {
          id: `prod_${taskId}`,
          taskId,
          workspaceId: tx.workspaceId,
          profileId: profile.id,
          profileVersion: profile.version,
          inputHash: task.inputHash,
          status: 'succeeded',
          readyForPublish: true,
          artifacts: manifest.artifacts,
          media: result.media,
          manifest,
          createdAt: tx.state.productions[taskId]?.createdAt || nowIso(this.now),
          finishedAt: nowIso(this.now)
        };
        this.taskManager.transition(tx, current, 'succeeded', {
          actor: principal?.id || 'system',
          reason: 'real media validated; ready for independent publish approval',
          result: {
            readyForPublish: true,
            videoArtifactId: video.artifactId,
            coverArtifactId: cover.artifactId,
            media: result.media,
            manifestHash: sha256Hex(JSON.stringify(manifest))
          }
        });
      }
    };
  }

  async _failStage(taskId, stage, error, outcome = 'failed') {
    await this.store.transaction(async (draft, tx) => {
      const task = draft.tasks[taskId];
      if (!task) return;
      const entry = this._stageEntry(task, stage);
      entry.status = outcome;
      entry.error = {
        code: error.code || 'DEPENDENCY_UNAVAILABLE',
        message: truncateText(error.message || String(error), 500),
        blockedBy: error.details?.blockedBy || null
      };
      entry.finishedAt = nowIso(this.now);
      task.executionActive = false;
      task.result = {
        ...(task.result || {}),
        readyForPublish: false,
        failedStage: stage,
        error: entry.error
      };
      draft.productions[taskId] = {
        ...(draft.productions[taskId] || {
          id: `prod_${taskId}`,
          taskId,
          workspaceId: draft.workspaceId,
          profileId: task.input.profileId,
          profileVersion: task.input.profileVersion,
          inputHash: task.inputHash,
          createdAt: nowIso(this.now)
        }),
        status: outcome,
        readyForPublish: false,
        error: entry.error,
        finishedAt: nowIso(this.now)
      };
      try {
        if (outcome === 'unknown') {
          this.taskManager.transition(tx, task, 'unknown', {
            verified: true,
            actor: 'system',
            reason: `production stage ${stage} unknown`,
            error: entry.error
          });
        } else if (task.status === 'running') {
          this.taskManager.transition(tx, task, 'failed', {
            actor: 'system',
            reason: `production stage ${stage} failed`,
            error: entry.error
          });
        }
      } catch (transitionError) {
        entry.transitionError = transitionError.message;
      }
      tx.appendEvent({
        type: outcome === 'unknown' ? 'production.stage.unknown' : 'production.stage.failed',
        actor: 'system',
        taskId,
        payload: { stage, code: entry.error.code, blockedBy: entry.error.blockedBy }
      });
    });
  }

  async _cancelTask(taskId, reason) {
    await this.store.transaction(async (draft, tx) => {
      const task = draft.tasks[taskId];
      if (!task || ['succeeded', 'cancelled'].includes(task.status)) return;
      for (const entry of task.stages || []) {
        if (entry.status === 'running') {
          entry.status = 'cancelled';
          entry.finishedAt = nowIso(this.now);
        }
      }
      task.executionActive = false;
      if (task.status === 'running' || task.status === 'queued') {
        this.taskManager.transition(tx, task, 'cancelled', {
          provenUndispatched: true,
          actor: 'local_human',
          reason,
          result: { ...(task.result || {}), readyForPublish: false }
        });
      }
      draft.productions[taskId] = {
        ...(draft.productions[taskId] || {
          id: `prod_${taskId}`,
          taskId,
          workspaceId: draft.workspaceId,
          inputHash: task.inputHash,
          createdAt: nowIso(this.now)
        }),
        status: 'cancelled',
        readyForPublish: false,
        finishedAt: nowIso(this.now)
      };
      tx.appendEvent({
        type: 'production.cancelled',
        actor: 'local_human',
        taskId,
        payload: { reason }
      });
    });
  }

  async cancel({ taskId, principal }) {
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task) throw new AppError('FORBIDDEN', 'production task not found');
    await this.store.transaction(async (draft, tx) => {
      const current = draft.tasks[taskId];
      this.taskManager.requestCancel(tx, current, { reason: 'human cancel request', actor: principal?.id || 'local_human' });
      tx.appendEvent({ type: 'production.cancel.requested', actor: principal?.id || 'local_human', taskId, payload: {} });
    });
    for (const executionId of task.executionIds || []) {
      const execution = state.executions[executionId];
      if (execution && ['accepted', 'running', 'cancel_requested'].includes(execution.status)) {
        if (this.backend?.cancel) await this.backend.cancel(executionId);
      }
    }
    return { task: (await this.store.getSnapshot()).tasks[taskId], cancelRequested: true };
  }

  async recoverInterrupted() {
    const state = await this.store.getSnapshot();
    const affected = new Set();
    await this.store.transaction(async (draft, tx) => {
      for (const execution of Object.values(draft.executions)) {
        if (!['accepted', 'running', 'cancel_requested'].includes(execution.status)) continue;
        let ownerAlive = false;
        if (execution.ownerPid && isProcessAlive(execution.ownerPid)) {
          const actualStart = getProcessStartMs(execution.ownerPid);
          const recordedStart = Date.parse(execution.processStartedAt || '');
          // On platforms without process start-time inspection, a live PID is
          // conservatively treated as the owner rather than stolen.
          ownerAlive =
            actualStart === null ||
            (Number.isFinite(recordedStart) && Math.abs(actualStart - recordedStart) <= 5000);
        }
        if (ownerAlive) continue;
        execution.status = 'interrupted';
        execution.finishedAt = nowIso(this.now);
        execution.error = { code: 'DEPENDENCY_UNAVAILABLE', message: 'execution owner disappeared' };
        affected.add(execution.taskId);
        tx.appendEvent({
          type: 'production.execution.interrupted',
          actor: 'system',
          taskId: execution.taskId,
          payload: { executionId: execution.executionId }
        });
      }
      for (const taskId of affected) {
        const task = draft.tasks[taskId];
        if (!task || task.kind !== 'production') continue;
        for (const entry of task.stages || []) {
          if (entry.status === 'running') entry.status = 'interrupted';
        }
        task.executionActive = false;
        if (task.status === 'running') {
          try {
            this.taskManager.transition(tx, task, 'interrupted', {
              actor: 'system',
              reason: 'local execution owner disappeared'
            });
          } catch {
            // keep the historical state if it cannot transition safely
          }
        }
        if (draft.productions[taskId]) draft.productions[taskId].readyForPublish = false;
        task.result = { ...(task.result || {}), readyForPublish: false };
      }
    });
    return { affected: [...affected] };
  }

  async getStatus(taskId) {
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task) throw new AppError('FORBIDDEN', 'production task not found');
    return {
      taskId,
      status: task.status,
      isSettled: task.isSettled,
      stages: deepClone(task.stages || []),
      production: deepClone(state.productions[taskId] || null)
    };
  }
}

export default ProductionModule;
