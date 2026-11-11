import { AppError } from '../errors.js';
import { assertWritablePhase } from '../contracts.js';
import { deepClone, nowIso, truncateText } from '../utils.js';

const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export class BrowseModule {
  constructor({ store, taskManager, adapter, configService, now = () => new Date(), logger, failureCooldownMs = FAILURE_COOLDOWN_MS } = {}) {
    this.store = store;
    this.taskManager = taskManager;
    this.adapter = adapter;
    this.configService = configService;
    this.now = now;
    this.logger = logger;
    // Legacy constructor fallback; the runtime value comes from
    // browse.failureCooldownMinutes when the config exposes it (I2/F05).
    this.failureCooldownMs = failureCooldownMs;
  }

  /**
   * Stable per-account dedupe key (FR-BRO-002): the persisted video history is
   * scoped by platform + accountId + contentId so two accounts never share
   * processed/failure state for the same BV.
   */
  _videoKey(account, contentRef) {
    const platform = contentRef?.platform || account?.accountRef?.platform || 'bilibili';
    const accountId = account?.accountRef?.accountId;
    if (!accountId) throw new AppError('IDENTITY_UNVERIFIED', 'browse requires a verified account');
    return `${platform}:${accountId}:${contentRef.contentId}`;
  }

  /** Pre-F05 keys were `bilibili:<BV>`; keep reading them once for migration. */
  _legacyVideoKey(contentRef) {
    const platform = contentRef?.platform || 'bilibili';
    return `${platform}:${contentRef.contentId}`;
  }

  _lookupVideo(snapshot, account, contentRef) {
    const key = this._videoKey(account, contentRef);
    const legacyKey = this._legacyVideoKey(contentRef);
    const scoped = snapshot.videos?.[key] || null;
    if (scoped) return { key, legacyKey, video: scoped, legacy: false };
    const legacy = snapshot.videos?.[legacyKey] || null;
    return { key, legacyKey, video: legacy, legacy: Boolean(legacy) };
  }

  _failureCooldownMs(config) {
    const minutes = config?.browse?.failureCooldownMinutes;
    if (minutes === undefined || minutes === null) return this.failureCooldownMs;
    const parsed = Number(minutes);
    if (!Number.isFinite(parsed) || parsed < 0) return this.failureCooldownMs;
    return parsed * MINUTE_MS;
  }

  _recordVideo(draft, account, contentRef, patch, now, extra = {}) {
    const key = this._videoKey(account, contentRef);
    const legacyKey = this._legacyVideoKey(contentRef);
    const base = draft.videos[key] || draft.videos[legacyKey] || {};
    draft.videos[key] = {
      ...base,
      contentRef: deepClone(contentRef),
      platform: contentRef.platform || account.accountRef.platform,
      accountId: account.accountRef.accountId,
      ...extra,
      ...patch,
      lastSeenAt: now
    };
    // Legacy keys carry no account identity. Once the scoped record exists the
    // legacy entry is retired so the other account is not blocked by it (D-01).
    if (draft.videos[legacyKey]) delete draft.videos[legacyKey];
    return key;
  }

  async createTask({ principal, trigger = 'manual', input = {} }) {
    const config = this.configService.get();
    if (!config.browse.enabled) throw new AppError('FEATURE_DISABLED', 'browse is disabled');
    return this.store.transaction(async (draft, tx) => {
      tx.assertBusinessAcceptance();
      assertWritablePhase(draft);
      const task = this.taskManager.create(tx, {
        kind: 'browse',
        principalId: principal.id,
        trigger,
        sourceKind: principal.sourceKind,
        input: { sources: config.browse.sources, keywords: config.browse.keywords, ...input }
      });
      tx.appendEvent({
        type: 'browse.task.created',
        actor: principal.id,
        taskId: task.id,
        payload: { trigger }
      });
      return deepClone(task);
    });
  }

  async run({ taskId, principal = null, deferCompletion = false }) {
    const config = this.configService.get();
    if (!config.browse.enabled) throw new AppError('FEATURE_DISABLED', 'browse is disabled');
    let snapshot = await this.store.getSnapshot();
    let task = snapshot.tasks[taskId];
    if (!task) throw new AppError('FORBIDDEN', 'browse task not found');
    if (task.kind !== 'browse') throw new AppError('INPUT_REQUIRED', 'task is not a browse task');
    if (['succeeded', 'cancelled', 'failed'].includes(task.status)) {
      return { task: deepClone(task), skipped: true };
    }
    if (task.status === 'running') throw new AppError('DUPLICATE_OPERATION', 'browse round is already running');
    if (task.cancelRequestedAt) {
      await this.store.transaction(async (draft, tx) => {
        const current = draft.tasks[taskId];
        this.taskManager.transition(tx, current, 'cancelled', {
          provenUndispatched: true,
          actor: 'local_human',
          reason: 'cancel requested before browse started'
        });
      });
      return { task: (await this.store.getSnapshot()).tasks[taskId], skipped: true };
    }

    const account = await this._activeAccount(snapshot);
    await this.store.transaction(async (draft, tx) => {
      const current = draft.tasks[taskId];
      this.taskManager.transition(tx, current, 'running', {
        actor: principal?.id || 'system',
        reason: 'browse round started',
        executionActive: true
      });
    });

    const selected = [];
    const failed = [];
    const skipped = [];
    let discoveryError = null;
    let candidates = [];
    try {
      candidates = await this.adapter.discover({
        sources: config.browse.sources,
        keywords: config.browse.keywords,
        limit: config.browse.candidatePool
      });
    } catch (error) {
      discoveryError = error;
    }

    const seenThisRound = new Set();
    const failureCooldownMs = this._failureCooldownMs(config);
    if (!discoveryError) {
      for (const candidate of candidates) {
        const contentId = candidate?.contentRef?.contentId;
        if (!contentId || seenThisRound.has(contentId)) continue;
        seenThisRound.add(contentId);
        if (selected.length >= config.browse.perRound * 2) break;
        const { video } = this._lookupVideo(snapshot, account, candidate.contentRef);
        if (candidate.author?.accountId && candidate.author.accountId === account.accountRef.accountId) {
          skipped.push({ contentRef: candidate.contentRef, reason: 'own_content' });
          continue;
        }
        if (video?.processedAt) {
          skipped.push({ contentRef: candidate.contentRef, reason: 'already_processed' });
          continue;
        }
        if (
          failureCooldownMs > 0 &&
          video?.lastFailureAt &&
          this.now().getTime() - Date.parse(video.lastFailureAt) < failureCooldownMs
        ) {
          skipped.push({ contentRef: candidate.contentRef, reason: 'failure_cooldown' });
          continue;
        }
        if (Number(candidate.durationSec) > config.browse.maxDurationSec) {
          skipped.push({ contentRef: candidate.contentRef, reason: 'too_long' });
          continue;
        }
        let content;
        try {
          content = await this.adapter.readContent(candidate, {
            includeComments: config.comments.enabled,
            includeSubtitle: true
          });
        } catch (error) {
          failed.push({
            contentRef: candidate.contentRef,
            code: error.code || 'BILI_API_ERROR',
            message: truncateText(error.message || 'read failed', 300)
          });
          continue;
        }
        const subtitleText = content.subtitle?.text || '';
        if (content.subtitleError) {
          failed.push({ contentRef: content.contentRef, code: content.subtitleError.code,
            message: 'subtitle retrieval failed; candidate will observe failure cooldown' });
          continue;
        }
        if (subtitleText.trim().length < config.browse.minSubtitleChars) {
          if (config.browse.allowNoSubtitle === true) {
            // FR-BRO-004 alternative content: keep title/description facts and
            // mark the candidate so downstream consumers know there is no subtitle.
            content.subtitleFallback = true;
          } else {
            skipped.push({ contentRef: content.contentRef, reason: 'insufficient_subtitle' });
            continue;
          }
        }
        const score = this.scoreCandidate(content, config);
        content.score = score;
        if (score < config.browse.minScore) {
          skipped.push({ contentRef: content.contentRef, reason: 'below_min_score', score });
          continue;
        }
        selected.push(this.compactCandidate(content));
      }
    }

    selected.sort((a, b) => b.score - a.score);
    const chosen = selected.slice(0, config.browse.perRound);
    const status = discoveryError || failed.length > 0 ? 'partial' : chosen.length === 0 ? 'skipped' : 'succeeded';
    const result = {
      status,
      selected: chosen,
      failed,
      skipped,
      roundId: taskId,
      discovered: candidates.length,
      accountRef: account.accountRef,
      ...(discoveryError
        ? { discoveryError: { code: discoveryError.code || 'BILI_API_ERROR', message: truncateText(discoveryError.message, 300) } }
        : {})
    };

    const finalState = await this.store.transaction(async (draft, tx) => {
      const current = draft.tasks[taskId];
      const now = nowIso(this.now);
      for (const item of chosen) {
        this._recordVideo(draft, account, item.contentRef, {
          title: item.title,
          processedAt: now,
          score: item.score
        }, now);
      }
      for (const item of failed) {
        this._recordVideo(draft, account, item.contentRef, {
          lastFailureAt: now,
          lastError: { code: item.code, message: item.message }
        }, now);
      }
      tx.appendEvent({
        type: 'browse.round.completed',
        actor: current.principalId,
        taskId,
        accountRef: account.accountRef,
        payload: {
          status,
          selected: chosen.map((item) => ({
            contentRef: item.contentRef,
            title: truncateText(item.title, 200),
            score: item.score,
            source: item.source
          })),
          failed: failed.map((item) => ({ contentRef: item.contentRef, code: item.code })),
          skippedCount: skipped.length
        }
      });
      if (discoveryError) {
        // FR-BRO-004 / §11.3: a round-level discovery failure is a partial
        // round, never a hard failure that hides already-read facts.
        this.taskManager.transition(tx, current, 'partial', {
          actor: 'system',
          reason: 'browse discovery failed',
          error: { code: discoveryError.code || 'BILI_API_ERROR', message: truncateText(discoveryError.message, 500) },
          result
        });
      } else if (failed.length > 0) {
        this.taskManager.transition(tx, current, 'partial', {
          actor: 'system',
          reason: 'one or more candidates failed',
          result
        });
      } else if (deferCompletion) {
        current.result = result;
      } else {
        this.taskManager.transition(tx, current, 'succeeded', {
          actor: 'system',
          reason: status === 'skipped' ? 'no candidate selected' : 'browse round completed',
          result
        });
      }
      return deepClone(current);
    });
    return { task: finalState, result, candidates: chosen.map((item) => this.fullCandidate(item)) };
  }

  async _activeAccount(snapshot = null) {
    const state = snapshot || (await this.store.getSnapshot());
    if (!state.activeAccountRef) throw new AppError('IDENTITY_UNVERIFIED', 'browse requires a verified account');
    const key = `bilibili:${state.activeAccountRef.accountId}`;
    const account = state.accounts[key];
    if (!account) throw new AppError('IDENTITY_UNVERIFIED', 'active account record is missing');
    return account;
  }

  scoreCandidate(candidate, config) {
    let score = 0;
    const title = String(candidate.title || '').toLowerCase();
    const description = String(candidate.description || '').toLowerCase();
    const subtitle = String(candidate.subtitle?.text || '').toLowerCase();
    for (const keyword of config.browse.keywords || []) {
      const needle = String(keyword).toLowerCase();
      if (!needle) continue;
      if (title.includes(needle)) score += 10;
      else if (description.includes(needle)) score += 5;
      else if (subtitle.includes(needle)) score += 3;
    }
    score = Math.min(score, 30);
    score += Math.min(10, Math.floor(String(candidate.subtitle?.text || '').length / 200));
    score += candidate.source === 'popular' ? 5 : 3;
    const duration = Number(candidate.durationSec) || 0;
    if (duration > 0 && duration <= 600) score += 5;
    else if (duration > 600) score += 2;
    if (Array.isArray(candidate.topComments) && candidate.topComments.length > 0) score += 2;
    return score;
  }

  compactCandidate(candidate) {
    return {
      contentRef: deepClone(candidate.contentRef),
      title: truncateText(candidate.title, 300),
      description: truncateText(candidate.description, 1000),
      author: candidate.author,
      durationSec: candidate.durationSec,
      subtitle: candidate.subtitle
        ? {
            text: truncateText(candidate.subtitle.text, 6000),
            lang: candidate.subtitle.lang,
            source: candidate.subtitle.source
          }
        : null,
      topComments: (candidate.topComments || []).slice(0, 10),
      score: candidate.score,
      source: candidate.source,
      subtitleFallback: candidate.subtitleFallback === true,
      platformData: deepClone(candidate.platformData || {})
    };
  }

  fullCandidate(compact) {
    return deepClone(compact);
  }
}

export default BrowseModule;
