import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeClock } from './helpers/harness.js';
import { RateLimiter } from '../src/rate-limiter.js';

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
