#!/usr/bin/env node
/**
 * Fixed local production runner. It receives one JSON request on stdin and
 * emits bounded JSONL progress on stdout. It never sees platform credentials,
 * the ledger path, or arbitrary shell templates.
 */
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_TOOL_OUTPUT = 8 * 1024 * 1024;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fail(code, message, seq = null) {
  emit({
    status: 'failed',
    seq,
    error: { code, message: String(message).slice(0, 1000) }
  });
  process.exitCode = 1;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}

async function assertInputFile(file, allowedRoots, label) {
  requireAbsolute(file, label);
  if (!allowedRoots.some((root) => isInside(root, file))) {
    throw new Error(`${label} is outside allowed input roots`);
  }
  const lstat = await fsp.lstat(file);
  if (lstat.isSymbolicLink() || !lstat.isFile()) throw new Error(`${label} must be a regular file`);
}

async function runTool(command, args, { timeoutMs, cwd }) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    cwd,
    maxBuffer: MAX_TOOL_OUTPUT,
    windowsHide: true,
    env: {
      PATH: process.env.PATH || '',
      LANG: process.env.LANG || 'C.UTF-8',
      TMPDIR: process.env.TMPDIR || ''
    }
  });
  return { stdout, stderr };
}

function parseRate(value) {
  if (typeof value !== 'string' || value === '' || value === '0/0') return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

async function probeJson(ffprobe, file, timeoutMs, cwd) {
  const { stdout } = await runTool(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs, cwd }
  );
  return JSON.parse(stdout);
}

function buildRenderArgs(plan, tools, workDir, videoFile, coverFile) {
  const { width, height, fps, durationSec, segments, audioPath, subtitlePath } = plan;
  const args = [];
  const inputIndexes = [];
  for (const segment of segments) {
    if (segment.type === 'image') {
      args.push('-loop', '1', '-framerate', String(fps), '-t', String(segment.durationSec), '-i', segment.path);
    } else {
      if (segment.startSec) args.push('-ss', String(segment.startSec));
      args.push('-t', String(segment.durationSec), '-i', segment.path);
    }
    inputIndexes.push(args.filter((token) => token === '-i').length - 1);
  }
  let audioIndex = null;
  if (audioPath) {
    args.push('-i', audioPath);
    audioIndex = inputIndexes.length;
  }
  let subtitleIndex = null;
  if (subtitlePath) {
    args.push('-i', subtitlePath);
    subtitleIndex = inputIndexes.length + (audioIndex === null ? 0 : 1);
  }
  const filters = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const label = `v${index}`;
    filters.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},` +
        `trim=duration=${segment.durationSec},setpts=PTS-STARTPTS[${label}]`
    );
  }
  filters.push(`${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0[vout]`);
  if (audioPath) {
    filters.push(`[${audioIndex}:a]atrim=0:${durationSec},asetpts=PTS-STARTPTS[aout]`);
  }
  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[vout]');
  if (audioPath) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  if (subtitlePath) {
    args.push('-map', `${subtitleIndex}:s:0`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=chi');
  }
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-t',
    String(durationSec),
    '-movflags',
    '+faststart',
    '-y',
    videoFile
  );
  return { args, coverFile };
}

async function render(request, emitEvent, tools, workDir) {
  const plan = request.plan;
  const videoRel = plan.videoFile || 'render.mp4';
  const coverRel = plan.coverFile || 'cover.jpg';
  const videoFile = path.join(workDir, videoRel);
  const coverFile = path.join(workDir, coverRel);
  if (!isInside(workDir, videoFile) || !isInside(workDir, coverFile)) {
    throw new Error('output path escapes workDir');
  }
  const allowedRoots = request.allowedInputRoots || [];
  if (!Array.isArray(plan.segments) || plan.segments.length === 0) throw new Error('render plan has no segments');
  for (const segment of plan.segments) {
    if (!['image', 'clip'].includes(segment.type)) throw new Error('segment type must be image or clip');
    if (!(Number(segment.durationSec) > 0)) throw new Error('segment duration must be positive');
    await assertInputFile(segment.path, allowedRoots, 'segment');
  }
  if (plan.audioPath) await assertInputFile(plan.audioPath, allowedRoots, 'audioPath');
  if (plan.subtitlePath) await assertInputFile(plan.subtitlePath, allowedRoots, 'subtitlePath');
  const targetDuration = plan.segments.reduce((sum, segment) => sum + Number(segment.durationSec), 0);
  if (Math.abs(targetDuration - Number(plan.durationSec)) > 0.05) {
    throw new Error('segment durations do not add up to durationSec');
  }
  const { args } = buildRenderArgs(plan, tools, workDir, videoFile, coverFile);
  emitEvent({ status: 'running', progress: 0.1, detail: 'render' });
  const timeoutMs = (request.limits?.wallTimeSec || 1800) * 1000;
  await runTool(tools.ffmpeg, args, { timeoutMs, cwd: workDir });
  emitEvent({ status: 'running', progress: 0.85, detail: 'cover' });
  await runTool(
    tools.ffmpeg,
    ['-v', 'error', '-ss', '0', '-i', videoFile, '-frames:v', '1', '-q:v', '2', '-y', coverFile],
    { timeoutMs: 120000, cwd: workDir }
  );
  const videoStat = await fsp.stat(videoFile);
  const coverStat = await fsp.stat(coverFile);
  if (videoStat.size === 0 || coverStat.size === 0) throw new Error('renderer produced an empty output');
  if (videoStat.size > (plan.maxOutputBytes || Number.MAX_SAFE_INTEGER)) throw new Error('video exceeds maxOutputBytes');
  return {
    video: videoRel,
    cover: coverRel,
    videoBytes: videoStat.size,
    coverBytes: coverStat.size,
    durationSec: targetDuration
  };
}

async function validate(request, emitEvent, tools, workDir) {
  const plan = request.plan;
  const videoFile = path.join(workDir, plan.videoFile || 'render.mp4');
  const coverFile = path.join(workDir, plan.coverFile || 'cover.jpg');
  for (const file of [videoFile, coverFile]) {
    if (!isInside(workDir, file)) throw new Error('output path escapes workDir');
    const lstat = await fsp.lstat(file);
    if (lstat.isSymbolicLink() || !lstat.isFile()) throw new Error('output must be a regular file');
  }
  const timeoutMs = (request.limits?.wallTimeSec || 1800) * 1000;
  const probe = await probeJson(tools.ffprobe, videoFile, timeoutMs, workDir);
  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === 'video');
  if (!videoStream) throw new Error('video stream is missing');
  if (videoStream.width !== plan.width || videoStream.height !== plan.height) {
    throw new Error('video dimensions do not match the plan');
  }
  const fps = parseRate(videoStream.avg_frame_rate) || parseRate(videoStream.r_frame_rate);
  if (Math.abs(fps - plan.fps) > 0.6) throw new Error(`video fps ${fps} does not match ${plan.fps}`);
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - plan.durationSec) > Math.max(0.5, plan.durationSec * 0.05)) {
    throw new Error('video duration is outside tolerance');
  }
  const size = Number(probe.format?.size);
  if (!Number.isFinite(size) || size <= 0 || size > (plan.maxOutputBytes || Number.MAX_SAFE_INTEGER)) {
    throw new Error('video size is outside allowed range');
  }
  const hasAudio = (probe.streams || []).some((stream) => stream.codec_type === 'audio');
  if (Boolean(plan.audioPath) !== hasAudio) throw new Error('audio stream presence does not match the plan');
  const hasSubtitle = (probe.streams || []).some((stream) => stream.codec_type === 'subtitle');
  if (plan.subtitlePath && !hasSubtitle) throw new Error('subtitle stream is missing');
  const coverProbe = await probeJson(tools.ffprobe, coverFile, 120000, workDir);
  const coverStream = (coverProbe.streams || []).find((stream) => stream.codec_type === 'video');
  if (!coverStream) throw new Error('cover is not a readable image');
  emitEvent({ status: 'running', progress: 0.6, detail: 'decode' });
  await runTool(tools.ffmpeg, ['-v', 'error', '-i', videoFile, '-f', 'null', '-'], {
    timeoutMs,
    cwd: workDir
  });
  await runTool(tools.ffmpeg, ['-v', 'error', '-i', coverFile, '-frames:v', '1', '-f', 'null', '-'], {
    timeoutMs: 120000,
    cwd: workDir
  });
  return {
    media: {
      width: videoStream.width,
      height: videoStream.height,
      fps,
      duration,
      videoCodec: videoStream.codec_name,
      hasAudio,
      hasSubtitle,
      sizeBytes: size,
      cover: { width: coverStream.width, height: coverStream.height }
    }
  };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 4 * 1024 * 1024) {
      fail('INPUT_REQUIRED', 'request exceeds 4MiB');
      return;
    }
  }
  let request;
  try {
    request = JSON.parse(input);
  } catch {
    fail('INPUT_REQUIRED', 'request is not valid JSON');
    return;
  }
  const {
    executionId,
    taskId,
    stageId,
    attempt = 1,
    profile,
    tools = {},
    workDir,
    plan
  } = request;
  if (request.schemaVersion !== 1) {
    fail('SCHEMA_UNSUPPORTED', 'schemaVersion must be 1');
    return;
  }
  if (!executionId || !taskId || !stageId) {
    fail('INPUT_REQUIRED', 'executionId/taskId/stageId are required');
    return;
  }
  if (!['render', 'validate'].includes(stageId)) {
    fail('CAPABILITY_UNSUPPORTED', `stage ${stageId} is not a runner stage`);
    return;
  }
  if (!plan || !Number.isSafeInteger(plan.width) || plan.width < 2 || plan.width > 3840 || plan.width % 2 !== 0) {
    fail('BUDGET_EXCEEDED', 'invalid even width');
    return;
  }
  if (!Number.isSafeInteger(plan.height) || plan.height < 2 || plan.height > 3840 || plan.height % 2 !== 0) {
    fail('BUDGET_EXCEEDED', 'invalid even height');
    return;
  }
  if (!Number.isSafeInteger(plan.fps) || plan.fps < 1 || plan.fps > 60) {
    fail('BUDGET_EXCEEDED', 'invalid fps');
    return;
  }
  if (!(Number(plan.durationSec) > 0) || Number(plan.durationSec) > 600) {
    fail('BUDGET_EXCEEDED', 'invalid duration');
    return;
  }
  try {
    requireAbsolute(workDir, 'workDir');
    requireAbsolute(tools.ffmpeg, 'tools.ffmpeg');
    requireAbsolute(tools.ffprobe, 'tools.ffprobe');
    await fsp.mkdir(workDir, { recursive: true });
  } catch (error) {
    fail('INPUT_REQUIRED', error.message);
    return;
  }
  let seq = 0;
  const emitEvent = (event) => {
    seq += 1;
    emit({
      executionId,
      taskId,
      stageId,
      attempt,
      seq,
      profileId: profile?.id || null,
      ...event
    });
  };
  emitEvent({ status: 'accepted' });
  emitEvent({ status: 'running', progress: 0.02, detail: 'starting' });
  try {
    const outputs =
      stageId === 'render'
        ? await render(request, emitEvent, tools, workDir)
        : await validate(request, emitEvent, tools, workDir);
    emitEvent({ status: 'succeeded', progress: 1, outputs });
  } catch (error) {
    fail(error.code || 'DEPENDENCY_UNAVAILABLE', error.message || String(error), seq + 1);
  }
}

await main();
