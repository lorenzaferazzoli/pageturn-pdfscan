// Riconoscimento dei bordi: quanto sono lontani gli angoli trovati da quelli veri, sulle foto
// sintetiche di tests/fixtures/detect (pagina sola e libro aperto, sfondi e luci diverse).
// Come nell'app: riconoscimento a 400 px, poi bordi rimisurati a 1200 px.
//   node tests/detect-accuracy.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { detectQuad, refineDetection } from '../js/detect.js';

const fails = [];
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };
const load = (f, S) => {
  const o = execFileSync('python3', ['-c', `import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('L');k=${S}/max(im.size);im=im.resize((round(im.width*k),round(im.height*k)),Image.BILINEAR);sys.stdout.buffer.write(im.width.to_bytes(4,'little')+im.height.to_bytes(4,'little')+im.tobytes())`, f], { maxBuffer: 1 << 28 });
  const w = o.readUInt32LE(0); const h = o.readUInt32LE(4);
  return { g: new Uint8Array(o.buffer, o.byteOffset + 8, w * h), w, h };
};
const clamp = (q) => q.map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
const items = Object.entries(JSON.parse(readFileSync('tests/fixtures/detect/quads.json', 'utf8'))).map(([n, q]) => [n, `tests/fixtures/detect/${n}.jpg`, clamp(q)]);
items.push(['photo', 'tests/fixtures/photo.jpg', [[0.235, 0.215], [0.78, 0.185], [0.82, 0.86], [0.18, 0.815]]]);

const all = [];
const single = [];
for (const [name, file, gt] of items) {
  const a = load(file, 400);
  let d = detectQuad(a.g, a.w, a.h);
  const err = (q) => (q ? Math.max(...q.map((p, i) => Math.hypot((p[0] - gt[i][0]) * a.w, (p[1] - gt[i][1]) * a.h))) / Math.max(a.w, a.h) * 100 : 99);
  const e0 = err(d && d.quad);
  if (d) { const b = load(file, 1200); d = refineDetection(b.g, b.w, b.h, d); }
  const e = err(d && d.quad);
  all.push(e);
  if (/sola|photo/.test(name)) single.push(e);
  console.log(name.padEnd(26), `${e0.toFixed(2)}%`.padStart(8), '→', `${e.toFixed(2)}%`.padStart(7), '  (angolo più lontano, in % del lato lungo: a 400 px → rimisurato)');
}
const med = (v) => [...v].sort((x, y) => x - y)[v.length >> 1];
check(med(all) < 1, `errore mediano ${med(all).toFixed(2)}% (sotto l'1%)`);
check(Math.max(...single) < 1.5, `pagina sola: nessun margine tagliato, errore massimo ${Math.max(...single).toFixed(2)}%`);
console.log(fails.length ? `\n${fails.length} problemi` : '\nTutto ok');
process.exit(fails.length ? 1 : 0);
