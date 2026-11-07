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
