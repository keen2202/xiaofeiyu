import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigService } from '../../src/config.js';
import { DEFAULT_CONFIG, computeConfigHash } from '../../src/config.js';
import { JsonStore, DEFAULT_ALLOWED_CAPABILITIES } from '../../src/store.js';
import { EventJournal } from '../../src/event-journal.js';
import { TaskManager } from '../../src/task-manager.js';
import { HumanProofService, IdentityService } from '../../src/identity.js';
import { ApprovalService } from '../../src/approval.js';
import { RateLimiter } from '../../src/rate-limiter.js';
import { EffectGateway } from '../../src/effect-gateway.js';
import { ArtifactStore } from '../../src/artifact-store.js';
import { deepMerge, nowIso, randomId } from '../../src/utils.js';

export const FIXED_NOW = new Date('2026-11-07T00:00:00.000Z');

export function makeClock(start = FIXED_NOW) {
  let current = new Date(start);
  const now = () => new Date(current);
  now.advance = (ms) => {
    current = new Date(current.getTime() + ms);
    return now();
  };
  now.set = (value) => {
    current = new Date(value);
  };
  return now;
}

export class AlwaysHumanVerifier {
  constructor() {
    this.calls = 0;
  }
  async verify(proof, binding) {
    this.calls += 1;
    return proof?.kind === 'test' && proof.ok === true;
  }
}

export async function createHarness({
  overrides = {},
  now = makeClock(),
  protection = 'protected',
  verifier = new AlwaysHumanVerifier(),
  allowedCapabilities = [...DEFAULT_ALLOWED_CAPABILITIES],
  workspaceId = 'workspace_test',
  historyEpoch = 'epoch_test'
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-test-'));
  const config = deepMerge(DEFAULT_CONFIG, overrides);
  config.dataDir = dir;
  const configService = new ConfigService({ dataDir: dir, injected: config, env: {}, now });
  const loaded = await configService.load();
  const store = new JsonStore({
    file: loaded.paths.stateFile,
    instanceFile: loaded.paths.instanceFile,
    now,
    lockTimeoutMs: 1500,
    staleLockMs: 5000
  });
  await store.init({
    bootstrap: true,
    workspaceId,
    historyEpoch,
    configRevision: { version: 1, sha256: computeConfigHash(loaded.config) },
    timeZone: loaded.config.timeZone,
    allowedCapabilities
  });
  configService.store = store;
  await configService.syncRevision({ bootstrap: true });
  const journal = new EventJournal({ store, dir: loaded.paths.journalDir, now });
  const taskManager = new TaskManager({ store, now });
  const identity = new IdentityService({ store, now });
  const humanProof = new HumanProofService({ verifier });
  const approvalService = new ApprovalService({ store, taskManager, identity, humanProof, now });
  const rateLimiter = new RateLimiter({ now, getTimeZone: () => configService.get().timeZone });
  const artifactStore = new ArtifactStore({
    store,
    rootDir: loaded.paths.artifactsDir,
    workDir: loaded.paths.workDir,
    configService,
    now
  });
  const protectionProvider =
    typeof protection === 'function'
      ? { getProtection: protection }
      : {
          async getProtection() {
            if (protection === 'protected') {
              return {
                status: 'protected',
                backupId: 'backup_test',
                kind: 'ledger',
                cutAt: new Date(now().getTime() - 60000).toISOString(),
                ageMs: 60000
              };
            }
            if (protection === 'unprotected') return { status: 'unprotected', reason: 'test_unprotected' };
            if (protection === 'degraded') return { status: 'degraded', reason: 'test_stale', ageMs: 9999999 };
            return { status: protection, reason: 'test' };
          }
        };
  const effectGateway = new EffectGateway({
    store,
    taskManager,
    approvalService,
    identity,
    humanProof,
    rateLimiter,
    configService,
    protection: protectionProvider,
    now
  });
  const owner = await store.transaction(async (draft, tx) => identity.ensureLocalOwner(tx));
  const humanContext = { principal: owner, proof: { kind: 'test', ok: true } };
  const cleanup = async () => {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  };
  const sourceDir = path.join(dir, 'sources');
  await fs.mkdir(sourceDir, { recursive: true });
  return {
    dir,
    config,
    configService,
    store,
    journal,
    taskManager,
    identity,
    humanProof,
    verifier,
    approvalService,
    rateLimiter,
    artifactStore,
    effectGateway,
    protectionProvider,
    owner,
    humanContext,
    paths: loaded.paths,
    sourceDir,
    now,
    cleanup,
    async snapshot() {
      return store.getSnapshot();
    },
    async makeSourceFile(name, content) {
      const file = path.join(sourceDir, name);
      await fs.writeFile(file, content);
      return file;
    },
    async importFile(name, role, content) {
      const file = await this.makeSourceFile(name, content);
      const previous = loaded.config.security.allowedSourceDirs;
      configService.config.security.allowedSourceDirs = [sourceDir];
      try {
        return await artifactStore.importFile({ sourcePath: file, role, principal: owner });
      } finally {
        configService.config.security.allowedSourceDirs = previous;
      }
    }
  };
}

export function makeMockAdapter({ candidates = [], readSubtitle = '这是一个足够长的字幕内容，用于测试确定性评分和后续互动。'.repeat(4) } = {}) {
  const calls = { discover: [], readContent: [], writeComment: [], sendDirectMessage: [], relation: [], checkRecipient: [] };
  const adapter = {
    name: 'mock-bilibili',
    calls,
    capabilities: {
      'read.content': { supported: true, limits: {} },
      'read.comments': { supported: true, limits: {} },
      'write.comment': { supported: true, limits: {} },
      'dm.send': { supported: true, limits: {} },
      'dm.receive': { supported: false, reason: 'inbox_not_in_scope' },
      'publish.manual': { supported: true, limits: {} },
      'publish.external': { supported: false, reason: 'not_verified' }
    },
    async verifyAccount() {
      return { accountRef: { platform: 'bilibili', accountId: '1001' }, profile: { mid: '1001', uname: 'tester' } };
    },
    async discover(args) {
      calls.discover.push(args);
      return structuredClone(candidates);
    },
    async readContent(candidate) {
      calls.readContent.push(candidate.contentRef.contentId);
      return {
        ...structuredClone(candidate),
        subtitle: { text: readSubtitle, lang: 'zh-CN', source: 'mock' },
        author: candidate.author || { accountId: '2002', name: 'author' },
        platformData: { aid: Number(candidate.platformData?.aid) || 1234, cid: Number(candidate.platformData?.cid) || 5678 }
      };
    },
    async readComments() {
      return [];
    },
    async writeComment({ candidate, text, operationContext }) {
      calls.writeComment.push({ candidate: candidate.contentRef, text, operationContext });
      return {
        platform: 'bilibili',
        accountId: operationContext.accountRef.accountId,
        action: 'comment',
        externalId: `rpid_${calls.writeComment.length}`,
        url: `https://www.bilibili.com/video/${candidate.contentRef.contentId}#reply1`,
        verification: 'platform_readback',
        receivedAt: nowIso()
      };
    },
    async checkRecipient(args) {
      calls.checkRecipient.push(args);
      return { allowed: true };
    },
    async sendDirectMessage({ recipientMid, text, operationContext }) {
      calls.sendDirectMessage.push({ recipientMid, text, operationContext });
      return {
        platform: 'bilibili',
        accountId: operationContext.accountRef.accountId,
        action: 'dm',
        externalId: `msg_${calls.sendDirectMessage.length}`,
        url: null,
        verification: 'platform_readback',
        receivedAt: nowIso()
      };
    },
    async relation(mid) {
      calls.relation.push(mid);
      return { mutual: true, attribute: 6 };
    }
  };
  return adapter;
}

export function mockCandidate(bvid = 'BV1xx411c7mD', overrides = {}) {
  return {
    contentRef: { platform: 'bilibili', contentId: bvid },
    title: '测试视频标题',
    description: '测试视频简介，包含关键词',
    author: { accountId: '2002', name: '作者' },
    durationSec: 300,
    score: 0,
    source: 'popular',
    platformData: { aid: 1234, cid: 5678 },
    ...overrides
  };
}

export async function bindMockAccount(harness) {
  const account = {
    accountRef: { platform: 'bilibili', accountId: '1001' },
    mid: '1001',
    uname: 'tester',
    credentialRevision: 'rev1',
    devId: 'dev_test',
    boundAt: nowIso(harness.now),
    lastVerifiedAt: nowIso(harness.now),
    verifiedFrom: 'whoami'
  };
  await harness.store.transaction(async (draft, tx) => {
    draft.accounts['bilibili:1001'] = account;
    draft.activeAccountRef = { platform: 'bilibili', accountId: '1001' };
    tx.appendEvent({ type: 'test.account.bound', actor: 'test', payload: { accountId: '1001' } });
  });
  return account;
}

export function approvalDecide(harness, { approvalId, nonce, decision = 'approve' }) {
  return harness.approvalService.decide(
    { approvalId, decision, nonce, mode: 'go' },
    harness.humanContext
  );
}
