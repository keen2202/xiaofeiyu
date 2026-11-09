import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeClock } from './helpers/harness.js';
import { RateLimiter } from '../src/rate-limiter.js';
import { nowIso } from '../src/utils.js';

const limits = {
  minGapMs: 500,
  writeGapMs: 30000,
  readPerHour: 2,
  readPerDay: 3,
  writePerHour: 1,
  writePerDay: 2
};

test('read quotas and write cooldown are enforced in the ledger', async () => {
  const harness = await createHarness();
  try {
    const limiter = new RateLimiter({ now: harness.now, getTimeZone: () => 'Asia/Shanghai' });
    await harness.store.transaction(async (draft) => {
      limiter.reserveRead(draft, { key: 'bili:1', limits });
      limiter.reserveRead(draft, { key: 'bili:1', limits });
      assert.throws(() => limiter.reserveRead(draft, { key: 'bili:1', limits }), (error) => error.code === 'QUOTA_EXCEEDED');
      limiter.reserveWrite(draft, { key: 'bili:1', limits, action: 'comment', actionQuota: { perDay: 2 } });
      assert.throws(
        () => limiter.reserveWrite(draft, { key: 'bili:1', limits, action: 'comment', actionQuota: { perDay: 2 } }),
        (error) => error.code === 'RATE_LIMITED'
      );
    });
  } finally {
    await harness.cleanup();
  }
});

test('risk control opens an exponential circuit and blocks reads until expiry', async () => {
  const clock = makeClock();
  const harness = await createHarness({ now: clock });
  try {
    const limiter = new RateLimiter({ now: clock, getTimeZone: () => 'UTC' });
    await harness.store.transaction(async (draft) => {
      const risk = limiter.recordRisk(draft, 'bili:1', { code: -412 });
      assert.equal(risk.failures, 1);
      assert.equal(risk.openUntil, new Date(clock().getTime() + 5 * 60 * 1000).toISOString());
      assert.throws(() => limiter.reserveRead(draft, { key: 'bili:1', limits }), (error) => error.code === 'RATE_LIMITED');
      assert.throws(
        () => limiter.reserveRead(draft, { key: 'bili:1', limits: { ...limits, readPerHour: 99, readPerDay: 99 } }),
        (error) => error.code === 'RATE_LIMITED'
      );
    });
    clock.advance(5 * 60 * 1000 + 1);
    await harness.store.transaction(async (draft) => {
      assert.doesNotThrow(() => limiter.reserveRead(draft, { key: 'bili:1', limits }));
    });
  } finally {
    await harness.cleanup();
  }
});

test('success resets the circuit and daily windows rotate', async () => {
  const clock = makeClock();
  const harness = await createHarness({ now: clock });
  try {
    const limiter = new RateLimiter({ now: clock, getTimeZone: () => 'UTC' });
    await harness.store.transaction(async (draft) => {
      limiter.recordRisk(draft, 'bili:2', { code: -799 });
      limiter.recordSuccess(draft, 'bili:2');
      assert.doesNotThrow(() => limiter.reserveWrite(draft, { key: 'bili:2', limits }));
    });
    clock.advance(24 * 60 * 60 * 1000);
    await harness.store.transaction(async (draft) => {
      const result = limiter.reserveWrite(draft, { key: 'bili:2', limits });
      assert.equal(result.dayCount, 1);
    });
  } finally {
    await harness.cleanup();
  }
});

test('circuit base/max delays follow the configured values', async () => {
  const clock = makeClock();
  const harness = await createHarness({ now: clock });
  try {
    const limiter = new RateLimiter({
      now: clock,
      getTimeZone: () => 'UTC',
      circuitBaseMs: 1000,
      circuitMaxMs: 3000
    });
    await harness.store.transaction(async (draft) => {
      assert.equal(limiter.recordRisk(draft, 'bili:cfg', { code: -412 }).delayMs, 1000);
      assert.equal(limiter.recordRisk(draft, 'bili:cfg', { code: -412 }).delayMs, 2000);
      assert.equal(limiter.recordRisk(draft, 'bili:cfg', { code: -412 }).delayMs, 3000);
      assert.equal(limiter.recordRisk(draft, 'bili:cfg', { code: -412 }).delayMs, 3000);
      assert.equal(
        limiter.recordRisk(draft, 'bili:cfg', { code: -412, retryAfterMs: 10000 }).delayMs,
        3000
      );
    });
  } finally {
    await harness.cleanup();
  }
});

test('read time slots are reserved and only enforced when requested', async () => {
  const clock = makeClock();
  const harness = await createHarness({ now: clock });
  try {
    const limiter = new RateLimiter({ now: clock, getTimeZone: () => 'UTC' });
    const slotLimits = { ...limits, readPerHour: 10, readPerDay: 10 };
    await harness.store.transaction(async (draft) => {
      const first = limiter.reserveRead(draft, { key: 'bili:slot', limits: slotLimits, enforceGap: true });
      assert.equal(first.nextAllowedAt, new Date(clock().getTime() + limits.minGapMs).toISOString());
      assert.throws(
        () => limiter.reserveRead(draft, { key: 'bili:slot', limits: slotLimits, enforceGap: true }),
        (error) => error.code === 'RATE_LIMITED' && error.retryable === true
      );
      // A retry reserves quota again without waiting for the slot it consumed.
      const retry = limiter.reserveRead(draft, { key: 'bili:slot', limits: slotLimits, enforceGap: false });
      assert.equal(retry.hourCount, 2);
    });
    clock.advance(limits.minGapMs + 1);
    await harness.store.transaction(async (draft) => {
      assert.doesNotThrow(() => limiter.reserveRead(draft, { key: 'bili:slot', limits: slotLimits, enforceGap: true }));
    });
  } finally {
    await harness.cleanup();
  }
});

test('released write reservations return quota to the bucket', async () => {
  const clock = makeClock();
  const harness = await createHarness({ now: clock });
  try {
    const limiter = new RateLimiter({ now: clock, getTimeZone: () => 'UTC' });
    await harness.store.transaction(async (draft) => {
      const reserved = limiter.reserveWrite(draft, { key: 'bili:release', limits, action: 'dm' });
      assert.equal(reserved.hourCount, 1);
      const released = limiter.releaseWrite(draft, { key: 'bili:release', action: 'dm' });
      assert.equal(released.released, true);
      assert.equal(draft.rate['bili:release'].write.hourCount, 0);
      assert.equal(draft.rate['bili:release'].write.actions.dm.hourCount, 0);
    });
  } finally {
    await harness.cleanup();
  }
});

test('manual auth pause blocks reads/writes until a human resumes the account', async () => {
  const clock = makeClock();
  const harness = await createHarness({ now: clock });
  try {
    const limiter = new RateLimiter({ now: clock, getTimeZone: () => 'UTC' });
    await harness.store.transaction(async (draft) => {
      draft.accounts['bilibili:1001'] = {
        accountRef: { platform: 'bilibili', accountId: '1001' },
        mid: '1001',
        credentialRevision: 'rev',
        devId: 'dev',
        boundAt: nowIso(clock),
        lastVerifiedAt: nowIso(clock)
      };
      const paused = limiter.markAuthPaused(draft, 'bilibili:1001', { code: -101, reason: 'login_invalid' });
      assert.equal(paused.paused, true);
      assert.equal(limiter.isAuthPaused(draft, 'bilibili:1001'), true);
      assert.throws(
        () => limiter.reserveRead(draft, { key: 'bilibili:1001', limits }),
        (error) => error.code === 'CREDENTIAL_MISSING' && /paused/.test(error.message)
      );
      assert.throws(
        () => limiter.reserveWrite(draft, { key: 'bilibili:1001', limits }),
        (error) => error.code === 'CREDENTIAL_MISSING'
      );
      const status = limiter.status(draft, 'bilibili:1001');
      assert.equal(status.authPaused, true);
      assert.equal(status.authPause.biliCode, '-101');
      assert.equal(limiter.markAuthPaused(draft, 'bilibili:unbound', { code: -101 }).paused, false);
    });
    await harness.store.transaction(async (draft, tx) => {
      const result = limiter.clearAuthPause(tx, 'bilibili:1001', {
        note: 'operator confirmed login',
        actor: 'local_human'
      });
      assert.equal(result.cleared, true);
      assert.equal(limiter.isAuthPaused(draft, 'bilibili:1001'), false);
      assert.doesNotThrow(() => limiter.reserveRead(draft, { key: 'bilibili:1001', limits }));
    });
    const state = await harness.snapshot();
    assert.equal(state.accounts['bilibili:1001'].authPausedAt, null);
    assert.ok(state.events.some((event) => event.type === 'account.auth.resumed'));
    await assert.rejects(
      () => harness.store.transaction(async (draft, tx) => limiter.clearAuthPause(tx, 'bilibili:404', {})),
      (error) => error.code === 'INPUT_REQUIRED'
    );
  } finally {
    await harness.cleanup();
  }
});
