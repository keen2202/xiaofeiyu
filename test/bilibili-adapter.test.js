import test from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliPlatformAdapter } from '../src/adapters/platforms/bilibili.js';
import { BilibiliClient } from '../src/bilibili.js';
import { createHarness, bindMockAccount } from './helpers/harness.js';
import { createMockFetch, responseJson, NAV_WBI } from './helpers/mock-fetch.js';

test('capabilities declare dm.receive=false and no metadata-only publish', async () => {
  const harness = await createHarness();
  try {
    await bindMockAccount(harness);
    const client = new BilibiliClient({ config: harness.config, credentials: {} });
    const adapter = new BilibiliPlatformAdapter({
      client,
      store: harness.store,
      configService: harness.configService,
      rateLimiter: harness.rateLimiter,
      now: harness.now
    });
    assert.equal(adapter.capabilities['dm.receive'].supported, false);
    assert.equal(adapter.capabilities['read.content'].supported, true);
    assert.equal(adapter.capabilities['publish.external'].supported, false);
    await assert.rejects(() => adapter.preparePublish({}), (error) => error.code === 'CAPABILITY_UNSUPPORTED');
  } finally {
    await harness.cleanup();
  }
});

test('discover maps raw popular/search data into platform-neutral candidates', async () => {
  const harness = await createHarness();
  try {
    await bindMockAccount(harness);
    const fetchImpl = createMockFetch(async (call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith('/popular')) {
        return responseJson({
          code: 0,
          data: { list: [{ bvid: 'BV1', aid: 1, cid: 2, title: 'T', desc: 'D', duration: 30, owner: { mid: 7, name: 'up' } }] }
        });
      }
      if (url.pathname.endsWith('/nav')) return responseJson(NAV_WBI);
      if (url.pathname.endsWith('/search/type')) {
        return responseJson({
          code: 0,
          data: { result: [{ bvid: 'BV1', aid: 1, title: '<em>T</em>', description: 'D', duration: '30', mid: 7, author: 'up' }] }
        });
      }
      return responseJson({ code: 0, data: {} });
    });
    const client = new BilibiliClient({
      config: harness.config,
      credentials: { sessdata: 'S', bili_jct: 'J' },
      fetchImpl,
      now: harness.now
    });
    const adapter = new BilibiliPlatformAdapter({
      client,
      store: harness.store,
      configService: harness.configService,
      rateLimiter: harness.rateLimiter,
      now: harness.now
    });
    const candidates = await adapter.discover({ sources: ['popular', 'search'], keywords: ['x'], limit: 10 });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].contentRef.contentId, 'BV1');
    assert.equal(candidates[0].author.accountId, '7');
    assert.equal(candidates[0].title, 'T');
  } finally {
    await harness.cleanup();
  }
});

test('adapter refuses a write context for a different account', async () => {
  const harness = await createHarness();
  try {
    await bindMockAccount(harness);
    const adapter = new BilibiliPlatformAdapter({
      client: new BilibiliClient({ config: harness.config, credentials: {} }),
      store: harness.store,
      configService: harness.configService,
      rateLimiter: harness.rateLimiter,
      now: harness.now
    });
    await assert.rejects(
      () =>
        adapter.writeComment({
          candidate: { contentRef: { platform: 'bilibili', contentId: 'BV1' }, platformData: { aid: 1 } },
          text: 'x',
          operationContext: { accountRef: { platform: 'bilibili', accountId: '9999' } }
        }),
      (error) => error.code === 'FORBIDDEN'
    );
  } finally {
    await harness.cleanup();
  }
});

test('publish metadata limits are declared and validated by the adapter (I8)', async () => {
  const harness = await createHarness();
  try {
    await bindMockAccount(harness);
    const adapter = new BilibiliPlatformAdapter({
      client: new BilibiliClient({ config: harness.config, credentials: {} }),
      store: harness.store,
      configService: harness.configService,
      rateLimiter: harness.rateLimiter,
      now: harness.now
    });
    assert.deepEqual(adapter.capabilities['publish.manual'].limits, {
      nativeUpload: false,
      titleMaxBytes: 80,
      descriptionMaxBytes: 2000,
      tagsMax: 12,
      tagLengthMax: 20,
      tidRequired: true
    });
    const normalized = await adapter.validatePublishMetadata({
      title: ' 标题 ',
      description: ' 简介 ',
      tags: [' a ', 'a', ''],
      platformData: { tid: 1, extra: 'kept' }
    });
    assert.deepEqual(normalized, {
      title: '标题',
      description: '简介',
      tags: ['a'],
      platformData: { tid: 1, extra: 'kept' }
    });
    const field = (expected) => (error) =>
      error.code === 'PUBLISH_INPUT_INVALID' && error.details.field === expected;
    await assert.rejects(() => adapter.validatePublishMetadata(null), field('metadata'));
    await assert.rejects(
      () => adapter.validatePublishMetadata({ title: ' '.repeat(3), platformData: { tid: 1 } }),
      field('metadata.title')
    );
    await assert.rejects(
      () => adapter.validatePublishMetadata({ title: 'x'.repeat(81), platformData: { tid: 1 } }),
      field('metadata.title')
    );
    // The declared limit is bytes, so CJK titles are bounded by UTF-8 bytes.
    await assert.rejects(
      () => adapter.validatePublishMetadata({ title: '中'.repeat(27), platformData: { tid: 1 } }),
      field('metadata.title')
    );
    await assert.rejects(
      () =>
        adapter.validatePublishMetadata({
          title: 'ok',
          description: 'x'.repeat(2001),
          platformData: { tid: 1 }
        }),
      field('metadata.description')
    );
    await assert.rejects(
      () => adapter.validatePublishMetadata({ title: 'ok' }),
      field('metadata.platformData.tid')
    );
    await assert.rejects(
      () => adapter.validatePublishMetadata({ title: 'ok', platformData: { tid: 0 } }),
      field('metadata.platformData.tid')
    );
    await assert.rejects(
      () =>
        adapter.validatePublishMetadata({
          title: 'ok',
          tags: Array.from({ length: 13 }, (_, index) => `tag${index}`),
          platformData: { tid: 1 }
        }),
      field('metadata.tags')
    );
    await assert.rejects(
      () =>
        adapter.validatePublishMetadata({
          title: 'ok',
          tags: ['x'.repeat(21)],
          platformData: { tid: 1 }
        }),
      field('metadata.tags')
    );
    assert.doesNotThrow(() =>
      adapter.validatePublishMetadata({ title: '中'.repeat(26), platformData: { tid: 1 } })
    );
  } finally {
    await harness.cleanup();
  }
});

test('adapter verifies mutual follow once and passes mutualVerified to the client (G-P1-8)', async () => {
  const harness = await createHarness();
  try {
    await bindMockAccount(harness);
    const calls = { relation: [], sent: [] };
    const client = {
      async relation(mid) {
        calls.relation.push(mid);
        return { mutual: true, attribute: 6 };
      },
      async sendDirectMessage(args) {
        calls.sent.push(args);
        return { externalId: 'msg_1' };
      }
    };
    const adapter = new BilibiliPlatformAdapter({
      client,
      store: harness.store,
      configService: harness.configService,
      rateLimiter: harness.rateLimiter,
      now: harness.now
    });
    await adapter.sendDirectMessage({
      recipientMid: 2002,
      text: 'hi',
      operationContext: { accountRef: { platform: 'bilibili', accountId: '1001' } }
    });
    assert.deepEqual(calls.relation, [2002]);
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.sent[0].mutualVerified, true);
    assert.equal(calls.sent[0].requireMutual, true);
    // The dead adapter-level read/risk shims were removed; wiring is owned by
    // the runtime so there is only one implementation (G-P2-6).
    assert.equal(adapter._beforeRead, undefined);
    assert.equal(adapter._onRisk, undefined);
  } finally {
    await harness.cleanup();
  }
});
