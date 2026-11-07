import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadLocalSlideshowProfile,
  preflightProfile
} from '../src/production/profiles/local-slideshow.js';
import { DEFAULT_CONFIG } from '../src/config.js';

test('unbound profile reports blockers without spawning a tool', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-prefix-'));
  try {
    const config = {
      ...DEFAULT_CONFIG,
      production: { ...DEFAULT_CONFIG.production, enabled: true },
      security: { ...DEFAULT_CONFIG.security, allowLocalProducer: true }
    };
    const profile = await loadLocalSlideshowProfile({ profilesFile: path.join(dir, 'missing.json'), config });
    assert.equal(profile.bound, false);
    assert.ok(profile.blocked.includes('ffmpeg_not_bound'));
    let calls = 0;
    const result = await preflightProfile(profile, {
      runTool: async () => {
        calls += 1;
        return { stdout: 'ffmpeg version 6.0.0', stderr: '' };
      }
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('explicit profile preflight checks only declared absolute tools', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xfy-prefix-'));
  try {
    const profilesFile = path.join(dir, 'profiles.json');
    await fs.writeFile(
      profilesFile,
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          'local-slideshow-v1': {
            version: '1',
            backend: 'local',
            ffmpegPath: process.execPath,
            ffprobePath: process.execPath
          }
        }
      })
    );
    const config = {
      ...DEFAULT_CONFIG,
      production: { ...DEFAULT_CONFIG.production, enabled: true },
      security: { ...DEFAULT_CONFIG.security, allowLocalProducer: true }
    };
    const profile = await loadLocalSlideshowProfile({ profilesFile, config });
    const calls = [];
    const result = await preflightProfile(profile, {
      runTool: async (command, args) => {
        calls.push({ command, args });
        return { stdout: 'ffmpeg version 6.1.0', stderr: '' };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.args), [['-version'], ['-version']]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
