import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';
import {
  assertAccountRef,
  assertArtifactRef,
  assertWritablePhase,
  assertReceipt,
  computeInputHash,
  computeMetadataHash,
  effectiveDryRun,
  makeReceipt
} from '../contracts.js';
import {
  deepClone,
  ensureDir,
  isSafeRelativePath,
  jcsHash,
  nowIso,
  pathExists,
  processStartIso,
  randomId,
  resolveInside,
  sha256Hex,
  truncateText
} from '../utils.js';

const execFileAsync = promisify(execFile);
const BV_PATTERN = /^BV[0-9A-Za-z]{6,32}$/;

export class PublisherModule {
  constructor({
    store,
    taskManager,
    approvalService,
    humanProof,
    artifactStore,
    configService,
    effectGateway,
    now = () => new Date(),
    logger,
    hooks = {}
  } = {}) {
    this.store = store;
    this.taskManager = taskManager;
    this.approvalService = approvalService;
    this.humanProof = humanProof;
    this.artifactStore = artifactStore;
    this.configService = configService;
    this.effectGateway = effectGateway;
    this.now = now;
    this.logger = logger;
    this.hooks = hooks;
  }

  _config() {
    return this.configService.get();
  }

  async _activeAccount(accountRef) {
    const state = await this.store.getSnapshot();
    assertAccountRef(accountRef);
    if (
      !state.activeAccountRef ||
      state.activeAccountRef.platform !== accountRef.platform ||
      state.activeAccountRef.accountId !== accountRef.accountId
    ) {
      throw new AppError('IDENTITY_UNVERIFIED', 'publish account does not match the active verified account');
    }
    return state.accounts[`${accountRef.platform}:${accountRef.accountId}`];
  }

  _providerVersion(provider) {
    const config = this._config();
    if (provider === 'manual') return 'manual-v1';
    return sha256Hex(
      JSON.stringify({
        provider: 'external',
        command: config.publishing.external.command,
        args: config.publishing.external.args,
        timeoutMs: config.publishing.external.timeoutMs,
        successJson: config.publishing.external.successJson
      })
    );
  }

  _validateMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') throw new AppError('PUBLISH_INPUT_INVALID', 'metadata is required');
    if (typeof metadata.title !== 'string' || metadata.title.trim() === '' || metadata.title.length > 80) {
      throw new AppError('PUBLISH_INPUT_INVALID', 'title must be 1..80 characters');
    }
    const description = metadata.description === undefined ? '' : String(metadata.description);
    if (description.length > 2000) throw new AppError('PUBLISH_INPUT_INVALID', 'description exceeds 2000 characters');
    const tags = metadata.tags === undefined ? [] : metadata.tags;
    if (!Array.isArray(tags) || tags.length > 12 || !tags.every((tag) => typeof tag === 'string' && tag.length <= 20)) {
      throw new AppError('PUBLISH_INPUT_INVALID', 'tags must be at most 12 strings of 20 characters');
    }
    const platformData = metadata.platformData === undefined ? {} : metadata.platformData;
    if (metadata.platformData !== undefined && (typeof platformData !== 'object' || Array.isArray(platformData))) {
      throw new AppError('PUBLISH_INPUT_INVALID', 'metadata.platformData must be an object');
    }
    if (platformData.tid !== undefined && (!Number.isSafeInteger(platformData.tid) || platformData.tid <= 0)) {
      throw new AppError('PUBLISH_INPUT_INVALID', 'platformData.tid must be a positive integer');
    }
    return {
      title: metadata.title.trim(),
      description: description.trim(),
      tags: [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))],
      platformData: deepClone(platformData)
    };
  }

  async create(input, principal) {
    if (!input || typeof input !== 'object') throw new AppError('PUBLISH_INPUT_INVALID', 'publish input is required');
    if (!['dry', 'go'].includes(input.mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
    const config = this._config();
    const account = await this._activeAccount(input.accountRef);
    const metadata = this._validateMetadata(input.metadata);
    const provider = input.provider || config.publishing.provider;
    if (!['manual', 'external'].includes(provider)) throw new AppError('CONFIG_INVALID', 'provider must be manual or external');
    if (provider === 'external') {
      if (!config.security.allowExternalPublisher) {
        throw new AppError('EXTERNAL_PUBLISH_DISABLED', 'external publisher is not allowed');
      }
      if (!config.publishing.external.command) {
        throw new AppError('EXTERNAL_PUBLISH_DISABLED', 'external publisher command is not configured');
      }
      if (!config.publishing.external.successJson) {
        throw new AppError('CAPABILITY_UNSUPPORTED', 'external publisher has no verified receipt protocol');
      }
    }
    const video = await this.artifactStore.verify(input.videoArtifactId, { principal });
    if (video.role !== 'video') throw new AppError('PUBLISH_INPUT_INVALID', 'videoArtifactId must have role video');
    if (video.sizeBytes > config.security.maxUploadBytes) {
      throw new AppError('PUBLISH_INPUT_INVALID', 'video exceeds maxUploadBytes');
    }
    let cover = null;
    if (input.coverArtifactId) {
      cover = await this.artifactStore.verify(input.coverArtifactId, { principal });
      if (cover.role !== 'cover') throw new AppError('PUBLISH_INPUT_INVALID', 'coverArtifactId must have role cover');
    }
    if (input.productionTaskId) {
      const state = await this.store.getSnapshot();
      const production = state.productions[input.productionTaskId];
      if (!production || production.readyForPublish !== true || production.status !== 'succeeded') {
        throw new AppError('PUBLISH_INPUT_INVALID', 'source production is not ready for publish');
      }
      if (production.artifacts?.video?.artifactId !== video.artifactId) {
        throw new AppError('PUBLISH_INPUT_INVALID', 'publish video does not match the production artifact');
      }
      if (cover && production.artifacts?.cover?.artifactId !== cover.artifactId) {
        throw new AppError('PUBLISH_INPUT_INVALID', 'publish cover does not match the production artifact');
      }
    }
    const providerVersion = this._providerVersion(provider);
    const target = {
      platform: account.accountRef.platform,
      accountId: account.accountRef.accountId
    };
    const metadataHash = computeMetadataHash({
      videoSha256: video.sha256,
      coverSha256: cover?.sha256 || null,
      target,
      metadata,
      providerVersion
    });
    const businessKey = `publish:${target.platform}:${target.accountId}:${video.sha256}:${metadataHash}`;
    const inputHash = computeInputHash({
      action: 'publish',
      input: {
        videoArtifactId: video.artifactId,
        coverArtifactId: cover?.artifactId || null,
        accountRef: target,
        metadata,
        provider
      },
      artifacts: [
        { artifactId: video.artifactId, sha256: video.sha256, role: 'video' },
        ...(cover ? [{ artifactId: cover.artifactId, sha256: cover.sha256, role: 'cover' }] : [])
      ],
      target,
      metadata,
      providerVersion,
      outputSpec: { provider }
    });
    const state = await this.store.getSnapshot();
    const existing = Object.values(state.publishes).find(
      (publish) =>
        publish.businessKey === businessKey &&
        !publish.archived &&
        !(publish.status === 'dry_run' && state.tasks[publish.taskId]?.result?.executionMode === 'dry')
    );
    if (existing) {
      const existingTask = state.tasks[existing.taskId];
      if (existingTask && !['succeeded', 'cancelled', 'failed'].includes(existingTask.status)) {
        let challenge = null;
        if (existingTask.status === 'waiting_approval') {
          challenge = await this.store.transaction(async (draft, tx) => {
            const currentTask = draft.tasks[existingTask.id];
            const created = this.approvalService.create(tx, {
              task: currentTask,
              action: currentTask.input.approvalAction,
              inputHash: currentTask.inputHash,
              principalId: principal.id,
              ttlSec: config.im.approvalTtlSec,
              source: principal.sourceKind
            });
            currentTask.input.approvalId = created.approval.id;
            return created;
          });
        }
        return {
          task: deepClone(existingTask),
          publish: deepClone(existing),
          approval: challenge?.approval || null,
          nonce: challenge?.nonce || null,
          expiresAt: challenge?.expiresAt || null,
          reused: true,
          executionMode: 'go'
        };
      }
      throw new AppError('DUPLICATE_OPERATION', 'publish business key already exists', {
        details: { businessKey, taskId: existing.taskId }
      });
    }
    const effective = effectiveDryRun({ config, feature: 'publishing', invocationMode: input.mode });
    const approvalAction = provider === 'external' ? 'publish.external' : 'publish.prepare';
    const publishInput = {
      videoArtifactId: video.artifactId,
      coverArtifactId: cover?.artifactId || null,
      videoSha256: video.sha256,
      coverSha256: cover?.sha256 || null,
      accountRef: target,
      metadata,
      metadataHash,
      businessKey,
      provider,
      providerVersion,
      productionTaskId: input.productionTaskId || null,
      approvalAction,
      bundleDir: null,
      externalOperationId: null,
      receipt: null
    };
    const creation = await this.store.transaction(async (draft, tx) => {
      tx.assertBusinessAcceptance();
      assertWritablePhase(draft);
      if (draft.publishing?.enabled === false && input.mode === 'go' && !effective.dryRun) {
        throw new AppError('FEATURE_DISABLED', 'publishing is disabled');
      }
      const task = this.taskManager.create(tx, {
        kind: 'publish',
        principalId: principal.id,
        accountRef: account.accountRef,
        trigger: 'manual',
        sourceKind: principal.sourceKind,
        input: publishInput,
        inputHash
      });
      const publish = {
        taskId: task.id,
        workspaceId: draft.workspaceId,
        businessKey,
        provider,
        providerVersion,
        status: 'draft',
        accountRef: account.accountRef,
        videoArtifactId: video.artifactId,
        coverArtifactId: cover?.artifactId || null,
        metadata,
        metadataHash,
        inputHash,
        productionTaskId: input.productionTaskId || null,
        receipt: null,
        externalOperationId: null,
        createdAt: nowIso(this.now),
        archived: false
      };
      draft.publishes[task.id] = publish;
      tx.appendEvent({
        type: 'publish.task.created',
        actor: principal.id,
        taskId: task.id,
        accountRef: account.accountRef,
        payload: {
          provider,
          businessKey,
          executionMode: effective.executionMode,
          videoSha256: video.sha256,
          metadataHash
        }
      });
      if (input.mode === 'go' && !effective.dryRun) {
        if (!config.publishing.enabled) throw new AppError('FEATURE_DISABLED', 'publishing is disabled');
        this.taskManager.transition(tx, task, 'waiting_approval');
        const challenge = this.approvalService.create(tx, {
          task,
          action: approvalAction,
          inputHash,
          principalId: principal.id,
          ttlSec: config.im.approvalTtlSec,
          source: principal.sourceKind
        });
        task.input.approvalId = challenge.approval.id;
        return { task, publish, challenge };
      }
      this.taskManager.transition(tx, task, 'running', { actor: principal.id, reason: 'publish dry run' });
      this.taskManager.transition(tx, task, 'succeeded', {
        actor: principal.id,
        reason: 'publish dry run preflight',
        result: {
          executionMode: 'dry',
          readyForPublish: false,
          provider,
          plan: { provider, accountRef: account.accountRef, videoArtifactId: video.artifactId, metadataHash }
        }
      });
      publish.status = 'dry_run';
      return { task, publish, challenge: null };
    });
    return {
      task: deepClone(creation.task),
      publish: deepClone(creation.publish),
      approval: creation.challenge?.approval || null,
      nonce: creation.challenge?.nonce || null,
      expiresAt: creation.challenge?.expiresAt || null,
      reused: false,
      dryRun: effective.dryRun,
      executionMode: effective.executionMode
    };
  }

  async prepare({ taskId, mode = 'go', principal = null }) {
    if (!['dry', 'go'].includes(mode)) throw new AppError('CONFIG_INVALID', 'mode must be dry or go');
    const config = this._config();
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task) throw new AppError('FORBIDDEN', 'publish task not found');
    if (task.kind !== 'publish') throw new AppError('INPUT_REQUIRED', 'task is not a publish task');
    if (['succeeded', 'cancelled', 'failed', 'unknown'].includes(task.status)) {
      return { task: deepClone(task), skipped: true };
    }
    const effective = effectiveDryRun({ config, feature: 'publishing', invocationMode: mode });
    if (effective.dryRun) {
      return {
        task: deepClone(task),
        dryRun: true,
        executionMode: 'dry',
        blockedBy: effective.blockedBy,
        plan: { provider: task.input.provider, videoArtifactId: task.input.videoArtifactId, readyForPublish: false }
      };
    }
    if (task.status === 'waiting_approval') throw new AppError('APPROVAL_REQUIRED', 'publish is waiting for human approval');
    if (task.status === 'awaiting_manual') {
      return { task: deepClone(task), publish: deepClone(state.publishes[taskId]), awaitingManual: true };
    }
    if (!['running', 'queued'].includes(task.status)) throw new AppError('FORBIDDEN', `publish cannot proceed from ${task.status}`);
    if (!config.publishing.enabled) throw new AppError('FEATURE_DISABLED', 'publishing is disabled');
    this.approvalService.assertApproved(state, {
      taskId,
      action: task.input.approvalAction,
      inputHash: task.inputHash
    });
    if (this._providerVersion(task.input.provider) !== task.input.providerVersion) {
      throw new AppError('APPROVAL_STALE', 'publisher configuration changed; re-approval is required');
    }
    // Re-verify artifact bytes immediately before any bundle/dispatch.
    const video = await this.artifactStore.verify(task.input.videoArtifactId, { principal });
    if (video.sha256 !== task.input.videoSha256) throw new AppError('ARTIFACT_INVALID', 'video changed after approval');
    if (task.input.coverArtifactId) {
      const cover = await this.artifactStore.verify(task.input.coverArtifactId, { principal });
      if (cover.sha256 !== task.input.coverSha256) throw new AppError('ARTIFACT_INVALID', 'cover changed after approval');
    }
    if (task.input.provider === 'manual') {
      return this._prepareManual({ task, principal });
    }
    return this._prepareExternal({ task, principal });
  }

  async _bundleDir(taskId) {
    const config = this._config();
    const root = config.publishing.outputDir || path.join(this.configService.getPaths().dataDir, 'posts');
    return resolveInside(root, taskId);
  }

  async _writeBundle(task, { external = false } = {}) {
    const dir = await this._bundleDir(task.id);
    await ensureDir(dir);
    const metadataPath = path.join(dir, 'metadata.json');
    const bundle = {
      schemaVersion: 1,
      taskId: task.id,
      accountRef: task.input.accountRef,
      provider: task.input.provider,
      artifacts: {
        video: { artifactId: task.input.videoArtifactId, sha256: task.input.videoSha256 },
        cover: task.input.coverArtifactId
          ? { artifactId: task.input.coverArtifactId, sha256: task.input.coverSha256 }
          : null
      },
      metadata: task.input.metadata,
      status: external ? 'external_pending' : 'awaiting_manual',
      operationId: null,
      published: false,
      instructions:
        'This bundle is not a published post. Complete it manually in the Bilibili creator studio, then register the real BV via: publish complete <taskId> --bvid <BV> --confirm --note <note>.'
    };
    await fsp.writeFile(metadataPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    const publishTxt = [
      'dsh-bili-unified manual publish bundle',
      '',
      `Task: ${task.id}`,
      `Account: ${task.input.accountRef.platform}/${task.input.accountRef.accountId}`,
      `Title: ${task.input.metadata.title}`,
      `Video artifact: ${task.input.videoArtifactId} (sha256 ${task.input.videoSha256})`,
      `Cover artifact: ${task.input.coverArtifactId || 'none'}`,
      '',
      'THIS BUNDLE IS NOT A PUBLISHED POST.',
      'Upload the referenced video/cover manually, then register the platform BV.',
      'A bundle does not prove platform acceptance or a successful upload.',
      ''
    ].join('\n');
    await fsp.writeFile(path.join(dir, 'PUBLISH.txt'), publishTxt, 'utf8');
    return dir;
  }

  async _prepareManual({ task, principal }) {
    const dir = await this._writeBundle(task);
    const result = await this.store.transaction(async (draft, tx) => {
      const current = draft.tasks[task.id];
      if (current.status === 'running' || current.status === 'queued') {
        this.taskManager.transition(tx, current, 'awaiting_manual', {
          actor: principal?.id || 'local_human',
          reason: 'manual bundle generated; awaiting human publish assertion',
          result: {
            readyForPublish: true,
            awaitingManual: true,
            bundleTaskId: task.id,
            published: false
          }
        });
      }
      const publish = draft.publishes[task.id];
      if (publish) {
        publish.status = 'awaiting_manual';
        publish.bundleRef = task.id;
        publish.updatedAt = nowIso(this.now);
      }
      tx.appendEvent({
        type: 'publish.manual.bundle_ready',
        actor: principal?.id || 'local_human',
        taskId: task.id,
        accountRef: task.input.accountRef,
        payload: { awaitManual: true, bundleTaskId: task.id }
      });
      return { task: deepClone(current), publish: deepClone(publish) };
    });
    return {
      task: result.task,
      publish: result.publish,
      bundleDir: dir,
      awaitingManual: true,
      executionMode: 'go'
    };
  }

  async _prepareExternal({ task, principal }) {
    const config = this._config();
    if (!config.security.allowExternalPublisher) throw new AppError('EXTERNAL_PUBLISH_DISABLED', 'external publishing is disabled');
    const dir = await this._writeBundle(task, { external: true });
    const state = await this.store.getSnapshot();
    if (task.cancelRequestedAt) throw new AppError('FORBIDDEN', 'publish task was cancelled');
    const operationId = randomId('op');
    const inputHash = task.inputHash;
    const outcome = await this.effectGateway.executeOperation(
      {
        operationId,
        namespace: 'external',
        action: 'publish_external',
        receiptAction: 'publish_external',
        recoveryAction: 'external_publish',
        accountRef: task.input.accountRef,
        businessKey: task.input.businessKey,
        taskIds: [task.id],
        inputHash,
        approvalId: task.input.approvalId,
        approvalAction: 'publish.external',
        protected: true,
        target: task.input.accountRef,
        metadata: { bundleTaskId: task.id, provider: 'external' },
        extraBusinessKeys: [`publish-target:${task.input.accountRef.platform}:${task.input.accountRef.accountId}:${task.input.videoSha256}`]
      },
      async (operationContext) => this._runExternalCommand({ task, dir, operationContext }),
      {
        applyResult: async (tx, operation, status) => {
          const current = tx.state.tasks[task.id];
          const publish = tx.state.publishes[task.id];
          if (publish) {
            publish.status =
              status === 'confirmed' ? 'published' : status === 'unknown' ? 'unknown' : status === 'not_sent' ? 'not_sent' : 'failed';
            publish.externalOperationId = operation.id;
            publish.receipt = operation.resultSummary || null;
            publish.updatedAt = nowIso(this.now);
          }
          if (status === 'confirmed') {
            if (current.status === 'running') {
              this.taskManager.transition(tx, current, 'succeeded', {
                actor: 'system',
                reason: 'external publisher returned a valid receipt',
                result: {
                  provider: 'external',
                  receipt: operation.resultSummary,
                  verification: operation.receipt?.verification || 'publisher_receipt',
                  readyForPublish: true
                }
              });
            }
          } else if (status === 'failed' || status === 'not_sent') {
            if (current.status === 'running') {
              this.taskManager.transition(tx, current, 'failed', {
                actor: 'system',
                reason: `external publish ${status}`,
                error: operation.error
              });
            }
          }
          tx.appendEvent({
            type: 'publish.external.settled',
            actor: 'system',
            taskId: task.id,
            accountRef: task.input.accountRef,
            payload: { operationId: operation.id, status }
          });
        }
      }
    );
    return {
      task: (await this.store.getSnapshot()).tasks[task.id],
      publish: (await this.store.getSnapshot()).publishes[task.id],
      operation: outcome.operation,
      executionMode: 'go'
    };
  }

  _externalArgs(task, dir, metadataPath) {
    const config = this._config();
    const values = {
      video: null,
      cover: task.input.coverArtifactId ? null : '',
      title: task.input.metadata.title,
      description: task.input.metadata.description,
      tags: task.input.metadata.tags.join(','),
      tid: String(task.input.metadata.platformData?.tid || ''),
      bundleDir: dir,
      metadata: metadataPath
    };
    return { config, values };
  }

  async _runExternalCommand({ task, dir, operationContext }) {
    const config = this._config();
    if (!config.security.allowExternalPublisher) throw new AppError('EXTERNAL_PUBLISH_DISABLED', 'external publishing is disabled');
    if (!config.publishing.external.successJson) {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'external publisher has no verified receipt protocol');
    }
    const videoPath = (await this.artifactStore.resolveManagedPath(task.input.videoArtifactId, { verify: true })).absolute;
    const coverPath = task.input.coverArtifactId
      ? (await this.artifactStore.resolveManagedPath(task.input.coverArtifactId, { verify: true })).absolute
      : '';
    const metadataPath = path.join(dir, 'metadata.json');
    const values = {
      video: videoPath,
      cover: coverPath,
      title: task.input.metadata.title,
      description: task.input.metadata.description,
      tags: task.input.metadata.tags.join(','),
      tid: String(task.input.metadata.platformData?.tid || ''),
      bundleDir: dir,
      metadata: metadataPath
    };
    const placeholders = new Set(Object.keys(values));
    const args = [];
    for (const argument of config.publishing.external.args) {
      const matches = [...String(argument).matchAll(/\{([a-zA-Z]+)\}/g)];
      for (const match of matches) {
        if (!placeholders.has(match[1])) {
          throw new AppError('PUBLISH_INPUT_INVALID', `unknown external publisher placeholder {${match[1]}}`);
        }
      }
      args.push(
        String(argument).replace(/\{([a-zA-Z]+)\}/g, (_, name) => values[name] ?? '')
      );
    }
    const envKeys = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'];
    const env = {};
    for (const key of envKeys) if (process.env[key] !== undefined) env[key] = process.env[key];
    let started = false;
    let stdout = '';
    let stderr = '';
    try {
      started = true;
      const result = await execFileAsync(config.publishing.external.command, args, {
        timeout: config.publishing.external.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env,
        cwd: dir
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      if (!started || error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR') {
        throw Object.assign(new AppError('EXTERNAL_PUBLISH_DISABLED', 'external publisher could not start'), { notSent: true });
      }
      if (error.killed || error.signal) {
        throw new AppError('OPERATION_UNKNOWN', 'external publisher timed out or was terminated');
      }
      // A non-zero exit after start is not proof that nothing was published.
      throw new AppError('OPERATION_UNKNOWN', 'external publisher exited without a verifiable receipt', {
        details: { stderr: truncateText(stderr || error.message, 500) }
      });
    }
    const text = String(stdout || '').trim();
    if (!text.startsWith('{') || !text.endsWith('}')) {
      throw new AppError('OPERATION_UNKNOWN', 'external publisher stdout is not a single JSON object');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError('OPERATION_UNKNOWN', 'external publisher receipt is invalid JSON');
    }
    if (parsed.ok !== true) {
      throw Object.assign(new AppError('BILI_API_ERROR', 'external publisher reported failure'), { notSent: true });
    }
    if (typeof parsed.bvid !== 'string' || !BV_PATTERN.test(parsed.bvid)) {
      throw new AppError('OPERATION_UNKNOWN', 'external publisher returned an invalid BV');
    }
    if (typeof parsed.url !== 'string' || !/^https:\/\//.test(parsed.url)) {
      throw new AppError('OPERATION_UNKNOWN', 'external publisher returned an invalid url');
    }
    return makeReceipt({
      platform: task.input.accountRef.platform,
      accountId: task.input.accountRef.accountId,
      action: 'publish_external',
      externalId: parsed.bvid,
      url: parsed.url,
      verification: 'publisher_receipt',
      receivedAt: nowIso(this.now)
    });
  }

  async complete({ taskId, bvid, url = null, note = '' }, humanContext) {
    if (!BV_PATTERN.test(String(bvid || ''))) throw new AppError('PUBLISH_INPUT_INVALID', 'bvid is invalid');
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task || task.kind !== 'publish') throw new AppError('FORBIDDEN', 'publish task not found');
    if (task.input.provider !== 'manual') {
      throw new AppError('FORBIDDEN', 'publish complete is only valid for Manual provider');
    }
    if (!humanContext?.principal || !humanContext?.proof) {
      throw new AppError('TRUST_UNAVAILABLE', 'publish complete requires a trusted local human');
    }
    await this.humanProof.assert(humanContext, {
      action: 'publish.complete',
      taskId,
      inputHash: task.inputHash,
      bvid: String(bvid),
      note: truncateText(note, 500)
    });
    const existing = state.publishes[taskId];
    if (existing?.receipt && existing.receipt.externalId === String(bvid)) {
      return { task: deepClone(task), publish: deepClone(existing), receipt: existing.receipt, deduplicated: true };
    }
    if (existing?.receipt && existing.receipt.externalId !== String(bvid)) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'a different manual receipt was already registered');
    }
    if (!['awaiting_manual', 'running'].includes(task.status)) {
      throw new AppError('FORBIDDEN', `publish task is ${task.status}, not awaiting manual`);
    }
    const operations = (task.operationIds || []).map((id) => state.operations[id]).filter(Boolean);
    if (operations.some((operation) => operation.status === 'unknown' || operation.dispatchAt)) {
      throw new AppError('OPERATION_UNKNOWN', 'manual completion cannot override dispatched/unknown operations');
    }
    const receipt = makeReceipt({
      platform: task.input.accountRef.platform,
      accountId: task.input.accountRef.accountId,
      action: 'publish_manual_confirmation',
      externalId: String(bvid),
      url: url || `https://www.bilibili.com/video/${bvid}`,
      verification: 'manual_assertion',
      receivedAt: nowIso(this.now)
    });
    return this.store.transaction(async (draft, tx) => {
      const current = draft.tasks[taskId];
      if (!this.effectGateway?.assertProtectedCompletionInTransaction) {
        throw new AppError('DEPENDENCY_UNAVAILABLE', 'protected completion gate is not configured');
      }
      await this.effectGateway.assertProtectedCompletionInTransaction(tx, {
        accountRef: current.input.accountRef,
        capability: 'publish:manual',
        recoveryScope: {
          kind: 'account_action',
          workspaceId: draft.workspaceId,
          platform: current.input.accountRef.platform,
          accountId: current.input.accountRef.accountId,
          action: 'publish'
        }
      });
      const operationId = randomId('op');
      const operation = {
        id: operationId,
        workspaceId: draft.workspaceId,
        namespace: 'manual',
        action: 'publish_manual_confirmation',
        receiptAction: 'publish_manual_confirmation',
        status: 'confirmed',
        instanceId: tx.instanceId,
        ownerPid: process.pid,
        processStartedAt: processStartIso(),
        createdAt: nowIso(this.now),
        dispatchAt: null,
        finishedAt: nowIso(this.now),
        businessKey: current.input.businessKey,
        businessKeys: [current.input.businessKey],
        taskIds: [taskId],
        accountRef: current.input.accountRef,
        inputHash: current.inputHash,
        approvalId: null,
        quota: null,
        budget: null,
        amountMinor: 0,
        currency: null,
        recoveryScope: null,
        protected: false,
        metadata: { verification: 'manual_assertion' },
        attempts: 0,
        resultSummary: {
          externalId: String(bvid),
          url: receipt.url,
          verification: 'manual_assertion'
        },
        error: null,
        receipt
      };
      draft.operations[operationId] = operation;
      draft.businessKeys[current.input.businessKey] = {
        ...(draft.businessKeys[current.input.businessKey] || {
          key: current.input.businessKey,
          namespace: 'manual',
          type: 'publish_manual_confirmation',
          createdAt: nowIso(this.now)
        }),
        key: current.input.businessKey,
        status: 'confirmed',
        confirmedAt: nowIso(this.now),
        lastOperationId: operationId,
        receipt: operation.resultSummary,
        updatedAt: nowIso(this.now)
      };
      current.operationIds.push(operationId);
      current.pendingOperationIds = (current.pendingOperationIds || []).filter((id) => id !== operationId);
      const publish = draft.publishes[taskId];
      publish.status = 'published';
      publish.receipt = operation.resultSummary;
      publish.manualOperationId = operationId;
      publish.updatedAt = nowIso(this.now);
      this.taskManager.transition(tx, current, 'succeeded', {
        manualReceipt: true,
        actor: humanContext.principal.id,
        reason: 'local human registered a manual publish assertion',
        result: {
          provider: 'manual',
          verification: 'manual_assertion',
          receipt: operation.resultSummary,
          published: true
        }
      });
      tx.appendEvent({
        type: 'publish.manual.completed',
        actor: humanContext.principal.id,
        taskId,
        accountRef: current.input.accountRef,
        payload: {
          operationId,
          bvid: String(bvid),
          verification: 'manual_assertion'
        }
      });
      return { task: deepClone(current), publish: deepClone(publish), receipt, deduplicated: false };
    });
  }

  async resolveExternal({ taskId, decision, receipt, note = '' }, humanContext) {
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task || task.kind !== 'publish') throw new AppError('FORBIDDEN', 'publish task not found');
    const publish = state.publishes[taskId];
    if (task.input.provider !== 'external' || !publish?.externalOperationId) {
      throw new AppError('FORBIDDEN', 'no external publish Operation to resolve');
    }
    const resolved = await this.effectGateway.resolve(
      {
        operationId: publish.externalOperationId,
        decision,
        receipt: receipt || null,
        note
      },
      humanContext,
      {
        applyResult: async (tx, operation, status) => {
          const current = tx.state.tasks[taskId];
          const currentPublish = tx.state.publishes[taskId];
          if (currentPublish) {
            currentPublish.status = status === 'confirmed' ? 'published' : 'not_sent';
            currentPublish.receipt = operation.resultSummary || currentPublish.receipt;
            currentPublish.updatedAt = nowIso(this.now);
          }
          if (status === 'confirmed' && current.status === 'unknown') {
            this.taskManager.transition(tx, current, 'succeeded', {
              verified: true,
              actor: humanContext.principal.id,
              reason: 'external publish verified by local human',
              result: {
                provider: 'external',
                receipt: operation.resultSummary,
                verification: operation.receipt?.verification || 'platform_readback'
              }
            });
          }
        }
      }
    );
    return {
      task: (await this.store.getSnapshot()).tasks[taskId],
      publish: (await this.store.getSnapshot()).publishes[taskId],
      operation: resolved.operation
    };
  }

  async getStatus(taskId) {
    const state = await this.store.getSnapshot();
    const task = state.tasks[taskId];
    if (!task) throw new AppError('FORBIDDEN', 'publish task not found');
    return { task: deepClone(task), publish: deepClone(state.publishes[taskId] || null) };
  }
}

export default PublisherModule;
