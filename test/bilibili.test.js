import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BilibiliClient,
  mixinKey,
  signWbi
} from '../src/bilibili.js';
import { createMockFetch, responseJson, NAV_WBI } from './helpers/mock-fetch.js';
import { AppError } from '../src/errors.js';
import { makeReceipt } from '../src/contracts.js';

const config = {
  comments: { maxLength: 300 },
  directMessages: { maxLength: 300 },
  rateLimit: { requestTimeoutMs: 5000 }
};

function clientWith(fetchImpl, overrides = {}) {
  return new BilibiliClient({
    config,
    credentials: { sessdata: 'S', bili_jct: 'J', buvid3: 'B', dedeuserid: '1001' },
    fetchImpl,
    now: () => new Date('2026-11-07T00:00:00Z'),
    operationContextVerifier: { verify() {} },
    deviceId: 'dev_1',
    ...overrides
  });
}

const context = {
  operationId: 'op_1',
  businessKey: 'k',
  action: 'comment',
  inputHash: 'hash',
  accountRef: { platform: 'bilibili', accountId: '1001' },
  permit: 'dispatch-once'
};

test('WBI signing is deterministic, filters params and requires keys', () => {
  const images = {
    img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
  };
  const signed = signWbi({ bvid: 'BV1', empty: '', nested: "a!'()*" }, images, 1700000000000);
  assert.equal(signed.wts, '1700000000');
  assert.equal(signed.empty, undefined);
  assert.equal(signed.nested, 'a');
  assert.equal(signed.w_rid.length, 32);
  assert.equal(mixinKey({ wbi_img: images }).length, 32);
  assert.throws(() => signWbi({}, {}, 1700000000000), (error) => error.code === 'BILI_API_ERROR');
});

test('whoami, popular, video details and relation parse business receipts', async () => {
  const fetchImpl = createMockFetch(async (call) => {
    const url = new URL(call.url);
    if (url.pathname.endsWith('/nav')) return responseJson(NAV_WBI);
    if (url.pathname.endsWith('/popular')) {
      return responseJson({ code: 0, data: { list: [{ bvid: 'BV1', title: 't' }] } });
    }
    if (url.pathname.endsWith('/view')) {
      return responseJson({ code: 0, data: { bvid: 'BV1', aid: 1, cid: 2, title: 't', owner: { mid: 9 } } });
    }
    if (url.pathname.endsWith('/relation')) {
      return responseJson({ code: 0, data: { attribute: 6 } });
    }
    return responseJson({ code: -404, message: 'no' });
  });
  const client = clientWith(fetchImpl);
  assert.deepEqual(await client.whoami(), { mid: 1001, uname: 'tester', isLogin: true });
  assert.equal((await client.popular(5)).length, 1);
  assert.equal((await client.videoDetails('BV1')).aid, 1);
  assert.equal((await client.relation(9)).mutual, true);
  const navCall = fetchImpl.calls.find((call) => call.url.includes('/nav'));
  assert.match(navCall.headers.cookie, /SESSDATA=S/);
});

test('subtitles only use allowed HTTPS hosts and never send cookies', async () => {
  const subtitleUrl = 'https://i0.hdslb.com/bfs/subtitle/a.json';
  const fetchImpl = createMockFetch(async (call) => {
    if (call.url.includes('/player/v2')) {
      return responseJson({
        code: 0,
        data: { subtitle: { subtitles: [{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: subtitleUrl }] } }
      });
    }
    if (call.url === subtitleUrl) {
      return responseJson({ body: [{ content: '第一句' }, { content: '第二句' }] });
    }
    return responseJson(NAV_WBI);
  });
  const client = clientWith(fetchImpl);
  const subtitle = await client.subtitles({ bvid: 'BV1', cid: 2 });
  assert.equal(subtitle.text, '第一句\n第二句');
  const subtitleCall = fetchImpl.calls.find((call) => call.url === subtitleUrl);
  assert.equal(subtitleCall.headers.cookie, undefined);
});

test('read retries once, write never retries, and non-zero code is not success', async () => {
  let reads = 0;
  const retrying = createMockFetch(async () => {
    reads += 1;
    if (reads === 1) return responseJson({ code: 0, data: {} }, { status: 503 });
    return responseJson(NAV_WBI);
  });
  const client = clientWith(retrying);
  await client.whoami();
  assert.equal(reads, 2);

  let writes = 0;
  const failingWrite = createMockFetch(async () => {
    writes += 1;
    return responseJson({ code: -400, message: 'bad' });
  });
  const writer = clientWith(failingWrite);
  await assert.rejects(
    () => writer.sendComment({ aid: 1, bvid: 'BV1', text: 'hello', operationContext: context }),
    (error) => error.code === 'BILI_API_ERROR'
  );
  assert.equal(writes, 1);
});

test('comment and DM writes require a context and return structured receipts', async () => {
  const fetchImpl = createMockFetch(async (call) => {
    if (call.url.includes('/reply/add')) return responseJson({ code: 0, data: { rpid: 42 } });
    if (call.url.includes('/send_msg')) return responseJson({ code: 0, data: { msg_key: 'm1' } });
    return responseJson({ code: 0, data: {} });
  });
  const client = clientWith(fetchImpl);
  const comment = await client.sendComment({ aid: 1, bvid: 'BV1', text: 'hello', operationContext: context });
  assert.equal(comment.externalId, '42');
  assert.equal(comment.verification, 'platform_readback');
  const dm = await client.sendDirectMessage({
    recipientMid: 2,
    text: 'hi',
    operationContext: context
  });
  assert.equal(dm.externalId, 'm1');
  const dmBody = new URLSearchParams(fetchImpl.calls.find((call) => call.url.includes('/send_msg')).body);
  assert.equal(dmBody.get('msg[dev_id]'), 'dev_1');
  await assert.rejects(
    () => client.sendComment({ aid: 1, text: 'x', operationContext: null }),
    (error) => error.code === 'FORBIDDEN'
  );
});

test('risk control invokes the circuit callback and never uses empty WBI keys', async () => {
  let risk = null;
  const fetchImpl = createMockFetch(async (call) => {
    if (call.url.includes('/search/type')) return responseJson({ code: -412 }, { status: 200 });
    if (call.url.includes('/nav')) return responseJson(NAV_WBI);
    return responseJson({ code: 0, data: {} });
  });
  const client = clientWith(fetchImpl, { onRisk: async (value) => { risk = value; } });
  await assert.rejects(() => client.search('x', 5), (error) => error.code === 'BILI_API_ERROR');
  assert.equal(risk.code, -412);
});

test('empty WBI keys are rejected rather than signing with an empty key', async () => {
  const fetchImpl = createMockFetch(async () => responseJson({ code: 0, data: { wbi_img: { img_url: '', sub_url: '' } } }));
  const client = clientWith(fetchImpl);
  await assert.rejects(() => client.search('x', 5), (error) => error.code === 'BILI_API_ERROR');
});
