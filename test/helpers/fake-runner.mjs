#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
let seq = 0;
const emit = (event) => {
  seq += 1;
  process.stdout.write(`${JSON.stringify({
    executionId: request.executionId,
    taskId: request.taskId,
    stageId: request.stageId,
    attempt: request.attempt,
    seq,
    profileId: request.profile?.id,
    ...event
  })}\n`);
};
const mode = request.plan?.testMode || 'success';
emit({ status: 'accepted' });
emit({ status: 'running', progress: 0.1 });
if (mode === 'badjson') {
  process.stdout.write('not json\n');
  process.exit(0);
}
if (mode === 'badseq') {
  process.stdout.write(`${JSON.stringify({ executionId: request.executionId, seq: 99, status: 'succeeded', outputs: {} })}\n`);
  process.stdout.write(`${JSON.stringify({ executionId: request.executionId, seq: 99, status: 'failed', error: { message: 'conflict' } })}\n`);
  process.exit(0);
}
if (mode === 'oversize') {
  const line = 'x'.repeat(1024 * 1024 + 10);
  process.stdout.write(`${line}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.exit(0);
}
if (mode === 'flood') {
  for (let i = 0; i < 20; i += 1) {
    process.stdout.write(`${'x'.repeat(512 * 1024)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.exit(0);
}
if (mode === 'slow') {
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (mode === 'fail') {
  emit({ status: 'failed', error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'fake failure' } });
  process.exit(1);
}
if (mode === 'no-success') {
  process.exit(0);
}
const workDir = request.workDir;
if (request.stageId === 'render') {
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(path.join(workDir, 'render.mp4'), 'fake video bytes');
  await fs.writeFile(path.join(workDir, 'cover.jpg'), 'fake cover bytes');
  emit({
    status: 'succeeded',
    outputs: {
      video: 'render.mp4',
      cover: 'cover.jpg',
      envKeys: Object.keys(process.env).sort(),
      args: process.argv.slice(2)
    }
  });
} else {
  emit({ status: 'succeeded', outputs: { validated: true } });
}
