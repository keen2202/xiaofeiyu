import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import {
  atomicWriteJson,
  deepClone,
  ensureDir,
  isSafeRelativePath,
  jcsHash,
  nowIso,
  pathExists,
  resolveInside,
  sha256Hex
} from './utils.js';

export const JOURNAL_SCHEMA_VERSION = 1;
export const JOURNAL_SEGMENT_MAX_EVENTS = 500;

export function safeEpochName(epoch) {
  if (typeof epoch === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(epoch)) return epoch;
  return `epoch-${sha256Hex(String(epoch)).slice(0, 32)}`;
}

export function segmentHash(historyEpoch, events) {
  return jcsHash({ schemaVersion: JOURNAL_SCHEMA_VERSION, historyEpoch, events });
}

export class EventJournal {
  constructor({ store, dir, now = () => new Date(), hooks = {}, logger, segmentMaxEvents = JOURNAL_SEGMENT_MAX_EVENTS } = {}) {
    this.store = store;
    this.dir = dir;
    this.now = now;
    this.hooks = hooks;
    this.logger = logger;
    this.segmentMaxEvents = segmentMaxEvents;
  }

  async _writeSegment(historyEpoch, events) {
    if (events.length === 0) throw new Error('cannot write an empty journal segment');
    const startSeq = events[0].seq;
    const endSeq = events.at(-1).seq;
    const hash = segmentHash(historyEpoch, events);
    const epochDir = safeEpochName(historyEpoch);
    const hashName = hash.replace(/^jcs-sha256-v1:/, '').slice(0, 32);
    const relative = path.posix.join(epochDir, `${startSeq}-${endSeq}-${hashName}.json`);
    const file = resolveInside(this.dir, relative);
    await ensureDir(path.dirname(file));
    const segment = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      historyEpoch,
      startSeq,
      endSeq,
      segmentHash: hash,
      createdAt: nowIso(this.now),
      events
    };
    await atomicWriteJson(file, segment, {
      hooks: {
        afterTempWrite: this.hooks.afterSegmentTempWrite,
        beforeRename: this.hooks.beforeSegmentRename,
        afterRename: this.hooks.afterSegmentRename
      }
    });
    return { relative, file, hash, startSeq, endSeq, count: events.length };
  }

  async flush({ maxEvents = 2000 } = {}) {
    const snapshot = await this.store.getSnapshot();
    const pending = Object.values(snapshot.journalPending)
      .filter((event) => event.historyEpoch === snapshot.historyEpoch)
      .sort((a, b) => a.seq - b.seq || String(a.eventId).localeCompare(String(b.eventId)))
      .slice(0, maxEvents);
    if (pending.length === 0) return { archived: 0, segments: [] };

    const segments = [];
    for (let offset = 0; offset < pending.length; offset += this.segmentMaxEvents) {
      const chunk = pending.slice(offset, offset + this.segmentMaxEvents);
      segments.push(await this._writeSegment(snapshot.historyEpoch, chunk));
    }

    const confirmed = await this.store.transaction(async (draft, tx) => {
      const registered = [];
      for (const segment of segments) {
        const currentEvents = segmentEventsFromPending(draft, segment, snapshot.historyEpoch);
        if (!currentEvents) {
          throw new AppError('JOURNAL_CORRUPTED', 'journal pending changed during archival');
        }
        const key = `${snapshot.historyEpoch}:${segment.startSeq}-${segment.endSeq}`;
        if (draft.journalSegments[key]) {
          const existing = draft.journalSegments[key];
          if (existing.hash !== segment.hash) {
            throw new AppError('JOURNAL_CORRUPTED', 'journal segment sequence conflict', {
              details: { epoch: snapshot.historyEpoch, startSeq: segment.startSeq, endSeq: segment.endSeq }
            });
          }
        } else {
          draft.journalSegments[key] = {
            key,
            relativePath: segment.relative,
            historyEpoch: snapshot.historyEpoch,
            startSeq: segment.startSeq,
            endSeq: segment.endSeq,
            hash: segment.hash,
            count: segment.count,
            createdAt: nowIso(this.now)
          };
        }
        for (const event of currentEvents) delete draft.journalPending[event.eventId];
        registered.push(key);
      }
      // Archival itself is not a business fact; emitting an event here would
      // create an endless archive-of-archive loop.
      return registered;
    });

    await this._writeIndexes(snapshot.historyEpoch);
    return { archived: pending.length, segments: confirmed };
  }

  async archiveAll({ maxRounds = 100, maxEvents = 2000 } = {}) {
    let archived = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      const result = await this.flush({ maxEvents });
      archived += result.archived;
      if (result.archived === 0) break;
    }
    return { archived };
  }

  async _writeIndexes(historyEpoch) {
    const state = await this.store.getSnapshot();
    const epochDirName = safeEpochName(historyEpoch);
    const segments = Object.values(state.journalSegments)
      .filter((segment) => segment.historyEpoch === historyEpoch)
      .sort((a, b) => a.startSeq - b.startSeq);
    const indexFile = resolveInside(this.dir, path.posix.join(epochDirName, 'index.json'));
    await atomicWriteJson(indexFile, {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      historyEpoch,
      eventSeq: state.eventSeq,
      segments,
      updatedAt: nowIso(this.now)
    });
  }

  /**
   * Read a complete, gap-free event range for one epoch.
   * Missing/corrupt segments or duplicate seq always fail closed.
   */
  async readEvents({ epoch, upToSeq, fromSeq = 1 } = {}) {
    const state = await this.store.getSnapshot();
    const historyEpoch = epoch || state.historyEpoch;
    const targetSeq = upToSeq === undefined ? (historyEpoch === state.historyEpoch ? state.eventSeq : undefined) : upToSeq;
    if (targetSeq === undefined) {
      throw new AppError('JOURNAL_CORRUPTED', 'cannot infer event cursor for a non-current epoch');
    }
    const bySeq = new Map();
    const byEventId = new Map();
    const segments = Object.values(state.journalSegments)
      .filter((segment) => segment.historyEpoch === historyEpoch)
      .sort((a, b) => a.startSeq - b.startSeq);
    for (const registered of segments) {
      if (!isSafeRelativePath(registered.relativePath)) {
        throw new AppError('JOURNAL_CORRUPTED', 'journal segment path is unsafe');
      }
      const file = resolveInside(this.dir, registered.relativePath);
      if (!(await pathExists(file))) {
        throw new AppError('JOURNAL_CORRUPTED', 'journal segment is missing', {
          details: { relativePath: registered.relativePath }
        });
      }
      let segment;
      try {
        segment = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch (error) {
        throw new AppError('JOURNAL_CORRUPTED', 'journal segment is not valid JSON', {
          cause: error,
          details: { relativePath: registered.relativePath }
        });
      }
      if (
        segment.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
        segment.historyEpoch !== historyEpoch ||
        segment.startSeq !== registered.startSeq ||
        segment.endSeq !== registered.endSeq ||
        segment.segmentHash !== registered.hash ||
        segmentHash(historyEpoch, segment.events) !== registered.hash
      ) {
        throw new AppError('JOURNAL_CORRUPTED', 'journal segment integrity check failed', {
          details: { relativePath: registered.relativePath }
        });
      }
      for (const event of segment.events) addEvent(event, historyEpoch, bySeq, byEventId);
    }
    for (const event of Object.values(state.journalPending)) {
      if (event.historyEpoch === historyEpoch) addEvent(event, historyEpoch, bySeq, byEventId);
    }
    for (const event of state.events) {
      if (event.historyEpoch === historyEpoch) addEvent(event, historyEpoch, bySeq, byEventId);
    }
    const events = [];
    for (let seq = fromSeq; seq <= targetSeq; seq += 1) {
      const event = bySeq.get(seq);
      if (!event) {
        throw new AppError('JOURNAL_CORRUPTED', 'journal event sequence gap', {
          details: { historyEpoch, seq }
        });
      }
      events.push(event);
    }
    return events;
  }

  async verify({ epoch } = {}) {
    const state = await this.store.getSnapshot();
    const historyEpoch = epoch || state.historyEpoch;
    const target = historyEpoch === state.historyEpoch ? state.eventSeq : undefined;
    const events = await this.readEvents({ epoch: historyEpoch, upToSeq: target });
    return { historyEpoch, eventSeq: events.length ? events.at(-1).seq : 0, segments: Object.keys(state.journalSegments).length };
  }

  async readCursorEvents(cursor) {
    if (!cursor || typeof cursor.historyEpoch !== 'string' || !Number.isSafeInteger(cursor.seq)) {
      throw new AppError('JOURNAL_CORRUPTED', 'invalid event cursor');
    }
    const state = await this.store.getSnapshot();
    if (cursor.historyEpoch === state.historyEpoch) {
      return this.readEvents({ epoch: cursor.historyEpoch, upToSeq: cursor.seq });
    }
    return this.readEvents({ epoch: cursor.historyEpoch, upToSeq: cursor.seq });
  }
}

function addEvent(event, expectedEpoch, bySeq, byEventId) {
  if (!event || event.historyEpoch !== expectedEpoch || !Number.isSafeInteger(event.seq) || typeof event.eventId !== 'string') {
    throw new AppError('JOURNAL_CORRUPTED', 'journal event shape is invalid');
  }
  const existingSeq = bySeq.get(event.seq);
  if (existingSeq && jcsHash(existingSeq) !== jcsHash(event)) {
    throw new AppError('JOURNAL_CORRUPTED', 'duplicate journal seq with different content', {
      details: { seq: event.seq }
    });
  }
  const existingId = byEventId.get(event.eventId);
  if (existingId && jcsHash(existingId) !== jcsHash(event)) {
    throw new AppError('JOURNAL_CORRUPTED', 'duplicate eventId with different content');
  }
  bySeq.set(event.seq, event);
  byEventId.set(event.eventId, event);
}

function segmentEventsFromPending(draft, segment, epoch) {
  const events = [];
  for (let seq = segment.startSeq; seq <= segment.endSeq; seq += 1) {
    const event = Object.values(draft.journalPending).find(
      (candidate) => candidate.historyEpoch === epoch && candidate.seq === seq
    );
    if (!event) return null;
    events.push(event);
  }
  const hash = segmentHash(epoch, events);
  if (hash !== segment.hash) return null;
  return events;
}

export default EventJournal;
