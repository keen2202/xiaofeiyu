export function makeMockImHost({ sendStatus = 'sent', queryStatus = 'sent', capabilities = null } = {}) {
  const calls = { probe: 0, start: 0, send: [], query: [], stop: 0 };
  let handler = null;
  const host = {
    calls,
    async describeCapabilities() {
      calls.probe += 1;
      return capabilities || {
        receive: true,
        send: true,
        humanIdentity: 'verified',
        delivery: { query: true, idempotent: true },
        description: 'mock host'
      };
    },
    async start(callback) {
      calls.start += 1;
      handler = callback;
      return { subscribed: true };
    },
    async send(payload) {
      calls.send.push(payload);
      if (sendStatus === 'unknown') throw new Error('timeout');
      if (sendStatus === 'not_sent') return { status: 'not_sent', evidence: { externalId: 'evidence' } };
      if (sendStatus === 'failed') return { ok: false };
      return { status: 'sent', receipt: { platform: 'dsh-im', externalId: `msg_${calls.send.length}` } };
    },
    async queryDelivery(payload) {
      calls.query.push(payload);
      return { status: queryStatus };
    },
    async stop() {
      calls.stop += 1;
    },
    emit(event, trustedContext) {
      return handler(event, trustedContext);
    }
  };
  return host;
}

export function makeMockChannel({ sendStatus = 'sent', queryStatus = 'sent' } = {}) {
  const calls = { send: [], query: [], start: 0, stop: 0 };
  return {
    calls,
    capabilities: {
      receive: true,
      send: true,
      delivery: { query: true, idempotent: true },
      humanIdentity: true
    },
    started: false,
    async start(handler) {
      calls.start += 1;
      this.started = true;
      this.handler = handler;
      return { started: true };
    },
    async send(context, notification) {
      calls.send.push({ context, notification });
      if (sendStatus === 'unknown') throw new Error('timeout');
      return { status: 'sent', receipt: { platform: 'dsh-im', externalId: 'im_msg_1' } };
    },
    async queryDelivery(id, receipt) {
      calls.query.push({ id, receipt });
      return { status: queryStatus };
    },
    async stop() {
      calls.stop += 1;
      this.started = false;
      return { stopped: true };
    }
  };
}
