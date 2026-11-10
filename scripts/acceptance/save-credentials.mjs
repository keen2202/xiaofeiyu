#!/usr/bin/env node
// Save Bilibili credentials into <dataDir>/credentials.json without echoing any
// secret value. Reads a raw cookie header (or a JSON object) from STDIN.
//
//   $cookie = 'SESSDATA=...; bili_jct=...; buvid3=...; DedeUserID=...'
//   $cookie | node scripts/acceptance/save-credentials.mjs [--data-dir <dir>]
//
// Only the four fields accepted by src/credentials.js are written:
// sessdata, bili_jct, buvid3, dedeuserid. Output never contains values.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from './_common.mjs';

const FIELDS = ['sessdata', 'bili_jct', 'buvid3', 'dedeuserid'];
const { flags } = parseArgs(process.argv.slice(2));
const dataDir = typeof flags['data-dir'] === 'string'
  ? path.resolve(flags['data-dir'])
  : (process.env.DSH_HOME
      ? path.join(process.env.DSH_HOME, 'dsh-bili-unified')
      : path.join(os.homedir(), '.dsh', 'dsh-bili-unified'));

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const text = raw.trim();
  if (text === '') {
    console.error('no input on stdin (expected a cookie header or JSON object)');
    process.exit(1);
  }
  let values = {};
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.error('stdin JSON is invalid:', error.message);
      process.exit(1);
    }
    for (const field of FIELDS) {
      const key = Object.keys(parsed).find((name) => name.toLowerCase() === field);
      if (key !== undefined && parsed[key] !== undefined && parsed[key] !== null && String(parsed[key]) !== '') {
        values[field] = String(parsed[key]).trim();
      }
    }
  } else {
    for (const part of text.split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      const name = part.slice(0, index).trim().toLowerCase();
      const value = part.slice(index + 1).trim();
      if (FIELDS.includes(name) && value !== '') values[name] = value;
    }
  }
  const missing = ['sessdata', 'bili_jct'].filter((field) => !values[field]);
  if (missing.length > 0) {
    console.error(`missing required credential field(s): ${missing.join(', ')}`);
    process.exit(1);
  }
  const payload = {};
  for (const field of FIELDS) payload[field] = values[field] ?? null;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'credentials.json');
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL is applied separately */ }
  const writable = payload.sessdata && payload.bili_jct;
  console.log(JSON.stringify({
    saved: true,
    file,
    fields: FIELDS.filter((field) => payload[field] !== null),
    hasSession: Boolean(payload.sessdata),
    hasWriteCredentials: Boolean(writable)
    // values are intentionally never printed
  }, null, 2));
});
