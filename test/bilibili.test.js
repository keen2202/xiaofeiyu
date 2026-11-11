import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BilibiliClient,
  mixinKey,
  parseRetryAfterMs,
  signWbi
} from '../src/bilibili.js';
import { createMockFetch, responseJson, NAV_WBI } from './helpers/mock-fetch.js';
import { createHarness } from './helpers/harness.js';
import { AppError } from '../src/errors.js';
import { makeReceipt } from '../src/contracts.js';
import { nowIso } from '../src/utils.js';

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

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      redirect: options.redirect || null
    });
    return handler(calls.at(-1), calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function redirectResponse(location, status = 302) {
  return {
    ok: false,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'location' ? location : null;
      }
    },
    async text() {
      return '';
    }
  };
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
    if (call.url.includes('/relation')) return responseJson({ code: 0, data: { attribute: 6 } });
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
  // The protocol layer verifies mutual follow itself when the caller has not.
  assert.equal(fetchImpl.calls.filter((call) => call.url.includes('/relation')).length, 1);
  const dmBody = new URLSearchParams(fetchImpl.calls.find((call) => call.url.includes('/send_msg')).body);
  assert.equal(dmBody.get('msg[sender_uid]'), '1001');
  assert.equal(dmBody.get('msg[receiver_id]'), '2');
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

test('Retry-After accepts delta-seconds and HTTP-date forms', () => {
  const nowMs = Date.parse('2026-11-07T00:00:00Z');
  assert.equal(parseRetryAfterMs('120', nowMs), 120000);
  assert.equal(parseRetryAfterMs('Sat, 07 Nov 2026 00:05:00 GMT', nowMs), 300000);
  assert.equal(parseRetryAfterMs('garbage', nowMs), 0);
  assert.equal(parseRetryAfterMs(null, nowMs), 0);
});

test('non-JSON HTTP 412 risk pages open the circuit with an HTTP-date delay and no retry', async () => {
  const riskCalls = [];
  const fetchImpl = createMockFetch(() =>
    responseJson('<html>risk control</html>', {
      status: 412,
      headers: { 'retry-after': 'Sat, 07 Nov 2026 00:05:00 GMT' }
    })
  );
  const client = clientWith(fetchImpl, { onRisk: async (value) => riskCalls.push(value) });
  await assert.rejects(
    () => client.whoami(),
    (error) => error.code === 'BILI_API_ERROR' && error.retryable === false
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(riskCalls, [{ code: 412, retryAfterMs: 300000 }]);
});

test('HTTP 429 plain-text bodies honour delta-seconds Retry-After', async () => {
  const riskCalls = [];
  const fetchImpl = createMockFetch(() =>
    responseJson('too many requests', { status: 429, headers: { 'retry-after': '60' } })
  );
  const client = clientWith(fetchImpl, { onRisk: async (value) => riskCalls.push(value) });
  await assert.rejects(() => client.popular(5), (error) => error.code === 'BILI_API_ERROR' && error.retryable === false);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(riskCalls, [{ code: 429, retryAfterMs: 60000 }]);
});

test('login failure (-101) notifies the auth pause hook and is never retried', async () => {
  const failures = [];
  const fetchImpl = createMockFetch(() => responseJson({ code: -101, message: 'not logged in' }));
  const client = clientWith(fetchImpl, { onAuthFailure: async (value) => failures.push(value) });
  await assert.rejects(
    () => client.whoami(),
    (error) => error.code === 'CREDENTIAL_MISSING' && error.retryable === false
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(failures, [{ code: -101 }]);
});

test('read retries reserve read quota again and skip the read time slot', async () => {
  let reads = 0;
  const beforeReadCalls = [];
  const fetchImpl = createMockFetch(async () => {
    reads += 1;
    if (reads === 1) return responseJson({ code: 0, data: {} }, { status: 503 });
    return responseJson(NAV_WBI);
  });
  const client = clientWith(fetchImpl, { beforeRead: async (info) => beforeReadCalls.push(info) });
  await client.whoami();
  assert.equal(reads, 2);
  assert.deepEqual(beforeReadCalls.map((info) => [info.attempt, info.retry]), [[0, false], [1, true]]);
});

test('default store/rateLimiter wiring waits outside the transaction for the read time slot', async () => {
  const harness = await createHarness();
  try {
    await harness.store.transaction(async (draft) => {
      draft.accounts['bilibili:1001'] = {
        accountRef: { platform: 'bilibili', accountId: '1001' },
        mid: '1001',
        uname: 'tester',
        credentialRevision: 'rev',
        devId: 'dev_1',
        boundAt: nowIso(harness.now),
        lastVerifiedAt: nowIso(harness.now),
        verifiedFrom: 'whoami'
      };
      draft.activeAccountRef = { platform: 'bilibili', accountId: '1001' };
    });
    const fetchImpl = createMockFetch(async () => responseJson(NAV_WBI));
    const client = new BilibiliClient({
      config: harness.config,
      credentials: { sessdata: 'S', bili_jct: 'J' },
      fetchImpl,
      now: harness.now,
      store: harness.store,
      rateLimiter: harness.rateLimiter,
      sleep: async ms => { harness.now.advance(ms); }
    });
    await client.whoami();
    const callsAfterFirst = fetchImpl.calls.length;
    await client.whoami();
    assert.equal(fetchImpl.calls.length, callsAfterFirst + 1);
    harness.now.advance(harness.config.rateLimit.minGapMs + 1);
    await client.whoami();
  } finally {
    await harness.cleanup();
  }
});

test('cookie requests use manual redirects and reject non-whitelisted targets', async () => {
  const fetchImpl = recordingFetch(() => redirectResponse('https://evil.example/collect'));
  const client = clientWith(fetchImpl);
  await assert.rejects(() => client.whoami(), (error) => error.code === 'FORBIDDEN');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].redirect, 'manual');
  assert.match(fetchImpl.calls[0].headers.cookie, /SESSDATA=S/);
});

test('whitelisted redirects are followed with the cookie', async () => {
  const fetchImpl = recordingFetch((call, count) => {
    if (count === 1) return redirectResponse('https://api.bilibili.com/x/web-interface/nav2');
    return responseJson(NAV_WBI);
  });
  const client = clientWith(fetchImpl);
  const profile = await client.whoami();
  assert.equal(profile.mid, 1001);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].redirect, 'manual');
  assert.match(fetchImpl.calls[1].headers.cookie, /SESSDATA=S/);
});

test('cookie-bearing writes are never replayed across a redirect', async () => {
  const fetchImpl = recordingFetch(() => redirectResponse('https://api.bilibili.com/x/v2/reply/add'));
  const client = clientWith(fetchImpl);
  await assert.rejects(
    () => client.sendComment({ aid: 1, text: 'hi', operationContext: context }),
    (error) => error.code === 'FORBIDDEN'
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('reconfigure applies a committed configuration at runtime', () => {
  const client = clientWith(createMockFetch(async () => responseJson({ code: 0, data: {} })));
  const next = {
    comments: { maxLength: 10 },
    directMessages: { maxLength: 10 },
    rateLimit: { requestTimeoutMs: 1234 }
  };
  client.reconfigure(next);
  assert.equal(client.config.comments.maxLength, 10);
  assert.equal(client.timeoutMs, 1234);
  assert.throws(() => client.reconfigure(null), (error) => error.code === 'CONFIG_INVALID');
});

test('DM mutual-follow is enforced at the protocol layer unless the adapter verified it', async () => {
  const fetchImpl = createMockFetch(async (call) => {
    if (call.url.includes('/relation')) return responseJson({ code: 0, data: { attribute: 0 } });
    return responseJson({ code: 0, data: { msg_key: 'm1' } });
  });
  const client = clientWith(fetchImpl);
  await assert.rejects(
    () => client.sendDirectMessage({ recipientMid: 2, text: 'hi', operationContext: context }),
    (error) => error.code === 'MUTUAL_FOLLOW_REQUIRED'
  );
  assert.equal(fetchImpl.calls.some((call) => call.url.includes('/send_msg')), false);

  const verifiedFetch = createMockFetch(async () => responseJson({ code: 0, data: { msg_key: 'm2' } }));
  const verifiedClient = clientWith(verifiedFetch);
  const receipt = await verifiedClient.sendDirectMessage({
    recipientMid: 2,
    text: 'hi',
    operationContext: context,
    mutualVerified: true
  });
  assert.equal(receipt.externalId, 'm2');
  assert.equal(verifiedFetch.calls.some((call) => call.url.includes('/relation')), false);
});

test('injected mutual verifier replaces the relation read for DM writes', async () => {
  const fetchImpl = createMockFetch(async () => responseJson({ code: 0, data: { msg_key: 'm3' } }));
  const checks = [];
  const client = clientWith(fetchImpl, {
    mutualVerifier: async ({ recipientMid }) => {
      checks.push(recipientMid);
      return { mutual: true };
    }
  });
  const receipt = await client.sendDirectMessage({ recipientMid: '2002', text: 'hi', operationContext: context });
  assert.equal(receipt.externalId, 'm3');
  assert.deepEqual(checks, ['2002']);
  assert.equal(fetchImpl.calls.some((call) => call.url.includes('/relation')), false);
  const rejecting = clientWith(fetchImpl, { mutualVerifier: async () => ({ mutual: false }) });
  await assert.rejects(
    () => rejecting.sendDirectMessage({ recipientMid: 2002, text: 'hi', operationContext: context }),
    (error) => error.code === 'MUTUAL_FOLLOW_REQUIRED'
  );
});
