// Read-only DSH capability probe. Runs under the local Electron in
// ELECTRON_RUN_AS_NODE mode so the asar archive is readable through fs.
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'D:/DSHdesktop/resources/app.asar';
const DSH = path.join(ASAR, 'dsh');
const NM = path.join(DSH, 'node_modules');
const OUT = process.argv[2] || path.join(process.cwd(), '.dsh-probe', 'probe-out.json');

function list(p) { try { return fs.readdirSync(p); } catch { return []; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

const out = {
  probedAt: new Date().toISOString(),
  asarRoot: list(ASAR),
  dshRoot: list(DSH),
  dshPackage: readJson(path.join(DSH, 'package.json')),
  packages: [],
  otherPackages: list(NM).filter((n) => !n.startsWith('@')),
  hits: [],
  scan: { files: 0, bytes: 0, truncated: false }
};

const scope = path.join(NM, '@deepseek-ai');
for (const name of list(scope)) {
  const dir = path.join(scope, name);
  const pkg = readJson(path.join(dir, 'package.json'));
  out.packages.push({
    name,
    version: pkg?.version,
    description: pkg?.description,
    main: pkg?.main,
    bin: pkg?.bin,
    keywords: pkg?.keywords,
    exports: pkg?.exports
  });
}

const KEYWORDS = [
  'requestRejection',
  'registerHandler',
  'onDispose',
  'lifecycle',
  'humanProof',
  'human-interaction',
  'humanInterruption',
  'humanAnswer',
  'qq',
  'QQ',
  'channel',
  'imBridge',
  'dsh-im',
  'approvalRequest',
  'trustedHuman',
  'trustedContext'
];
const MAX_BYTES = 220 * 1024 * 1024;
const MAX_FILES = 3500;
const MAX_HITS = 1200;

function walk(dir, depth) {
  if (depth > 5 || out.scan.truncated) return;
  for (const entry of list(dir)) {
    if (out.scan.truncated) return;
    const full = path.join(dir, entry);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walk(full, depth + 1);
      continue;
    }
    if (!/\.(?:js|mjs|cjs|json|md)$/.test(entry)) continue;
    out.scan.files += 1;
    out.scan.bytes += st.size;
    if (out.scan.files > MAX_FILES || out.scan.bytes > MAX_BYTES) { out.scan.truncated = true; return; }
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (text.length > 3_500_000) text = text.slice(0, 3_500_000);
    for (const kw of KEYWORDS) {
      const re = kw.length <= 3 ? new RegExp(`\\b${kw}\\b`, 'g') : new RegExp(kw, 'g');
      let m;
      let count = 0;
      const samples = [];
      while ((m = re.exec(text)) && count < 3) {
        count += 1;
        const start = Math.max(0, m.index - 90);
        samples.push(text.slice(start, m.index + kw.length + 120).replace(/\s+/g, ' ').trim());
      }
      if (count) {
        out.hits.push({ file: full.replace(ASAR + '/', ''), keyword: kw, count: count, samples });
        if (out.hits.length > MAX_HITS) { out.scan.truncated = true; return; }
      }
    }
  }
}

walk(scope, 0);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  packages: out.packages.length,
  otherPackages: out.otherPackages.length,
  hits: out.hits.length,
  scan: out.scan,
  out: OUT
}, null, 2));
