import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LOCAL_SLIDESHOW_PROFILE,
  compareVersion,
  parseVersion,
  preflightProfile,
  validateLocalMedia,
  validateOutputSpec
} from '../src/production/profiles/local-slideshow.js';

test('output spec enforces even dimensions, fps and duration bounds', () => {
  assert.doesNotThrow(() =>
    validateOutputSpec({ container: 'mp4', width: 320, height: 240, fps: 10, maxDurationSec: 5 })
  );
  for (const output of [
    { container: 'mp4', width: 321, height: 240, fps: 10, maxDurationSec: 5 },
    { container: 'mp4', width: 320, height: 240, fps: 0, maxDurationSec: 5 },
    { container: 'mp4', width: 320, height: 240, fps: 10, maxDurationSec: 0 },
    { container: 'mkv', width: 320, height: 240, fps: 10, maxDurationSec: 5 }
  ]) {
    assert.throws(() => validateOutputSpec(output), (error) => error.code === 'INPUT_REQUIRED');
  }
  assert.equal(parseVersion('ffmpeg version 6.1.1-3ubuntu5')?.join('.'), '6.1.1');
  assert.equal(compareVersion('6.1.1', '4.0.0') > 0, true);
});

test('profile preflight blocks missing or unusable tools and succeeds with explicit absolute tools', async () => {
  const missing = await preflightProfile({ ...LOCAL_SLIDESHOW_PROFILE, bound: false, tools: {}, blocked: ['ffmpeg_not_bound'] }, {
    runTool: async () => ({ stdout: 'ffmpeg version 6.1.1', stderr: '' })
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.blockedBy.includes('ffmpeg_not_bound'));
  const profile = {
    ...LOCAL_SLIDESHOW_PROFILE,
    bound: true,
    blocked: [],
    tools: { ffmpeg: process.execPath, ffprobe: process.execPath },
    toolVersionRange: { min: '4.0.0', max: '99.0.0' }
  };
  const good = await preflightProfile(profile, {
    runTool: async () => ({ stdout: 'ffmpeg version 6.1.1', stderr: '' })
  });
  assert.equal(good.ok, true);
  assert.equal(good.tools.ffmpeg.version, '6.1.1');
  const badVersion = await preflightProfile(
    { ...profile, toolVersionRange: { min: '7.0.0', max: '8.0.0' } },
    { runTool: async () => ({ stdout: 'ffmpeg version 6.1.1', stderr: '' }) }
  );
  assert.equal(badVersion.ok, false);
});

test('core-side media validation checks dimensions, audio/subtitle presence and decodes again', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-media-'));
  const video = path.join(dir, 'render.mp4');
  const cover = path.join(dir, 'cover.jpg');
  await fs.writeFile(video, 'video');
  await fs.writeFile(cover, 'cover');
  const calls = [];
  const runTool = async (command, args) => {
    calls.push({ command, args });
    if (args.includes('-print_format') && args.includes('json')) {
      const file = args.at(-1);
      if (file === video) {
        return {
          stdout: JSON.stringify({
            streams: [
              { codec_type: 'video', codec_name: 'h264', width: 320, height: 240, avg_frame_rate: '10/1', r_frame_rate: '10/1' }
            ],
            format: { duration: '2.0', size: '1000' }
          }),
          stderr: ''
        };
      }
      return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 320, height: 240 }] }), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  try {
    const result = await validateLocalMedia({
      ffmpeg: '/usr/bin/ffmpeg',
      ffprobe: '/usr/bin/ffprobe',
      workDir: dir,
      videoFile: video,
      coverFile: cover,
      expected: { width: 320, height: 240, fps: 10, durationSec: 2, audioPath: false, subtitlePath: false, maxOutputBytes: 10000 },
      runTool
    });
    assert.equal(result.ok, true);
    assert.equal(result.media.width, 320);
    assert.ok(calls.some((call) => call.args.includes('null')));
    await assert.rejects(
      () => validateLocalMedia({
        ffmpeg: '/usr/bin/ffmpeg',
        ffprobe: '/usr/bin/ffprobe',
        workDir: dir,
        videoFile: video,
        coverFile: cover,
        expected: { width: 640, height: 240, fps: 10, durationSec: 2, audioPath: false, subtitlePath: false, maxOutputBytes: 10000 },
        runTool
      }),
      (error) => error.code === 'ARTIFACT_INVALID'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
