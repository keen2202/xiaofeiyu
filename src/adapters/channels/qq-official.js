import { AppError } from '../../errors.js';
import { nowIso } from '../../utils.js';

/**
 * Optional transport for the **official QQ bot platform** (bot.q.qq.com /
 * api.bot.qq.com). This is a different protocol from OneBot v11:
 * - AppID + ClientSecret are read from environment variables and exchanged for
 *   a short-lived `access_token` (`POST /app/getAppAccessToken`);
 * - API calls use `Authorization: QQBot <access_token>`;
 * - events arrive over the gateway WebSocket (`GET /gateway` → op10 Hello →
 *   op2 Identify with intents `GROUP_AND_C2C_EVENT`);
 * - private messages are addressed by `user_openid` and replies use
 *   `POST /v2/users/{openid}/messages` with `msg_id`/`msg_seq`.
 *
 * The plugin bundles no QQ SDK: it only speaks the documented HTTP/WS API. The
 * official platform cannot prove human identity, so events carry
 * `humanAssurance: 'unverified'` and IM approvals stay fail-closed. No delivery
 * query API exists, so delivery ids are only recorded from send responses.
 */

export const QQ_OFFICIAL_TRANSPORT = 'qq-official';
export const DEFAULT_API_BASE = 'https://api.bot.qq.com';
export const DEFAULT_INTENTS = 1 << 25; // GROUP_AND_C2C_EVENT
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_RECONNECT_MS = 5000;
export const MAX_RECONNECT_MS = 60000;
/** Passive replies must reference a msg_id received within this window. */
export const PASSIVE_REPLY_WINDOW_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const ADAPTER_ID = 'dsh-im';

const TOKEN_ERROR_HINTS = {
  100001: '请求过于频繁，稍后重试',
  100007: 'AppID 无效或机器人状态异常（被封禁/已删除）',
  100016: 'AppID 或 ClientSecret 不正确',
  10004: 'AppID 对应的机器人不存在'
};

// Send errors that prove the message was NOT delivered.
const NOT_SENT_ERROR_CODES = new Set([
  304061, 304103, 304004, 304080,
  40034004, 40034005, 40034006, 40034008, 40034009, 40034010, 40034011,
  40034024, 40034025, 40034026, 40034027,
  40034100, 40034105, 40034106, 40034108, 40034109, 40034128,
  40054004, 40054005, 40054006, 40054007, 40054013, 40054016, 40054018,
  50059
]);
// Passive reply failures that allow one proactive fallback attempt.
const EXPIRED_PASSIVE_CODES = new Set([304103, 40034004, 40034005, 40034128]);

const DEFINITELY_NOT_SENT_TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_INVALID_URL',
  'UND_ERR_CONNECT_TIMEOUT'
]);

function errorCodeOf(error) {
  return error?.cause?.code || error?.code || null;
}

function isDefinitelyNotSentTransport(error) {
  return DEFINITELY_NOT_SENT_TRANSPORT_CODES.has(errorCodeOf(error));
}

/** Error raised by the official QQ bot client; `notSent` marks provable failures. */
export class QQOfficialApiError extends Error {
  constructor(message, { code = null, status = null, notSent = false, hint = null, cause = undefined } = {}) {
    super(message);
    this.name = 'QQOfficialApiError';
    this.code = code;
    this.status = status;
    this.notSent = notSent;
    this.hint = hint;
    if (cause !== undefined) this.cause = cause;
  }
}

async function readJsonBody(response, label) {
  try {
    return (await response.json()) ?? {};
  } catch (error) {
    throw new QQOfficialApiError(`${label} returned a non-JSON body`, { cause: error });
  }
}

/**
 * Exchange AppID + ClientSecret for an access_token. The official API reports
 * business failures with HTTP 200 and a `code`, so callers must check `code`.
 */
export async function fetchAppAccessToken({
  appId,
  clientSecret,
  tokenUrl = `${DEFAULT_API_BASE}/app/getAppAccessToken`,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== 'function') throw new QQOfficialApiError('HTTP fetch is unavailable in this runtime');
  if (typeof appId !== 'string' || appId.trim() === '') {
    throw new QQOfficialApiError('AppID is missing', { code: 'APP_ID_MISSING' });
  }
  if (typeof clientSecret !== 'string' || clientSecret.trim() === '') {
    throw new QQOfficialApiError('ClientSecret is missing', { code: 'APP_SECRET_MISSING' });
  }
  let response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: appId.trim(), clientSecret: clientSecret.trim() }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new QQOfficialApiError('cannot reach the token endpoint', {
      code: errorCodeOf(error) || 'TOKEN_ENDPOINT_UNREACHABLE',
      notSent: isDefinitelyNotSentTransport(error),
      cause: error
    });
  }
  const body = await readJsonBody(response, 'token endpoint');
  if (body.code !== undefined && body.code !== 0) {
    const numeric = Number(body.code);
    throw new QQOfficialApiError(`token exchange failed with code ${body.code}`, {
      code: numeric,
      notSent: true,
      hint: TOKEN_ERROR_HINTS[numeric] || null
    });
  }
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new QQOfficialApiError('token endpoint returned no access_token', { code: body.code ?? null });
  }
  return { accessToken: body.access_token, expiresIn: Number(body.expires_in) || null };
}

/** One authenticated official API call; `notSent` is set for definitive send errors. */
export async function callOfficialApi({
  pathname,
  accessToken,
  apiBase = DEFAULT_API_BASE,
  method = 'GET',
  body = undefined,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof fetchImpl !== 'function') throw new QQOfficialApiError('HTTP fetch is unavailable in this runtime');
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new QQOfficialApiError('access_token is missing', { code: 'TOKEN_MISSING' });
  }
  const url = new URL(pathname.replace(/^\/+/, ''), `${apiBase.replace(/\/+$/, '')}/`);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { authorization: `QQBot ${accessToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new QQOfficialApiError(`cannot reach ${pathname}`, {
      code: errorCodeOf(error) || 'API_UNREACHABLE',
      notSent: isDefinitelyNotSentTransport(error),
      cause: error
    });
  }
  const payload = await readJsonBody(response, pathname);
  if (!response.ok) {
    const code = payload.code !== undefined ? Number(payload.code) : response.status;
    throw new QQOfficialApiError(`${pathname} returned HTTP ${response.status}`, {
      code,
      status: response.status,
      notSent: [400, 401, 403, 404].includes(response.status) || NOT_SENT_ERROR_CODES.has(code),
      hint: payload.message ? String(payload.message).slice(0, 200) : null
    });
  }
  if (payload.code !== undefined && payload.code !== 0) {
    const code = Number(payload.code);
    throw new QQOfficialApiError(`${pathname} returned business code ${payload.code}`, {
      code,
      notSent: NOT_SENT_ERROR_CODES.has(code),
      hint: payload.message ? String(payload.message).slice(0, 200) : null
    });
  }
  return payload;
}

/**
 * Read-only identity/gateway probe. Returns only non-secret data; the access
 * token and client secret are never included in the result.
 */
export async function probeOfficialBot({
  appId,
  clientSecret,
  apiBase = DEFAULT_API_BASE,
  tokenUrl = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const token = await fetchAppAccessToken({
    appId,
    clientSecret,
    tokenUrl: tokenUrl || `${apiBase.replace(/\/+$/, '')}/app/getAppAccessToken`,
    fetchImpl,
    timeoutMs
  });
  const me = await callOfficialApi({
    pathname: '/users/@me',
    accessToken: token.accessToken,
    apiBase,
    fetchImpl,
    timeoutMs
  });
  const gateway = await callOfficialApi({
    pathname: '/gateway',
    accessToken: token.accessToken,
    apiBase,
    fetchImpl,
    timeoutMs
  });
  return {
    ok: true,
    tokenAcquired: true,
    tokenExpiresIn: token.expiresIn,
    bot: {
      id: me.id ? String(me.id) : null,
      username: me.username ? String(me.username).slice(0, 64) : null,
      bot: me.bot === true
    },
    gatewayUrl: typeof gateway.url === 'string' ? gateway.url : null,
    note: 'read-only probe: token exchange + /users/@me + /gateway; no message sent'
  };
}

/** One author-facing command line: JSON object with `action` is structured. */
export function parseOfficialCommand(rawText) {
  const text = String(rawText ?? '').trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') return parsed;
    } catch {
      // fall through to a natural-language candidate
    }
  }
  return text;
}

function privateConversation(openid) {
  return `private:${String(openid)}`;
}

function groupConversation(groupOpenid) {
  return `group:${String(groupOpenid)}`;
}

/**
 * QQ official bot host implementing the dsh-im ChannelAdapter host contract
 * (`describeCapabilities` / `start` / `send` / `queryDelivery` / `stop`).
 */
export class QQOfficialHost {
  constructor({
    apiBase = DEFAULT_API_BASE,
    tokenUrl = null,
    appId = null,
    clientSecret = null,
    websocketUrl = '',
    intents = DEFAULT_INTENTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    reconnectMs = DEFAULT_RECONNECT_MS,
    now = () => new Date(),
    logger,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    envNames = null
  } = {}) {
    this.apiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.tokenUrl = tokenUrl || `${this.apiBase}/app/getAppAccessToken`;
    this.appId = appId || null;
    this.clientSecret = clientSecret || null;
    this.websocketUrl = websocketUrl || '';
    this.intents = Number.isSafeInteger(intents) ? intents : DEFAULT_INTENTS;
    this.timeoutMs = timeoutMs;
    this.reconnectMs = reconnectMs;
    this.now = now;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.envNames = envNames;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.botIdentity = null;
    this.gatewayUrl = null;
    this.started = false;
    this.stopped = false;
    this.socket = null;
    this.onEvent = null;
    this.heartbeatTimer = null;
    this.heartbeatIntervalMs = 45000;
    this.reconnectTimer = null;
    this.reconnectDelay = reconnectMs;
    this.sessionId = null;
    this.lastSeq = null;
    this.lastInbound = new Map();
    this.probeCache = null;
    this.capabilities = {
      receive: false,
      send: false,
      delivery: { query: false, idempotent: false },
      humanIdentity: 'unverified',
      status: 'unavailable',
      reason: 'not_probed'
    };
  }

  async _accessToken({ force = false } = {}) {
    if (!force && this.token && this.now().getTime() < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.token;
    }
    const result = await fetchAppAccessToken({
      appId: this.appId,
      clientSecret: this.clientSecret,
      tokenUrl: this.tokenUrl,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs
    });
    this.token = result.accessToken;
    const lifetime = result.expiresIn ? result.expiresIn * 1000 : 7200 * 1000;
    this.tokenExpiresAt = this.now().getTime() + lifetime;
    return this.token;
  }

  /** Read-only probe: token exchange + bot identity + gateway URL. Never sends. */
  async describeCapabilities({ force = false } = {}) {
    const nowMs = this.now().getTime();
    if (!force && this.probeCache && nowMs - this.probeCache.atMs < 60 * 1000) {
      return this.probeCache.capabilities;
    }
    const capabilities = await this._probe();
    this.probeCache = { atMs: nowMs, capabilities };
    return capabilities;
  }

  async _probe() {
    if (typeof this.fetchImpl !== 'function' || typeof this.WebSocketImpl !== 'function') {
      this.capabilities = {
        ...this.capabilities,
        status: 'blocked',
        reason: 'transport_unavailable',
        receive: false,
        send: false
      };
      return this.capabilities;
    }
    if (!this.appId || !this.clientSecret) {
      this.capabilities = {
        receive: false,
        send: false,
        delivery: { query: false, idempotent: false },
        humanIdentity: 'unverified',
        status: 'blocked',
        reason: 'app_credentials_missing',
        env: this.envNames || { appIdEnv: null, appSecretEnv: null }
      };
      return this.capabilities;
    }
    let token;
    try {
      token = await this._accessToken({ force: this.token === null });
    } catch (error) {
      this.capabilities = {
        receive: false,
        send: false,
        delivery: { query: false, idempotent: false },
        humanIdentity: 'unverified',
        status: 'blocked',
        reason: 'token_failed',
        error: { code: error.code ?? null, message: String(error.message || error).slice(0, 200), hint: error.hint ?? null }
      };
      return this.capabilities;
    }
    let me;
    try {
      me = await callOfficialApi({
        pathname: '/users/@me',
        accessToken: token,
        apiBase: this.apiBase,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs
      });
    } catch (error) {
      this.capabilities = {
        receive: false,
        send: false,
        delivery: { query: false, idempotent: false },
        humanIdentity: 'unverified',
        status: 'blocked',
        reason: error.status === 401 || error.status === 403 ? 'auth_rejected' : 'identity_probe_failed',
        error: { code: error.code ?? null, message: String(error.message || error).slice(0, 200), hint: error.hint ?? null }
      };
      return this.capabilities;
    }
    this.botIdentity = {
      botAccountId: me.id !== undefined && me.id !== null ? String(me.id) : null,
      username: me.username ? String(me.username).slice(0, 64) : null
    };
    let gateway = null;
    try {
      gateway = await callOfficialApi({
        pathname: '/gateway',
        accessToken: token,
        apiBase: this.apiBase,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs
      });
      if (typeof gateway?.url === 'string' && gateway.url !== '') this.gatewayUrl = gateway.url;
    } catch (error) {
      gateway = null;
    }
    const haveGateway = Boolean(this.websocketUrl || this.gatewayUrl);
    this.capabilities = {
      receive: haveGateway,
      send: true,
      delivery: { query: false, idempotent: false },
      humanIdentity: 'unverified',
      status: haveGateway ? 'available' : 'unavailable',
      reason: haveGateway ? null : 'gateway_unavailable',
      verified: haveGateway,
      description: this.botIdentity.username
        ? `qq-official ${this.botIdentity.botAccountId || ''} (${this.botIdentity.username})`.trim()
        : 'qq-official',
      bot: this.botIdentity,
      gatewayUrl: this.websocketUrl || this.gatewayUrl || null
    };
    return this.capabilities;
  }

  async start(onEvent) {
    if (typeof onEvent !== 'function') {
      throw new AppError('CONFIG_INVALID', 'qq-official host start requires an event handler');
    }
    const capabilities = await this.describeCapabilities();
    if (capabilities.status !== 'available') {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'official QQ bot is unavailable', {
        details: { reason: capabilities.reason, verified: capabilities.verified === true }
      });
    }
    this.onEvent = onEvent;
    this.started = true;
    this.stopped = false;
    this._connect();
    return { subscribed: true, bot: this.botIdentity };
  }

  _connect() {
    if (this.stopped) return;
    const target = this.websocketUrl || this.gatewayUrl;
    if (!target) {
      this._scheduleReconnect();
      return;
    }
    let socket;
    try {
      socket = new this.WebSocketImpl(target);
    } catch (error) {
      this.logger?.warn?.('qq-official websocket connect failed', { code: errorCodeOf(error), message: error?.message });
      this._scheduleReconnect();
      return;
    }
    this.socket = socket;
    const listen = (type, handler) => {
      if (typeof socket?.addEventListener === 'function') socket.addEventListener(type, handler);
      else if (socket) socket[`on${type}`] = handler;
    };
    listen('open', () => {
      this.reconnectDelay = this.reconnectMs;
      this.logger?.debug?.('qq-official websocket connected');
    });
    listen('message', (messageEvent) => {
      this._handleFrame(messageEvent?.data ?? messageEvent);
    });
    listen('close', () => {
      this.socket = null;
      this._stopHeartbeat();
      if (!this.stopped) this._scheduleReconnect();
    });
    listen('error', (error) => {
      this.logger?.warn?.('qq-official websocket error', { message: error?.message || 'websocket error' });
    });
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(Math.max(this.reconnectDelay, 500), MAX_RECONNECT_MS);
    this.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  _sendSocket(payload) {
    if (!this.socket || typeof this.socket.send !== 'function') return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  async _handleFrame(raw) {
    if (typeof raw !== 'string' || raw === '') return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    if (payload.s !== undefined && payload.s !== null) this.lastSeq = payload.s;
    switch (payload.op) {
      case 10: { // Hello
        const interval = Number(payload.d?.heartbeat_interval);
        if (Number.isFinite(interval) && interval > 0) this.heartbeatIntervalMs = interval;
        await this._identifyOrResume();
        this._startHeartbeat();
        return;
      }
      case 11: // Heartbeat ACK
        return;
      case 7: // Reconnect requested by server
        try { this.socket?.close(); } catch { /* ignore */ }
        return;
      case 9: // Invalid session
        this.sessionId = null;
        this.lastSeq = null;
        try { this.socket?.close(); } catch { /* ignore */ }
        return;
      case 0:
        await this._handleDispatch(payload.t, payload.d);
        return;
      default:
        return;
    }
  }

  async _identifyOrResume() {
    let token;
    try {
      token = await this._accessToken();
    } catch (error) {
      this.logger?.warn?.('qq-official token refresh failed', { code: error.code ?? null });
      return;
    }
    if (this.sessionId && this.lastSeq !== null) {
      this._sendSocket({
        op: 6,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq }
      });
      return;
    }
    this._sendSocket({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: this.intents,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'dsh-bili-unified', $device: 'dsh-bili-unified' }
      }
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._sendSocket({ op: 1, d: this.lastSeq });
    this.heartbeatTimer = setInterval(() => {
      this._sendSocket({ op: 1, d: this.lastSeq });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async _handleDispatch(type, data) {
    if (type === 'READY') {
      this.sessionId = data?.session_id ? String(data.session_id) : null;
      if (data?.user?.id) {
        this.botIdentity = {
          botAccountId: String(data.user.id),
          username: data.user.username ? String(data.user.username).slice(0, 64) : this.botIdentity?.username || null
        };
      }
      return;
    }
    if (type === 'RESUMED') return;
    if (type !== 'C2C_MESSAGE_CREATE' && type !== 'GROUP_AT_MESSAGE_CREATE') return;
    const event = this._normalize(type, data);
    if (!event || !this.onEvent) return;
    const trustedContext = {
      trusted: true,
      source: QQ_OFFICIAL_TRANSPORT,
      humanAssurance: 'unverified',
      hostProof: null,
      bridgeAccountId: this.botIdentity?.botAccountId || null
    };
    Promise.resolve()
      .then(() => this.onEvent(event, trustedContext))
      .catch((error) => this.logger?.warn?.('qq-official event handler failed', {
        code: error?.code || 'DEPENDENCY_UNAVAILABLE',
        message: String(error?.message || error).slice(0, 200)
      }));
  }

  _normalize(type, data) {
    if (!data || typeof data !== 'object') return null;
    const messageId = data.id !== undefined && data.id !== null ? String(data.id) : null;
    const occurredAt = (() => {
      const parsed = Date.parse(String(data.timestamp || ''));
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : nowIso(this.now);
    })();
    if (type === 'C2C_MESSAGE_CREATE') {
      const openid = data.author?.user_openid || data.author?.id || null;
      if (!openid) return null;
      const conversationId = privateConversation(openid);
      this._rememberInbound(conversationId, messageId);
      return {
        adapterId: ADAPTER_ID,
        botAccountId: this.botIdentity?.botAccountId || null,
        conversationId,
        senderRef: String(openid),
        eventId: messageId,
        occurredAt,
        command: parseOfficialCommand(data.content || ''),
        group: false,
        raw: {
          platform: QQ_OFFICIAL_TRANSPORT,
          messageType: 'c2c',
          messageId,
          userId: String(openid),
          sceneSource: data.message_scene?.source || null
        }
      };
    }
    const groupOpenid = data.group_openid || data.group?.openid || null;
    const memberOpenid = data.author?.member_openid || null;
    if (!groupOpenid || !memberOpenid) return null;
    const conversationId = groupConversation(groupOpenid);
    this._rememberInbound(conversationId, messageId);
    return {
      adapterId: ADAPTER_ID,
      botAccountId: this.botIdentity?.botAccountId || null,
      conversationId,
      senderRef: String(memberOpenid),
      eventId: messageId,
      occurredAt,
      command: parseOfficialCommand(data.content || ''),
      group: true,
      raw: {
        platform: QQ_OFFICIAL_TRANSPORT,
        messageType: 'group',
        messageId,
        groupOpenid: String(groupOpenid),
        memberOpenid: String(memberOpenid)
      }
    };
  }

  _rememberInbound(conversationId, messageId) {
    if (!messageId) return;
    const previous = this.lastInbound.get(conversationId);
    this.lastInbound.set(conversationId, {
      messageId,
      atMs: this.now().getTime(),
      replySeq: previous?.messageId === messageId ? previous.replySeq : 0
    });
  }

  async send(payload = {}) {
    if (!this.started) throw new AppError('DEPENDENCY_UNAVAILABLE', 'qq-official host has not started');
    if (!this.capabilities.send) throw new AppError('DEPENDENCY_UNAVAILABLE', 'qq-official host cannot send');
    const conversationId = String(payload.conversationId ?? '');
    const privateMatch = /^private:(.+)$/.exec(conversationId);
    const groupMatch = /^group:(.+)$/.exec(conversationId);
    if (!privateMatch && !groupMatch) {
      throw new AppError('FORBIDDEN', 'qq-official host only sends to private:/group: conversations', {
        details: { reason: 'conversation_not_supported' }
      });
    }
    const text = String(payload.text ?? '');
    if (text === '') throw new AppError('INPUT_REQUIRED', 'notification text is empty');
    const targetPath = privateMatch
      ? `/v2/users/${encodeURIComponent(privateMatch[1])}/messages`
      : `/v2/groups/${encodeURIComponent(groupMatch[1])}/messages`;
    const last = this.lastInbound.get(conversationId) || null;
    const passiveUsable = last && (this.now().getTime() - last.atMs) <= PASSIVE_REPLY_WINDOW_MS;
    if (passiveUsable) {
      const body = { content: text, msg_type: 0, msg_id: last.messageId, msg_seq: (last.replySeq += 1) };
      try {
        return await this._sendRequest(targetPath, body);
      } catch (error) {
        if (!EXPIRED_PASSIVE_CODES.has(Number(error.code))) throw this._mapSendError(error);
        // Fall through to one proactive attempt.
      }
    }
    try {
      return await this._sendRequest(targetPath, { content: text, msg_type: 0 });
    } catch (error) {
      throw this._mapSendError(error);
    }
  }

  async _sendRequest(pathname, body) {
    const token = await this._accessToken();
    const data = await callOfficialApi({
      pathname,
      accessToken: token,
      apiBase: this.apiBase,
      method: 'POST',
      body,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs
    });
    const id = data?.id !== undefined && data?.id !== null ? String(data.id) : null;
    if (!id) {
      throw new QQOfficialApiError('qq-official send returned no message id', { code: 'SEND_RESULT_AMBIGUOUS', notSent: false });
    }
    return {
      status: 'sent',
      receipt: { platform: QQ_OFFICIAL_TRANSPORT, externalId: id, receivedAt: nowIso(this.now) }
    };
  }

  _mapSendError(error) {
    if (error?.notSent === true) {
      const mapped = new Error(`qq-official message was not sent: ${error.message}`);
      mapped.notSent = true;
      mapped.code = error.code ?? 'DEPENDENCY_UNAVAILABLE';
      return mapped;
    }
    return new AppError('OPERATION_UNKNOWN', 'qq-official send result is ambiguous', { cause: error });
  }

  async queryDelivery() {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'the official QQ bot API does not expose delivery queries');
  }

  async stop() {
    this.stopped = true;
    this.started = false;
    this._stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && typeof socket.close === 'function') {
      try { socket.close(); } catch { /* ignore */ }
    }
    return { stopped: true };
  }
}

/**
 * Build the official QQ bot host from config + environment. Returns null unless
 * `im.transport === 'qq-official'`; missing AppID/Secret still returns a host so
 * the read-only probe can report `app_credentials_missing` instead of crashing.
 */
export function createQQOfficialHost({
  config,
  env = process.env,
  logger,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  now = () => new Date()
} = {}) {
  const im = config?.im;
  if (!im || im.transport !== QQ_OFFICIAL_TRANSPORT) return null;
  const qq = im.qqOfficial || {};
  const appIdEnv = typeof qq.appIdEnv === 'string' ? qq.appIdEnv : 'QQBOT_APP_ID';
  const appSecretEnv = typeof qq.appSecretEnv === 'string' ? qq.appSecretEnv : 'QQBOT_APP_SECRET';
  return new QQOfficialHost({
    apiBase: qq.apiBase || DEFAULT_API_BASE,
    appId: env?.[appIdEnv] ? String(env[appIdEnv]) : null,
    clientSecret: env?.[appSecretEnv] ? String(env[appSecretEnv]) : null,
    websocketUrl: qq.websocketUrl || '',
    intents: qq.intents ?? DEFAULT_INTENTS,
    timeoutMs: qq.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    reconnectMs: qq.reconnectMs ?? DEFAULT_RECONNECT_MS,
    now,
    logger,
    fetchImpl,
    WebSocketImpl,
    envNames: { appIdEnv, appSecretEnv }
  });
}

export default QQOfficialHost;
