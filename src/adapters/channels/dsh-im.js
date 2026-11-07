import { AppError } from '../../errors.js';
import { deepClone, jcsHash, nowIso, truncateText } from '../../utils.js';

const RELIABLE_READ_ACTIONS = new Set(['task.get', 'task.list', 'status.get']);
const IM_ACTION_SET = new Set([
  'production.create',
  'task.get',
  'task.list',
  'task.cancel',
  'task.resume',
  'approval.decide',
  'comment.draft'
]);

/**
 * Thin adapter over a host-provided IM channel. No QQ/WeChat SDK is bundled.
 * The default instance has no host and reports unavailable/BLOCKED.
 */
export class DshImChannelAdapter {
  constructor({ host = null, config = null, now = () => new Date(), logger } = {}) {
    this.host = host;
    this.config = config;
    this.now = now;
    this.logger = logger;
    this.started = false;
    this.capabilities = {
      receive: false,
      send: false,
      delivery: { query: false, idempotent: false },
      humanIdentity: false,
      verified: false,
      status: 'unavailable',
      reason: 'host_not_provided'
    };
    this._handler = null;
  }

  async probe() {
    if (!this.host) {
      this.capabilities = {
        receive: false,
        send: false,
        delivery: { query: false, idempotent: false },
        humanIdentity: false,
        verified: false,
        status: 'unavailable',
        reason: 'host_not_provided'
      };
      return this.capabilities;
    }
    if (typeof this.host.describeCapabilities !== 'function') {
      this.capabilities = {
        ...this.capabilities,
        status: 'blocked',
        reason: 'host_capability_contract_missing',
        verified: false
      };
      return this.capabilities;
    }
    let declared;
    try {
      declared = await this.host.describeCapabilities();
    } catch (error) {
      this.capabilities = {
        ...this.capabilities,
        status: 'blocked',
        reason: 'host_probe_failed',
        error: error.message,
        verified: false
      };
      return this.capabilities;
    }
    const receive = declared?.receive === true;
    const send = declared?.send === true;
    const humanIdentity = declared?.humanIdentity === 'verified';
    const delivery = {
      query: declared?.delivery?.query === true,
      idempotent: declared?.delivery?.idempotent === true
    };
    const status = receive && send ? 'available' : 'unavailable';
    this.capabilities = {
      receive,
      send,
      delivery,
      humanIdentity,
      verified: true,
      status,
      reason: status === 'available' ? null : 'host_lacks_required_capability',
      description: declared?.description || null
    };
    return this.capabilities;
  }

  async start(onEvent) {
    const capabilities = await this.probe();
    if (capabilities.status !== 'available') {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'dsh-im host is unavailable', {
        details: { reason: capabilities.reason }
      });
    }
    if (typeof this.host.start !== 'function') {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'dsh-im host does not expose start');
    }
    this._handler = onEvent;
    const result = await this.host.start((rawEvent, trustedContext) => {
      const event = this._normalizeEvent(rawEvent);
      if (this._handler) return this._handler(event, trustedContext);
      return { accepted: false, reason: 'no_handler' };
    });
    this.started = true;
    return { started: true, capabilities, result: result ?? null };
  }

  _normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object') throw new AppError('FORBIDDEN', 'host IM event is invalid');
    return {
      adapterId: raw.adapterId || this.config?.im?.adapterId || 'dsh-im',
      botAccountId: raw.botAccountId,
      conversationId: raw.conversationId || raw.conversation?.id,
      senderRef: raw.senderRef || raw.sender?.id,
      eventId: raw.eventId || raw.id,
      occurredAt: raw.occurredAt || raw.timestamp,
      command: raw.command ?? raw.text ?? null,
      group: raw.group === true || raw.conversation?.type === 'group',
      raw
    };
  }

  async send(context, notification) {
    if (!this.started) throw new AppError('DEPENDENCY_UNAVAILABLE', 'dsh-im adapter has not started');
    if (!this.capabilities.send) throw new AppError('DEPENDENCY_UNAVAILABLE', 'host cannot send messages');
    let response;
    try {
      response = await this.host.send({
        notificationId: context.notificationId,
        bindingId: context.bindingId,
        conversationId: context.conversationId,
        text: notification.summary,
        idempotent: this.capabilities.delivery.idempotent === true
      });
    } catch (error) {
      if (error?.notSent === true) {
        return { status: 'not_sent', error: { code: 'DEPENDENCY_UNAVAILABLE', message: error.message } };
      }
      throw new AppError('OPERATION_UNKNOWN', 'host IM send did not return a trustworthy result', { cause: error });
    }
    if (response?.status === 'sent' && response.receipt) {
      return { status: 'sent', receipt: response.receipt };
    }
    if (response?.status === 'not_sent' && response.evidence) {
      return { status: 'not_sent', receipt: response.evidence };
    }
    if (response?.ok === true) {
      return {
        status: 'sent',
        receipt: response.receipt || { platform: 'dsh-im', externalId: context.notificationId, receivedAt: nowIso(this.now) }
      };
    }
    throw new AppError('OPERATION_UNKNOWN', 'host IM send result is ambiguous');
  }

  async queryDelivery(notificationId, receipt) {
    if (!this.capabilities.delivery.query) {
      throw new AppError('CAPABILITY_UNSUPPORTED', 'host does not support delivery.query');
    }
    const response = await this.host.queryDelivery({ notificationId, receipt });
    if (!['sent', 'not_sent', 'unknown'].includes(response?.status)) {
      return { status: 'unknown' };
    }
    return response;
  }

  async stop() {
    if (this.host?.stop) await this.host.stop();
    this.started = false;
    return { stopped: true };
  }
}

export class ImBridge {
  constructor({
    store,
    identity,
    commandService,
    effectGateway = null,
    configService,
    channel,
    now = () => new Date(),
    logger
  } = {}) {
    this.store = store;
    this.identity = identity;
    this.commandService = commandService;
    this.effectGateway = effectGateway;
    this.configService = configService;
    this.channel = channel;
    this.now = now;
    this.logger = logger;
    this.started = false;
  }

  async start(onEvent) {
    if (this.started) return { started: true, deduplicated: true };
    if (!this.channel) throw new AppError('DEPENDENCY_UNAVAILABLE', 'dsh-im channel is not configured');
    const result = await this.channel.start(async (event, trustedContext) => {
      const response = await this.ingest(event, trustedContext);
      if (onEvent) await onEvent(response, event);
      return response;
    });
    this.started = true;
    return { ...result, started: true };
  }

  async stop() {
    if (this.channel) await this.channel.stop();
    this.started = false;
    return { stopped: true };
  }

  _assertEvent(event, trustedContext) {
    const config = this.configService.get();
    if (!config.im.enabled) throw new AppError('FEATURE_DISABLED', 'IM bridge is disabled');
    for (const field of ['adapterId', 'botAccountId', 'conversationId', 'senderRef', 'occurredAt']) {
      if (typeof event?.[field] !== 'string' || event[field] === '') {
        throw new AppError('FORBIDDEN', `IM event.${field} is required`);
      }
    }
    if (event.adapterId !== config.im.adapterId) throw new AppError('FORBIDDEN', 'IM adapter id mismatch');
    if (!trustedContext || trustedContext.trusted !== true) {
      throw new AppError('TRUST_UNAVAILABLE', 'IM event did not come from a trusted host context');
    }
    const occurred = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurred)) throw new AppError('FORBIDDEN', 'IM event time is invalid');
    const ageMs = this.now().getTime() - occurred;
    if (ageMs > config.im.maxMessageAgeSec * 1000) throw new AppError('FORBIDDEN', 'IM event is too old');
    if (ageMs < -60000) throw new AppError('FORBIDDEN', 'IM event time is in the future');
    if (event.raw?.principal || event.raw?.role || event.raw?.approved || event.raw?.actorKind) {
      throw new AppError('FORBIDDEN', 'IM event body cannot assert identity or approval');
    }
    return config;
  }

  _command(event, config) {
    const command = event.command;
    if (typeof command === 'string') {
      return {
        structured: false,
        action: null,
        candidate: truncateText(command, 500),
        input: {},
        mode: 'dry'
      };
    }
    if (!command || typeof command !== 'object' || typeof command.action !== 'string') {
      throw new AppError('FORBIDDEN', 'IM command must be structured');
    }
    if (!IM_ACTION_SET.has(command.action)) {
      throw new AppError('FORBIDDEN', 'IM action is not allowed');
    }
    const mode = command.mode || 'dry';
    if (!['dry', 'go'].includes(mode)) throw new AppError('CONFIG_INVALID', 'IM command mode must be dry or go');
    if (['production.create', 'comment.draft'].includes(command.action) && mode === 'go') {
      throw new AppError('FORBIDDEN', 'IM can only create drafts/dry-run production');
    }
    return { structured: true, action: command.action, input: command.input || {}, mode };
  }

  async ingest(event, trustedContext) {
    const config = this._assertEvent(event, trustedContext);
    const command = this._command(event, config);
    const dedupeKey = `im:${event.adapterId}:${event.botAccountId}:${event.conversationId}:${event.eventId || 'no-event-id'}`;
    const commandHash = jcsHash({
      action: command.action || 'natural_language',
      input: command.input,
      mode: command.mode
    });
    const existing = (await this.store.getSnapshot()).inboxKeys[dedupeKey];
    if (existing) {
      if (existing.commandHash !== commandHash) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'same IM event id received with different command');
      }
      await this.store.transaction(async (draft, tx) => {
        this.identity.resolveImPrincipal(tx, {
          adapterId: event.adapterId,
          botAccountId: event.botAccountId,
          senderRef: event.senderRef,
          conversationId: event.conversationId
        });
      });
      return { ...existing.result, deduplicated: true };
    }
    if (!event.eventId && !RELIABLE_READ_ACTIONS.has(command.action)) {
      throw new AppError('FORBIDDEN', 'events without a reliable eventId are limited to read-only commands');
    }
    if (!command.structured) {
      return {
        accepted: false,
        candidate: true,
        taskId: null,
        message: 'Natural-language input only produces a candidate; send a structured command to create a task.',
        candidateText: command.candidate
      };
    }
    const bindingResolution = await this.store.transaction(async (draft, tx) =>
      this.identity.resolveImPrincipal(tx, {
        adapterId: event.adapterId,
        botAccountId: event.botAccountId,
        senderRef: event.senderRef,
        conversationId: event.conversationId
      })
    );
    const principal = bindingResolution.principal;
    let humanContext = null;
    if (command.action === 'approval.decide') {
      if (trustedContext.humanAssurance !== 'verified' || !trustedContext.hostProof) {
        throw new AppError('TRUST_UNAVAILABLE', 'IM approval requires verified host human identity');
      }
      humanContext = {
        principal,
        proof: trustedContext.hostProof
      };
    }
    await this.store.transaction(async (draft, tx) => {
      if (draft.inboxKeys[dedupeKey]) {
        throw new AppError('DUPLICATE_OPERATION', 'concurrent IM event processing', { retryable: true });
      }
      draft.inboxKeys[dedupeKey] = {
        key: dedupeKey,
        adapterId: event.adapterId,
        botAccountId: event.botAccountId,
        conversationId: event.conversationId,
        senderRef: event.senderRef,
        eventId: event.eventId || null,
        commandHash,
        status: 'pending',
        taskId: null,
        result: null,
        createdAt: nowIso(this.now),
        updatedAt: nowIso(this.now)
      };
      tx.appendEvent({
        type: 'im.command.received',
        actor: principal.id,
        payload: {
          adapterId: event.adapterId,
          conversationId: event.conversationId,
          action: command.action,
          commandHash
        }
      });
    });
    const envelope = {
      schemaVersion: 1,
      requestId: `im-${event.eventId || `${event.adapterId}-${event.botAccountId}-${Date.now()}`}`,
      action: command.action,
      input: command.input,
      mode: command.mode
    };
    let response;
    try {
      response = await this.commandService.execute(envelope, principal, {
        sourceKind: 'im',
        humanContext,
        trusted: true
      });
    } catch (error) {
      await this.store.transaction(async (draft) => {
        const record = draft.inboxKeys[dedupeKey];
        if (!record) return;
        record.status = 'failed';
        record.error = { code: error.code || 'DEPENDENCY_UNAVAILABLE', message: truncateText(error.message, 500) };
        record.updatedAt = nowIso(this.now);
      }).catch(() => {});
      throw error;
    }
    let notificationId = null;
    let protectionError = null;
    if (config.im.notifications.enabled && this.effectGateway) {
      try {
        await this.effectGateway.assertNotificationProtection(bindingResolution.binding, event.conversationId);
        const notification = await this.store.transaction(async (draft, tx) => {
          const created = this.effectGateway.appendNotification(tx, {
            taskId: response.taskId,
            taskRevision: null,
            bindingId: bindingResolution.binding.bindingId,
            conversationId: event.conversationId,
            summary: truncateText(`Task ${response.taskId || 'draft'}: ${response.status || 'accepted'}`, 500),
            actor: principal.id
          });
          const record = draft.inboxKeys[dedupeKey];
          if (record) {
            record.status = 'accepted';
            record.taskId = response.taskId || null;
            record.result = {
              accepted: response.accepted,
              taskId: response.taskId,
              status: response.status,
              executionMode: response.executionMode,
              notificationId: created.id
            };
            record.updatedAt = nowIso(this.now);
          }
          return created;
        });
        notificationId = notification.id;
      } catch (error) {
        protectionError = { code: error.code || 'BACKUP_UNPROTECTED', message: truncateText(error.message, 300) };
      }
    }
    if (!notificationId) {
      await this.store.transaction(async (draft) => {
        const record = draft.inboxKeys[dedupeKey];
        if (!record) return;
        record.status = 'accepted';
        record.taskId = response.taskId || null;
        record.result = {
          accepted: response.accepted,
          taskId: response.taskId,
          status: response.status,
          executionMode: response.executionMode,
          notificationId: null,
          protectionError
        };
        record.updatedAt = nowIso(this.now);
      });
    }
    return {
      ...response,
      notificationId,
      protectionError,
      deduplicated: false,
      principalId: principal.id
    };
  }

  async dispatchOutbox(notificationId) {
    if (!this.channel || !this.effectGateway) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'IM outbox is not configured');
    }
    return this.effectGateway.dispatchNotification(notificationId, this.channel);
  }

  async queryOutbox(notificationId) {
    if (!this.channel || !this.effectGateway) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'IM outbox is not configured');
    }
    return this.effectGateway.queryNotificationDelivery(notificationId, this.channel);
  }
}

export default DshImChannelAdapter;
