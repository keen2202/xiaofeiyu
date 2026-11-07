import fs from 'node:fs/promises';
import path from 'node:path';

export class FakeExecutionBackend {
  constructor({ status = 'succeeded', validate = null, now = () => new Date() } = {}) {
    this.status = status;
    this.validate = validate;
    this.now = now;
    this.requests = [];
    this.cancelled = [];
    this.records = new Map();
    this.active = 0;
    this.closed = false;
  }

  capabilities() {
    return {
      backendId: 'local',
      supportedStages: ['render', 'validate'],
      supportsCancel: true,
      supportsCheckpoint: false,
      maxConcurrent: 1
    };
  }

  async submit(request) {
    this.requests.push(structuredClone(request));
    this.active += 1;
    const record = {
      status: this.status === 'terminal-reuse' ? 'failed' : this.status,
      outputs: null,
      error: this.status === 'failed' ? { code: 'DEPENDENCY_UNAVAILABLE', message: 'fake backend failure' } : null,
      seq: 2
    };
    if (this.status === 'succeeded') {
      await fs.mkdir(request.workDir, { recursive: true });
      await fs.writeFile(path.join(request.workDir, 'render.mp4'), 'fake video bytes');
      await fs.writeFile(path.join(request.workDir, 'cover.jpg'), 'fake cover bytes');
      record.outputs = { video: 'render.mp4', cover: 'cover.jpg' };
    }
    this.records.set(request.executionId, record);
    return { executionId: request.executionId, accepted: true, status: 'accepted' };
  }

  async wait(executionId) {
    this.active = Math.max(0, this.active - 1);
    const record = this.records.get(executionId);
    if (!record) throw new Error('unknown execution');
    return {
      executionId,
      status: record.status,
      seq: record.seq,
      outputs: this.validate ? await this.validate(record.outputs) : record.outputs,
      error: record.error,
      finishedAt: this.now().toISOString()
    };
  }

  async cancel(executionId) {
    this.cancelled.push(executionId);
    return { executionId, status: 'cancel_requested' };
  }

  async close() {
    this.closed = true;
    return { stopped: true, active: [] };
  }
}
