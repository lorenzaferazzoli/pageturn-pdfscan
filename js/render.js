// Dalla foto originale alla pagina finita. Funziona nel worker (OffscreenCanvas)
// e, se serve, nel thread principale.
import { warp, rotate, outputSize, applyFilter, toGray, sharpness, FULL_QUAD } from './proc.js';
import { detectQuad } from './detect.js';

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c) {
  return c.getContext('2d', { willReadFrequently: true });
}

async function encode(c, type, quality) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality });
  return new Promise((res) => c.toBlob(res, type, quality));
}

async function decode(blob) {
  return createImageBitmap(blob);
}

function release(bmp) {
  if (bmp && bmp.close) bmp.close();
}

function putImage(img) {
  const c = canvas(img.width, img.height);
  ctx2d(c).putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

async function thumbOf(c, side) {
  const k = Math.min(1, side / Math.max(c.width, c.height));
  const t = canvas(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  const x = t.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(c, 0, 0, t.width, t.height);
  return encode(t, 'image/jpeg', 0.72);
}

// ---------- pagina curva (UVDoc) ----------
// Il modello stima come è piegata la pagina e la distende. Si carica solo al primo uso (31 MB).
const UV_MAX = 1800; // lato lungo massimo su cui lavora (memoria del telefono)
let uv = null;
let uvCache = { key: '', img: null };

async function uvSession() {
  if (uv) return uv;
  const base = new URL('../vendor/', import.meta.url).href;
  const ort = await import('../vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = base + 'ort/';
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  const r = await fetch(base + 'paddle/uvdoc.onnx');
  if (!r.ok) throw new Error('Modello per le pagine curve non disponibile');
  const session = await ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'] });
  uv = { ort, session };
  return uv;
}

function scaleImage(img, maxSide) {
  const k = maxSide / Math.max(img.width, img.height);
  if (k >= 1) return img;
  const c = putImage(img);
  const t = canvas(Math.round(img.width * k), Math.round(img.height * k));
  const x = ctx2d(t);
  x.imageSmoothingQuality = 'high';
  x.drawImage(c, 0, 0, t.width, t.height);
  return x.getImageData(0, 0, t.width, t.height);
}

async function dewarp(img, key) {
  if (uvCache.key === key) return { data: new Uint8ClampedArray(uvCache.img.data), width: uvCache.img.width, height: uvCache.img.height };
  const { ort, session } = await uvSession();
  const src = scaleImage(img, UV_MAX);
  const { width: w, height: h, data: d } = src;
  const n = w * h;
  const x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    x[i] = d[i * 4] / 255;
    x[n + i] = d[i * 4 + 1] / 255;
    x[2 * n + i] = d[i * 4 + 2] / 255;
  }
  const r = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, h, w]) });
  const o = r[session.outputNames[0]].data;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = o[i] * 255;
    out[i * 4 + 1] = o[n + i] * 255;
    out[i * 4 + 2] = o[2 * n + i] * 255;
    out[i * 4 + 3] = 255;
  }
  const res = { data: out, width: w, height: h };
  uvCache = { key, img: { data: new Uint8ClampedArray(out), width: w, height: h } };
  return res;
}

// params: { quad, rotation, filter, brightness, contrast, erase, dewarp }
// opts: { maxSide, quality, thumb }
export async function render(blob, params = {}, opts = {}) {
  const maxSide = opts.maxSide || 2400;
  const bmp = await decode(blob);
  try {
    const SW = bmp.width;
    const SH = bmp.height;
    const qn = params.quad || FULL_QUAD;
    let q = qn.map(([x, y]) => [x * SW, y * SH]);
    const [ow, oh] = outputSize(q, maxSide);
    // Se l'uscita è molto più piccola della foto, si lavora su una copia ridotta.
    const quadLong = Math.max(...outputSize(q, 1e9));
    const k = Math.min(1, (Math.max(ow, oh) * 1.25) / quadLong);
    const cw = Math.max(1, Math.round(SW * k));
    const ch = Math.max(1, Math.round(SH * k));
    const c = canvas(cw, ch);
    const x = ctx2d(c);
    x.imageSmoothingQuality = 'high';
    x.drawImage(bmp, 0, 0, cw, ch);
    const src = x.getImageData(0, 0, cw, ch);
    q = q.map(([a, b]) => [a * k, b * k]);
    let img = warp(src, q, ow, oh);
    img = rotate(img, params.rotation || 0);
    if (params.dewarp) img = await dewarp(img, `${blob.size}|${JSON.stringify(qn)}|${params.rotation || 0}|${maxSide}`);

    // Nitidezza misurata prima dei filtri, su una versione ridotta.
    let sharp = null;
    if (opts.measure) {
      const g = toGray(img);
      sharp = sharpness(g, img.width, img.height) * (Math.max(img.width, img.height) / 2400) ** 2;
    }
    applyFilter(img, params);
    const out = putImage(img);
    const res = {
      blob: await encode(out, 'image/jpeg', opts.quality || 0.82),
      width: img.width,
      height: img.height,
      sharp,
    };
    if (opts.thumb) res.thumb = await thumbOf(out, opts.thumb);
    return res;
  } finally {
    release(bmp);
  }
}

// Ridimensiona e ricomprime (per l'esportazione in qualità bassa).
export async function resize(blob, { maxSide = 1600, quality = 0.7, up = false } = {}) {
  const bmp = await decode(blob);
  try {
    const k0 = maxSide / Math.max(bmp.width, bmp.height);
    const k = up ? k0 : Math.min(1, k0);
    const c = canvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(bmp, 0, 0, c.width, c.height);
    return { blob: await encode(c, 'image/jpeg', quality), width: c.width, height: c.height };
  } finally {
    release(bmp);
  }
}

// Riconoscimento della pagina in una foto (per le foto importate e la fotocamera iOS).
export async function detect(blob) {
  const bmp = await decode(blob);
  try {
    const k = 200 / Math.max(bmp.width, bmp.height);
    const w = Math.round(bmp.width * k);
    const h = Math.round(bmp.height * k);
    const c = canvas(w, h);
    const x = ctx2d(c);
    x.drawImage(bmp, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return { found: detectQuad(g, w, h), width: bmp.width, height: bmp.height };
  } finally {
    release(bmp);
  }
}
