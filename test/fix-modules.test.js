import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  createHarness,
  makeMockAdapter,
  mockCandidate,
  bindMockAccount,
  approvalDecide
} from './helpers/harness.js';
import { AppError } from '../src/errors.js';
import { computeInputHash } from '../src/contracts.js';
import { BrowseModule } from '../src/modules/browse.js';
import { CommentsModule } from '../src/modules/comments.js';
import { DirectMessagesModule } from '../src/modules/direct-messages.js';
import { DiaryModule } from '../src/modules/diary.js';
import { PublisherModule } from '../src/modules/publisher.js';
import { Coordinator } from '../src/coordinator.js';

const DATE = '2026-11-07';
const WORKSPACE_SCOPE = 'workspace/workspace_test';

function configOverride(harness, patch) {
  return { get: () => ({ ...harness.configService.get(), ...patch }) };
}

async function bindAccount(harness, accountId) {
  const account = {
    accountRef: { platform: 'bilibili', accountId: String(accountId) },
    mid: String(accountId),
    uname: `tester-${accountId}`,
    credentialRevision: 'rev1',
    devId: 'dev_test',
    boundAt: harness.now().toISOString(),
    lastVerifiedAt: harness.now().toISOString(),
    verifiedFrom: 'whoami'
  };
  await harness.store.transaction(async (draft) => {
    draft.accounts[`bilibili:${accountId}`] = account;
    draft.activeAccountRef = { platform: 'bilibili', accountId: String(accountId) };
  });
  return account;
}

async function makeBrowseHarness({ overrides = {}, candidates = [] } = {}) {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      browse: {
        enabled: true,
        sources: ['popular'],
        perRound: 3,
        candidatePool: 10,
        minSubtitleChars: 10,
        minScore: 0
      },
      comments: { enabled: false },
      ...overrides
    }
  });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter({ candidates });
  return { harness, adapter };
}

function makeBrowse(harness, adapter, configService = null) {
  return new BrowseModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: configService || harness.configService,
    now: harness.now
  });
}

/* ------------------------------------------------------------------ */
/* M-P1-1 F05: per-account video history, config cooldown, subtitle    */
/* ------------------------------------------------------------------ */

test('M-P1-1: browse history is isolated per account for the same BV', async () => {
  const candidates = [mockCandidate('BV_SHARED', { author: { accountId: '3003', name: 'third-party' } })];
  const { harness, adapter } = await makeBrowseHarness({ candidates });
  const browse = makeBrowse(harness, adapter);
  try {
    const firstTask = await browse.createTask({ principal: harness.owner });
    const first = await browse.run({ taskId: firstTask.id, principal: harness.owner });
    assert.equal(first.result.selected.length, 1);
    let state = await harness.snapshot();
    assert.ok(state.videos['bilibili:1001:BV_SHARED']?.processedAt);
    assert.equal(state.videos['bilibili:BV_SHARED'], undefined);

    // Switch to a second verified account; the same BV must be considered again.
    await bindAccount(harness, 2002);
    const secondTask = await browse.createTask({ principal: harness.owner });
    const second = await browse.run({ taskId: secondTask.id, principal: harness.owner });
    assert.equal(second.result.selected.length, 1);
    assert.equal(second.result.skipped.some((entry) => entry.reason === 'already_processed'), false);
    state = await harness.snapshot();
    assert.ok(state.videos['bilibili:1001:BV_SHARED']?.processedAt);
    assert.ok(state.videos['bilibili:2002:BV_SHARED']?.processedAt);
    assert.equal(state.videos['bilibili:2002:BV_SHARED'].accountId, '2002');
    assert.equal(adapter.calls.readContent.length, 2);
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-1: legacy global history keys stay readable and migrate on next account write', async () => {
  const { harness, adapter } = await makeBrowseHarness({
    candidates: [mockCandidate('BV_LEGACY'), mockCandidate('BV_FAIL_LEGACY')],
    overrides: { browse: { enabled: true, perRound: 3, minSubtitleChars: 10, minScore: 0, candidatePool: 10 } }
  });
  const browse = makeBrowse(harness, adapter);
  const processedAt = harness.now().toISOString();
  const legacyFailureAt = new Date(harness.now().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await harness.store.transaction(async (draft) => {
    draft.videos['bilibili:BV_LEGACY'] = { processedAt, lastSeenAt: processedAt };
    draft.videos['bilibili:BV_FAIL_LEGACY'] = { lastFailureAt: legacyFailureAt };
  });
  adapter.readContent = async (candidate) => {
    if (candidate.contentRef.contentId === 'BV_FAIL_LEGACY') {
      throw Object.assign(new Error('detail down'), { code: 'BILI_API_ERROR' });
    }
    return makeMockAdapter().readContent(candidate);
  };
  try {
    const task = await browse.createTask({ principal: harness.owner });
    const result = await browse.run({ taskId: task.id, principal: harness.owner });
    // Old processed entry is honoured, while the expired legacy failure record
    // is retried and rewritten as an account-scoped failure.
    assert.ok(result.result.skipped.some((entry) => entry.reason === 'already_processed'));
    assert.equal(result.result.skipped.some((entry) => entry.reason === 'failure_cooldown'), false);
    assert.ok(result.result.failed.some((entry) => entry.contentRef.contentId === 'BV_FAIL_LEGACY'));
    const state = await harness.snapshot();
    // The failed legacy entry was carried over to an account-scoped record and
    // the un-scoped legacy key is retired.
    assert.equal(state.videos['bilibili:BV_FAIL_LEGACY'], undefined);
    assert.ok(state.videos['bilibili:1001:BV_FAIL_LEGACY']?.lastFailureAt);
    assert.ok(state.videos['bilibili:1001:BV_FAIL_LEGACY']?.lastError);
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-1: browse.failureCooldownMinutes is consumed from configuration (0 disables)', async () => {
  const candidates = [mockCandidate('BV_COOLDOWN')];
  const { harness, adapter } = await makeBrowseHarness({ candidates });
  adapter.readContent = async () => {
    throw Object.assign(new Error('detail down'), { code: 'BILI_API_ERROR' });
  };
  try {
    const baseConfig = harness.configService.get();
    const defaultBrowse = makeBrowse(harness, adapter);
    const first = await defaultBrowse.createTask({ principal: harness.owner });
    await defaultBrowse.run({ taskId: first.id, principal: harness.owner });
    harness.now.advance(2 * 60 * 1000);

    // Default (field absent) keeps the legacy 6h cooldown.
    const defaultTask = await defaultBrowse.createTask({ principal: harness.owner });
    const defaultResult = await defaultBrowse.run({
      taskId: defaultTask.id,
      principal: harness.owner
    });
    assert.ok(defaultResult.result.skipped.some((entry) => entry.reason === 'failure_cooldown'));

    // A configured 1 minute cooldown is already over after 2 minutes.
    const shortCooldown = makeBrowse(
      harness,
      adapter,
      configOverride(harness, { browse: { ...baseConfig.browse, failureCooldownMinutes: 1 } })
    );
    const shortTask = await shortCooldown.createTask({ principal: harness.owner });
    const shortResult = await shortCooldown.run({
      taskId: shortTask.id,
      principal: harness.owner
    });
    assert.equal(
      shortResult.result.skipped.some((entry) => entry.reason === 'failure_cooldown'),
      false
    );
    assert.equal(shortResult.result.failed.length, 1);

    // 0 disables the failure cooldown entirely.
    const noCooldown = makeBrowse(
      harness,
      adapter,
      configOverride(harness, { browse: { ...baseConfig.browse, failureCooldownMinutes: 0 } })
    );
    const noCooldownTask = await noCooldown.createTask({ principal: harness.owner });
    const noCooldownResult = await noCooldown.run({
      taskId: noCooldownTask.id,
      principal: harness.owner
    });
    assert.equal(
      noCooldownResult.result.skipped.some((entry) => entry.reason === 'failure_cooldown'),
      false
    );
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-1: browse.allowNoSubtitle keeps a candidate with title/description facts', async () => {
  const candidates = [mockCandidate('BV_NOSUB')];
  const { harness, adapter } = await makeBrowseHarness({ candidates });
  adapter.readContent = async (candidate) => ({
    ...candidate,
    subtitle: { text: '', lang: 'zh-CN', source: 'mock' },
    author: { accountId: '2002', name: 'author' },
    platformData: { aid: 10, cid: 20 }
  });
  try {
    const config = harness.configService.get();
    const fallbackBrowse = makeBrowse(
      harness,
      adapter,
      configOverride(harness, { browse: { ...config.browse, allowNoSubtitle: true } })
    );
    const task = await fallbackBrowse.createTask({ principal: harness.owner });
    const result = await fallbackBrowse.run({ taskId: task.id, principal: harness.owner });
    assert.equal(result.result.selected.length, 1);
    assert.equal(result.result.selected[0].subtitleFallback, true);
    assert.equal(
      result.result.skipped.some((entry) => entry.reason === 'insufficient_subtitle'),
      false
    );

    // Without the opt-in the existing skip behaviour is preserved.
    const strictHarness = await makeBrowseHarness({ candidates: [mockCandidate('BV_NOSUB2')] });
    strictHarness.adapter.readContent = async (candidate) => ({
      ...candidate,
      subtitle: { text: '', lang: 'zh-CN', source: 'mock' },
      author: { accountId: '2002', name: 'author' },
      platformData: { aid: 10, cid: 20 }
    });
    const strictBrowse = makeBrowse(strictHarness.harness, strictHarness.adapter);
    const strictTask = await strictBrowse.createTask({ principal: strictHarness.harness.owner });
    const strictResult = await strictBrowse.run({
      taskId: strictTask.id,
      principal: strictHarness.harness.owner
    });
    assert.ok(strictResult.result.skipped.some((entry) => entry.reason === 'insufficient_subtitle'));
    await strictHarness.harness.cleanup();
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* M-P1-2: parent aggregation and true interaction status              */
/* ------------------------------------------------------------------ */

async function makeCoordinatorHarness({ overrides = {}, candidates = [mockCandidate('BV1')], adapterOverrides = {} } = {}) {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      browse: { enabled: true, perRound: 2, minScore: 0, minSubtitleChars: 10 },
      comments: { enabled: true, mode: 'auto', perRound: 1, dailyLimit: 5, allowTemplate: true, maxLength: 300 },
      directMessages: { enabled: false },
      diary: { enabled: false },
      scheduler: { enabled: false, tickSeconds: 30, browseIntervalMinutes: 60, diaryTime: '23:00' },
      ...overrides
    }
  });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter({ candidates });
  Object.assign(adapter, adapterOverrides);
  const browse = new BrowseModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: harness.configService,
    now: harness.now
  });
  const comments = new CommentsModule({
    store: harness.store,
    taskManager: harness.taskManager,
    approvalService: harness.approvalService,
    adapter,
    configService: harness.configService,
    effectGateway: harness.effectGateway,
    now: harness.now
  });
  const directMessages = new DirectMessagesModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: harness.configService,
    effectGateway: harness.effectGateway,
    now: harness.now
  });
  const diary = new DiaryModule({
    store: harness.store,
    journal: harness.journal,
    configService: harness.configService,
    identity: harness.identity,
    diaryDir: harness.paths.diaryDir,
    now: harness.now
  });
  const coordinator = new Coordinator({
    store: harness.store,
    taskManager: harness.taskManager,
    identity: harness.identity,
    configService: harness.configService,
    browse,
    comments,
    directMessages,
    diary,
    now: harness.now
  });
  return { harness, adapter, browse, comments, diary, coordinator };
}

test('M-P1-2: a settled failed follow-up makes the browse parent partial, never succeeded', async () => {
  const { harness, coordinator } = await makeCoordinatorHarness({
    adapterOverrides: {
      async writeComment() {
        throw Object.assign(new Error('comment rejected'), { code: 'BILI_API_ERROR', notSent: true });
      }
    }
  });
  try {
    const round = await coordinator.runBrowse({ trigger: 'manual' });
    assert.equal(round.task.status, 'partial');
    // No unresolved child remains: the partial round is settled with a failure.
    assert.equal(round.task.isSettled, true);
    assert.equal(round.interactions.comments.length, 1);
    const interaction = round.interactions.comments[0];
    assert.equal(interaction.sent, 'failed');
    assert.equal(interaction.status, 'failed');
    assert.equal(interaction.isSettled, true);
    assert.deepEqual(round.task.result.failedChildTaskIds, [interaction.taskId]);
    const state = await harness.snapshot();
    assert.equal(state.tasks[interaction.taskId].status, 'failed');
    assert.equal(state.tasks[round.task.id].result.unresolvedTaskIds.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-2: unknown follow-up results keep the parent unknown and unsettled', async () => {
  const { harness, coordinator } = await makeCoordinatorHarness({
    adapterOverrides: {
      async writeComment() {
        throw new Error('network timeout');
      }
    }
  });
  try {
    const round = await coordinator.runBrowse({ trigger: 'manual' });
    assert.equal(round.interactions.comments[0].sent, 'unknown');
    assert.equal(round.task.status, 'unknown');
    assert.equal(round.task.isSettled, false);
    assert.equal(round.task.result.unknownChildTaskIds.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-2: a late child failure does not downgrade a completed browse parent to failed', async () => {
  const { harness, coordinator, comments } = await makeCoordinatorHarness({
    overrides: {
      comments: { enabled: true, mode: 'approval', perRound: 1, dailyLimit: 5, allowTemplate: true, maxLength: 300 }
    }
  });
  try {
    const round = await coordinator.runBrowse({ trigger: 'manual' });
    assert.equal(round.task.status, 'partial');
    const interaction = round.interactions.comments[0];
    const draftTask = (await harness.snapshot()).tasks[interaction.taskId];
    // Re-drafting the same pending target returns a fresh challenge nonce.
    const redraft = await comments.createDraft({
      candidate: {
        contentRef: draftTask.input.contentRef,
        title: draftTask.input.title,
        author: draftTask.input.author
      },
      text: draftTask.input.text,
      principal: harness.owner
    });
    assert.equal(redraft.task.id, interaction.taskId);
    await approvalDecide(harness, {
      approvalId: redraft.approval.id,
      nonce: redraft.nonce,
      decision: 'reject'
    });
    const parent = (await harness.snapshot()).tasks[round.task.id];
    assert.equal(parent.status, 'partial');
    assert.notEqual(parent.status, 'failed');
    assert.equal((await harness.snapshot()).tasks[interaction.taskId].status, 'failed');
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* M-P1-3 / M06: afterBrowse, both books, cursor, diary kind lock      */
/* ------------------------------------------------------------------ */

test('M-P1-3: browse triggers the afterBrowse diary projection when enabled', async () => {
  const { harness, coordinator } = await makeCoordinatorHarness({
    overrides: { diary: { enabled: true, afterBrowse: true, daily: true, publicBook: true, privateBook: false } }
  });
  try {
    const round = await coordinator.runBrowse({ trigger: 'manual' });
    assert.ok(round.diary);
    assert.match(round.diary.path, /\/public\/2026-11-07\.md$/);
    const state = await harness.snapshot();
    assert.ok(Object.keys(state.diaries).length > 0);
    assert.ok(round.diary.diaryId);
    const again = await coordinator.runBrowse({ trigger: 'manual' });
    assert.ok(again.diary);
    // The second round appends another browse fact for the same date, so the
    // projection is rebuilt rather than reused.
    assert.equal(again.diary.unchanged, false);
    assert.equal(again.diary.revision, 2);
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-3: afterBrowse=false leaves diary generation to explicit runs', async () => {
  const { harness, coordinator } = await makeCoordinatorHarness({
    overrides: { diary: { enabled: true, afterBrowse: false, daily: true, publicBook: true, privateBook: false } }
  });
  try {
    const round = await coordinator.runBrowse({ trigger: 'manual' });
    assert.equal(round.diary, null);
    assert.equal(Object.keys((await harness.snapshot()).diaries).length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-3: a manual daily run rebuilds each enabled book separately', async () => {
  const { harness, coordinator } = await makeCoordinatorHarness({
    overrides: { diary: { enabled: true, afterBrowse: false, daily: true, publicBook: true, privateBook: true } }
  });
  try {
    const result = await coordinator.runDiary({ date: DATE, scope: WORKSPACE_SCOPE, principal: harness.owner });
    assert.equal(result.books.length, 2);
    assert.deepEqual(result.books.map((entry) => entry.unchanged), [false, false]);
    const state = await harness.snapshot();
    const entries = Object.values(state.diaries).filter((entry) => entry.diaryId);
    assert.equal(entries.filter((entry) => entry.book === 'public').length, 1);
    assert.equal(entries.filter((entry) => entry.book === 'private').length, 1);
    // An explicitly requested book keeps the single-result shape.
    const single = await coordinator.runDiary({ date: DATE, scope: WORKSPACE_SCOPE, book: 'public', principal: harness.owner });
    assert.equal(single.facts.book, 'public');
    assert.equal(single.unchanged, true);
  } finally {
    await harness.cleanup();
  }
});

test('M06: scheduled diary goes through the diary kind lock and only advances the cursor on success', async () => {
  const { harness, coordinator, diary } = await makeCoordinatorHarness({
    overrides: {
      diary: { enabled: true, afterBrowse: false, daily: true, publicBook: true, privateBook: false },
      scheduler: { enabled: true, tickSeconds: 3600, browseIntervalMinutes: 60, diaryTime: '00:00' },
      comments: { enabled: false },
      browse: { enabled: false }
    }
  });
  const originalGenerate = diary.generate.bind(diary);
  try {
    await coordinator.start();
    diary.generate = async () => {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'simulated diary failure');
    };
    const firstTick = await coordinator.tick();
    assert.ok(firstTick.ran.includes('diary'));
    assert.equal(firstTick.outcomes.includes('diary_failed'), true);
    // Cursor is not advanced after a failure: the next tick retries.
    assert.equal((await harness.snapshot()).cursors.scheduler?.diaryLastDate, undefined);
    diary.generate = originalGenerate;
    const secondTick = await coordinator.tick();
    assert.ok(secondTick.ran.includes('diary'));
    assert.equal((await harness.snapshot()).cursors.scheduler.diaryLastDate, DATE);

    // A concurrent manual diary round occupies the diary kind lock: the timer
    // must not start a second generation (M06).
    await harness.store.transaction(async (draft) => {
      draft.cursors.scheduler = { ...(draft.cursors.scheduler || {}), diaryLastDate: null };
    });
    let manualRelease;
    const manualGate = new Promise((resolve) => {
      manualRelease = resolve;
    });
    diary.generate = async () => {
      await manualGate;
      return {};
    };
    const manual = coordinator.runDiary({ date: DATE, scope: WORKSPACE_SCOPE, book: 'public', principal: harness.owner });
    const tickDuringManual = await coordinator.tick();
    assert.ok(tickDuringManual.ran.includes('diary'));
    assert.equal(tickDuringManual.outcomes.includes('diary_failed'), true);
    assert.equal((await harness.snapshot()).cursors.scheduler?.diaryLastDate, null);
    manualRelease();
    await manual;
    diary.generate = originalGenerate;
  } finally {
    await coordinator.stop();
    await harness.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* M-P1-4 / M-P2-4: force, fact-hash narrative reuse, dirty rebuild    */
/* ------------------------------------------------------------------ */

function makeAgentSpy() {
  return {
    calls: 0,
    config: { agent: { enabled: true } },
    async generateText() {
      this.calls += 1;
      return `narrative-${this.calls}`;
    }
  };
}

async function makeDiaryHarness({ overrides = {}, agent = null } = {}) {
  const harness = await createHarness({
    overrides: {
      diary: { enabled: true, afterBrowse: true, daily: true, publicBook: true, privateBook: false },
      agent: { enabled: false },
      ...overrides
    }
  });
  await bindMockAccount(harness);
  const diary = new DiaryModule({
    store: harness.store,
    journal: harness.journal,
    configService: harness.configService,
    identity: harness.identity,
    agent,
    diaryDir: harness.paths.diaryDir,
    now: harness.now
  });
  return { harness, diary };
}

async function addFact(harness, payload = {}) {
  await harness.store.transaction(async (draft, tx) => {
    tx.appendEvent({
      type: 'browse.round.completed',
      payload: { selected: [{ contentRef: { platform: 'bilibili', contentId: 'BV1' } }], failed: [], ...payload },
      occurredAt: '2026-11-07T01:00:00.000Z'
    });
  });
}

test('M-P1-4: force rebuilds an unchanged diary even when the facts did not change', async () => {
  const { harness, diary } = await makeDiaryHarness();
  try {
    await addFact(harness);
    const first = await diary.generate({ date: DATE, scope: WORKSPACE_SCOPE, book: 'public', principal: harness.owner });
    assert.equal(first.revision, 1);
    const unchanged = await diary.generate({ date: DATE, scope: WORKSPACE_SCOPE, book: 'public', principal: harness.owner });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.revision, 1);
    const forced = await diary.generate({
      date: DATE,
      scope: WORKSPACE_SCOPE,
      book: 'public',
      force: true,
      principal: harness.owner
    });
    assert.equal(forced.unchanged, false);
    assert.equal(forced.revision, 2);
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-4: unchanged facts reuse the committed narrative without another model call', async () => {
  const agent = makeAgentSpy();
  const { harness, diary } = await makeDiaryHarness({ agent });
  try {
    await addFact(harness);
    const first = await diary.generate({ date: DATE, scope: WORKSPACE_SCOPE, book: 'public', principal: harness.owner });
    assert.equal(agent.calls, 1);
    assert.match(first.content, /narrative-1/);
    const unchanged = await diary.generate({ date: DATE, scope: WORKSPACE_SCOPE, book: 'public', principal: harness.owner });
    assert.equal(unchanged.unchanged, true);
    assert.equal(agent.calls, 1, 'no model call when the facts hash is unchanged');
    assert.equal(unchanged.revision, 1);
    // A new fact changes the facts hash and therefore rebuilds the narrative.
    await harness.store.transaction(async (draft, tx) => {
      tx.appendEvent({
        type: 'operation.unknown',
        payload: { operationId: 'op1', action: 'comment' },
        occurredAt: '2026-11-07T02:00:00.000Z'
      });
    });
    const rebuilt = await diary.generate({ date: DATE, scope: WORKSPACE_SCOPE, book: 'public', principal: harness.owner });
    assert.equal(rebuilt.unchanged, false);
    assert.equal(agent.calls, 2);
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-4: narrative generation runs before the diary identity lock is taken', async () => {
  const agent = makeAgentSpy();
  const { harness, diary } = await makeDiaryHarness({ agent });
  try {
    await addFact(harness);
    let agentCallsAtLock = null;
    const originalLock = diary._withLocalLock.bind(diary);
    diary._withLocalLock = (key, fn) => {
      if (agentCallsAtLock === null) agentCallsAtLock = agent.calls;
      return originalLock(key, fn);
    };
    const result = await diary.generate({
      date: DATE,
      scope: WORKSPACE_SCOPE,
      book: 'public',
      principal: harness.owner
    });
    assert.equal(result.revision, 1);
    assert.equal(agentCallsAtLock, 1, 'the model call happened before entering the identity lock');
  } finally {
    await harness.cleanup();
  }
});

test('M-P2-4: markDirty records __pendingRebuild and the next generate consumes it', async () => {
  const { harness, diary } = await makeDiaryHarness();
  try {
    await addFact(harness);
    const first = await diary.generate({ date: DATE, scope: WORKSPACE_SCOPE, book: 'public', principal: harness.owner });
    assert.equal(first.revision, 1);
    const before = await harness.snapshot();
    const diaryId = first.diaryId;
    await harness.store.transaction(async (draft, tx) => {
      diary.markDirty(draft, tx, {
        kind: 'operation.resolve.confirmed',
        accountRef: { platform: 'bilibili', accountId: '1001' },
        taskId: 'task_resolved',
        operationId: null,
        date: DATE
      });
    });
    const marked = await harness.snapshot();
    assert.ok(marked.diaries.__pendingRebuild);
    const markerKeys = Object.keys(marked.diaries.__pendingRebuild);
    assert.ok(markerKeys.includes(diaryId));
    const marker = marked.diaries.__pendingRebuild[diaryId];
    assert.equal(marker.date, DATE);
    assert.equal(marker.scope, WORKSPACE_SCOPE);
    assert.ok(marker.at);
    assert.ok(marked.events.some((event) => event.type === 'diary.rebuild.marked'));
    assert.equal((await diary.getStatus()).pendingRebuilds > 0, true);
    // No file/model work happened during markDirty.
    assert.equal(marked.diaries[diaryId].revision, 1);
    assert.equal(marked.diaries[diaryId].contentHash, before.diaries[diaryId].contentHash);

    const rebuilt = await diary.generate({ date: DATE, scope: WORKSPACE_SCOPE, book: 'public', principal: harness.owner });
    assert.equal(rebuilt.unchanged, false);
    assert.equal(rebuilt.revision, 2);
    const after = await harness.snapshot();
    assert.equal(after.diaries.__pendingRebuild[diaryId], undefined);
  } finally {
    await harness.cleanup();
  }
});

test('M-P2-4: a recovered diary annotates parent recovery point and gap', async () => {
  const { harness, diary } = await makeDiaryHarness();
  try {
    await harness.store.transaction(async (draft) => {
      draft.recovery = {
        ...(draft.recovery || {}),
        id: 'recovery_test',
        phase: 'released',
        revision: 1,
        holds: [],
        parent: {
          backupId: 'backup_parent',
          sourceHistoryEpoch: 'epoch_test',
          cutEventSeq: 3,
          snapshotHash: `sha256:${'a'.repeat(64)}`
        },
        uncertaintyRange: {
          startAt: '2026-11-06T00:00:00.000Z',
          endAt: null,
          open: true
        },
        missingMedia: [{ artifactId: 'artifact_missing' }]
      };
    });
    await addFact(harness);
    const generated = await diary.generate({ date: DATE, scope: WORKSPACE_SCOPE, book: 'public', principal: harness.owner });
    assert.match(generated.content, /恢复来源与缺口/);
    assert.match(generated.content, /父恢复点 backup_parent/);
    assert.match(generated.content, /缺口说明/);
    assert.match(generated.content, /缺失受保护媒体：1/);
    assert.equal(generated.facts.recovery.parent.backupId, 'backup_parent');
    assert.equal(generated.facts.recovery.derived, true);
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* M-P1-5 / M-P1-6 / M-P2-2: publisher adapter metadata, redaction, void */
/* ------------------------------------------------------------------ */

async function makePublisherHarness({ adapter = null, overrides = {} } = {}) {
  const harness = await createHarness({
    allowedCapabilities: [
      'core:read',
      'core:write',
      'platform:bilibili',
      'production:local',
      'publish:manual',
      'publish:external'
    ],
    overrides: {
      dryRun: false,
      security: { allowExternalPublisher: false, allowedSourceDirs: [] },
      publishing: {
        enabled: true,
        dryRun: false,
        requireApproval: true,
        provider: 'manual',
        outputDir: ''
      },
      ...overrides
    }
  });
  await harness.store.transaction(async (draft) => {
    draft.accounts['bilibili:1001'] = {
      accountRef: { platform: 'bilibili', accountId: '1001' },
      mid: '1001',
      uname: 'tester',
      credentialRevision: 'rev1',
      devId: 'dev_test',
      boundAt: harness.now().toISOString(),
      lastVerifiedAt: harness.now().toISOString(),
      verifiedFrom: 'whoami'
    };
    draft.activeAccountRef = { platform: 'bilibili', accountId: '1001' };
  });
  const publisher = new PublisherModule({
    store: harness.store,
    taskManager: harness.taskManager,
    approvalService: harness.approvalService,
    humanProof: harness.humanProof,
    artifactStore: harness.artifactStore,
    configService: harness.configService,
    effectGateway: harness.effectGateway,
    adapter,
    now: harness.now
  });
  const video = await harness.importFile('video.mp4', 'video', 'fake video bytes');
  const cover = await harness.importFile('cover.jpg', 'cover', 'fake cover bytes');
  return { harness, publisher, video, cover };
}

function publishJob(video, cover, overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: `publish-${Math.random()}`,
    productionTaskId: null,
    videoArtifactId: video.artifactId,
    coverArtifactId: cover.artifactId,
    accountRef: { platform: 'bilibili', accountId: '1001' },
    metadata: { title: '测试投稿', description: 'desc', tags: ['tag'], platformData: { tid: 1 } },
    provider: 'manual',
    mode: 'go',
    ...overrides
  };
}

function makeMetadataAdapter() {
  const adapter = {
    calls: 0,
    capabilities: {
      'publish.manual': {
        supported: true,
        limits: { titleMaxBytes: 80, descriptionMaxBytes: 2000, tagsMax: 12, tagLengthMax: 20, tidRequired: true }
      }
    },
    async validatePublishMetadata(metadata) {
      adapter.calls += 1;
      if (metadata.title === 'bad') {
        throw new AppError('PUBLISH_INPUT_INVALID', 'metadata.title is rejected by the adapter', {
          details: { field: 'metadata.title' }
        });
      }
      return { ...metadata, title: ` ${metadata.title.trim()} ` };
    }
  };
  return adapter;
}

test('M-P1-5: publisher prefers adapter.validatePublishMetadata and falls back without it', async () => {
  const adapter = makeMetadataAdapter();
  const { harness, publisher, video, cover } = await makePublisherHarness({ adapter });
  try {
    const created = await publisher.create(publishJob(video, cover), harness.owner);
    assert.equal(adapter.calls, 1);
    assert.equal(created.task.input.metadata.title, '测试投稿');
    await assert.rejects(
      () => publisher.create(publishJob(video, cover, { metadata: { title: 'bad', tags: [], platformData: { tid: 1 } } }), harness.owner),
      (error) => error.code === 'PUBLISH_INPUT_INVALID' && error.details.field === 'metadata.title'
    );
    assert.equal(adapter.calls, 2);
  } finally {
    await harness.cleanup();
  }

  // Fallback validation is kept when no adapter is wired.
  const fallback = await makePublisherHarness();
  try {
    const longTitle = 'x'.repeat(81);
    await assert.rejects(
      () =>
        fallback.publisher.create(
          publishJob(fallback.video, fallback.cover, {
            metadata: { title: longTitle, tags: [], platformData: { tid: 1 } }
          }),
          fallback.harness.owner
        ),
      (error) => error.code === 'PUBLISH_INPUT_INVALID'
    );
  } finally {
    await fallback.harness.cleanup();
  }
});

test('M-P2-2: publish input rejects schemaVersion/unknown fields/approved', async () => {
  const { harness, publisher, video, cover } = await makePublisherHarness();
  try {
    await assert.rejects(
      () => publisher.create(publishJob(video, cover, { schemaVersion: 2 }), harness.owner),
      (error) => error.code === 'SCHEMA_UNSUPPORTED'
    );
    await assert.rejects(
      () => publisher.create(publishJob(video, cover, { approved: true }), harness.owner),
      (error) => error.code === 'PUBLISH_INPUT_INVALID' && /approved/.test(error.message)
    );
    await assert.rejects(
      () => publisher.create(publishJob(video, cover, { videoPath: '/etc/passwd' }), harness.owner),
      (error) => error.code === 'PUBLISH_INPUT_INVALID' && error.details.fields.includes('videoPath')
    );
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-5: external publisher output is redacted before it can reach an Operation', async () => {
  const { harness, publisher } = await makePublisherHarness();
  try {
    const redacted = publisher._redactExternalOutput(
      'SESSDATA=secret-sessdata-value\nAuthorization: bearer top-secret-token\nplain output line'
    );
    assert.equal(redacted.includes('secret-sessdata-value'), false);
    assert.equal(redacted.includes('top-secret-token'), false);
    assert.match(redacted, /SESSDATA=\[redacted\]/);
    assert.match(redacted, /Authorization=\[redacted\]/);
    assert.match(redacted, /plain output line/);
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-6: markNotPublished voids an awaiting_manual task, keeps the bundle and is idempotent', async () => {
  const { harness, publisher, video, cover } = await makePublisherHarness();
  try {
    const created = await publisher.create(publishJob(video, cover), harness.owner);
    await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
    const prepared = await publisher.prepare({ taskId: created.task.id, mode: 'go', principal: harness.owner });
    assert.equal(prepared.task.status, 'awaiting_manual');
    const bundleMetadata = path.join(prepared.bundleDir, 'metadata.json');
    assert.ok(await fsp.stat(bundleMetadata));

    await assert.rejects(
      () => publisher.markNotPublished({ taskId: created.task.id, reason: 'not uploaded' }),
      (error) => error.code === 'TRUST_UNAVAILABLE'
    );
    const voided = await publisher.markNotPublished(
      { taskId: created.task.id, reason: 'not uploaded', note: 'owner checked creator studio' },
      harness.humanContext
    );
    assert.equal(voided.task.status, 'cancelled');
    assert.equal(voided.publish.status, 'void');
    assert.equal(voided.publish.voidReason, 'not uploaded');
    assert.ok(voided.publish.statusHistory.some((entry) => entry.status === 'void'));
    assert.ok(await fsp.stat(bundleMetadata), 'bundle is retained after void');
    const state = await harness.snapshot();
    assert.ok(state.events.some((event) => event.type === 'publish.manual.voided'));
    assert.equal(state.tasks[created.task.id].result.voided, true);
    assert.equal(state.tasks[created.task.id].isSettled, true);

    const again = await publisher.markNotPublished(
      { taskId: created.task.id, reason: 'not uploaded' },
      harness.humanContext
    );
    assert.equal(again.deduplicated, true);
    await assert.rejects(
      () => publisher.markNotPublished({ taskId: created.task.id, reason: 'different reason' }, harness.humanContext),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-6: markNotPublished refuses tasks that are not awaiting manual', async () => {
  const { harness, publisher, video, cover } = await makePublisherHarness();
  try {
    const created = await publisher.create(publishJob(video, cover), harness.owner);
    await assert.rejects(
      () => publisher.markNotPublished({ taskId: created.task.id, reason: 'too early' }, harness.humanContext),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* I6: gateway resolve hook calls diary.markDirty                      */
/* ------------------------------------------------------------------ */

test('I6: resolving an unknown operation marks the diary dirty through the gateway service hook', async () => {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      owner: { mid: 0, name: 'owner' },
      comments: {
        enabled: true,
        mode: 'auto',
        perRound: 1,
        dailyLimit: 10,
        sameVideoDays: 7,
        maxLength: 300,
        allowTemplate: true
      }
    }
  });
  await bindMockAccount(harness);
  harness.configService.config.diary.enabled = true;
  await harness.configService.syncRevision();
  const adapter = makeMockAdapter({
    candidates: [mockCandidate('BV1')]
  });
  adapter.writeComment = async () => {
    throw new Error('network timeout');
  };
  const commentsModule = new CommentsModule({
    store: harness.store,
    taskManager: harness.taskManager,
    approvalService: harness.approvalService,
    adapter,
    configService: harness.configService,
    effectGateway: harness.effectGateway,
    now: harness.now
  });
  const diary = new DiaryModule({
    store: harness.store,
    journal: harness.journal,
    configService: harness.configService,
    identity: harness.identity,
    diaryDir: harness.paths.diaryDir,
    now: harness.now
  });
  // Same lazy service wiring the runtime uses for the I6 hook.
  harness.effectGateway.services = { diary };
  try {
    const draft = await commentsModule.createDraft({
      candidate: mockCandidate('BV1'),
      text: 'mark dirty via resolve',
      principal: harness.owner
    });
    const sent = await commentsModule.send({ taskId: draft.task.id, mode: 'go', principal: harness.owner });
    assert.equal(sent.operation.status, 'unknown');
    const resolved = await harness.effectGateway.resolve(
      {
        operationId: sent.operation.id,
        decision: 'not_sent',
        note: 'owner confirmed the comment never left the machine'
      },
      harness.humanContext
    );
    assert.equal(resolved.operation.status, 'not_sent');
    const marked = await harness.snapshot();
    assert.ok(marked.diaries.__pendingRebuild);
    assert.ok(Object.keys(marked.diaries.__pendingRebuild).length > 0);
    assert.ok(marked.events.some((event) => event.type === 'diary.rebuild.marked'));
    const generated = await diary.generate({
      date: DATE,
      scope: WORKSPACE_SCOPE,
      book: 'public',
      principal: harness.owner
    });
    assert.equal(generated.unchanged, false);
  } finally {
    await harness.cleanup();
  }
});


async function makeCommentsHarness({ comments = {}, adapterOverrides = {} } = {}) {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      owner: { mid: 0, name: 'owner' },
      comments: {
        enabled: true,
        mode: 'approval',
        perRound: 3,
        dailyLimit: 10,
        sameVideoDays: 7,
        maxLength: 300,
        allowTemplate: false,
        ...comments
      }
    }
  });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter();
  Object.assign(adapter, adapterOverrides);
  const commentsModule = new CommentsModule({
    store: harness.store,
    taskManager: harness.taskManager,
    approvalService: harness.approvalService,
    adapter,
    configService: harness.configService,
    effectGateway: harness.effectGateway,
    now: harness.now
  });
  return { harness, adapter, comments: commentsModule };
}

test('M-P1-7: caller supplied platformData is ignored and the adapter resolved aid/cid is bound', async () => {
  const { harness, adapter, comments } = await makeCommentsHarness();
  try {
    const candidate = mockCandidate('BV1', { platformData: { aid: 9999, cid: 7777 } });
    const draft = await comments.createDraft({ candidate, text: 'adapter resolved', principal: harness.owner });
    const task = (await harness.snapshot()).tasks[draft.task.id];
    assert.deepEqual(task.input.platformData, { aid: 1234, cid: 5678 });
    const expectedHash = computeInputHash({
      action: 'comment.send',
      input: {
        contentRef: task.input.contentRef,
        platformData: task.input.platformData,
        text: task.input.text,
        root: 0,
        parent: 0
      },
      target: { platform: 'bilibili', accountId: '1001', contentId: 'BV1' },
      feeCapMinor: 0
    });
    assert.equal(task.inputHash, expectedHash);
    assert.notEqual(
      expectedHash,
      computeInputHash({
        action: 'comment.send',
        input: { contentRef: task.input.contentRef, text: task.input.text, root: 0, parent: 0 },
        target: { platform: 'bilibili', accountId: '1001', contentId: 'BV1' },
        feeCapMinor: 0
      }),
      'resolved aid/cid must be covered by the input hash'
    );
    await approvalDecide(harness, { approvalId: draft.approval.id, nonce: draft.nonce });
    await comments.send({ taskId: draft.task.id, mode: 'go', principal: harness.owner });
    assert.equal(adapter.calls.writeComment.length, 1);
    assert.equal(adapter.calls.writeComment[0].candidate.contentId, 'BV1');
    assert.equal(adapter.calls.writeComment[0].text, 'adapter resolved');
    assert.ok(adapter.calls.readContent.length >= 1, 'the adapter resolved the write target');
  } finally {
    await harness.cleanup();
  }
});

test('M-P1-7: an unresolved Bilibili aid is rejected instead of using caller data', async () => {
  const { harness, comments } = await makeCommentsHarness({
    adapterOverrides: {
      async readContent(candidate) {
        return { ...candidate, subtitle: null, platformData: {}, author: { accountId: '2002', name: 'author' } };
      }
    }
  });
  try {
    await assert.rejects(
      () =>
        comments.createDraft({
          candidate: mockCandidate('BV1', { platformData: { aid: 9999, cid: 1 } }),
          text: 'should fail',
          principal: harness.owner
        }),
      (error) => error.code === 'INPUT_REQUIRED' && /aid/.test(error.message)
    );
  } finally {
    await harness.cleanup();
  }
});

test('M-P2-5: a changed draft text revises the pending task through taskManager.reviseInput', async () => {
  const { harness, adapter, comments } = await makeCommentsHarness();
  try {
    const first = await comments.createDraft({
      candidate: mockCandidate('BV1'),
      text: 'first text',
      principal: harness.owner
    });
    const second = await comments.createDraft({
      candidate: mockCandidate('BV1'),
      text: 'second text',
      principal: harness.owner
    });
    assert.equal(second.task.id, first.task.id);
    assert.equal(second.reused, true);
    assert.equal(second.revised, true);
    const state = await harness.snapshot();
    const task = state.tasks[first.task.id];
    assert.equal(task.revision, 2);
    assert.equal(task.input.text, 'second text');
    const firstApproval = state.approvals[first.approval.id];
    assert.ok(firstApproval.supersededAt);
    assert.ok(second.approval.id);
    assert.notEqual(second.approval.id, first.approval.id);
    await approvalDecide(harness, { approvalId: second.approval.id, nonce: second.nonce });
    const sent = await comments.send({ taskId: first.task.id, mode: 'go', principal: harness.owner });
    assert.equal(sent.operation.status, 'confirmed');
    assert.equal(adapter.calls.writeComment.length, 1);
    assert.equal(adapter.calls.writeComment[0].text, 'second text');
  } finally {
    await harness.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* M-P2-1: DM cooldown goes through the gateway reservation (I7)       */
/* ------------------------------------------------------------------ */

test('M-P2-1: confirmed DM state passes the same-recipient cooldown into reserveOperation', async () => {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      directMessages: {
        enabled: true,
        allowedRecipientMids: [2002],
        requireMutual: true,
        perRound: 1,
        dailyLimit: 10,
        sameVideoDays: 7,
        maxLength: 300
      }
    }
  });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter();
  const reservations = [];
  const gateway = {
    executeOperation(reservation, execute, options) {
      reservations.push(reservation);
      return harness.effectGateway.executeOperation(reservation, execute, options);
    }
  };
  const directMessages = new DirectMessagesModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: harness.configService,
    effectGateway: gateway,
    now: harness.now
  });
  try {
    // A previously confirmed (out-of-window) DM target is the case where the
    // gateway must enforce the cooldown window in the reservation transaction.
    const targetKey = 'dm-target:bilibili:1001:2002';
    await harness.store.transaction(async (draft) => {
      draft.businessKeys[targetKey] = {
        key: targetKey,
        namespace: 'platform',
        type: 'dm',
        status: 'confirmed',
        confirmedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
    });
    const first = await directMessages.send({
      content: mockCandidate('BV1'),
      recipientMid: 2002,
      text: 'first dm',
      mode: 'go',
      principal: harness.owner
    });
    assert.equal(first.operation.status, 'confirmed');
    assert.equal(reservations.length, 1);
    assert.deepEqual(reservations[0].cooldown, {
      businessKey: targetKey,
      days: 7
    });
    harness.now.advance(121000);
    await assert.rejects(
      () =>
        directMessages.send({
          content: mockCandidate('BV1'),
          recipientMid: 2002,
          text: 'second dm',
          mode: 'go',
          principal: harness.owner
        }),
      (error) => error.code === 'DUPLICATE_TARGET'
    );
  } finally {
    await harness.cleanup();
  }
});

test('M-P2-1: permanent DM cooldown (0 days) never passes an invalid zero-day cooldown', async () => {
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      directMessages: {
        enabled: true,
        allowedRecipientMids: [2002],
        requireMutual: true,
        perRound: 1,
        dailyLimit: 10,
        sameVideoDays: 0,
        maxLength: 300
      }
    }
  });
  await bindMockAccount(harness);
  const adapter = makeMockAdapter();
  const reservations = [];
  const gateway = {
    executeOperation(reservation, execute, options) {
      reservations.push(reservation);
      return harness.effectGateway.executeOperation(reservation, execute, options);
    }
  };
  const directMessages = new DirectMessagesModule({
    store: harness.store,
    taskManager: harness.taskManager,
    adapter,
    configService: harness.configService,
    effectGateway: gateway,
    now: harness.now
  });
  try {
    const first = await directMessages.send({
      content: mockCandidate('BV2'),
      recipientMid: 2002,
      text: 'permanent once',
      mode: 'go',
      principal: harness.owner
    });
    assert.equal(first.operation.status, 'confirmed');
    assert.equal(reservations[0].cooldown, undefined);
    await assert.rejects(
      () =>
        directMessages.send({
          content: mockCandidate('BV2'),
          recipientMid: 2002,
          text: 'permanent twice',
          mode: 'go',
          principal: harness.owner
        }),
      (error) => error.code === 'DUPLICATE_TARGET'
    );
  } finally {
    await harness.cleanup();
  }
});
