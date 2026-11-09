import { AppError } from './errors.js';
import { formatDateInZone, formatDateTimeInZone, nowIso } from './utils.js';

export const RISK_CODES = Object.freeze([-412, -352, -799, -509, -10403]);

export class RateLimiter {
  constructor({
    now = () => new Date(),
    getTimeZone = () => 'Asia/Shanghai',
    circuitBaseMs = 5 * 60 * 1000,
    circuitMaxMs = 30 * 60 * 1000
  } = {}) {
    this.now = now;
    this.getTimeZone = getTimeZone;
    this.circuitBaseMs = Number(circuitBaseMs) > 0 ? Number(circuitBaseMs) : 5 * 60 * 1000;
    this.circuitMaxMs = Number(circuitMaxMs) >= this.circuitBaseMs ? Number(circuitMaxMs) : 30 * 60 * 1000;
  }

  _bucket(state, key) {
    if (!state.rate[key]) {
      state.rate[key] = {
        read: {
          hourKey: null,
          dayKey: null,
          hourCount: 0,
          dayCount: 0,
          nextAllowedAt: null
        },
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

  /**
   * Login failure / captcha handling is a human decision (SPEC §7.4): the
   * stable account namespace is paused until a local human resumes it. Reads
   * and writes both fail closed while the pause is active.
   */
  assertAuthNotPaused(state, key) {
    const account = state?.accounts?.[key];
    if (!account?.authPausedAt) return true;
    throw new AppError('CREDENTIAL_MISSING', 'platform login is paused pending a local human resume', {
      details: {
        key,
        pausedAt: account.authPausedAt,
        reason: account.authPausedReason || null,
        biliCode: account.authPausedCode ?? null
      }
    });
  }

  isAuthPaused(state, key) {
    return Boolean(state?.accounts?.[key]?.authPausedAt);
  }

  /** Persist the manual pause. Callers pass the draft inside a transaction. */
  markAuthPaused(state, key, { code = null, reason = 'login_invalid', at = null } = {}) {
    const account = state?.accounts?.[key];
    if (!account) return { paused: false, reason: 'account_not_bound' };
    account.authPausedAt = at || nowIso(this.now);
    account.authPausedReason = String(reason || 'login_invalid').slice(0, 200);
    account.authPausedCode = code === null || code === undefined ? null : String(code);
    return { paused: true, accountRef: account.accountRef || null, pausedAt: account.authPausedAt };
  }

  /**
   * Clear the manual pause after a local human resume. The event, when a
   * transaction is supplied, records the human evidence; the pause fields are
   * always cleared so the account can be re-verified.
   */
  clearAuthPause(stateOrTx, accountKey, evidence = {}) {
    const state = stateOrTx?.state?.accounts ? stateOrTx.state : stateOrTx;
    const tx = stateOrTx?.state?.accounts ? stateOrTx : null;
    const account = state?.accounts?.[accountKey];
    if (!account) {
      throw new AppError('INPUT_REQUIRED', `account ${accountKey} is not bound`);
    }
    const cleared = Boolean(account.authPausedAt);
    const previous = {
      pausedAt: account.authPausedAt || null,
      reason: account.authPausedReason || null,
      code: account.authPausedCode ?? null
    };
    account.authPausedAt = null;
    account.authPausedReason = null;
    account.authPausedCode = null;
    if (tx?.appendEvent) {
      tx.appendEvent({
        type: 'account.auth.resumed',
        actor: evidence.actor || 'local_human',
        accountRef: account.accountRef || null,
        payload: {
          accountKey,
          cleared,
          previous,
          note: evidence.note ? String(evidence.note).slice(0, 300) : null,
          evidenceRef: evidence.evidenceRef || null,
          at: nowIso(this.now)
        }
      });
    }
    return { cleared, accountKey };
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

  /**
   * Reserve a read slot and (optionally) enforce the read time slot. Retries
   * must reserve the quota again; they pass `enforceGap: false` so a transient
   * read failure is not blocked by the slot it just consumed.
   */
  reserveRead(state, { key, limits = {}, enforceGap = false } = {}) {
    this.assertAuthNotPaused(state, key);
    this.assertCircuitClosed(state, key);
    const bucket = this._bucket(state, key);
    const keys = this._windowKeys();
    this._rotate(bucket.read, keys);
    const gapMs = Number(limits?.minGapMs) > 0 ? Number(limits.minGapMs) : 0;
    const nextAllowedAt = bucket.read.nextAllowedAt ? Date.parse(bucket.read.nextAllowedAt) : NaN;
    if (enforceGap && gapMs > 0 && Number.isFinite(nextAllowedAt) && nextAllowedAt > keys.nowMs) {
      throw new AppError('RATE_LIMITED', 'read time slot is not available yet', {
        retryable: true,
        details: { key, nextAllowedAt: bucket.read.nextAllowedAt, minGapMs: gapMs }
      });
    }
    const readPerHour = Number(limits?.readPerHour) || Number.POSITIVE_INFINITY;
    const readPerDay = Number(limits?.readPerDay) || Number.POSITIVE_INFINITY;
    if (bucket.read.hourCount >= readPerHour || bucket.read.dayCount >= readPerDay) {
      throw new AppError('QUOTA_EXCEEDED', 'read quota exhausted', {
        details: { key, readPerHour: limits?.readPerHour, readPerDay: limits?.readPerDay }
      });
    }
    bucket.read.hourCount += 1;
    bucket.read.dayCount += 1;
    bucket.read.nextAllowedAt = gapMs > 0 ? new Date(keys.nowMs + gapMs).toISOString() : null;
    return {
      hourCount: bucket.read.hourCount,
      dayCount: bucket.read.dayCount,
      nextAllowedAt: bucket.read.nextAllowedAt
    };
  }

  /**
   * Consume a platform write slot and optional action-specific quota.
   * Must be called inside the same store transaction that reserves the Operation.
   */
  reserveWrite(state, { key, limits = {}, action = null, actionQuota = null }) {
    this.assertAuthNotPaused(state, key);
    this.assertCircuitClosed(state, key);
    const bucket = this._bucket(state, key);
    const keys = this._windowKeys();
    this._rotate(bucket.write, keys);
    const writeGapMs = Number(limits?.writeGapMs) > 0 ? Number(limits.writeGapMs) : 0;
    const writePerHour = Number(limits?.writePerHour) || Number.POSITIVE_INFINITY;
    const writePerDay = Number(limits?.writePerDay) || Number.POSITIVE_INFINITY;
    if (bucket.write.nextAllowedAt && Date.parse(bucket.write.nextAllowedAt) > keys.nowMs) {
      throw new AppError('RATE_LIMITED', 'write cooldown is active', {
        retryable: true,
        details: { nextAllowedAt: bucket.write.nextAllowedAt }
      });
    }
    if (bucket.write.hourCount >= writePerHour || bucket.write.dayCount >= writePerDay) {
      throw new AppError('QUOTA_EXCEEDED', 'global write quota exhausted', {
        details: { key, writePerHour: limits?.writePerHour, writePerDay: limits?.writePerDay }
      });
    }
    let actionBucket = null;
    if (action) {
      if (!bucket.write.actions[action]) {
        bucket.write.actions[action] = { hourKey: null, dayKey: null, hourCount: 0, dayCount: 0 };
      }
      actionBucket = bucket.write.actions[action];
      this._rotate(actionBucket, keys);
      const perHour = Number(actionQuota?.perHour ?? limits?.writePerHour) || Number.POSITIVE_INFINITY;
      const perDay = Number(actionQuota?.perDay ?? limits?.writePerDay) || Number.POSITIVE_INFINITY;
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
    bucket.write.nextAllowedAt = writeGapMs > 0 ? new Date(keys.nowMs + writeGapMs).toISOString() : null;
    return {
      hourCount: bucket.write.hourCount,
      dayCount: bucket.write.dayCount,
      nextAllowedAt: bucket.write.nextAllowedAt
    };
  }

  /**
   * Release the quota consumed by a reserved Operation that is provably never
   * dispatched. The scheduling slot is kept: the cancelled attempt already
   * consumed its turn (SPEC §7.3).
   */
  releaseWrite(state, { key, action = null, amount = 1 } = {}) {
    const bucket = state?.rate?.[key];
    if (!bucket?.write) return { released: false };
    const count = Number.isSafeInteger(amount) && amount > 0 ? amount : 1;
    bucket.write.hourCount = Math.max(0, bucket.write.hourCount - count);
    bucket.write.dayCount = Math.max(0, bucket.write.dayCount - count);
    if (action && bucket.write.actions?.[action]) {
      bucket.write.actions[action].hourCount = Math.max(0, bucket.write.actions[action].hourCount - count);
      bucket.write.actions[action].dayCount = Math.max(0, bucket.write.actions[action].dayCount - count);
    }
    return { released: true };
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
    const base = this.circuitBaseMs;
    const maximum = this.circuitMaxMs;
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
    const account = state.accounts?.[key] || null;
    const authPause = account?.authPausedAt
      ? {
          pausedAt: account.authPausedAt,
          reason: account.authPausedReason || null,
          biliCode: account.authPausedCode ?? null
        }
      : null;
    if (!bucket) {
      return {
        circuitOpen: false,
        read: null,
        write: null,
        authPaused: Boolean(account?.authPausedAt),
        authPause
      };
    }
    return {
      circuitOpen: Boolean(bucket.circuit?.openUntil && Date.parse(bucket.circuit.openUntil) > this.now().getTime()),
      circuit: bucket.circuit || null,
      authPaused: Boolean(account?.authPausedAt),
      authPause,
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
