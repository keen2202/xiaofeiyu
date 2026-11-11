import fs from 'node:fs';

const asarPath = 'D:/DSHdesktop/resources/app.asar';
const buf = fs.readFileSync(asarPath);
const headerSize = buf.readUInt32LE(4);
const jsonStart = 16;
const dataStart = 8 + headerSize;
const raw = buf.subarray(jsonStart, dataStart).toString('utf8');
const jsonText = raw.slice(0, raw.lastIndexOf('}') + 1);
const header = JSON.parse(jsonText);
console.log('header parsed; top entries:', Object.keys(header.files).join(','), '| dataStart:', dataStart);

function find(node, prefix = '') {
  const out = [];
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) out.push(...find(entry, p));
    else out.push({ path: p, entry });
  }
  return out;
}

const files = find(header);
console.log('total files:', files.length);
const wanted = files.filter((f) => /app-boot/.test(f.path) && f.path.endsWith('lib/index.js'));
console.log('matches:', wanted.map((f) => f.path).join(', ') || '(none)');
const target = wanted[0];
if (target) {
  const offset = dataStart + Number(target.entry.offset);
  const data = buf.subarray(offset, offset + Number(target.entry.size));
  fs.writeFileSync('D:/Workespace/xiaofeiyu/.dsh-probe/dsh-app-boot-index.js', data);
  console.log('extracted', target.path, data.length, 'bytes');
}
