import { AppError } from './errors.js';
import { makeReceipt } from './contracts.js';
import { md5Hex, nowIso } from './utils.js';

export const BILI_ALLOWED_COOKIE_HOSTS = Object.freeze(['api.bilibili.com', 'api.vc.bilibili.com']);
export const BILI_RISK_CODES = Object.freeze([-412, -352, -799, -509, -10403]);
export const BILI_AUTH_CODES = Object.freeze([-101, -111]);
// Business errors that reject the request outright (invalid parameters/auth scope):
// the platform creates no effect, so a write may be settled as not_sent.
export const BILI_REJECTED_CODES = Object.freeze([-400, -403, -404]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Retry-After may be delta-seconds or an HTTP-date (SPEC §7.4). */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).trim();
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.round(numeric * 1000);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed - nowMs);
}

function isRedirectStatus(status) {
  return REDIRECT_STATUSES.has(Number(status));
}

/** Standard WBI mixin permutation table. */
export const WBI_MIXIN_KEY_ENC_TAB = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]);

export function extractWbiKey(imageUrl) {
  if (typeof imageUrl !== 'string' || imageUrl === '') {
    throw new AppError('BILI_API_ERROR', 'invalid WBI image URL');
  }
  try {
    const url = new URL(imageUrl);
    const name = url.pathname.split('/').filter(Boolean).at(-1) || '';
    return name.split('.')[0];
  } catch {
    return imageUrl.split('/').filter(Boolean).at(-1)?.split('.')[0] || '';
  }
}

export function mixinKey(wbiImg) {
  const images = wbiImg?.wbi_img || wbiImg;
  const imgKey = images?.imgKey || extractWbiKey(images?.img_url || '');
  const subKey = images?.subKey || extractWbiKey(images?.sub_url || '');
  if (!imgKey || !subKey) throw new AppError('BILI_API_ERROR', 'WBI keys are missing');
  const raw = `${imgKey}${subKey}`;
  return WBI_MIXIN_KEY_ENC_TAB.map((index) => raw[index] || '').join('').slice(0, 32);
}

export function signWbi(params, images, now = Date.now()) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new AppError('BILI_API_ERROR', 'WBI params must be an object');
  }
  const key = mixinKey(images);
  const clean = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    clean[name] = String(value).replace(/[!'()*]/g, '');
  }
  const wts = Math.floor((typeof now === 'number' ? now : now.getTime()) / 1000);
  clean.wts = String(wts);
  const query = Object.keys(clean)
    .sort()
    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(clean[name])}`)
    .join('&');
  const w_rid = md5Hex(`${query}${key}`);
  return { ...clean, w_rid };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isAllowedSubtitleUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return (
      host === 'bilibili.com' ||
      host.endsWith('.bilibili.com') ||
      host === 'hdslb.com' ||
      host.endsWith('.hdslb.com') ||
      host.endsWith('.bilivideo.com')
    );
  } catch {
    return false;
  }
}

export class BilibiliClient {
  constructor({
    config,
    credentials,
    store = null,
    rateLimiter = null,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    logger,
    onRisk = null,
    onAuthFailure = null,
    beforeRead = null,
    operationContextVerifier = null,
    mutualVerifier = null,
    deviceId = null,
    deviceIdProvider = null,
    timeoutMs = null
  } = {}) {
    this.config = config;
    this.credentials = credentials || {};
    this.store = store;
    this.rateLimiter = rateLimiter;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.onRisk = onRisk;
    this.onAuthFailure = onAuthFailure;
    this.beforeRead = beforeRead;
    this.operationContextVerifier = operationContextVerifier;
    this.mutualVerifier = mutualVerifier;
    this.deviceId = deviceId;
    this.deviceIdProvider = deviceIdProvider;
    this._explicitTimeoutMs = timeoutMs;
    this.timeoutMs = timeoutMs ?? config?.rateLimit?.requestTimeoutMs ?? 30000;
    this.wbiCache = null;
    this._deviceIdFallback = null;
  }

  /**
   * Apply a committed configuration revision at runtime (SPEC §4.5). The
   * credentials object is owned by the caller and can be updated separately
   * after a successful account verification.
   */
  reconfigure(config) {
    if (!config || typeof config !== 'object') {
      throw new AppError('CONFIG_INVALID', 'BilibiliClient.reconfigure requires a configuration object');
    }
    this.config = config;
    if (this._explicitTimeoutMs === null || this._explicitTimeoutMs === undefined) {
      this.timeoutMs = config?.rateLimit?.requestTimeoutMs ?? this.timeoutMs;
    }
    return this;
  }

  setCredentials(credentials) {
    this.credentials = credentials || {};
    return this;
  }

  _activeRateKey(state) {
    return state?.activeAccountRef ? `bilibili:${state.activeAccountRef.accountId}` : 'bilibili:unverified';
  }

  _cookieHeader(url) {
    if (!this.credentials?.sessdata) return null;
    if (!BILI_ALLOWED_COOKIE_HOSTS.includes(hostOf(url))) return null;
    const parts = [`SESSDATA=${this.credentials.sessdata}`];
    if (this.credentials.bili_jct) parts.push(`bili_jct=${this.credentials.bili_jct}`);
    if (this.credentials.buvid3) parts.push(`buvid3=${this.credentials.buvid3}`);
    if (this.credentials.dedeuserid) parts.push(`DedeUserID=${this.credentials.dedeuserid}`);
    return parts.join('; ');
  }

  async _beforeRead(info = {}) {
    if (typeof this.beforeRead === 'function') return this.beforeRead(info);
    return this._defaultReserveRead(info);
  }

  /**
   * Default wiring used when the runtime injects the SPEC §8.1 `store` and
   * `rateLimiter` instead of callbacks. Retries reserve the quota again but do
   * not wait for the read time slot they already consumed.
   */
  async _defaultReserveRead(info = {}) {
    if (!this.store || !this.rateLimiter) return null;
    const state = await this.store.getSnapshot();
    const key = this._activeRateKey(state);
    return this.store.transaction(async (draft) =>
      this.rateLimiter.reserveRead(draft, {
        key,
        limits: this.config?.rateLimit || {},
        enforceGap: info.retry !== true
      })
    );
  }

  async _notifyRisk(code, retryAfterMs = 0) {
    if (typeof this.onRisk === 'function') {
      try {
        await this.onRisk({ code, retryAfterMs });
      } catch (error) {
        if (this.logger) this.logger.warn?.('bilibili risk callback failed', { message: error.message });
      }
      return;
    }
    if (!this.store) return;
    try {
      const state = await this.store.getSnapshot();
      if (!state.activeAccountRef) return;
      const key = this._activeRateKey(state);
      await this.store.transaction(async (draft, tx) => {
        this.rateLimiter?.recordRisk?.(draft, key, {
          code,
          retryAfterMs,
          reason: 'bilibili_risk_control'
        });
        tx.appendEvent({
          type: 'bilibili.circuit.opened',
          actor: 'system',
          accountRef: state.activeAccountRef,
          payload: { code, retryAfterMs }
        });
      });
    } catch (error) {
      if (this.logger) this.logger.warn?.('bilibili risk persistence failed', { message: error.message });
    }
  }

  /** SPEC §7.4: an invalid login becomes a persistent manual pause. */
  async _notifyAuthFailure(code) {
    if (typeof this.onAuthFailure === 'function') {
      try {
        await this.onAuthFailure({ code });
      } catch (error) {
        if (this.logger) this.logger.warn?.('bilibili auth callback failed', { message: error.message });
      }
      return;
    }
    if (!this.store) return;
    try {
      const state = await this.store.getSnapshot();
      if (!state.activeAccountRef) return;
      const key = this._activeRateKey(state);
      await this.store.transaction(async (draft, tx) => {
        if (typeof this.rateLimiter?.markAuthPaused === 'function') {
          this.rateLimiter.markAuthPaused(draft, key, {
            code,
            reason: 'bilibili_login_invalid',
            at: nowIso(this.now)
          });
        } else if (draft.accounts?.[key]) {
          draft.accounts[key].authPausedAt = nowIso(this.now);
          draft.accounts[key].authPausedReason = 'bilibili_login_invalid';
          draft.accounts[key].authPausedCode = String(code);
        }
        tx.appendEvent({
          type: 'bilibili.auth.paused',
          actor: 'system',
          accountRef: state.activeAccountRef,
          payload: { code: Number(code), accountKey: key }
        });
      });
    } catch (error) {
      if (this.logger) this.logger.warn?.('bilibili auth pause persistence failed', { message: error.message });
    }
  }

  /**
   * Cookie-bearing requests must never leak the session cookie across a
   * redirect (SPEC §5.2). They use `redirect: 'manual'` and may only follow a
   * redirect when every hop stays on the cookie whitelist and the request is a
   * replay-safe GET or HEAD.
   */
  async _fetchWithCookiePolicy(url, init, cookie) {
    if (!cookie) {
      return this.fetchImpl(url, { ...init, redirect: 'follow' });
    }
    const method = String(init.method || 'GET').toUpperCase();
    let currentUrl = String(url);
    let response = await this.fetchImpl(currentUrl, { ...init, redirect: 'manual' });
    if (!isRedirectStatus(response.status)) return response;
    if (method !== 'GET' && method !== 'HEAD') {
      throw new AppError('FORBIDDEN', 'a cookie-bearing write must not be redirected', {
        retryable: false,
        details: { httpStatus: response.status, method }
      });
    }
    for (let hop = 0; hop < 3; hop += 1) {
      const location = response.headers?.get?.('location');
      if (!location) {
        throw new AppError('BILI_API_ERROR', 'redirect response has no location header', {
          retryable: false,
          details: { httpStatus: response.status }
        });
      }
      let target;
      try {
        target = new URL(location, currentUrl);
      } catch {
        throw new AppError('FORBIDDEN', 'cookie-bearing request redirect target is invalid', {
          retryable: false
        });
      }
      if (target.protocol !== 'https:' || !BILI_ALLOWED_COOKIE_HOSTS.includes(target.hostname)) {
        throw new AppError('FORBIDDEN', 'cookie redirect to a non-whitelisted host is rejected', {
          retryable: false,
          details: { from: hostOf(currentUrl), to: target.hostname, protocol: target.protocol }
        });
      }
      currentUrl = target.toString();
      response = await this.fetchImpl(currentUrl, { ...init, redirect: 'manual' });
      if (!isRedirectStatus(response.status)) return response;
    }
    throw new AppError('BILI_API_ERROR', 'too many redirects for a cookie-bearing request', {
      retryable: false
    });
  }

  async _rawRequest(url, { method = 'GET', headers = {}, body = undefined, read = false } = {}) {
    const cookie = this._cookieHeader(url);
    const requestHeaders = {
      accept: 'application/json, text/plain, */*',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      referer: 'https://www.bilibili.com/',
      ...headers
    };
    if (cookie) requestHeaders.cookie = cookie;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), this.timeoutMs);
    try {
      const response = await this._fetchWithCookiePolicy(
        url,
        { method, headers: requestHeaders, body, signal: controller.signal },
        cookie
      );
      const text = await response.text();
      if (text.length > 20 * 1024 * 1024) {
        throw new AppError('BILI_API_ERROR', 'Bilibili response is too large');
      }
      const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'), this.now().getTime());
      // Risk-control pages are frequently HTML, so the HTTP status must be
      // classified before any JSON parsing (SPEC §7.4).
      if (response.status === 412 || response.status === 429) {
        await this._notifyRisk(response.status, retryAfterMs);
        throw new AppError('BILI_API_ERROR', 'Bilibili risk control triggered', {
          retryable: false,
          details: { httpStatus: response.status, retryAfterMs }
        });
      }
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (!json || typeof json !== 'object') {
        throw new AppError('BILI_API_ERROR', 'Bilibili response is not JSON', {
          retryable: !response.ok && response.status >= 500,
          details: { httpStatus: response.status }
        });
      }
      const riskCode = Number(json.code);
      if (BILI_RISK_CODES.includes(riskCode)) {
        await this._notifyRisk(riskCode, retryAfterMs);
        throw new AppError('BILI_API_ERROR', 'Bilibili risk control triggered', {
          retryable: false,
          details: { httpStatus: response.status, biliCode: riskCode, retryAfterMs }
        });
      }
      if (!response.ok) {
        throw new AppError('BILI_API_ERROR', `Bilibili HTTP ${response.status}`, {
          retryable: read && response.status >= 500,
          details: { httpStatus: response.status }
        });
      }
      if (json.code !== undefined && Number(json.code) !== 0) {
        const biliCode = Number(json.code);
        if (BILI_AUTH_CODES.includes(biliCode)) {
          await this._notifyAuthFailure(biliCode);
          throw new AppError('CREDENTIAL_MISSING', 'Bilibili login is required', {
            retryable: false,
            details: { biliCode }
          });
        }
        const rejected = BILI_REJECTED_CODES.includes(biliCode);
        throw Object.assign(
          new AppError('BILI_API_ERROR', json.message || `Bilibili error ${json.code}`, {
            retryable: false,
            details: { biliCode }
          }),
          rejected ? { notSent: true } : {}
        );
      }
      return json;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('BILI_API_ERROR', 'Bilibili request failed', {
        cause: error,
        retryable: read,
        details: { networkError: true }
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async _request(url, options = {}) {
    const maxAttempts = options.read ? 2 : 1;
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        // Every read attempt reserves quota again; retries do not wait for the
        // read time slot they already consumed (SPEC §7.1).
        if (options.read) await this._beforeRead({ attempt, retry: attempt > 0 });
        return await this._rawRequest(url, options);
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= maxAttempts || !options.read || error.retryable !== true) break;
        // Quota/time-slot waits are scheduling decisions, not transient errors;
        // retrying immediately would bypass the slot that just blocked.
        if (error.code === 'RATE_LIMITED' || error.code === 'QUOTA_EXCEEDED') break;
      }
    }
    throw lastError;
  }

  async _wbiKeys({ force = false } = {}) {
    const nowMs = this.now().getTime();
    if (!force && this.wbiCache && this.wbiCache.expiresAt > nowMs) return this.wbiCache;
    const json = await this._request('https://api.bilibili.com/x/web-interface/nav', { read: true });
    const images = json?.data?.wbi_img;
    if (!images?.img_url || !images?.sub_url) {
      throw new AppError('BILI_API_ERROR', 'WBI images are unavailable (empty keys are forbidden)');
    }
    this.wbiCache = {
      wbi_img: {
        img_url: images.img_url,
        sub_url: images.sub_url,
        imgKey: extractWbiKey(images.img_url),
        subKey: extractWbiKey(images.sub_url)
      },
      expiresAt: nowMs + 10 * 60 * 1000
    };
    return this.wbiCache;
  }

  async whoami() {
    const json = await this._request('https://api.bilibili.com/x/web-interface/nav', { read: true });
    const data = json.data || {};
    if (data.isLogin !== true) {
      await this._notifyAuthFailure(-101);
      throw new AppError('CREDENTIAL_MISSING', 'Bilibili session is not logged in', { retryable: false });
    }
    return { mid: Number(data.mid), uname: data.uname || '', isLogin: true };
  }

  async popular(limit = 20) {
    const url = new URL('https://api.bilibili.com/x/web-interface/popular');
    url.searchParams.set('ps', String(Math.max(1, Math.min(Number(limit) || 20, 100))));
    url.searchParams.set('pn', '1');
    const json = await this._request(url.toString(), { read: true });
    return Array.isArray(json.data?.list) ? json.data.list : [];
  }

  async search(keyword, limit = 20) {
    if (typeof keyword !== 'string' || keyword.trim() === '') {
      throw new AppError('INPUT_REQUIRED', 'search keyword is required');
    }
    const wbi = await this._wbiKeys();
    const params = signWbi(
      {
        search_type: 'video',
        keyword: keyword.trim(),
        page: 1,
        page_size: Math.max(1, Math.min(Number(limit) || 20, 50))
      },
      wbi.wbi_img,
      this.now()
    );
    const url = new URL('https://api.bilibili.com/x/web-interface/wbi/search/type');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const json = await this._request(url.toString(), { read: true });
    return Array.isArray(json.data?.result) ? json.data.result : [];
  }

  async videoDetails(bvid) {
    if (typeof bvid !== 'string' || bvid === '') throw new AppError('INPUT_REQUIRED', 'bvid is required');
    const wbi = await this._wbiKeys();
    const params = signWbi({ bvid }, wbi.wbi_img, this.now());
    const url = new URL('https://api.bilibili.com/x/web-interface/wbi/view');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const json = await this._request(url.toString(), { read: true });
    if (!json.data?.bvid) throw new AppError('BILI_API_ERROR', 'video details are unavailable');
    return json.data;
  }

  async subtitles({ bvid, cid }) {
    if (!bvid || !cid) throw new AppError('INPUT_REQUIRED', 'bvid and cid are required');
    const url = new URL('https://api.bilibili.com/x/player/v2');
    url.searchParams.set('bvid', String(bvid));
    url.searchParams.set('cid', String(cid));
    const json = await this._request(url.toString(), { read: true });
    const list = json.data?.subtitle?.subtitles || [];
    if (list.length === 0) return null;
    const preferred =
      list.find((entry) => String(entry.lan).startsWith('zh')) ||
      list.find((entry) => String(entry.lan).startsWith('ai-zh')) ||
      list[0];
    if (!preferred?.subtitle_url || !isAllowedSubtitleUrl(preferred.subtitle_url)) {
      throw new AppError('BILI_API_ERROR', 'subtitle URL is not an allowed HTTPS Bilibili domain');
    }
    let subtitleText;
    if (preferred.subtitle_url.startsWith('//')) {
      throw new AppError('BILI_API_ERROR', 'protocol-relative subtitle URLs are rejected');
    }
    await this._beforeRead();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('subtitle timeout')), this.timeoutMs);
    try {
      const response = await this.fetchImpl(preferred.subtitle_url, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-bili-unified' },
        signal: controller.signal
      });
      if (!response.ok) throw new AppError('BILI_API_ERROR', 'subtitle download failed');
      const text = await response.text();
      const parsed = JSON.parse(text);
      subtitleText = (parsed.body || [])
        .map((entry) => String(entry.content || '').trim())
        .filter(Boolean)
        .join('\n');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('BILI_API_ERROR', 'subtitle download failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }
    return {
      text: subtitleText,
      lang: preferred.lan,
      source: `bilibili:${preferred.lan_doc || preferred.lan}`
    };
  }

  async comments(aid, limit = 20) {
    if (!aid) throw new AppError('INPUT_REQUIRED', 'aid is required');
    const url = new URL('https://api.bilibili.com/x/v2/reply');
    url.searchParams.set('type', '1');
    url.searchParams.set('oid', String(aid));
    url.searchParams.set('pn', '1');
    url.searchParams.set('ps', String(Math.max(1, Math.min(Number(limit) || 20, 50))));
    url.searchParams.set('sort', '2');
    const json = await this._request(url.toString(), { read: true });
    return Array.isArray(json.data?.replies) ? json.data.replies : [];
  }

  async relation(mid) {
    if (!mid) throw new AppError('INPUT_REQUIRED', 'mid is required');
    const url = new URL('https://api.bilibili.com/x/relation');
    url.searchParams.set('fid', String(mid));
    const json = await this._request(url.toString(), { read: true });
    const attribute = Number(json.data?.attribute) || 0;
    return {
      attribute,
      mutual: attribute === 6 || json.data?.be_relation === 1,
      followedByTarget: (attribute & 2) === 2,
      followsTarget: (attribute & 4) === 4
    };
  }

  _verifyOperationContext(context) {
    if (!this.operationContextVerifier) {
      throw new AppError('FORBIDDEN', 'Bilibili writes require a core-issued OperationContext');
    }
    if (typeof this.operationContextVerifier === 'function') {
      this.operationContextVerifier(context);
    } else if (typeof this.operationContextVerifier.verify === 'function') {
      this.operationContextVerifier.verify(context);
    } else {
      throw new AppError('FORBIDDEN', 'OperationContext verifier is invalid');
    }
    if (!context?.accountRef || context.accountRef.platform !== 'bilibili') {
      throw new AppError('FORBIDDEN', 'OperationContext has no Bilibili account');
    }
    return context;
  }

  _csrf() {
    if (!this.credentials?.bili_jct) throw new AppError('CREDENTIAL_MISSING', 'bili_jct (CSRF) is missing');
    return this.credentials.bili_jct;
  }

  async sendComment({ aid, bvid, text, root = 0, parent = 0, operationContext }) {
    this._verifyOperationContext(operationContext);
    const message = String(text ?? '').trim();
    const maxLength = this.config?.comments?.maxLength ?? 300;
    if (message.length === 0) throw new AppError('INPUT_REQUIRED', 'comment text is required');
    if (message.length > maxLength) {
      throw new AppError('INPUT_REQUIRED', `comment text exceeds ${maxLength} characters`);
    }
    if (!aid) throw new AppError('INPUT_REQUIRED', 'aid is required for comment writes');
    const body = new URLSearchParams();
    body.set('oid', String(aid));
    body.set('type', '1');
    body.set('message', message);
    body.set('plat', '1');
    body.set('csrf', this._csrf());
    if (root) body.set('root', String(root));
    if (parent) body.set('parent', String(parent));
    const json = await this._request('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      read: false,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = json.data || {};
    const rpid = data.rpid ?? data.rpid_str;
    if (rpid === undefined || rpid === null) {
      throw Object.assign(new AppError('OPERATION_UNKNOWN', 'comment response did not include rpid'), {
        notSent: false
      });
    }
    return makeReceipt({
      platform: 'bilibili',
      accountId: operationContext.accountRef.accountId,
      action: 'comment',
      externalId: String(rpid),
      url: bvid ? `https://www.bilibili.com/video/${bvid}#reply${rpid}` : null,
      verification: 'platform_readback',
      receivedAt: this.now().toISOString()
    });
  }

  /**
   * Mutual-follow is enforced at the protocol layer, not only in the adapter
   * (SPEC §8.5). Callers that already verified the relation pass
   * `mutualVerified: true`; everybody else is checked here through an injected
   * verifier or the relation read API.
   */
  async assertMutualFollow(recipientMid, { mutualVerified = false } = {}) {
    if (mutualVerified === true) return true;
    let relation;
    if (typeof this.mutualVerifier === 'function') {
      relation = await this.mutualVerifier({ recipientMid: String(recipientMid) });
    } else {
      relation = await this.relation(recipientMid);
    }
    if (!relation?.mutual) {
      throw new AppError('MUTUAL_FOLLOW_REQUIRED', 'recipient is not a mutual follow', { retryable: false });
    }
    return true;
  }

  async sendDirectMessage({
    recipientMid,
    text,
    operationContext,
    requireMutual = true,
    mutualVerified = false
  }) {
    this._verifyOperationContext(operationContext);
    const message = String(text ?? '').trim();
    const maxLength = this.config?.directMessages?.maxLength ?? 300;
    if (message.length === 0) throw new AppError('INPUT_REQUIRED', 'DM text is required');
    if (message.length > maxLength) throw new AppError('INPUT_REQUIRED', `DM text exceeds ${maxLength} characters`);
    const self = String(operationContext.accountRef.accountId);
    if (String(recipientMid) === self) throw new AppError('FORBIDDEN', 'cannot direct-message yourself');
    if (requireMutual) await this.assertMutualFollow(recipientMid, { mutualVerified });
    const deviceId = this.deviceIdProvider ? await this.deviceIdProvider() : this.deviceId;
    if (!deviceId) throw new AppError('DEPENDENCY_UNAVAILABLE', 'stable DM device id is unavailable');
    const body = new URLSearchParams();
    body.set('msg[sender_uid]', String(operationContext.accountRef.accountId));
    body.set('msg[receiver_id]', String(recipientMid));
    body.set('msg[receiver_type]', '1');
    body.set('msg[msg_type]', '1');
    body.set('msg[dev_id]', deviceId);
    body.set('msg[timestamp]', String(Math.floor(this.now().getTime() / 1000)));
    body.set('msg[content]', JSON.stringify({ content: message }));
    body.set('csrf', this._csrf());
    body.set('csrf_token', this._csrf());
    const json = await this._request('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
      method: 'POST',
      read: false,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = json.data || {};
    const msgKey = data.msg_key ?? data.msgKey ?? data.msgid;
    if (msgKey === undefined || msgKey === null) {
      throw Object.assign(new AppError('OPERATION_UNKNOWN', 'DM response did not include a message key'), {
        notSent: false
      });
    }
    return makeReceipt({
      platform: 'bilibili',
      accountId: operationContext.accountRef.accountId,
      action: 'dm',
      externalId: String(msgKey),
      url: null,
      verification: 'platform_readback',
      receivedAt: this.now().toISOString()
    });
  }
}

export default BilibiliClient;
