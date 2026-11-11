import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.js';
import { assertWritablePhase } from '../contracts.js';
import {
  atomicWriteFile,
  ensureDir,
  fileSha256,
  formatDateInZone,
  isSafeRelativePath,
  isValidDateString,
  jcsHash,
  nowIso,
  pathExists,
  randomToken,
  resolveInside,
  sha256Hex,
  truncateText
} from '../utils.js';

const BOOKS = Object.freeze(['public', 'private']);
const MAX_CONTENT_BYTES = 1024 * 1024;
const INTERNAL_EVENT_PREFIXES = Object.freeze([
  'diary.',
  'journal.',
  'config.',
  'identity.',
  'store.',
  'fence.',
  'outbox.',
  'im.binding.',
  'operation.reserved',
  'operation.dispatching',
  'browse.task.created',
  'comment.draft.created',
  'comment.auto.policy',
  'dm.task.created'
]);
function isFactEvent(event) {
  return !INTERNAL_EVENT_PREFIXES.some((prefix) => String(event.type).startsWith(prefix));
}

export class DiaryModule {
  constructor({
    store,
    journal,
    configService,
    identity,
    agent = null,
    now = () => new Date(),
    diaryDir,
    hooks = {},
    logger
  } = {}) {
    this.store = store;
    this.journal = journal;
    this.configService = configService;
    this.identity = identity;
    this.agent = agent;
    this.now = now;
    this.diaryDir = diaryDir;
    this.hooks = hooks;
    this.logger = logger;
    this._locks = new Map();
  }

  _config() {
    return this.configService.get();
  }

  _parseScope(rawScope) {
    const state = this.store;
    if (typeof rawScope !== 'string' || rawScope === '') {
      throw new AppError('FORBIDDEN', 'diary scope is required');
    }
    const parts = rawScope.split('/');
    if (parts[0] === 'account' && parts.length === 3 && parts[1] && parts[2]) {
      return { raw: rawScope, kind: 'account', platform: parts[1], accountId: parts[2] };
    }
    if (parts[0] === 'workspace' && parts.length === 2 && parts[1]) {
      return { raw: rawScope, kind: 'workspace', workspaceId: parts[1] };
    }
    throw new AppError('FORBIDDEN', 'scope must be account/<platform>/<accountId> or workspace/<workspaceId>');
  }

  async _authorize(scope, book, principal, snapshot, { reading = false } = {}) {
    if (!principal || principal.revokedAt) throw new AppError('FORBIDDEN', 'diary generation requires a principal');
    if (scope.kind === 'workspace' && scope.workspaceId !== snapshot.workspaceId) {
      throw new AppError('FORBIDDEN', 'workspace scope does not match this workspace');
    }
    if (scope.kind === 'account') {
      const key = `${scope.platform}:${scope.accountId}`;
      if (!snapshot.accounts[key]) throw new AppError('FORBIDDEN', 'account scope is not bound');
    }
    const isOwner = principal.kind === 'human' && principal.scopes?.includes('*');
    const hasScope =
      isOwner ||
      principal.scopes?.includes('diary.generate.own') ||
      principal.scopes?.includes('diary.read.own');
    if (!hasScope) throw new AppError('FORBIDDEN', 'principal lacks diary scope');
    if (book === 'private') {
      const generator = !reading && principal.kind === 'service' && principal.sourceKind === 'scheduler' &&
        snapshot.principals[principal.id]?.scopes?.includes('diary.generate.private') &&
        !snapshot.principals[principal.id]?.revokedAt;
      if (!generator && (principal.kind !== 'human' || !isOwner)) {
        throw new AppError('FORBIDDEN', 'private diaries are restricted to the local owner');
      }
      if (!this._config().diary.privateBook) throw new AppError('FEATURE_DISABLED', 'private diary is disabled');
    } else if (!this._config().diary.publicBook) {
      throw new AppError('FEATURE_DISABLED', 'public diary is disabled');
    }
  }

  _scopeKey(snapshot, scope) {
    return sha256Hex(`${snapshot.workspaceId}\n${scope.raw}`);
  }

  _enabledBooks() {
    const config = this._config();
    const books = [];
    if (config.diary.publicBook) books.push('public');
    if (config.diary.privateBook) books.push('private');
    return books.length > 0 ? books : ['public'];
  }

  _factsHash(facts) {
    const { generatedAt, eventCursor, ...stable } = facts;
    return jcsHash(stable);
  }

  /**
   * Pending-rebuild index lookup (I6). Markers are keyed by diaryId but are also
   * matched by scope+date so a book enable/disable change still consumes them.
   */
  _pendingRebuildFor(snapshot, scope, date, diaryId) {
    const index = snapshot.diaries?.__pendingRebuild;
    if (!index || typeof index !== 'object') return null;
    for (const [key, entry] of Object.entries(index)) {
      if (!entry || typeof entry !== 'object') continue;
      if (key === diaryId || (entry.date === date && entry.scope === scope.raw)) {
        return { key, entry };
      }
    }
    return null;
  }

  _dropPendingRebuildInDraft(draft, scope, date, diaryId) {
    const index = draft.diaries?.__pendingRebuild;
    if (!index || typeof index !== 'object') return 0;
    let dropped = 0;
    for (const [key, entry] of Object.entries(index)) {
      if (!entry || typeof entry !== 'object') {
        delete index[key];
        dropped += 1;
        continue;
      }
      if (key === diaryId || (entry.date === date && entry.scope === scope.raw)) {
        delete index[key];
        dropped += 1;
      }
    }
    return dropped;
  }

  _dateInZone(value, timeZone) {
    if (!value) return null;
    try {
      return formatDateInZone(value, timeZone);
    } catch {
      return null;
    }
  }

  /**
   * Mark diary dates for deterministic rebuild after a resolved interaction
   * (I6). This only records an index entry; it never renders, writes a file or
   * calls the model.
   */
  markDirty(draft, tx, info = {}) {
    if (!draft || typeof draft !== 'object') throw new AppError('DEPENDENCY_UNAVAILABLE', 'markDirty requires a state draft');
    if (!draft.diaries || typeof draft.diaries !== 'object') draft.diaries = {};
    const index =
      draft.diaries.__pendingRebuild && typeof draft.diaries.__pendingRebuild === 'object'
        ? draft.diaries.__pendingRebuild
        : (draft.diaries.__pendingRebuild = {});
    const operation = info.operationId ? draft.operations?.[info.operationId] : null;
    const accountRef = info.accountRef || operation?.accountRef || null;
    const config = this._config();
    const timeZone = config?.timeZone || draft.timeZone || 'Asia/Shanghai';
    const today = this._dateInZone(nowIso(this.now), timeZone) || nowIso(this.now).slice(0, 10);
    const dates = new Set();
    for (const candidate of [info.date, this._dateInZone(operation?.createdAt, timeZone), today]) {
      if (isValidDateString(candidate)) dates.add(candidate);
    }
    const scopes = [{ raw: `workspace/${draft.workspaceId}` }];
    if (
      accountRef?.platform &&
      accountRef?.accountId &&
      draft.accounts?.[`${accountRef.platform}:${accountRef.accountId}`]
    ) {
      scopes.push({ raw: `account/${accountRef.platform}/${accountRef.accountId}` });
    }
    const books = this._enabledBooks();
    const at = nowIso(this.now);
    let marked = 0;
    for (const scope of scopes) {
      for (const date of dates) {
        for (const book of books) {
          const diaryId = this._diaryId({ workspaceId: draft.workspaceId }, scope, date, book);
          index[diaryId] = {
            date,
            scope: scope.raw,
            book,
            reason: info.kind || info.reason || 'operation_resolved',
            taskId: info.taskId || null,
            operationId: info.operationId || null,
            at
          };
          marked += 1;
        }
      }
    }
    if (marked > 0) {
      tx.appendEvent({
        type: 'diary.rebuild.marked',
        actor: info.actor || 'system',
        taskId: info.taskId || null,
        accountRef,
        payload: {
          marked,
          dates: [...dates],
          scopes: scopes.map((scope) => scope.raw),
          operationId: info.operationId || null
        }
      });
    }
    return marked > 0;
  }

  _recoveryFacts(snapshot, recoveryDerived) {
    const recovery = snapshot.recovery || {};
    const parent = recovery.parent || null;
    if (!parent) {
      return recoveryDerived ? { parent: null, phase: recovery.phase || 'normal', derived: true } : null;
    }
    return {
      parent: {
        backupId: parent.backupId || null,
        sourceHistoryEpoch: parent.sourceHistoryEpoch || null,
        cutEventSeq: parent.cutEventSeq === undefined ? null : parent.cutEventSeq,
        snapshotHash: parent.snapshotHash || null
      },
      phase: recovery.phase || 'normal',
      uncertaintyRange: recovery.uncertaintyRange
        ? {
            startAt: recovery.uncertaintyRange.startAt || null,
            endAt: recovery.uncertaintyRange.endAt || null,
            open: recovery.uncertaintyRange.open === true
          }
        : null,
      missingMediaCount: Array.isArray(recovery.missingMedia) ? recovery.missingMedia.length : 0,
      derived: true
    };
  }

  _diaryId(snapshot, scope, date, book) {
    return `diary_${sha256Hex(`${snapshot.workspaceId}\n${scope.raw}\n${date}\n${book}`).slice(0, 40)}`;
  }

  _paths(snapshot, scope, date, book, diaryId) {
    const scopeKey = this._scopeKey(snapshot, scope);
    const directory = path.join(this.diaryDir, scopeKey, book);
    const targetFile = path.posix.join(scopeKey, book, `${date}.md`);
    const tempFile = path.posix.join('.tmp', `${diaryId}.${randomToken(6)}.tmp`);
    return {
      scopeKey,
      directory,
      targetFile,
      tempFile,
      targetAbs: resolveInside(this.diaryDir, targetFile),
      tempAbs: resolveInside(this.diaryDir, tempFile)
    };
  }

  _isHuman(principal) {
    return principal?.kind === 'human';
  }

  async _readEvents(snapshot) {
    const current = await this.journal.readEvents({
      epoch: snapshot.historyEpoch,
      upToSeq: snapshot.eventSeq
    });
    const parent = snapshot.recovery?.parent;
    if (
      !parent ||
      parent.sourceHistoryEpoch === snapshot.historyEpoch ||
      !Number.isSafeInteger(parent.cutEventSeq)
    ) {
      return current;
    }
    // A recovered branch must keep the facts that were archived before the
    // recovery cut. Events still in journalPending at the cut were re-sequenced
    // into the current branch, so reading the parent up to cutEventSeq would
    // otherwise hit a false sequence gap. Cap the parent read at its archived
    // watermark and let current-branch pending events carry the rest.
    const parentArchivedEnd = Object.values(snapshot.journalSegments || {})
      .filter((segment) => segment.historyEpoch === parent.sourceHistoryEpoch)
      .reduce((max, segment) => Math.max(max, Number(segment.endSeq) || 0), 0);
    const parentReadEnd = Math.min(parent.cutEventSeq, parentArchivedEnd);
    if (parentReadEnd <= 0) return current;
    const parentEvents = await this.journal.readEvents({
      epoch: parent.sourceHistoryEpoch,
      upToSeq: parentReadEnd
    });
    const merged = new Map();
    for (const event of parentEvents) merged.set(event.eventId, event);
    for (const event of current) merged.set(event.eventId, event);
    return [...merged.values()];
  }

  _scopeEvents(events, scope, snapshot) {
    if (scope.kind === 'workspace') return events;
    return events.filter((event) => {
      if (!event.accountRef) return true; // workspace production facts are relevant to account diaries
      return (
        event.accountRef.platform === scope.platform &&
        String(event.accountRef.accountId) === scope.accountId
      );
    });
  }

  _factsForDate(events, date, snapshot, book, { recoveryDerived = false } = {}) {
    const config = this._config();
    const timeZone = config.timeZone;
    const dayEvents = events.filter((event) => {
      try {
        return (
          isFactEvent(event) &&
          formatDateInZone(event.occurredAt, timeZone) === date
        );
      } catch {
        return false;
      }
    });
    const operations = snapshot.operations || {};
    const taskIds = new Set();
    const operationIds = new Set();
    const failures = [];
    const unknowns = [];
    let browseRounds = 0;
    let browseSelected = 0;
    let browseFailed = 0;
    let comments = 0;
    let dms = 0;
    let publishes = 0;
    let reconciliation = 0;
    for (const event of dayEvents) {
      if (event.taskId) taskIds.add(event.taskId);
      if (event.type === 'browse.round.completed') {
        browseRounds += 1;
        browseSelected += Array.isArray(event.payload?.selected) ? event.payload.selected.length : 0;
        browseFailed += Array.isArray(event.payload?.failed) ? event.payload.failed.length : 0;
      }
      if (event.type === 'operation.confirmed' || event.type === 'operation.not_sent') {
        const operation = operations[event.payload?.operationId];
        operationIds.add(event.payload?.operationId);
        const action = event.payload?.action || operation?.action || 'unknown';
        if (action === 'comment') comments += 1;
        if (action === 'dm') dms += 1;
        if (action === 'publish_external' || action === 'publish') publishes += 1;
        if (operation?.createdAt) {
          const createdDate = formatDateInZone(operation.createdAt, timeZone);
          if (createdDate !== formatDateInZone(event.occurredAt, timeZone)) reconciliation += 1;
        }
      }
      if (event.type === 'operation.unknown') {
        unknowns.push({ operationId: event.payload?.operationId, action: event.payload?.action || null });
      }
      if (event.type === 'operation.not_sent') {
        // not_sent is a verified no-op, not a failure.
      }
    }
    for (const task of Object.values(snapshot.tasks || {})) {
      if (task.kind === 'production' || task.kind === 'publish') {
        if (task.createdAt && formatDateInZone(task.createdAt, timeZone) === date) {
          taskIds.add(task.id);
        }
      }
      if (formatDateInZone(task.createdAt, timeZone) === date) {
        if (['failed', 'partial'].includes(task.status)) {
          failures.push({
            taskId: task.id,
            kind: task.kind,
            status: task.status,
            code: task.error?.code || null
          });
        }
        if (task.status === 'unknown' || (task.pendingOperationIds || []).some((id) => operations[id]?.status === 'unknown')) {
          unknowns.push({ taskId: task.id, kind: task.kind });
        }
      }
    }
    const productionsReady = Object.values(snapshot.productions || {})
      .filter((production) => production.readyForPublish === true)
      .filter((production) => {
        const task = snapshot.tasks[production.taskId];
        return task && formatDateInZone(task.createdAt, timeZone) === date;
      })
      .map((production) => ({
        productionId: production.id,
        taskId: production.taskId,
        readyForPublish: true
      }));
    const publishRecords = Object.values(snapshot.publishes || {})
      .filter((publish) => {
        const task = snapshot.tasks[publish.taskId];
        return task && formatDateInZone(task.createdAt, timeZone) === date;
      })
      .map((publish) => ({
        taskId: publish.taskId,
        status: publish.status,
        provider: publish.provider,
        contentRef: publish.receipt?.contentRef || null
      }));
    const uniqueUnknowns = [...new Map(unknowns.map((item) => [JSON.stringify(item), item])).values()];
    const recovery = this._recoveryFacts(snapshot, recoveryDerived);
    return {
      date,
      timeZone,
      browseRounds,
      browseSelected,
      browseFailed,
      comments,
      dms,
      publishes,
      reconciliation,
      taskIds: [...taskIds].slice(0, 200),
      operationIds: [...operationIds].slice(0, 200),
      failures: failures.slice(0, 50),
      unknowns: uniqueUnknowns.slice(0, 50),
      productionsReady,
      publishRecords,
      generatedAt: nowIso(this.now),
      book,
      recoveryDerived: Boolean(recoveryDerived) || Boolean(recovery),
      recovery,
      eventCursor: { historyEpoch: snapshot.historyEpoch, seq: snapshot.eventSeq },
      eventCount: dayEvents.length
    };
  }

  /**
   * Explicit recovery provenance/gap annotation (§14): a recovered diary must
   * never claim to be a complete record of the old instance.
   */
  _recoveryLines(facts) {
    const recovery = facts.recovery;
    if (!recovery) return ['- 本日记基于当前实例的完整事件归档生成。'];
    const parent = recovery.parent;
    const lines = [];
    if (parent) {
      lines.push(
        `- 本日记来自恢复分支：父恢复点 ${parent.backupId || 'unknown'}（源 historyEpoch ${parent.sourceHistoryEpoch || 'unknown'}，截止事件序号 ${parent.cutEventSeq === null ? 'unknown' : parent.cutEventSeq}）。`
      );
    } else {
      lines.push('- 本日记索引来源于恢复快照，父恢复点信息缺失。');
    }
    if (recovery.uncertaintyRange) {
      lines.push(
        `- 恢复区间：${recovery.uncertaintyRange.startAt || 'unknown'} 至 ${recovery.uncertaintyRange.endAt || '未闭合'}${recovery.uncertaintyRange.open ? '（仍在核查）' : '（已闭合）'}。`
      );
    }
    if (recovery.missingMediaCount > 0) {
      lines.push(`- 缺失受保护媒体：${recovery.missingMediaCount} 项，需人工核查。`);
    }
    lines.push(
      '- 缺口说明：恢复点之后的平台确认/核查结果可能仍未决；unknown 操作保持未决，不视为已发送或已完成。'
    );
    return lines;
  }

  _render(facts, scope, book, narrative = '') {
    const lines = [
      `# ${facts.date} ${book === 'public' ? '公共' : '私人'}日记`,
      '',
      `- 时区：${facts.timeZone}`,
      `- 记录范围：${scope.raw}`,
      `- 事实事件：${facts.eventCount}`,
      '',
      '## 浏览',
      '',
      `- 轮次：${facts.browseRounds}`,
      `- 选中内容：${facts.browseSelected}`,
      `- 读取失败：${facts.browseFailed}`,
      '',
      '## 互动',
      '',
      `- 评论确认：${facts.comments}`,
      `- 私信确认：${facts.dms}`,
      `- 投稿相关：${facts.publishes}`,
      `- 跨日核查：${facts.reconciliation}`,
      '',
      '## 生产与投稿',
      '',
      `- 可投稿产物：${facts.productionsReady.length}`,
      ...facts.productionsReady.map((entry) => `  - 生产 ${entry.productionId}（Task ${entry.taskId}）已就绪，但尚未自动发布`),
      `- 投稿记录：${facts.publishRecords.length}`,
      ...facts.publishRecords.map(
        (entry) => `  - Task ${entry.taskId}：${entry.provider}/${entry.status}${entry.contentRef?.contentId ? `，内容 ${entry.contentRef.contentId}` : ''}`
      ),
      '',
      '## 未决与失败',
      '',
      facts.failures.length === 0 ? '- 无失败记录' : `- 失败/部分任务：${facts.failures.length}`,
      ...facts.failures.map((entry) => `  - ${entry.kind} ${entry.taskId}：${entry.status}${entry.code ? `（${entry.code}）` : ''}`),
      facts.unknowns.length === 0 ? '- 无 unknown 结果' : `- unknown/待核查：${facts.unknowns.length}`,
      ...facts.unknowns.map((entry) => `  - ${entry.kind || 'operation'} ${entry.taskId || entry.operationId}`),
      '',
      '## 恢复来源与缺口',
      '',
      ...this._recoveryLines(facts),
      '',
      '## 任务引用',
      '',
      facts.taskIds.length === 0 ? '- 无' : facts.taskIds.map((id) => `- ${id}`).join('\n'),
      ''
    ];
    if (narrative) {
      lines.push('## 叙述', '', narrative.trim(), '');
    }
    if (facts.book === 'public') {
      lines.push('> 本日记由事实事件投影生成，不包含凭据、完整私信或本机绝对路径。', '');
    }
    return lines.join('\n');
  }

  async _existingResult(existing, diaryId, facts) {
    let content = null;
    try {
      if (existing?.targetFile) {
        content = await fsp.readFile(resolveInside(this.diaryDir, existing.targetFile), 'utf8');
      }
    } catch {
      content = null;
    }
    return {
      diaryId,
      revision: existing.revision,
      contentHash: existing.contentHash,
      unchanged: true,
      path: existing.targetFile,
      content,
      facts
    };
  }

  async _generateNarrative({ config, facts, date, selectedBook, scope }) {
    if (!this.agent?.config?.agent?.enabled) return '';
    try {
      return await this.agent.generateText({
        task: 'diary',
        input: {
          date,
          book: selectedBook,
          scope: scope.raw,
          facts: {
            ...facts,
            taskIds: facts.taskIds.slice(0, 20),
            operationIds: facts.operationIds.slice(0, 20)
          }
        },
        maxChars: 1200,
        persona: config.agent.persona
      });
    } catch (error) {
      this.logger?.warn?.('diary narrative generation failed', { message: error.message });
      return '';
    }
  }

  /**
   * Commit phase. Runs under the per-diary identity lock: re-check revision,
   * register the two-phase pendingCommit, write+rename the body, then confirm
   * inside a short transaction (§14).
   */
  async _commitDiary({ diaryId, scope, date, selectedBook, principal, facts, factsHash, content, contentHash, cursor, force }) {
    const snapshot = await this.store.getSnapshot();
    const existing = snapshot.diaries[diaryId] || null;
    if (existing?.pendingCommit) return { conflict: true };
    const marker = this._pendingRebuildFor(snapshot, scope, date, diaryId);
    const dirty = Boolean(marker) || existing?.needsRebuild === true;
    const factsChanged = !existing?.factsHash || existing.factsHash !== factsHash;
    if (!force && !dirty && !factsChanged && existing?.contentHash === contentHash) {
      // Another writer already committed the same facts and body.
      return { result: await this._existingResult(existing, diaryId, facts) };
    }
    const paths = this._paths(snapshot, scope, date, selectedBook, diaryId);
    await ensureDir(path.dirname(paths.targetAbs));
    await ensureDir(path.dirname(paths.tempAbs));
    const targetRevision = (existing?.revision || 0) + 1;
    const baseCursor = existing?.eventCursor || { historyEpoch: snapshot.historyEpoch, seq: 0 };
    const pendingCommit = {
      diaryId,
      expectedRevision: existing?.revision || 0,
      targetRevision,
      baseEventCursor: baseCursor,
      targetEventCursor: cursor,
      tempFile: paths.tempFile,
      targetFile: paths.targetFile,
      contentHash,
      factsHash,
      phase: 'pending',
      createdAt: nowIso(this.now)
    };
    try {
      await this.store.transaction(async (draft, tx) => {
        assertWritablePhase(draft);
        const current = draft.diaries[diaryId];
        if ((current?.revision || 0) !== (existing?.revision || 0)) throw new _DiaryConflict();
        if (current?.pendingCommit) throw new _DiaryConflict();
        draft.diaries[diaryId] = {
          ...(current || {
            diaryId,
            workspaceId: draft.workspaceId,
            scope: scope.raw,
            scopeKey: paths.scopeKey,
            date,
            book: selectedBook,
            revision: 0,
            contentHash: null,
            lastGeneratedAt: null,
            eventCursor: baseCursor,
            pendingCommit: null
          }),
          factsHash,
          pendingCommit
        };
        tx.appendEvent({
          type: 'diary.rebuild.started',
          actor: principal.id,
          payload: {
            diaryId,
            date,
            book: selectedBook,
            expectedRevision: pendingCommit.expectedRevision,
            targetRevision,
            cursor,
            force: force === true
          }
        });
      });
    } catch (error) {
      if (error instanceof _DiaryConflict) return { conflict: true };
      throw error;
    }
    await atomicWriteFile(paths.tempAbs, content, {
      mode: 0o600,
      hooks: {
        afterTempWrite: this.hooks.afterDiaryTempWrite,
        beforeRename: this.hooks.beforeDiaryRename,
        afterRename: this.hooks.afterDiaryRename
      }
    });
    await this.hooks.beforeDiaryCommit?.({ diaryId, paths, pendingCommit });
    try {
      await fsp.rename(paths.tempAbs, paths.targetAbs);
    } catch (error) {
      await fsp.rm(paths.tempAbs, { force: true }).catch(() => {});
      throw error;
    }
    await this.store.transaction(async (draft, tx) => {
      const current = draft.diaries[diaryId];
      if (!current?.pendingCommit || current.pendingCommit.contentHash !== contentHash) {
        throw new _DiaryConflict();
      }
      current.revision = targetRevision;
      current.contentHash = contentHash;
      current.factsHash = factsHash;
      current.lastGeneratedAt = nowIso(this.now);
      current.eventCursor = cursor;
      current.targetFile = paths.targetFile;
      current.pendingCommit = null;
      current.needsRebuild = false;
      current.recoveryDerived = false;
      this._dropPendingRebuildInDraft(draft, scope, date, diaryId);
      tx.appendEvent({
        type: 'diary.rebuilt',
        actor: principal.id,
        payload: {
          diaryId,
          date,
          book: selectedBook,
          revision: targetRevision,
          contentHash,
          factsHash,
          cursor,
          force: force === true
        }
      });
    });
    return {
      result: {
        diaryId,
        revision: targetRevision,
        contentHash,
        factsHash,
        unchanged: false,
        path: paths.targetFile,
        content,
        facts
      }
    };
  }

  async generate({ date, scope: rawScope, book = null, force = false, principal }) {
    const config = this._config();
    if (!config.diary.enabled) throw new AppError('FEATURE_DISABLED', 'diary is disabled');
    if (!isValidDateString(date)) throw new AppError('INPUT_REQUIRED', 'date must be YYYY-MM-DD');
    const scope = this._parseScope(rawScope);
    let selectedBook = book;
    if (selectedBook === null) {
      selectedBook = config.diary.publicBook ? 'public' : config.diary.privateBook ? 'private' : null;
    }
    if (!BOOKS.includes(selectedBook)) throw new AppError('CONFIG_INVALID', 'book must be public or private');
    let snapshot = await this.store.getSnapshot();
    // Recovering an in-flight two-phase commit is allowed during migration
    // quiescing; starting a *new* rebuild remains behind assertWritablePhase.
    await this.recoverPending({ principal });
    snapshot = await this.store.getSnapshot();
    assertWritablePhase(snapshot);
    await this._authorize(scope, selectedBook, principal, snapshot);
    const diaryId = this._diaryId(snapshot, scope, date, selectedBook);
    const lockKey = diaryId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      snapshot = await this.store.getSnapshot();
      const existing = snapshot.diaries[diaryId] || null;
      if (existing?.pendingCommit) {
        await this.recoverPending({ principal, diaryId });
        continue;
      }
      const marker = this._pendingRebuildFor(snapshot, scope, date, diaryId);
      const dirty = Boolean(marker) || existing?.needsRebuild === true;
      const events = await this._readEvents(snapshot);
      const scoped = this._scopeEvents(events, scope, snapshot);
      const facts = this._factsForDate(scoped, date, snapshot, selectedBook, {
        recoveryDerived: existing?.recoveryDerived === true
      });
      const factsHash = this._factsHash(facts);
      const factsChanged = !existing?.factsHash || existing.factsHash !== factsHash;
      // M04: compare the fact snapshot before deciding to call the model; reuse
      // the committed body when neither facts nor force/dirty demand a rebuild.
      if (!force && !dirty && !factsChanged && existing.contentHash) {
        return this._existingResult(existing, diaryId, facts);
      }
      // §14: large narrative generation happens outside the identity lock.
      const narrative = await this._generateNarrative({ config, facts, date, selectedBook, scope });
      const content = this._render(facts, scope, selectedBook, narrative);
      if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
        throw new AppError('INPUT_REQUIRED', 'diary content exceeds the 1MiB limit');
      }
      const contentHash = sha256Hex(content);
      const cursor = { historyEpoch: snapshot.historyEpoch, seq: snapshot.eventSeq };
      try {
        const committed = await this._withLocalLock(lockKey, () =>
          this._commitDiary({
            diaryId,
            scope,
            date,
            selectedBook,
            principal,
            facts,
            factsHash,
            content,
            contentHash,
            cursor,
            force: force === true
          })
        );
        if (committed?.conflict) continue;
        return committed.result;
      } catch (error) {
        if (error instanceof _DiaryConflict) continue;
        throw error;
      }
    }
    throw new AppError('IDEMPOTENCY_CONFLICT', 'diary revision repeatedly changed during commit');
  }

  async recoverPending({ principal = null, diaryId = null } = {}) {
    const snapshot = await this.store.getSnapshot();
    const entries = Object.values(snapshot.diaries).filter(
      (entry) => entry.pendingCommit && (!diaryId || entry.diaryId === diaryId)
    );
    for (const entry of entries) {
      const pending = entry.pendingCommit;
      if (!isSafeRelativePath(pending.targetFile) || !isSafeRelativePath(pending.tempFile)) {
        await this._clearPending(entry.diaryId, 'unsafe_pending_path');
        continue;
      }
      const targetAbs = resolveInside(this.diaryDir, pending.targetFile);
      const tempAbs = resolveInside(this.diaryDir, pending.tempFile);
      const targetExists = await pathExists(targetAbs);
      let targetHash = null;
      if (targetExists) targetHash = (await fileSha256(targetAbs)).sha256;
      if (targetHash === pending.contentHash) {
        await this.store.transaction(async (draft, tx) => {
          const current = draft.diaries[entry.diaryId];
          if (!current?.pendingCommit || current.pendingCommit.contentHash !== pending.contentHash) return;
          current.revision = pending.targetRevision;
          current.contentHash = pending.contentHash;
          current.factsHash = pending.factsHash ?? current.factsHash ?? null;
          current.lastGeneratedAt = nowIso(this.now);
          current.eventCursor = pending.targetEventCursor;
          current.targetFile = pending.targetFile;
          current.pendingCommit = null;
          current.needsRebuild = false;
          this._dropPendingRebuildInDraft(draft, { raw: current.scope }, current.date, entry.diaryId);
          tx.appendEvent({
            type: 'diary.commit.recovered',
            actor: principal?.id || 'system',
            payload: { diaryId: entry.diaryId, phase: 'confirmed' }
          });
        });
        continue;
      }
      const tempExists = await pathExists(tempAbs);
      if (tempExists) {
        const tempHash = (await fileSha256(tempAbs)).sha256;
        if (tempHash === pending.contentHash) {
          await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
          await fsp.rename(tempAbs, targetAbs);
          await this.store.transaction(async (draft, tx) => {
            const current = draft.diaries[entry.diaryId];
            if (!current?.pendingCommit || current.pendingCommit.contentHash !== pending.contentHash) return;
            current.revision = pending.targetRevision;
            current.contentHash = pending.contentHash;
            current.factsHash = pending.factsHash ?? current.factsHash ?? null;
            current.lastGeneratedAt = nowIso(this.now);
            current.eventCursor = pending.targetEventCursor;
            current.targetFile = pending.targetFile;
            current.pendingCommit = null;
            current.needsRebuild = false;
            this._dropPendingRebuildInDraft(draft, { raw: current.scope }, current.date, entry.diaryId);
            tx.appendEvent({
              type: 'diary.commit.recovered',
              actor: principal?.id || 'system',
              payload: { diaryId: entry.diaryId, phase: 'renamed' }
            });
          });
          continue;
        }
        await fsp.rm(tempAbs, { force: true }).catch(() => {});
      }
      await this._clearPending(entry.diaryId, 'hash_mismatch');
    }
    return { recovered: entries.length };
  }

  async _clearPending(diaryId, reason) {
    await this.store.transaction(async (draft) => {
      const current = draft.diaries[diaryId];
      if (!current?.pendingCommit) return;
      current.pendingCommit = null;
      current.lastRecoveryNote = { reason, at: nowIso(this.now) };
    });
  }

  async _withLocalLock(key, fn) {
    const previous = this._locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this._locks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this._locks.get(key) === chained) this._locks.delete(key);
    }
  }

  async read({ date, scope: rawScope, book = 'public', principal }) {
    if (!isValidDateString(date)) throw new AppError('INPUT_REQUIRED', 'date must be YYYY-MM-DD');
    const snapshot = await this.store.getSnapshot();
    const scope = this._parseScope(rawScope);
    await this._authorize(scope, book, principal, snapshot, { reading: true });
    const diaryId = this._diaryId(snapshot, scope, date, book);
    const entry = snapshot.diaries[diaryId];
    if (!entry) throw new AppError('DEPENDENCY_UNAVAILABLE', 'diary has not been generated');
    if (entry.needsRebuild || !entry.contentHash) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'diary body must be rebuilt from archived facts');
    }
    const targetAbs = resolveInside(this.diaryDir, entry.targetFile);
    const content = await fsp.readFile(targetAbs, 'utf8');
    const contentHash = sha256Hex(content);
    if (contentHash !== entry.contentHash) {
      throw new AppError('JOURNAL_CORRUPTED', 'diary body does not match its committed digest', {
        details: { diaryId }
      });
    }
    return {
      diaryId,
      revision: entry.revision,
      contentHash: entry.contentHash,
      content,
      path: entry.targetFile
    };
  }

  async getStatus() {
    const snapshot = await this.store.getSnapshot();
    const entries = Object.entries(snapshot.diaries).filter(([key]) => key !== '__pendingRebuild');
    const pendingRebuildIndex = snapshot.diaries.__pendingRebuild;
    const pendingRebuilds =
      pendingRebuildIndex && typeof pendingRebuildIndex === 'object'
        ? Object.values(pendingRebuildIndex).filter(
            (marker) => marker && typeof marker === 'object' && typeof marker.date === 'string'
          ).length
        : 0;
    return {
      entries: entries.length,
      pendingCommits: entries.filter(([, entry]) => entry?.pendingCommit).length,
      pendingRebuilds,
      directoryConfigured: Boolean(this.diaryDir)
    };
  }
}

class _DiaryConflict extends Error {
  constructor() {
    super('diary revision conflict');
    this.code = 'IDEMPOTENCY_CONFLICT';
  }
}

export default DiaryModule;
