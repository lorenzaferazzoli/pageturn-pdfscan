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

// UVDoc lavora sulla foto attorno alla pagina (come nei dati su cui è addestrato), con uno sfondo
// scuro fuori dal quadrilatero, così vede una pagina sola anche con il libro aperto. Il risultato
// è la pagina distesa, che si riporta alle proporzioni del ritaglio.
async function dewarp(src, q, ow, oh, key) {
  if (uvCache.key === key) return { data: new Uint8ClampedArray(uvCache.img.data), width: uvCache.img.width, height: uvCache.img.height };
  const { ort, session } = await uvSession();
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const m = 0.04 * Math.max(src.width, src.height);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - m));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - m));
  const x1 = Math.min(src.width, Math.ceil(Math.max(...xs) + m));
  const y1 = Math.min(src.height, Math.ceil(Math.max(...ys) + m));
  const k = Math.min(1, UV_MAX / Math.max(x1 - x0, y1 - y0));
  const w = Math.max(32, Math.round((x1 - x0) * k));
  const h = Math.max(32, Math.round((y1 - y0) * k));
  const n = w * h;
  const x = new Float32Array(3 * n);
  const qq = q.map(([a, b]) => [(a - x0) * k, (b - y0) * k]);
  const inside = (px, py) => {
    let sgn = 0;
    for (let j = 0; j < 4; j++) {
      const [ax, ay] = qq[j];
      const [bx, by] = qq[(j + 1) % 4];
      const z = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (!z) continue;
      if (!sgn) sgn = Math.sign(z);
      else if (Math.sign(z) !== sgn) return false;
    }
    return true;
  };
  const sd = src.data;
  for (let yy = 0; yy < h; yy++) {
    const sy = Math.min(src.height - 1, Math.floor(y0 + (yy + 0.5) / k));
    for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx;
      if (!inside(xx + 0.5, yy + 0.5)) { x[i] = 0.15; x[n + i] = 0.13; x[2 * n + i] = 0.12; continue; }
      const sx = Math.min(src.width - 1, Math.floor(x0 + (xx + 0.5) / k));
      const o = (sy * src.width + sx) * 4;
      x[i] = sd[o] / 255;
      x[n + i] = sd[o + 1] / 255;
      x[2 * n + i] = sd[o + 2] / 255;
    }
  }
  const r = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, h, w]) });
  const o = r[session.outputNames[0]].data;
  const flat = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    flat[i * 4] = o[i] * 255;
    flat[i * 4 + 1] = o[n + i] * 255;
    flat[i * 4 + 2] = o[2 * n + i] * 255;
    flat[i * 4 + 3] = 255;
  }
  // alle proporzioni della pagina ritagliata
  const c = putImage({ data: flat, width: w, height: h });
  const t = canvas(ow, oh);
  const tx = ctx2d(t);
  tx.imageSmoothingQuality = 'high';
  tx.drawImage(c, 0, 0, ow, oh);
  const res = tx.getImageData(0, 0, ow, oh);
  uvCache = { key, img: { data: new Uint8ClampedArray(res.data), width: ow, height: oh } };
  return { data: res.data, width: ow, height: oh };
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
    let img = params.dewarp
      ? await dewarp(src, q, ow, oh, `${blob.size}|${JSON.stringify(qn)}|${maxSide}`)
      : warp(src, q, ow, oh);
    img = rotate(img, params.rotation || 0);

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
    const k = 400 / Math.max(bmp.width, bmp.height);
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
