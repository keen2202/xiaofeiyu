import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../errors.js';
import { jcsHash, nowIso, randomId } from '../../utils.js';

const DEFAULT_RUNNER = fileURLToPath(new URL('../../production/runner.mjs', import.meta.url));
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);

export class LocalExecutionBackend {
  constructor({
    runnerPath = DEFAULT_RUNNER,
    nodeExecPath = process.execPath,
    maxConcurrent = 1,
    now = () => new Date(),
    logger,
    hooks = {},
    env = null,
    maxLineBytes = MAX_LINE_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES,
    killGraceMs = 3000
  } = {}) {
    this.backendId = 'local';
    this.runnerPath = runnerPath;
    this.nodeExecPath = nodeExecPath;
    this.maxConcurrent = maxConcurrent;
    this.now = now;
    this.logger = logger;
    this.hooks = hooks;
    this.env = env;
    this.maxLineBytes = maxLineBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.killGraceMs = killGraceMs;
    this.records = new Map();
    this.active = 0;
    this.closing = false;
    this._onEvent = null;
  }

  capabilities() {
    return {
      backendId: this.backendId,
      schemaVersion: 1,
      supportedStages: ['render', 'validate'],
      supportsCancel: true,
      supportsCheckpoint: false,
      maxConcurrent: this.maxConcurrent,
      unavailableReason: null
    };
  }

  setEventHandler(handler) {
    this._onEvent = handler;
  }

  _validateRequest(request) {
    const required = ['executionId', 'taskId', 'stageId', 'attempt', 'inputHash', 'profileId', 'workDir', 'plan'];
    for (const key of required) {
      if (request?.[key] === undefined || request?.[key] === null || request?.[key] === '') {
        throw new AppError('INPUT_REQUIRED', `stageRequest.${key} is required`);
      }
    }
    if (!['render', 'validate'].includes(request.stageId)) {
      throw new AppError('CAPABILITY_UNSUPPORTED', `local backend does not run stage ${request.stageId}`);
    }
    if (!path.isAbsolute(request.workDir)) throw new AppError('INPUT_REQUIRED', 'workDir must be absolute');
    if (!request.tools?.ffmpeg || !request.tools?.ffprobe) {
      throw new AppError('INPUT_REQUIRED', 'tools.ffmpeg and tools.ffprobe are required');
    }
    if (!path.isAbsolute(request.tools.ffmpeg) || !path.isAbsolute(request.tools.ffprobe)) {
      throw new AppError('INPUT_REQUIRED', 'ffmpeg/ffprobe paths must be absolute');
    }
    if (!Number.isSafeInteger(request.limits?.wallTimeSec) || request.limits.wallTimeSec < 1) {
      throw new AppError('INPUT_REQUIRED', 'limits.wallTimeSec is required');
    }
    if (!Array.isArray(request.allowedInputRoots) || request.allowedInputRoots.some((root) => !path.isAbsolute(root))) {
      throw new AppError('INPUT_REQUIRED', 'allowedInputRoots must be absolute paths');
    }
    return request;
  }

  async submit(request) {
    this._validateRequest(request);
    if (this.closing) throw new AppError('DEPENDENCY_UNAVAILABLE', 'execution backend is closing');
    const existing = this.records.get(request.executionId);
    if (existing) {
      if (TERMINAL.has(existing.status)) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'executionId is already terminal and cannot be restarted');
      }
      return {
        executionId: existing.executionId,
        accepted: true,
        status: existing.status,
        deduplicated: true
      };
    }
    if (this.active >= this.maxConcurrent) {
      throw new AppError('BUDGET_EXCEEDED', 'local execution concurrency limit reached');
    }
    const record = {
      executionId: request.executionId,
      taskId: request.taskId,
      stageId: request.stageId,
      attempt: request.attempt,
      inputHash: request.inputHash,
      status: 'accepted',
      seq: 0,
      events: [],
      outputs: null,
      error: null,
      progress: 0,
      startedAt: nowIso(this.now),
      finishedAt: null,
      cancelRequested: false,
      child: null,
      stderr: '',
      timedOut: false,
      done: null,
      _resolve: null
    };
    record.done = new Promise((resolve) => {
      record._resolve = resolve;
    });
    this.records.set(record.executionId, record);
    this.active += 1;

    if (this.hooks.beforeSpawn) {
      try {
        await this.hooks.beforeSpawn({ request, record });
      } catch (error) {
        record.error = { code: error.code || 'DEPENDENCY_UNAVAILABLE', message: error.message };
        record.status = 'failed';
        this._finalize(record);
        throw error;
      }
    }

    const env = this._environment();
    let child;
    try {
      child = spawn(this.nodeExecPath, [this.runnerPath], {
        cwd: request.workDir,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      record.error = { code: 'DEPENDENCY_UNAVAILABLE', message: error.message };
      record.status = 'failed';
      this._finalize(record);
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'failed to spawn local runner', { cause: error });
    }
    record.child = child;
    const timeoutMs = request.limits.wallTimeSec * 1000 + 5000;
    const timer = setTimeout(() => {
      record.timedOut = true;
      record.error = { code: 'BUDGET_EXCEEDED', message: 'runner wall-time limit exceeded' };
      this._terminate(child, 'SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    record._timer = timer;

    let stdoutBuffer = '';
    let totalBytes = 0;
    let resolved = false;
    const rejectOnce = (error) => {
      if (resolved) return;
      resolved = true;
      record.error = record.error || { code: error.code || 'DEPENDENCY_UNAVAILABLE', message: error.message };
      record.status = 'failed';
      this._terminate(child, 'SIGKILL');
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > this.maxTotalBytes) {
        rejectOnce(new AppError('BUDGET_EXCEEDED', 'runner output exceeded the total limit'));
        return;
      }
      stdoutBuffer += chunk;
      while (stdoutBuffer.includes('\n')) {
        const newline = stdoutBuffer.indexOf('\n');
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (Buffer.byteLength(line) > this.maxLineBytes) {
          rejectOnce(new AppError('BUDGET_EXCEEDED', 'runner JSONL line exceeded 1MiB'));
          return;
        }
        if (line.trim() === '') continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          rejectOnce(new AppError('DEPENDENCY_UNAVAILABLE', 'runner emitted invalid JSONL'));
          return;
        }
        this._applyEvent(record, event);
      }
      if (Buffer.byteLength(stdoutBuffer) > this.maxLineBytes) {
        rejectOnce(new AppError('BUDGET_EXCEEDED', 'runner JSONL buffer exceeded 1MiB'));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > this.maxTotalBytes) {
        rejectOnce(new AppError('BUDGET_EXCEEDED', 'runner output exceeded the total limit'));
        return;
      }
      record.stderr = `${record.stderr}${chunk}`.slice(-4096);
    });
    child.on('error', (error) => {
      record.error = { code: 'DEPENDENCY_UNAVAILABLE', message: error.message };
      this._finalize(record, { spawnError: error });
    });
    child.on('close', (code, signal) => {
      this._finalize(record, { exitCode: code, signal });
    });
    child.stdin.on('error', () => {});
    try {
      const payload = {
        schemaVersion: 1,
        executionId: request.executionId,
        taskId: request.taskId,
        stageId: request.stageId,
        attempt: request.attempt,
        profile: request.profile || { id: request.profileId },
        tools: request.tools,
        workDir: request.workDir,
        allowedInputRoots: request.allowedInputRoots,
        limits: request.limits,
        plan: request.plan
      };
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      child.stdin.end();
    } catch (error) {
      record.error = { code: 'DEPENDENCY_UNAVAILABLE', message: 'failed to write runner request' };
      this._terminate(child, 'SIGKILL');
    }
    await this.hooks.afterSpawn?.({ request, record });
    return {
      executionId: record.executionId,
      accepted: true,
      status: record.status,
      deduplicated: false
    };
  }

  _environment() {
    if (this.env) return this.env;
    const allowed = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'];
    const env = {};
    for (const key of allowed) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return env;
  }

  _applyEvent(record, event) {
    if (TERMINAL.has(record.status)) return;
    if (event.executionId !== undefined && event.executionId !== record.executionId) {
      this._failRecord(record, new AppError('IDEMPOTENCY_CONFLICT', 'executionId mismatch in runner event'));
      return;
    }
    if (event.taskId !== undefined && event.taskId !== record.taskId) {
      this._failRecord(record, new AppError('IDEMPOTENCY_CONFLICT', 'taskId mismatch in runner event'));
      return;
    }
    if (event.attempt !== undefined && event.attempt !== record.attempt) {
      return; // stale attempt
    }
    const seq = event.seq;
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      this._failRecord(record, new AppError('DEPENDENCY_UNAVAILABLE', 'runner event has no valid seq'));
      return;
    }
    const previous = record.events.find((entry) => entry.seq === seq);
    if (previous) {
      if (jcsHash(previous) !== jcsHash(event)) {
        this._failRecord(record, new AppError('IDEMPOTENCY_CONFLICT', 'same seq with different content'));
      }
      return;
    }
    if (seq < record.seq) return; // out-of-order older event cannot regress state
    record.seq = seq;
    record.events.push(event);
    if (record.events.length > 500) record.events.shift();
    if (typeof event.progress === 'number') record.progress = event.progress;
    if (event.status === 'accepted') record.status = record.status === 'accepted' ? 'accepted' : record.status;
    else if (event.status === 'running') record.status = 'running';
    else if (event.status === 'cancel_requested') record.status = event.status;
    else if (event.status === 'succeeded') {
      record.status = 'succeeded';
      record.outputs = event.outputs || null;
      record.finishedAt = nowIso(this.now);
    } else if (event.status === 'failed') {
      record.status = 'failed';
      record.error = event.error || { code: 'DEPENDENCY_UNAVAILABLE', message: 'runner failed' };
      record.finishedAt = nowIso(this.now);
    } else if (event.status === 'cancelled') {
      record.status = 'cancelled';
      record.finishedAt = nowIso(this.now);
    } else if (event.status === 'unknown') {
      record.status = 'unknown';
      record.error = event.error || { code: 'OPERATION_UNKNOWN', message: 'runner reported unknown' };
      record.finishedAt = nowIso(this.now);
    }
    try {
      this._onEvent?.(record, event);
    } catch (error) {
      if (this.logger) this.logger.warn?.('execution event handler failed', { message: error.message });
    }
    if (TERMINAL.has(record.status)) {
      // The child may still be flushing; terminate politely only if it does not exit.
      const child = record.child;
      if (child && !child.killed) {
        const timer = setTimeout(() => {
          if (record.child) this._terminate(child, 'SIGKILL');
        }, 2000);
        timer.unref?.();
      }
    }
  }

  _failRecord(record, error) {
    if (TERMINAL.has(record.status)) return;
    record.status = 'failed';
    record.error = { code: error.code || 'DEPENDENCY_UNAVAILABLE', message: error.message };
    if (record.child) this._terminate(record.child, 'SIGKILL');
  }

  _terminate(child, signal = 'SIGTERM') {
    if (!child || child.killed) return;
    try {
      child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  }

  _finalize(record, { exitCode = null, signal = null, spawnError = null } = {}) {
    if (record._finalized) return;
    record._finalized = true;
    clearTimeout(record._timer);
    if (record._killTimer) clearTimeout(record._killTimer);
    const wasTerminal = TERMINAL.has(record.status);
    if (!wasTerminal) {
      if (record.cancelRequested) {
        record.status = 'cancelled';
      } else if (record.timedOut) {
        record.status = 'failed';
        record.error = record.error || { code: 'BUDGET_EXCEEDED', message: 'runner timed out' };
      } else if (spawnError) {
        record.status = 'failed';
        record.error = { code: 'DEPENDENCY_UNAVAILABLE', message: spawnError.message };
      } else if (exitCode === 0) {
        record.status = 'failed';
        record.error = { code: 'DEPENDENCY_UNAVAILABLE', message: 'runner exited without a success event' };
      } else {
        record.status = 'failed';
        record.error = record.error || {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: `runner exited with code ${exitCode}${signal ? ` (${signal})` : ''}`
        };
      }
    }
    record.finishedAt = record.finishedAt || nowIso(this.now);
    record.exitCode = exitCode;
    record.signal = signal;
    record.child = null;
    if (this.active > 0) this.active -= 1;
    record._resolve?.(this.statusSnapshot(record));
    this.hooks.afterExit?.({ record: this.statusSnapshot(record) });
  }

  statusSnapshot(record) {
    return {
      executionId: record.executionId,
      taskId: record.taskId,
      stageId: record.stageId,
      attempt: record.attempt,
      inputHash: record.inputHash,
      status: record.status,
      seq: record.seq,
      progress: record.progress,
      outputs: record.outputs,
      error: record.error,
      stderrTail: record.stderr ? record.stderr.slice(-1000) : '',
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      cancelRequested: record.cancelRequested
    };
  }

  async getStatus(executionId) {
    const record = this.records.get(executionId);
    if (!record) throw new AppError('FORBIDDEN', 'execution not found');
    return this.statusSnapshot(record);
  }

  async wait(executionId) {
    const record = this.records.get(executionId);
    if (!record) throw new AppError('FORBIDDEN', 'execution not found');
    return record.done;
  }

  async run(request) {
    const submitted = await this.submit(request);
    return this.wait(submitted.executionId);
  }

  async cancel(executionId) {
    const record = this.records.get(executionId);
    if (!record) throw new AppError('FORBIDDEN', 'execution not found');
    if (TERMINAL.has(record.status)) return this.statusSnapshot(record);
    record.cancelRequested = true;
    record.status = 'cancel_requested';
    if (record.child) {
      this._terminate(record.child, 'SIGTERM');
      record._killTimer = setTimeout(() => this._terminate(record.child, 'SIGKILL'), this.killGraceMs);
      record._killTimer.unref?.();
    } else {
      this._finalize(record);
    }
    return this.statusSnapshot(record);
  }

  async _waitWithTimeout(promises, timeoutMs) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled(promises), timeout]);
    clearTimeout(timer);
  }

  async close() {
    this.closing = true;
    const activeRecords = [...this.records.values()].filter((record) => !TERMINAL.has(record.status));
    for (const record of activeRecords) {
      record.cancelRequested = true;
      if (record.child) this._terminate(record.child, 'SIGTERM');
    }
    await this._waitWithTimeout(activeRecords.map((record) => record.done), this.killGraceMs * 2);
    const stillActive = [...this.records.values()].filter((record) => record.child);
    for (const record of stillActive) this._terminate(record.child, 'SIGKILL');
    await this._waitWithTimeout(stillActive.map((record) => record.done), this.killGraceMs);
    return {
      stopped: ![...this.records.values()].some((record) => record.child),
      active: [...this.records.values()]
        .filter((record) => record.child)
        .map((record) => this.statusSnapshot(record))
    };
  }
}

export default LocalExecutionBackend;
