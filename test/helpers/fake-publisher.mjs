#!/usr/bin/env node
import fs from 'node:fs';
const mode = process.argv[2] || 'success';
const args = process.argv.slice(3);
if (mode === 'success') {
  process.stdout.write(JSON.stringify({ ok: true, bvid: 'BV1xx411c7mD', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }));
} else if (mode === 'invalid-after-start') {
  process.stdout.write('started but not json');
} else if (mode === 'fail-before-start') {
  process.stderr.write('cannot start');
  process.exit(2);
} else if (mode === 'args') {
  process.stdout.write(JSON.stringify({ ok: true, bvid: 'BV1xx411c7mD', url: 'https://www.bilibili.com/video/BV1xx411c7mD', args, cwd: process.cwd() }));
} else {
  process.exit(3);
}
