// Copy selected DSH package docs/sources out of app.asar into the workspace so
// they can be read with ordinary file tools. Read-only w.r.t. the DSH install.
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'D:/DSHdesktop/resources/app.asar';
const NM = path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai');
const OUT = 'D:/Workespace/xiaofeiyu/.dsh-probe/dsh-src';

const packages = [
  'dsh-host-webserver',
  'dsh-client-connection',
  'dsh-user-approval',
  'dsh-tools',
  'dsh-web-app',
  'dsh-plugin-market',
  'dsh-plugin-market-index',
  'dsh-experimental-plugin-market-bundle',
  'dsh-cordis-host-runner',
  'dsh-permission-presets',
  'dsh-api-session-controller',
  'dsh-tool-cordis',
  'dsh-desktop-host',
  'dsh-desktop-runtime'
];

function safeWalk(dir, rel, budget) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (budget.files <= 0 || budget.bytes <= 0) return;
    const full = path.join(dir, entry.name);
    const relPath = rel ? path.join(rel, entry.name) : entry.name;
    const posixRel = relPath.replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'types'].includes(entry.name)) continue;
      safeWalk(full, relPath, budget);
      continue;
    }
    const wanted = /(?:^|\/)(?:README[^/]*\.md|package\.json)$/.test(posixRel)
      || /(?:^|\/)lib\/(?:index|client)\.(?:js|mjs)$/.test(posixRel);
    if (!wanted) continue;
    const stat = fs.statSync(full);
    if (stat.size > budget.bytes) continue;
    budget.files -= 1;
    budget.bytes -= stat.size;
    const target = path.join(OUT, posixRel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(full, target);
  }
}

for (const name of packages) {
  const dir = path.join(NM, name);
  if (!fs.existsSync(dir)) { console.log('missing', name); continue; }
  safeWalk(dir, name, { files: 60, bytes: 14 * 1024 * 1024 });
  console.log('extracted', name);
}

// Search plugin-market related packages for QQ/IM catalog entries (JSON/MD only).
const marketRoots = [
  path.join(NM, 'dsh-plugin-market'),
  path.join(NM, 'dsh-plugin-market-index'),
  path.join(NM, 'dsh-experimental-plugin-market-bundle'),
  path.join(NM, 'dsh-web-app')
];
const matches = [];
function grepMarket(dir, depth) {
  if (depth > 5) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') grepMarket(full, depth + 1); continue; }
    if (!/\.(?:json|md|yml|yaml)$/.test(entry.name)) continue;
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/\bqq\b|qq\.com|tencent|qqbot|onebot|napcat|lagrange/i.test(line)) {
        matches.push({ file: full.replace(ASAR + '/', ''), line: index + 1, text: line.trim().slice(0, 300) });
      }
    });
  }
}
for (const root of marketRoots) if (fs.existsSync(root)) grepMarket(root, 0);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, '_market-qq-matches.json'), JSON.stringify(matches, null, 2));
console.log('market matches', matches.length);
