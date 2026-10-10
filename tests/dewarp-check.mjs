// Confronta due modi di usare UVDoc: sulla pagina già ritagliata (A) o sulla foto attorno alla pagina (B).
//   node tests/dewarp-check.mjs
import * as ort from '../node_modules/onnxruntime-web/dist/ort.node.min.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { warp, outputSize } from '../js/proc.js';
import { detectQuad } from '../js/detect.js';
mkdirSync('tests/out', { recursive: true });
const S = await ort.InferenceSession.create(readFileSync('vendor/paddle/uvdoc.onnx'));
const load = (f) => {
  const o = execFileSync('python3', ['-c', "import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('RGBA');sys.stdout.buffer.write(im.width.to_bytes(4,'little')+im.height.to_bytes(4,'little')+im.tobytes())", f], { maxBuffer: 1 << 30 });
  return { width: o.readUInt32LE(0), height: o.readUInt32LE(4), data: new Uint8ClampedArray(o.buffer, o.byteOffset + 8, o.length - 8) };
};
const save = (img, f) => {
  writeFileSync('tests/out/_raw', Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length));
  execFileSync('python3', ['-c', `from PIL import Image;im=Image.frombytes('RGBA',(${img.width},${img.height}),open('tests/out/_raw','rb').read()).convert('RGB');im.thumbnail((700,900));im.save('${f}')`]);
};
async function uv(img) {
  const { width: w, height: h, data: d } = img; const n = w * h;
  const x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { x[i] = d[i * 4] / 255; x[n + i] = d[i * 4 + 1] / 255; x[2 * n + i] = d[i * 4 + 2] / 255; }
  const r = await S.run({ [S.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, h, w]) });
  const o = r[S.outputNames[0]].data; const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { out[i * 4] = o[i] * 255; out[i * 4 + 1] = o[n + i] * 255; out[i * 4 + 2] = o[2 * n + i] * 255; out[i * 4 + 3] = 255; }
  return { data: out, width: w, height: h };
}
function crop(img, x0, y0, x1, y1) {
  const w = x1 - x0; const h = y1 - y0; const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x1) * 4), y * w * 4);
  return { data: out, width: w, height: h };
}
for (const name of ['libro-aperto', 'due-pagine'].filter((n) => existsSync(`tests/fixtures/real/${n}.jpg`))) {
  const img = load(`tests/fixtures/real/${name}.jpg`);
  const g = new Uint8Array(img.width * img.height);
  for (let i = 0; i < g.length; i++) g[i] = (img.data[i * 4] * 77 + img.data[i * 4 + 1] * 150 + img.data[i * 4 + 2] * 29) >> 8;
  // riconoscimento a 400 px come nell'app
  const k = 400 / Math.max(img.width, img.height);
  const sw = Math.round(img.width * k); const sh = Math.round(img.height * k);
  const sg = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sg[y * sw + x] = g[Math.min(img.height - 1, Math.round(y / k)) * img.width + Math.min(img.width - 1, Math.round(x / k))];
  const det = detectQuad(sg, sw, sh);
  const pages = det.halves && name === 'due-pagine' ? det.halves : [det.quad];
  let i = 0;
  for (const qn of pages) {
    const q = qn.map(([x, y]) => [x * img.width, y * img.height]);
    const [ow, oh] = outputSize(q, 1400);
    const flat = warp(img, q, ow, oh);
    save(flat, `tests/out/dw-${name}-${i}-0-ritaglio.png`);
    save(await uv(flat), `tests/out/dw-${name}-${i}-A-dopo-ritaglio.png`);
    const xs = q.map((p) => p[0]); const ys = q.map((p) => p[1]);
    const m = 0.04 * Math.max(img.width, img.height);
    const box = [Math.max(0, Math.floor(Math.min(...xs) - m)), Math.max(0, Math.floor(Math.min(...ys) - m)), Math.min(img.width, Math.ceil(Math.max(...xs) + m)), Math.min(img.height, Math.ceil(Math.max(...ys) + m))];
    save(await uv(crop(img, ...box)), `tests/out/dw-${name}-${i}-B-foto.png`);
    // C: come B, ma fuori dalla pagina si mette uno sfondo scuro (UVDoc vede una sola pagina)
    const c = crop(img, ...box);
    const inside = (x, y) => {
      let sgn = 0;
      for (let j = 0; j < 4; j++) {
        const [ax, ay] = q[j]; const [bx, by] = q[(j + 1) % 4];
        const z = (bx - ax) * (y + box[1] - ay) - (by - ay) * (x + box[0] - ax);
        if (z === 0) continue;
        if (!sgn) sgn = Math.sign(z); else if (Math.sign(z) !== sgn) return false;
      }
      return true;
    };
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (!inside(x, y)) { const o = (y * c.width + x) * 4; c.data[o] = 38; c.data[o + 1] = 34; c.data[o + 2] = 31; }
    save(await uv(c), `tests/out/dw-${name}-${i}-C-maschera.png`);
    i++;
  }
  console.log(name, 'ok');
}
