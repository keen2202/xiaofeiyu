// Probe-only: create a backup policy + verified ledger point in the temporary
// probe data dir so the stub integration can exercise the outbox protection
// gate (notifications require a valid recovery point). Uses a test-only TTY
// verifier; never touches the real data dir.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../cli.mjs';
import { createRuntime } from '../src/index.js';
import { TtyHumanVerifier } from '../src/identity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_HOME = path.join(HERE, '..', '.dsh-probe-home');
const DATA_DIR = path.join(PROBE_HOME, 'dsh-bili-unified');
const DEST = path.join(PROBE_HOME, 'backups');
await fs.mkdir(DEST, { recursive: true });

function collector() {
  let text = '';
  return { write(chunk) { text += String(chunk); }, text() { return text; } };
}

async function runCli(argv) {
  const out = collector();
  const err = collector();
  const proofOutput = collector();
  const verifier = new TtyHumanVerifier({
    isTTY: true,
    input: { isTTY: true },
    output: proofOutput,
    challengeTtlMs: 120000
  });
  const prompt = async () => {
    const matches = [...proofOutput.text().matchAll(/continue: (\S+)/g)];
    if (matches.length === 0) throw new Error('no challenge phrase in proof output');
    return matches[matches.length - 1][1];
  };
  const code = await main(argv, {
    stdout: out,
    stderr: err,
    proofOutput,
    prompt,
    createRuntime: async (options) => createRuntime({ ...options, humanVerifier: verifier })
  });
  if (code !== 0) throw new Error(`command failed (${code}): ${err.text() || out.text()}`);
  return out.text();
}

const policyFile = path.join(HERE, 'probe-backup-policy.json');
await fs.writeFile(policyFile, JSON.stringify({
  schemaVersion: 1,
  scheduleEnabled: false,
  destinationRoot: DEST,
  failureDomain: 'probe-temp-dir (not independent)',
  verifiedBy: 'probe-test-verifier',
  verifiedAt: null,
  intervalMinutes: 15,
  maxPointAgeMinutes: 20,
  fullIntervalHours: 24,
  keepRecent: 8,
  keepDaily: 7,
  keepWeekly: 4,
  autoPrune: false,
  checkpointTimeoutMs: 5000
}, null, 2));
console.log('policy:', await runCli(['backup', 'policy', '--file', policyFile, '--data-dir', DATA_DIR, '--confirm']).then((t) => t.trim().slice(0, 300)));
const created = JSON.parse(await runCli(['backup', 'create', '--kind', 'ledger', '--data-dir', DATA_DIR, '--confirm']));
console.log('backup:', created.backupId, created.kind, created.status);
const status = JSON.parse(await runCli(['backup', 'status', '--data-dir', DATA_DIR]));
console.log('protection:', status.service.status, 'ageMs:', status.service.latest?.ageMs);
