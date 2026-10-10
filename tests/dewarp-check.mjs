// Distendi: quanto restano storte le righe di testo. Sulle pagine curve sintetiche di
// tests/fixtures/curve (righe di partenza perfettamente dritte) e, se ci sono, sulle foto vere
// in tests/fixtures/real (non pubblicate). Confronta tre modi:
//   piatta   solo prospettiva (Distendi spento)
//   griglia  la griglia di UVDoc usata così com'è (com'era Distendi fino alla 1.6.0)
//   distesa  superficie liscia + righe di testo (js/dewarp.js)
//   node tests/dewarp-check.mjs        (immagini di confronto in tests/out/dw-*.jpg)
import * as ort from '../node_modules/onnxruntime-web/dist/ort.node.min.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { warp, outputSize } from '../js/proc.js';
import { detectQuad } from '../js/detect.js';
import { uvInput, uvGrid, buildModel, renderModel, trackLines, IW, IH, GW, GH } from '../js/dewarp.js';

mkdirSync('tests/out', { recursive: true });
const S = await ort.InferenceSession.create(readFileSync('vendor/paddle/uvdoc-grid.onnx'));
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };

const load = (f) => {
  const o = execFileSync('python3', ['-c', "import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGBA');sys.stdout.buffer.write(im.width.to_bytes(4,'little')+im.height.to_bytes(4,'little')+im.tobytes())", f], { maxBuffer: 1 << 30 });
  return { width: o.readUInt32LE(0), height: o.readUInt32LE(4), data: new Uint8ClampedArray(o.buffer, o.byteOffset + 8, o.length - 8) };
};
const saveRow = (imgs, f) => {
  const h = Math.max(...imgs.map((i) => i.height));
  const w = imgs.reduce((s, i) => s + i.width + 8, 0);
  const o = new Uint8ClampedArray(w * h * 4);
  let x0 = 0;
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) o.set(im.data.subarray(y * im.width * 4, (y + 1) * im.width * 4), (y * w + x0) * 4);
    x0 += im.width + 8;
  }
  writeFileSync('tests/out/_raw', Buffer.from(o.buffer));
  execFileSync('python3', ['-c', `from PIL import Image;im=Image.frombytes('RGBA',(${w},${h}),open('tests/out/_raw','rb').read()).convert('RGB');im.thumbnail((2400,1200));im.save('${f}',quality=85)`]);
};

// righe di testo: scarto medio dalla retta (px su una pagina alta 1000), sui tratti lunghi
function straightness(img) {
  const k = 1000 / img.height;
  const w = Math.round(img.width * k);
  const h = 1000;
  const g = new Float32Array(w * h);
  const { data: d, width: W, height: H } = img;
  for (let y = 0; y < h; y++) {
    const ya = Math.floor(y / k); const yb = Math.min(H, Math.max(ya + 1, Math.floor((y + 1) / k)));
    for (let x = 0; x < w; x++) {
      const xa = Math.floor(x / k); const xb = Math.min(W, Math.max(xa + 1, Math.floor((x + 1) / k)));
      let s = 0; let n = 0;
      for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) { const i = (yy * W + xx) * 4; s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
      g[y * w + x] = s / n;
    }
  }
  const { segs } = trackLines(g, w, h);
  const res = [];
  for (const s of segs) {
    if (s.length < 14) continue;
    const n = s.length;
    const mx = s.reduce((a, p) => a + p[0], 0) / n;
    const my = s.reduce((a, p) => a + p[1], 0) / n;
    let sxy = 0; let sxx = 0;
    for (const [x, y] of s) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    const b = sxy / sxx;
    res.push(Math.sqrt(s.reduce((a, [x, y]) => a + (y - my - b * (x - mx)) ** 2, 0) / n));
  }
  return { v: res.length ? res.reduce((a, b) => a + b, 0) / res.length : NaN, n: res.length };
}

// la griglia di UVDoc così com'è: bilineare sui 45×31 punti
function renderGrid(G, src, ow, oh) {
  const n = GW * GH;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const { width: SW, height: SH, data: sd } = src;
  for (let y = 0; y < oh; y++) {
    const gy = (y / (oh - 1)) * (GH - 1); const j = Math.min(GH - 2, Math.floor(gy)); const fy = gy - j;
    for (let x = 0; x < ow; x++) {
      const gx = (x / (ow - 1)) * (GW - 1); const i = Math.min(GW - 2, Math.floor(gx)); const fx = gx - i;
      const at = (c, jj, ii) => G[c * n + jj * GW + ii];
      const lerp = (c) => (at(c, j, i) * (1 - fx) + at(c, j, i + 1) * fx) * (1 - fy) + (at(c, j + 1, i) * (1 - fx) + at(c, j + 1, i + 1) * fx) * fy;
      const sx = Math.min(SW - 1.001, Math.max(0, lerp(0) * SW - 0.5));
      const sy = Math.min(SH - 1.001, Math.max(0, lerp(1) * SH - 0.5));
      const ax = Math.floor(sx); const ay = Math.floor(sy); const tx = sx - ax; const ty = sy - ay;
      const p = (ay * SW + ax) * 4; const q = p + SW * 4; const o = (y * ow + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = (sd[p + c] * (1 - tx) + sd[p + 4 + c] * tx) * (1 - ty) + (sd[q + c] * (1 - tx) + sd[q + 4 + c] * tx) * ty;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: ow, height: oh };
}

const items = [];
const quads = JSON.parse(readFileSync('tests/fixtures/curve/quads.json', 'utf8'));
for (const [n, q] of Object.entries(quads)) items.push({ name: n, file: `tests/fixtures/curve/${n}.jpg`, q, synth: true });
const realDir = 'tests/fixtures/real/pdf2';
if (existsSync(realDir)) for (const f of readdirSync(realDir).filter((x) => x.endsWith('.jpg')).sort()) items.push({ name: f.slice(0, -4), file: `${realDir}/${f}` });

const tot = { piatta: [], griglia: [], distesa: [] };
const totReal = { piatta: [], griglia: [], distesa: [] };
console.log('pagina'.padEnd(12), 'piatta'.padStart(8), 'griglia'.padStart(8), 'distesa'.padStart(8), '  (scarto medio delle righe dalla retta, px)');
for (const it of items) {
  const img = load(it.file);
  let qn = it.q;
  if (!qn) {
    // foto vere: riconoscimento come nell'app (a 400 px)
    const k = 400 / Math.max(img.width, img.height);
    const sw = Math.round(img.width * k); const sh = Math.round(img.height * k);
    const g = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const i = (Math.min(img.height - 1, Math.round(y / k)) * img.width + Math.min(img.width - 1, Math.round(x / k))) * 4; g[y * sw + x] = (img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29) >> 8; }
    const det = detectQuad(g, sw, sh);
    if (!det) continue;
    qn = det.quad;
  }
  const q = qn.map(([x, y]) => [x * img.width, y * img.height]);
  const [ow, oh] = outputSize(q, 1400);
  const { x, box } = uvInput(img, q);
  const r = await S.run({ [S.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, IH, IW]) });
  const G = uvGrid(r[S.outputNames[0]].data, box, img.width, img.height);
  const t0 = performance.now();
  const m = buildModel(G, img, ow / oh);
  const outs = { piatta: warp(img, q, ow, oh), griglia: renderGrid(G, img, ow, oh), distesa: renderModel(m, img, ow, oh) };
  const ms = performance.now() - t0;
  const row = {};
  for (const [k, o] of Object.entries(outs)) { row[k] = straightness(o).v; (it.synth ? tot : totReal)[k].push(row[k]); }
  console.log(it.name.padEnd(12), ...Object.values(row).map((v) => v.toFixed(2).padStart(8)), `   ${Math.round(ms)} ms, ${m.fields.length} correzioni`);
  saveRow(Object.values(outs), `tests/out/dw-${it.name}.jpg`);
}
const mean = (a) => a.filter((v) => v === v).reduce((s, v) => s + v, 0) / a.filter((v) => v === v).length;
const ms = Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, mean(v)]));
console.log('media sintetiche', Object.entries(ms).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' · '));
if (totReal.distesa.length) console.log('media foto vere ', Object.entries(totReal).map(([k, v]) => `${k} ${mean(v).toFixed(2)}`).join(' · '));
check(ms.distesa < ms.piatta * 0.5, `righe dritte rispetto alla sola prospettiva (${ms.distesa.toFixed(2)} contro ${ms.piatta.toFixed(2)})`);
check(ms.distesa < ms.griglia * 0.8, `righe più dritte della griglia di UVDoc da sola (${ms.distesa.toFixed(2)} contro ${ms.griglia.toFixed(2)})`);
console.log(fails.length ? `\n${fails.length} problemi` : '\nTutto ok');
process.exit(fails.length ? 1 : 0);
