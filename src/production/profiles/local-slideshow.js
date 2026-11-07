import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../../errors.js';
import { deepMerge, pathExists } from '../../utils.js';

const execFileAsync = promisify(execFile);
const MAX_TOOL_OUTPUT = 8 * 1024 * 1024;

export const LOCAL_SLIDESHOW_PROFILE = Object.freeze({
  id: 'local-slideshow-v1',
  version: '1.0.0',
  backend: 'local',
  stages: ['script', 'assets', 'voice', 'render', 'validate'],
  requiredInputs: { script: 1, visual: 1 },
  restartSafe: { script: true, assets: true, voice: true, render: false, validate: true },
  voiceMode: 'optional',
  outputLimits: {
    minWidth: 2,
    maxWidth: 3840,
    minHeight: 2,
    maxHeight: 3840,
    minFps: 1,
    maxFps: 60,
    minDurationSec: 1,
    maxDurationSec: 600,
    maxOutputBytes: 1024 * 1024 * 1024
  },
  toolVersionRange: { min: '4.0.0', max: '99.0.0' },
  tools: { ffmpeg: null, ffprobe: null }
});

export function validateOutputSpec(output, { profile = LOCAL_SLIDESHOW_PROFILE, config = null } = {}) {
  if (!output || typeof output !== 'object') throw new AppError('INPUT_REQUIRED', 'output spec is required');
  if (output.container !== 'mp4') throw new AppError('INPUT_REQUIRED', 'only mp4 output is supported');
  const limits = profile.outputLimits;
  for (const dimension of ['width', 'height']) {
    const value = output[dimension];
    const min = dimension === 'width' ? limits.minWidth : limits.minHeight;
    const max = dimension === 'width' ? limits.maxWidth : limits.maxHeight;
    if (!Number.isSafeInteger(value) || value < min || value > max || value % 2 !== 0) {
      throw new AppError('INPUT_REQUIRED', `${dimension} must be an even integer between ${min} and ${max}`);
    }
  }
  if (!Number.isSafeInteger(output.fps) || output.fps < limits.minFps || output.fps > limits.maxFps) {
    throw new AppError('INPUT_REQUIRED', `fps must be an integer between ${limits.minFps} and ${limits.maxFps}`);
  }
  if (
    !Number.isSafeInteger(output.maxDurationSec) ||
    output.maxDurationSec < limits.minDurationSec ||
    output.maxDurationSec > limits.maxDurationSec
  ) {
    throw new AppError(
      'INPUT_REQUIRED',
      `maxDurationSec must be between ${limits.minDurationSec} and ${limits.maxDurationSec}`
    );
  }
  const maxOutputBytes = output.maxOutputBytes ?? config?.production?.limits?.maxOutputBytes ?? limits.maxOutputBytes;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new AppError('INPUT_REQUIRED', 'maxOutputBytes must be a positive integer');
  }
  if (maxOutputBytes > limits.maxOutputBytes) {
    throw new AppError('BUDGET_EXCEEDED', 'maxOutputBytes exceeds the profile limit');
  }
  if (config && maxOutputBytes > config.production.limits.maxOutputBytes) {
    throw new AppError('BUDGET_EXCEEDED', 'maxOutputBytes exceeds the configured limit');
  }
  return {
    container: 'mp4',
    width: output.width,
    height: output.height,
    fps: output.fps,
    maxDurationSec: output.maxDurationSec,
    maxOutputBytes
  };
}

function parseVersion(text) {
  const match = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function compareVersion(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

async function defaultRunTool(command, args, { timeoutMs = 30000, cwd = undefined } = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    cwd,
    maxBuffer: MAX_TOOL_OUTPUT,
    windowsHide: true,
    shell: false,
    env: { PATH: process.env.PATH || '', LANG: process.env.LANG || 'C.UTF-8' }
  });
  return { stdout, stderr };
}

export function loadProfileFromConfig(config, profileId) {
  if (!config.production.profilesFile) {
    return { ...LOCAL_SLIDESHOW_PROFILE, tools: { ffmpeg: null, ffprobe: null }, bound: false };
  }
  return null;
}

export async function loadLocalSlideshowProfile({ profilesFile, profileId = 'local-slideshow-v1', config } = {}) {
  if (profileId !== LOCAL_SLIDESHOW_PROFILE.id) {
    throw new AppError('CAPABILITY_UNSUPPORTED', `unknown production profile ${profileId}`);
  }
  let fileData = null;
  if (profilesFile && (await pathExists(profilesFile))) {
    let text;
    try {
      text = await fsp.readFile(profilesFile, 'utf8');
    } catch (error) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'cannot read production profile file', { cause: error });
    }
    try {
      fileData = JSON.parse(text);
    } catch (error) {
      throw new AppError('CONFIG_INVALID', 'production profile file is not valid JSON', { cause: error });
    }
    if (fileData.schemaVersion !== 1) {
      throw new AppError('SCHEMA_UNSUPPORTED', 'production profile schemaVersion must be 1');
    }
  }
  const entry = fileData?.profiles?.[profileId] || {};
  if (entry.backend && entry.backend !== 'local') {
    throw new AppError('CAPABILITY_UNSUPPORTED', 'only the local execution backend is supported');
  }
  if (entry.voiceMode && !['optional', 'required'].includes(entry.voiceMode)) {
    throw new AppError('CONFIG_INVALID', 'profile voiceMode must be optional or required');
  }
  const merged = deepMerge(LOCAL_SLIDESHOW_PROFILE, {
    ...entry,
    tools: {
      ffmpeg: entry.ffmpegPath || entry.tools?.ffmpeg || null,
      ffprobe: entry.ffprobePath || entry.tools?.ffprobe || null
    }
  });
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const value = merged.tools[tool];
    if (value !== null && value !== undefined && typeof value === 'string' && !path.isAbsolute(value)) {
      throw new AppError('CONFIG_INVALID', `profile ${tool} path must be absolute`);
    }
  }
  if (entry.outputLimits) {
    for (const key of Object.keys(LOCAL_SLIDESHOW_PROFILE.outputLimits)) {
      if (entry.outputLimits[key] !== undefined && entry.outputLimits[key] !== null) {
        merged.outputLimits[key] = entry.outputLimits[key];
      }
    }
  }
  merged.bound = Boolean(merged.tools.ffmpeg && merged.tools.ffprobe);
  merged.blocked = [];
  if (!merged.tools.ffmpeg) merged.blocked.push('ffmpeg_not_bound');
  if (!merged.tools.ffprobe) merged.blocked.push('ffprobe_not_bound');
  if (config?.security?.allowLocalProducer !== true) merged.blocked.push('allowLocalProducer_false');
  if (!config?.production?.enabled) merged.blocked.push('production_disabled');
  return merged;
}

export async function preflightProfile(profile, { runTool = defaultRunTool } = {}) {
  if (!profile.bound) {
    return {
      ok: false,
      blockedBy: profile.blocked.length ? profile.blocked : ['tools_not_bound'],
      capability: 'production.local'
    };
  }
  const results = {};
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const executable = profile.tools[tool];
    const stat = await fsp.stat(executable).catch(() => null);
    if (!stat || !stat.isFile()) {
      return { ok: false, blockedBy: [`${tool}_missing`], capability: 'production.local' };
    }
    let versionText;
    try {
      const result = await runTool(executable, ['-version'], { timeoutMs: 15000 });
      versionText = `${result.stdout || ''}\n${result.stderr || ''}`;
    } catch (error) {
      return {
        ok: false,
        blockedBy: [`${tool}_unusable`],
        capability: 'production.local',
        error: error.message
      };
    }
    const version = parseVersion(versionText);
    if (!version) return { ok: false, blockedBy: [`${tool}_version_unparseable`], capability: 'production.local' };
    const { min, max } = profile.toolVersionRange || LOCAL_SLIDESHOW_PROFILE.toolVersionRange;
    if (compareVersion(version, min) < 0 || compareVersion(version, max) > 0) {
      return {
        ok: false,
        blockedBy: [`${tool}_version_out_of_range`],
        capability: 'production.local',
        version: version.join('.')
      };
    }
    results[tool] = { path: executable, version: version.join('.') };
  }
  return { ok: true, tools: results, capability: 'production.local' };
}

function parseRate(value) {
  if (typeof value !== 'string' || value === '' || value === '0/0') return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Core-side independent validation. Runner success is not trusted; the core
 * decodes the actual bytes again before readyForPublish can be set.
 */
export async function validateLocalMedia({
  ffmpeg,
  ffprobe,
  workDir,
  videoFile,
  coverFile,
  expected,
  runTool = defaultRunTool,
  timeoutMs = 600000
}) {
  for (const [label, file] of [
    ['video', videoFile],
    ['cover', coverFile]
  ]) {
    if (!path.isAbsolute(file)) throw new AppError('ARTIFACT_INVALID', `${label} path must be absolute`);
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new AppError('ARTIFACT_INVALID', `${label} is missing or not a regular file`);
    }
  }
  const probe = await runTool(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', videoFile],
    { timeoutMs: 120000, cwd: workDir }
  );
  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch (error) {
    throw new AppError('ARTIFACT_INVALID', 'ffprobe output is not JSON', { cause: error });
  }
  const videoStream = (parsed.streams || []).find((stream) => stream.codec_type === 'video');
  if (!videoStream) throw new AppError('ARTIFACT_INVALID', 'video stream is missing');
  if (videoStream.codec_name !== 'h264') throw new AppError('ARTIFACT_INVALID', 'video codec must be h264');
  if (videoStream.width !== expected.width || videoStream.height !== expected.height) {
    throw new AppError('ARTIFACT_INVALID', 'video dimensions do not match the plan');
  }
  const fps = parseRate(videoStream.avg_frame_rate) || parseRate(videoStream.r_frame_rate);
  if (Math.abs(fps - expected.fps) > 0.6) throw new AppError('ARTIFACT_INVALID', 'video fps does not match the plan');
  const duration = Number(parsed.format?.duration);
  if (
    !Number.isFinite(duration) ||
    Math.abs(duration - expected.durationSec) > Math.max(0.5, expected.durationSec * 0.05)
  ) {
    throw new AppError('ARTIFACT_INVALID', 'video duration is outside tolerance');
  }
  const size = Number(parsed.format?.size);
  if (!Number.isFinite(size) || size <= 0 || size > expected.maxOutputBytes) {
    throw new AppError('ARTIFACT_INVALID', 'video size is outside the allowed range');
  }
  const hasAudio = (parsed.streams || []).some((stream) => stream.codec_type === 'audio');
  if (Boolean(expected.audioPath) !== hasAudio) throw new AppError('ARTIFACT_INVALID', 'audio presence mismatch');
  const hasSubtitle = (parsed.streams || []).some((stream) => stream.codec_type === 'subtitle');
  if (Boolean(expected.subtitlePath) && !hasSubtitle) {
    throw new AppError('ARTIFACT_INVALID', 'subtitle stream is missing');
  }
  const coverProbe = await runTool(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', coverFile],
    { timeoutMs: 120000, cwd: workDir }
  );
  const coverStream = (JSON.parse(coverProbe.stdout).streams || []).find(
    (stream) => stream.codec_type === 'video'
  );
  if (!coverStream) throw new AppError('ARTIFACT_INVALID', 'cover is not a readable image');
  await runTool(ffmpeg, ['-v', 'error', '-i', videoFile, '-f', 'null', '-'], { timeoutMs, cwd: workDir });
  await runTool(ffmpeg, ['-v', 'error', '-i', coverFile, '-frames:v', '1', '-f', 'null', '-'], {
    timeoutMs: 120000,
    cwd: workDir
  });
  return {
    ok: true,
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

export { defaultRunTool, compareVersion, parseVersion };
export default LOCAL_SLIDESHOW_PROFILE;

export async function probeAudioDuration({ ffprobe, file, runTool = defaultRunTool, timeoutMs = 120000 }) {
  if (!path.isAbsolute(file)) throw new AppError('INPUT_REQUIRED', 'audio path must be absolute');
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new AppError('ARTIFACT_INVALID', 'audio input is missing or not a regular file');
  }
  const probe = await runTool(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs }
  );
  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch (error) {
    throw new AppError('ARTIFACT_INVALID', 'audio probe output is not JSON', { cause: error });
  }
  if (!(parsed.streams || []).some((stream) => stream.codec_type === 'audio')) {
    throw new AppError('ARTIFACT_INVALID', 'audio stream is missing');
  }
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AppError('ARTIFACT_INVALID', 'audio duration is invalid');
  }
  return { durationSec: duration, format: parsed.format?.format_name || null };
}
