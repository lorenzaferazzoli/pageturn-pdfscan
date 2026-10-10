// Confronto Tesseract / PaddleOCR sulle pagine di tests/fixtures/ocr (errore sui caratteri, CER).
//   node tests/ocr-compare.mjs
import * as ort from '../node_modules/onnxruntime-web/dist/ort.node.min.mjs';
import { createWorker } from 'tesseract.js';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createPaddle } from '../js/paddle.js';

const M = 'vendor/paddle';
const dir = 'tests/fixtures/ocr';
const only = process.argv[2];
const norm = (s) => s.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
function lev(a, b) {
  const n = b.length;
  let prev = new Uint32Array(n + 1).map((_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint32Array(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const cer = (got, ref) => lev(norm(got), norm(ref)) / norm(ref).length;
function rgba(file) {
  const out = execFileSync('python3', ['-c', "import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGBA');sys.stdout.buffer.write(im.width.to_bytes(4,'little')+im.height.to_bytes(4,'little')+im.tobytes())", file], { maxBuffer: 1 << 30 });
  return { width: out.readUInt32LE(0), height: out.readUInt32LE(4), data: new Uint8ClampedArray(out.buffer, out.byteOffset + 8, out.length - 8) };
}

const tess = await createWorker(['ita', 'eng'], 1, { langPath: 'vendor/tessdata', gzip: true, cachePath: 'tests/out/tess-cache' });
const sides = [960, 1280, 1600];
const pads = {};
for (const s of sides) {
  pads[s] = await createPaddle({
    ort, det: readFileSync(`${M}/det.onnx`), rec: readFileSync(`${M}/rec-latin.onnx`), dict: readFileSync(`${M}/dict-latin.txt`, 'utf8'), detSide: s,
  });
}
const files = readdirSync(dir).filter((f) => /\.(jpg|png)$/.test(f) && (!only || f.includes(only))).sort();
console.log('pagina'.padEnd(30), 'tesseract'.padEnd(16), ...sides.map((s) => `paddle@${s}`.padEnd(16)));
for (const f of files) {
  const ref = readFileSync(`${dir}/${f.replace(/(-hd|-foto|-curva|-piccola|-distesa)?\.(jpg|png)$/, '')}.txt`, 'utf8');
  let t = performance.now();
  const { data } = await tess.recognize(`${dir}/${f}`);
  const row = [`${(cer(data.text, ref) * 100).toFixed(1)}% ${Math.round(performance.now() - t)}ms`];
  if (process.env.SHOW) console.log('--- tesseract\n' + data.text);
  const img = rgba(`${dir}/${f}`);
  for (const s of sides) {
    t = performance.now();
    const r = await pads[s].recognize(img);
    row.push(`${(cer(r.text, ref) * 100).toFixed(1)}% ${Math.round(performance.now() - t)}ms`);
    if (process.env.SHOW && s === 1280) console.log('--- paddle\n' + r.text);
  }
  console.log(`${f} (${img.width}×${img.height})`.padEnd(30), ...row.map((x) => x.padEnd(16)));
}
await tess.terminate();
