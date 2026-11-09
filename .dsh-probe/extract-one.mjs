// Extract one asar package tree (or single file) to .dsh-probe/dsh-src/<pkg>/...
// Usage: ELECTRON_RUN_AS_NODE=1 "<electron exe>" .dsh-probe/extract-one.mjs <pkg> [subpath]
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'D:/DSHdesktop/resources/app.asar';
const NM = path.join(ASAR, 'dsh', 'node_modules', '@deepseek-ai');
const pkg = process.argv[2];
const sub = process.argv[3] || 'lib';
if (!pkg) throw new Error('package name required');
const src = path.join(NM, pkg, sub);
const dst = path.join(process.cwd(), '.dsh-probe', 'dsh-src', pkg, sub);
fs.mkdirSync(dst, { recursive: true });
const walk = (from, to) => {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(b, { recursive: true });
      walk(a, b);
    } else fs.copyFileSync(a, b);
  }
};
walk(src, dst);
console.log('extracted', pkg, sub, '->', dst);
