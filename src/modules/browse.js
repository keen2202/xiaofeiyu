import { AppError } from '../errors.js';
import { assertWritablePhase } from '../contracts.js';
import { deepClone, nowIso, truncateText } from '../utils.js';

const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export class BrowseModule {
  constructor({ store, taskManager, adapter, configService, now = () => new Date(), logger, failureCooldownMs = FAILURE_COOLDOWN_MS } = {}) {
    this.store = store;
    this.taskManager = taskManager;
    this.adapter = adapter;
    this.configService = configService;
    this.now = now;
    this.logger = logger;
    this.failureCooldownMs = failureCooldownMs;
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

  async run({ taskId, principal = null }) {
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
    if (!discoveryError) {
      for (const candidate of candidates) {
        const contentId = candidate?.contentRef?.contentId;
        if (!contentId || seenThisRound.has(contentId)) continue;
        seenThisRound.add(contentId);
        if (selected.length >= config.browse.perRound * 2) break;
        const videoKey = `bilibili:${contentId}`;
        const video = snapshot.videos[videoKey];
        if (candidate.author?.accountId && candidate.author.accountId === account.accountRef.accountId) {
          skipped.push({ contentRef: candidate.contentRef, reason: 'own_content' });
          continue;
        }
        if (video?.processedAt) {
          skipped.push({ contentRef: candidate.contentRef, reason: 'already_processed' });
          continue;
        }
        if (video?.lastFailureAt && this.now().getTime() - Date.parse(video.lastFailureAt) < this.failureCooldownMs) {
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
        if (subtitleText.trim().length < config.browse.minSubtitleChars) {
          skipped.push({ contentRef: content.contentRef, reason: 'insufficient_subtitle' });
          continue;
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
        const key = `bilibili:${item.contentRef.contentId}`;
        draft.videos[key] = {
          ...(draft.videos[key] || {}),
          contentRef: item.contentRef,
          title: item.title,
          processedAt: now,
          lastSeenAt: now,
          score: item.score
        };
      }
      for (const item of failed) {
        const key = `bilibili:${item.contentRef.contentId}`;
        draft.videos[key] = {
          ...(draft.videos[key] || {}),
          contentRef: item.contentRef,
          lastFailureAt: now,
          lastError: { code: item.code, message: item.message }
        };
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
        this.taskManager.transition(tx, current, 'failed', {
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
      platformData: deepClone(candidate.platformData || {})
    };
  }

  fullCandidate(compact) {
    return deepClone(compact);
  }
}

export default BrowseModule;
