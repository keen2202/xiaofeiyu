#!/usr/bin/env node
/**
 * T17.3 local media acceptance (offline, isolated temp dirs).
 *
 * This executes the real trusted ffmpeg/ffprobe paths and the production
 * Runner. It uses an injected test-human verifier only to exercise the approval
 * state machine; that is NOT production human-identity evidence.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHarness, approvalDecide } from '../helpers/harness.js';
import { ProductionModule } from '../../src/modules/production.js';
import { LocalExecutionBackend } from '../../src/adapters/execution/local.js';
import {
  defaultRunTool,
  loadLocalSlideshowProfile,
  preflightProfile,
  probeAudioDuration,
  validateLocalMedia
} from '../../src/production/profiles/local-slideshow.js';

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';

async function toolVersion(file) {
  const { stdout } = await execFileAsync(file, ['-version'], { maxBuffer: 1024 * 1024 });
  return stdout.split('\n')[0];
}

async function ffmpeg(args) {
  await execFileAsync(FFMPEG, args, { maxBuffer: 16 * 1024 * 1024 });
}

async function main() {
  for (const file of [FFMPEG, FFPROBE]) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new Error(`BLOCKED: required local media tool is missing: ${file}`);
  }
  const evidence = {
    kind: 't17.3-local-production-acceptance',
    executedAt: new Date().toISOString(),
    note: 'real ffmpeg/ffprobe execution; injected test-human approval context',
    tools: {},
    cases: []
  };
  evidence.tools.ffmpeg = { path: FFMPEG, version: await toolVersion(FFMPEG) };
  evidence.tools.ffprobe = { path: FFPROBE, version: await toolVersion(FFPROBE) };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-t173-'));
  const fixtures = path.join(root, 'fixtures');
  await fs.mkdir(fixtures);
  const harness = await createHarness({
    overrides: {
      dryRun: false,
      security: { allowLocalProducer: true },
      production: {
        enabled: true,
        dryRun: false,
        requireApproval: true,
        profilesFile: path.join(root, 'profiles.json'),
        limits: { wallTimeSec: 120, maxPaidCostMinor: 0, currency: 'CNY', maxOutputBytes: 100 * 1024 * 1024 }
      }
    }
  });
  const backend = new LocalExecutionBackend({ now: harness.now });
  try {
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=1', '-frames:v', '1', path.join(fixtures, 'slide1.png')]);
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=1', '-frames:v', '1', path.join(fixtures, 'slide2.png')]);
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=green:s=640x360:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '25', path.join(fixtures, 'clip.mp4')]);
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', path.join(fixtures, 'voice.m4a')]);
    await fs.writeFile(path.join(fixtures, 'script.txt'), '第一段：这是真实本地视频验收。\n\n第二段：全部素材均在隔离临时目录生成。\n');
    await fs.writeFile(
      path.join(fixtures, 'sub.srt'),
      '1\n00:00:00,000 --> 00:00:02,000\n第一句\n\n2\n00:00:02,000 --> 00:00:03,500\n第二句\n'
    );
    const profilesFile = path.join(root, 'profiles.json');
    await fs.writeFile(
      profilesFile,
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          'local-slideshow-v1': {
            version: 'acceptance-1.0.0',
            backend: 'local',
            ffmpegPath: FFMPEG,
            ffprobePath: FFPROBE,
            voiceMode: 'optional',
            outputLimits: { maxOutputBytes: 100 * 1024 * 1024 }
          }
        }
      })
    );
    harness.configService.config.production.profilesFile = profilesFile;
    const production = new ProductionModule({
      store: harness.store,
      taskManager: harness.taskManager,
      configService: harness.configService,
      artifactStore: harness.artifactStore,
      effectGateway: harness.effectGateway,
      approvalService: harness.approvalService,
      journal: harness.journal,
      backend,
      profileLoader: loadLocalSlideshowProfile,
      preflight: preflightProfile,
      mediaValidator: validateLocalMedia,
      audioProbe: probeAudioDuration,
      runTool: defaultRunTool,
      now: harness.now
    });

    async function importFixture(name, role) {
      return harness.importFile(name, role, await fs.readFile(path.join(fixtures, name)));
    }
    async function runCase({ name, withAudio, withSubtitle, withClip, output }) {
      const refs = [
        { artifactId: (await importFixture('script.txt', 'script')).artifactId },
        { artifactId: (await importFixture('slide1.png', 'image')).artifactId },
        { artifactId: (await importFixture('slide2.png', 'image')).artifactId }
      ];
      if (withClip) refs.push({ artifactId: (await importFixture('clip.mp4', 'clip')).artifactId });
      if (withAudio) refs.push({ artifactId: (await importFixture('voice.m4a', 'audio')).artifactId });
      if (withSubtitle) refs.push({ artifactId: (await importFixture('sub.srt', 'subtitle')).artifactId });
      const created = await production.create({
        schemaVersion: 1,
        requestId: `${name}-${Date.now()}`,
        profileId: 'local-slideshow-v1',
        brief: name,
        inputs: refs,
        output,
        mode: 'go',
        limits: { wallTimeSec: 120, maxPaidCostMinor: 0, currency: 'CNY' }
      }, harness.owner);
      assert.equal(created.task.status, 'waiting_approval');
      await approvalDecide(harness, { approvalId: created.approval.id, nonce: created.nonce });
      const result = await production.run({ taskId: created.task.id, mode: 'go', principal: harness.owner });
      assert.equal(result.task.status, 'succeeded', JSON.stringify(result.task.error));
      assert.equal(result.task.result.readyForPublish, true);
      const state = await harness.snapshot();
      const productionRecord = state.productions[created.task.id];
      assert.equal(productionRecord.readyForPublish, true);
      const videoArtifact = await harness.artifactStore.verify(productionRecord.artifacts.video.artifactId, {
        principal: harness.owner
      });
      const coverArtifact = await harness.artifactStore.verify(productionRecord.artifacts.cover.artifactId, {
        principal: harness.owner
      });
      const probe = JSON.parse(
        (await execFileAsync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', videoArtifact.absolute], {
          maxBuffer: 8 * 1024 * 1024
        })).stdout
      );
      const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
      assert.equal(videoStream.codec_name, 'h264');
      assert.equal(videoStream.width, output.width);
      assert.equal(videoStream.height, output.height);
      assert.equal((probe.streams || []).some((stream) => stream.codec_type === 'audio'), withAudio);
      assert.equal((probe.streams || []).some((stream) => stream.codec_type === 'subtitle'), withSubtitle);
      await execFileAsync(FFMPEG, ['-v', 'error', '-i', videoArtifact.absolute, '-f', 'null', '-'], {
        maxBuffer: 8 * 1024 * 1024
      });
      const voice = result.task.stages.find((entry) => entry.stage === 'voice');
      assert.equal(voice.status, withAudio ? 'succeeded' : 'skipped');
      if (!withAudio) assert.equal(voice.evidence.allowed, true);
      const record = {
        name,
        taskId: created.task.id,
        status: result.task.status,
        readyForPublish: true,
        stages: result.task.stages.map((entry) => ({ stage: entry.stage, status: entry.status })),
        video: {
          artifactId: videoArtifact.artifactId,
          sha256: videoArtifact.sha256,
          sizeBytes: videoArtifact.sizeBytes
        },
        cover: {
          artifactId: coverArtifact.artifactId,
          sha256: coverArtifact.sha256,
          sizeBytes: coverArtifact.sizeBytes
        },
        media: productionRecord.media,
        voiceEvidence: voice.evidence || null
      };
      evidence.cases.push(record);
      return record;
    }

    await runCase({
      name: 'images-clip-audio-subtitle',
      withAudio: true,
      withSubtitle: true,
      withClip: true,
      output: { container: 'mp4', width: 640, height: 360, fps: 25, maxDurationSec: 4 }
    });
    await runCase({
      name: 'images-silent-legitimate-skip',
      withAudio: false,
      withSubtitle: false,
      withClip: false,
      output: { container: 'mp4', width: 480, height: 270, fps: 20, maxDurationSec: 3 }
    });

    // A missing trusted tool must be a BLOCKED capability, not a silent success.
    harness.configService.config.production.profilesFile = path.join(root, 'missing-profiles.json');
    await fs.writeFile(
      path.join(root, 'missing-profiles.json'),
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          'local-slideshow-v1': {
            version: 'acceptance-missing',
            backend: 'local',
            ffmpegPath: '/definitely/missing/ffmpeg',
            ffprobePath: '/definitely/missing/ffprobe',
            voiceMode: 'optional'
          }
        }
      })
    );
    const script = await importFixture('script.txt', 'script');
    const image = await importFixture('slide1.png', 'image');
    await assert.rejects(
      () => production.create({
        requestId: `missing-${Date.now()}`,
        profileId: 'local-slideshow-v1',
        brief: 'missing tool',
        inputs: [{ artifactId: script.artifactId }, { artifactId: image.artifactId }],
        output: { container: 'mp4', width: 320, height: 240, fps: 10, maxDurationSec: 2 },
        mode: 'go',
        limits: { wallTimeSec: 10, maxPaidCostMinor: 0, currency: 'CNY' }
      }, harness.owner),
      (error) => error.code === 'DEPENDENCY_UNAVAILABLE'
    );
    evidence.missingToolBlocked = true;
    evidence.passed = true;
    console.log(JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    await backend.close();
    await harness.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ passed: false, code: error.code || null, message: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});
