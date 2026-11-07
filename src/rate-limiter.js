import { AppError } from './errors.js';
import { formatDateInZone, formatDateTimeInZone, nowIso } from './utils.js';

export const RISK_CODES = Object.freeze([-412, -352, -799, -509, -10403]);

export class RateLimiter {
  constructor({ now = () => new Date(), getTimeZone = () => 'Asia/Shanghai' } = {}) {
    this.now = now;
    this.getTimeZone = getTimeZone;
  }

  _bucket(state, key) {
    if (!state.rate[key]) {
      state.rate[key] = {
        read: { hourKey: null, dayKey: null, hourCount: 0, dayCount: 0 },
        write: {
          hourKey: null,
          dayKey: null,
          hourCount: 0,
          dayCount: 0,
          nextAllowedAt: null,
          actions: {}
        },
        circuit: { failures: 0, openUntil: null, lastCode: null }
      };
    }
    return state.rate[key];
  }

  _windowKeys() {
    const now = this.now();
    const timeZone = this.getTimeZone();
    return {
      date: formatDateInZone(now, timeZone),
      hour: formatDateTimeInZone(now, timeZone).slice(0, 13),
      nowMs: now.getTime(),
      now: nowIso(this.now)
    };
  }

  _rotate(bucket, keys) {
    if (bucket.hourKey !== keys.hour) {
      bucket.hourKey = keys.hour;
      bucket.hourCount = 0;
    }
    if (bucket.dayKey !== keys.date) {
      bucket.dayKey = keys.date;
      bucket.dayCount = 0;
    }
  }

  assertCircuitClosed(state, key) {
    const bucket = state.rate[key];
    const circuit = bucket?.circuit;
    if (!circuit?.openUntil) return true;
    if (Date.parse(circuit.openUntil) > this.now().getTime()) {
      throw new AppError('RATE_LIMITED', 'platform circuit breaker is open', {
        retryable: true,
        details: {
          openUntil: circuit.openUntil,
          retryAfterMs: Date.parse(circuit.openUntil) - this.now().getTime(),
          lastCode: circuit.lastCode
        }
      });
    }
    circuit.openUntil = null;
    circuit.failures = 0;
    return true;
  }

  reserveRead(state, { key, limits }) {
    this.assertCircuitClosed(state, key);
    const bucket = this._bucket(state, key);
    const keys = this._windowKeys();
    this._rotate(bucket.read, keys);
    if (bucket.read.hourCount >= limits.readPerHour || bucket.read.dayCount >= limits.readPerDay) {
      throw new AppError('QUOTA_EXCEEDED', 'read quota exhausted', {
        details: { key, readPerHour: limits.readPerHour, readPerDay: limits.readPerDay }
      });
    }
    bucket.read.hourCount += 1;
    bucket.read.dayCount += 1;
    return { hourCount: bucket.read.hourCount, dayCount: bucket.read.dayCount };
  }

  /**
   * Consume a platform write slot and optional action-specific quota.
   * Must be called inside the same store transaction that reserves the Operation.
   */
  reserveWrite(state, { key, limits, action = null, actionQuota = null }) {
    this.assertCircuitClosed(state, key);
    const bucket = this._bucket(state, key);
    const keys = this._windowKeys();
    this._rotate(bucket.write, keys);
    if (bucket.write.nextAllowedAt && Date.parse(bucket.write.nextAllowedAt) > keys.nowMs) {
      throw new AppError('RATE_LIMITED', 'write cooldown is active', {
        retryable: true,
        details: { nextAllowedAt: bucket.write.nextAllowedAt }
      });
    }
    if (bucket.write.hourCount >= limits.writePerHour || bucket.write.dayCount >= limits.writePerDay) {
      throw new AppError('QUOTA_EXCEEDED', 'global write quota exhausted', {
        details: { key, writePerHour: limits.writePerHour, writePerDay: limits.writePerDay }
      });
    }
    let actionBucket = null;
    if (action) {
      if (!bucket.write.actions[action]) {
        bucket.write.actions[action] = { hourKey: null, dayKey: null, hourCount: 0, dayCount: 0 };
      }
      actionBucket = bucket.write.actions[action];
      this._rotate(actionBucket, keys);
      const perHour = actionQuota?.perHour ?? limits.writePerHour;
      const perDay = actionQuota?.perDay ?? limits.writePerDay;
      if (actionBucket.hourCount >= perHour || actionBucket.dayCount >= perDay) {
        throw new AppError('QUOTA_EXCEEDED', `${action} quota exhausted`, {
          details: { key, action, perHour, perDay }
        });
      }
    }
    bucket.write.hourCount += 1;
    bucket.write.dayCount += 1;
    if (actionBucket) {
      actionBucket.hourCount += 1;
      actionBucket.dayCount += 1;
    }
    bucket.write.nextAllowedAt = new Date(keys.nowMs + limits.writeGapMs).toISOString();
    return {
      hourCount: bucket.write.hourCount,
      dayCount: bucket.write.dayCount,
      nextAllowedAt: bucket.write.nextAllowedAt
    };
  }

  /** Read-only quota probe; never increments. */
  peek(state, { key, action = null, limits }) {
    const bucket = state.rate[key];
    if (!bucket) return { available: true };
    this.assertCircuitClosed(state, key);
    const keys = this._windowKeys();
    const write = { ...bucket.write };
    this._rotate(write, keys);
    const actionBucket = action ? { ...(bucket.write.actions[action] || {}) } : null;
    if (actionBucket) this._rotate(actionBucket, keys);
    return {
      available:
        write.hourCount < limits.writePerHour &&
        write.dayCount < limits.writePerDay &&
        (!actionBucket || (actionBucket.hourCount < limits.writePerHour && actionBucket.dayCount < limits.writePerDay)),
      write,
      action: actionBucket,
      nextAllowedAt: write.nextAllowedAt
    };
  }

  recordRisk(state, key, { code = null, retryAfterMs = 0, reason = null } = {}) {
    const bucket = this._bucket(state, key);
    const circuit = bucket.circuit;
    circuit.failures = (circuit.failures || 0) + 1;
    const base = 5 * 60 * 1000;
    const maximum = 30 * 60 * 1000;
    const exponential = Math.min(maximum, base * 2 ** (circuit.failures - 1));
    const delay = Math.min(maximum, Math.max(retryAfterMs || 0, exponential));
    circuit.openUntil = new Date(this.now().getTime() + delay).toISOString();
    circuit.lastCode = code;
    circuit.reason = reason;
    return { ...circuit, delayMs: delay };
  }

  recordSuccess(state, key) {
    const bucket = this._bucket(state, key);
    bucket.circuit.failures = 0;
    bucket.circuit.openUntil = null;
    bucket.circuit.lastCode = null;
  }

  status(state, key) {
    const bucket = state.rate[key];
    if (!bucket) return { circuitOpen: false, read: null, write: null };
    return {
      circuitOpen: Boolean(bucket.circuit?.openUntil && Date.parse(bucket.circuit.openUntil) > this.now().getTime()),
      circuit: bucket.circuit || null,
      read: bucket.read || null,
      write: bucket.write
        ? {
            nextAllowedAt: bucket.write.nextAllowedAt,
            hourCount: bucket.write.hourCount,
            dayCount: bucket.write.dayCount,
            actions: bucket.write.actions
          }
        : null
    };
  }
}

export default RateLimiter;
