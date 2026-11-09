import { AppError } from '../../errors.js';
import { nowIso } from '../../utils.js';

/**
 * Optional local QQ bridge over the OneBot v11 protocol (HTTP action API +
 * forward WebSocket events). The plugin bundles **no** QQ/WeChat SDK: it only
 * talks to a user-supplied OneBot v11 implementation (e.g. NapCat, Lagrange)
 * running on the same machine or an operator-controlled endpoint.
 *
 * This module is a *host* for `DshImChannelAdapter` (see `dsh-im.js`), not a
 * second IM subsystem: capabilities, identity, approval semantics and the
 * outbox stay in the dsh-im contract.
 *
 * Security boundaries (SPEC §22, FR-IM-007):
 * - OneBot cannot prove human identity, so inbound events carry
 *   `humanAssurance: 'unverified'`; IM approvals fail closed in `ImBridge`.
 * - The bridge only consumes private conversations in this release; group
 *   events are ignored. Senders must match a local `im.bind` binding.
 * - Delivery has no idempotency key or delivery-query API in OneBot v11, so
 *   `delivery.query` / `delivery.idempotent` stay false and ambiguous sends
 *   remain unknown rather than being retried.
 */

export const ADAPTER_ID = 'dsh-im';
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_RECONNECT_MS = 5000;
export const MAX_RECONNECT_MS = 60000;
const CONVERSATION_PREFIX = 'private:';

const DEFINITELY_NOT_SENT_CODES = new Set([
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

/** OneBot HTTP failures that prove the action never reached the bridge. */
function isDefinitelyNotSent(error) {
  return DEFINITELY_NOT_SENT_CODES.has(errorCodeOf(error));
}

function requireHttpUrl(raw, label) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new AppError('CONFIG_INVALID', `${label} must be an absolute http(s) URL`, { details: { path: label } });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('CONFIG_INVALID', `${label} must use http or https`, { details: { path: label } });
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function requireWebSocketUrl(raw, label) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new AppError('CONFIG_INVALID', `${label} must be an absolute ws(s) URL`, { details: { path: label } });
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new AppError('CONFIG_INVALID', `${label} must use ws or wss`, { details: { path: label } });
  }
  return url;
}

function withAccessToken(url, accessToken) {
  if (!accessToken) return url;
  const next = new URL(url);
  next.searchParams.set('access_token', accessToken);
  return next;
}

/**
 * Minimal OneBot v11 HTTP client. OneBot answers `200 {status, retcode, data}`
 * for both success and action-level failure; transport failures are raised as
 * errors carrying `notSent` when the request provably never reached the bridge.
 */
export class OneBotHttpClient {
  constructor({
    baseUrl,
    accessToken = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.baseUrl = baseUrl instanceof URL ? baseUrl : requireHttpUrl(baseUrl, 'im.onebot.baseUrl');
    this.accessToken = accessToken || null;
    this.timeoutMs = timeoutMs;
    if (typeof fetchImpl !== 'function') {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'global fetch is unavailable in this runtime');
    }
    this.fetchImpl = fetchImpl;
  }

  urlFor(action) {
    const base = this.baseUrl.toString().replace(/\/+$/, '');
    return withAccessToken(new URL(`${base}/${action}`), this.accessToken);
  }

  async call(action, payload = {}) {
    const url = this.urlFor(action);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal
      });
    } catch (error) {
      const wrapped = new Error(`onebot ${action} request failed: ${error?.message || error}`);
      wrapped.code = errorCodeOf(error) || 'ONEBOT_TRANSPORT_ERROR';
      wrapped.notSent = isDefinitelyNotSent(error);
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
    if (!response || typeof response.status !== 'number') {
      throw new Error(`onebot ${action} returned no usable response`);
    }
    if (!response.ok) {
      const wrapped = new Error(`onebot ${action} rejected the request (HTTP ${response.status})`);
      wrapped.status = response.status;
      wrapped.notSent = [400, 401, 403, 404, 405].includes(response.status);
      throw wrapped;
    }
    let json;
    try {
      json = await response.json();
    } catch (error) {
      throw new Error(`onebot ${action} returned a non-JSON body`);
    }
    if (json && typeof json === 'object' && json.retcode !== undefined && json.retcode !== 0) {
      // A non-zero retcode is an action-level rejection: the bridge reports the
      // action as failed, so the request was not executed.
      const wrapped = new Error(`onebot ${action} failed with retcode ${json.retcode}` +
        (json.message ? ` (${json.message})` : ''));
      wrapped.retcode = json.retcode;
      wrapped.notSent = true;
      throw wrapped;
    }
    if (json && typeof json === 'object' && json.status !== undefined && json.status !== 'ok') {
      const wrapped = new Error(`onebot ${action} reported status ${json.status}`);
      wrapped.notSent = true;
      throw wrapped;
    }
    return json?.data;
  }
}

function extractMessageText(event) {
  const strip = (text) => String(text).replace(/\[CQ:[^\]]*\]/g, '');
  if (Array.isArray(event?.message)) {
    return event.message
      .filter((segment) => segment?.type === 'text')
      .map((segment) => String(segment?.data?.text ?? ''))
      .join('');
  }
  if (typeof event?.message === 'string') return strip(event.message);
  if (typeof event?.raw_message === 'string') return strip(event.raw_message);
  return '';
}

/**
 * One author-facing command line: a JSON object with a string `action` is a
 * structured command; anything else is a natural-language candidate (the
 * bridge turns that into a draft candidate, never a go execution).
 */
export function parseOneBotCommand(rawText) {
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

/** Build the dsh-im conversation id used for bindings and outbound sends. */
export function privateConversationId(userId) {
  return `${CONVERSATION_PREFIX}${String(userId)}`;
}

/**
 * OneBot v11 host implementing the dsh-im ChannelAdapter host contract
 * (`describeCapabilities` / `start` / `send` / `queryDelivery` / `stop`).
 */
export class OneBotQqHost {
  constructor({
    baseUrl,
    websocketUrl = '',
    accessToken = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    reconnectMs = DEFAULT_RECONNECT_MS,
    now = () => new Date(),
    logger,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket
  } = {}) {
    this.http = new OneBotHttpClient({ baseUrl, accessToken, timeoutMs, fetchImpl });
    this.websocketUrl = websocketUrl ? requireWebSocketUrl(websocketUrl, 'im.onebot.websocketUrl') : null;
    this.accessToken = accessToken || null;
    this.reconnectMs = reconnectMs;
    this.now = now;
    this.logger = logger;
    this.WebSocketImpl = WebSocketImpl;
    this.started = false;
    this.stopped = false;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectDelay = reconnectMs;
    this.onEvent = null;
    this.loginInfo = null;
    this.capabilities = {
      receive: false,
      send: false,
      delivery: { query: false, idempotent: false },
      humanIdentity: 'unverified',
      status: 'unavailable',
      reason: this.websocketUrl ? 'not_probed' : 'websocket_url_missing'
    };
  }

  /** Read-only capability probe: `get_status` + `get_login_info`, no message sent. */
  async describeCapabilities() {
    if (typeof this.WebSocketImpl !== 'function') {
      this.capabilities = {
        ...this.capabilities,
        status: 'blocked',
        reason: 'websocket_impl_unavailable',
        receive: false,
        send: false
      };
      return this.capabilities;
    }
    let status;
    try {
      status = await this.http.call('get_status');
    } catch (error) {
      const authRejected = error?.status === 401 || error?.status === 403;
      this.capabilities = {
        receive: false,
        send: false,
        delivery: { query: false, idempotent: false },
        humanIdentity: 'unverified',
        status: authRejected || error?.notSent ? 'blocked' : 'unavailable',
        reason: authRejected ? 'auth_rejected' : error?.notSent ? 'bridge_unreachable' : 'status_probe_failed',
        error: { code: error.code || 'DEPENDENCY_UNAVAILABLE', message: String(error.message || error).slice(0, 200) }
      };
      return this.capabilities;
    }
    if (status && status.online === false) {
      this.capabilities = {
        receive: false,
        send: false,
        delivery: { query: false, idempotent: false },
        humanIdentity: 'unverified',
        status: 'unavailable',
        reason: 'qq_offline'
      };
      return this.capabilities;
    }
    let login = null;
    try {
      login = await this.http.call('get_login_info');
    } catch (error) {
      login = null;
    }
    if (login && login.user_id !== undefined && login.user_id !== null) {
      this.loginInfo = {
        botAccountId: String(login.user_id),
        nickname: login.nickname ? String(login.nickname).slice(0, 64) : null
      };
    }
    const receive = Boolean(this.websocketUrl);
    const send = true;
    this.capabilities = {
      receive,
      send,
      delivery: { query: false, idempotent: false },
      humanIdentity: 'unverified',
      status: receive && send ? 'available' : 'unavailable',
      reason: receive ? null : 'websocket_url_missing',
      verified: true,
      description: this.loginInfo
        ? `onebot-v11 qq ${this.loginInfo.botAccountId}`
        : 'onebot-v11 qq',
      bot: this.loginInfo
    };
    return this.capabilities;
  }

  async start(onEvent) {
    if (typeof onEvent !== 'function') {
      throw new AppError('CONFIG_INVALID', 'onebot host start requires an event handler');
    }
    if (typeof this.WebSocketImpl !== 'function') {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'no WebSocket implementation is available');
    }
    const capabilities = await this.describeCapabilities();
    if (capabilities.status !== 'available') {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'onebot qq bridge is unavailable', {
        details: { reason: capabilities.reason, verified: capabilities.verified === true }
      });
    }
    this.onEvent = onEvent;
    this.started = true;
    this.stopped = false;
    this._connect();
    return { subscribed: true, bot: this.loginInfo };
  }

  _connect() {
    if (this.stopped) return;
    const url = withAccessToken(this.websocketUrl, this.accessToken);
    let socket;
    try {
      socket = new this.WebSocketImpl(url.toString());
    } catch (error) {
      this._scheduleReconnect();
      this.logger?.warn?.('onebot websocket connect failed', { code: errorCodeOf(error), message: error?.message });
      return;
    }
    this.socket = socket;
    const listen = (type, handler) => {
      if (typeof socket?.addEventListener === 'function') socket.addEventListener(type, handler);
      else if (socket) socket[`on${type}`] = handler;
    };
    listen('open', () => {
      this.reconnectDelay = this.reconnectMs;
      this.logger?.debug?.('onebot websocket connected');
    });
    listen('message', (messageEvent) => {
      this._handleFrame(messageEvent?.data ?? messageEvent);
    });
    listen('close', () => {
      this.socket = null;
      if (!this.stopped) this._scheduleReconnect();
    });
    listen('error', (error) => {
      this.logger?.warn?.('onebot websocket error', { message: error?.message || 'websocket error' });
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

  _handleFrame(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const normalized = this._normalize(event);
    if (!normalized || !this.onEvent) return;
    const trustedContext = {
      trusted: true,
      source: 'onebot-v11',
      humanAssurance: 'unverified',
      hostProof: null,
      bridgeAccountId: normalized.botAccountId
    };
    Promise.resolve()
      .then(() => this.onEvent(normalized, trustedContext))
      .catch((error) => this.logger?.warn?.('onebot event handler failed', {
        code: error?.code || 'DEPENDENCY_UNAVAILABLE',
        message: String(error?.message || error).slice(0, 200)
      }));
  }

  /** Normalize one OneBot v11 event to the dsh-im adapter envelope, or null. */
  _normalize(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.post_type !== 'message') return null;
    // This release deliberately accepts only private messages: bound senders
    // only, no group ingestion (SPEC §22 FR-IM-006 narrow channel).
    if (event.message_type !== 'private') return null;
    if (event.self_id === undefined || event.self_id === null) return null;
    if (event.user_id === undefined || event.user_id === null) return null;
    const botAccountId = String(event.self_id);
    const senderRef = String(event.user_id);
    if (senderRef === botAccountId) return null;
    const timeSec = Number(event.time);
    const occurredAt = Number.isFinite(timeSec) && timeSec > 0
      ? new Date(timeSec * 1000).toISOString()
      : nowIso(this.now);
    const messageId = event.message_id === undefined || event.message_id === null
      ? null
      : String(event.message_id);
    return {
      adapterId: ADAPTER_ID,
      botAccountId,
      conversationId: privateConversationId(senderRef),
      senderRef,
      eventId: messageId ? `msg:${messageId}` : null,
      occurredAt,
      command: parseOneBotCommand(extractMessageText(event) || event.raw_message || ''),
      group: false,
      raw: {
        postType: 'message',
        messageType: 'private',
        selfId: botAccountId,
        userId: senderRef,
        messageId,
        time: Number.isFinite(timeSec) ? timeSec : null
      }
    };
  }

  async send(payload = {}) {
    if (!this.started) throw new AppError('DEPENDENCY_UNAVAILABLE', 'onebot host has not started');
    if (!this.capabilities.send) throw new AppError('DEPENDENCY_UNAVAILABLE', 'onebot host cannot send');
    const conversationId = String(payload.conversationId ?? '');
    const match = new RegExp(`^${CONVERSATION_PREFIX}(\\d+)$`).exec(conversationId);
    if (!match) {
      throw new AppError('FORBIDDEN', 'onebot host only sends to bound private conversations', {
        details: { reason: 'conversation_not_private' }
      });
    }
    const text = String(payload.text ?? '');
    if (text === '') throw new AppError('INPUT_REQUIRED', 'notification text is empty');
    let data;
    try {
      data = await this.http.call('send_private_msg', {
        user_id: Number(match[1]),
        message: text
      });
    } catch (error) {
      if (error?.notSent === true) {
        const notSent = new Error(`onebot private message was not sent: ${error.message}`);
        notSent.notSent = true;
        notSent.code = error.code || 'DEPENDENCY_UNAVAILABLE';
        throw notSent;
      }
      throw new AppError('OPERATION_UNKNOWN', 'onebot send result is ambiguous', { cause: error });
    }
    const messageId = data?.message_id;
    if (messageId === undefined || messageId === null) {
      throw new AppError('OPERATION_UNKNOWN', 'onebot send returned no message id');
    }
    return {
      status: 'sent',
      receipt: {
        platform: 'onebot-v11',
        externalId: String(messageId),
        receivedAt: nowIso(this.now)
      }
    };
  }

  async queryDelivery() {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'onebot v11 does not expose delivery queries');
  }

  async stop() {
    this.stopped = true;
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && typeof socket.close === 'function') {
      try {
        socket.close();
      } catch {
        // socket may already be closed
      }
    }
    return { stopped: true };
  }
}

/**
 * Build the optional QQ bridge host from configuration. Returns null unless
 * `im.transport === 'onebot-v11'` and an endpoint is configured, so the default
 * composition stays free of network activity and secrets.
 */
export function createOneBotQqHost({
  config,
  env = process.env,
  logger,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  now = () => new Date()
} = {}) {
  const im = config?.im;
  if (!im || im.transport !== 'onebot-v11') return null;
  const onebot = im.onebot || {};
  if (typeof onebot.baseUrl !== 'string' || onebot.baseUrl.trim() === '') return null;
  const accessTokenEnv = typeof onebot.accessTokenEnv === 'string' && onebot.accessTokenEnv !== ''
    ? onebot.accessTokenEnv
    : 'ONEBOT_ACCESS_TOKEN';
  const accessToken = env?.[accessTokenEnv] ? String(env[accessTokenEnv]) : null;
  return new OneBotQqHost({
    baseUrl: onebot.baseUrl,
    websocketUrl: onebot.websocketUrl || '',
    accessToken,
    timeoutMs: onebot.timeoutMs,
    reconnectMs: onebot.reconnectMs,
    now,
    logger,
    fetchImpl,
    WebSocketImpl
  });
}

export default OneBotQqHost;
