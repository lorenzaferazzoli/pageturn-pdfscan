// Dalla foto originale alla pagina finita. Funziona nel worker (OffscreenCanvas)
// e, se serve, nel thread principale.
import { warp, rotate, outputSize, applyFilter, toGray, sharpness, homography, FULL_QUAD } from './proc.js';
import { uvInput, uvGrid, buildModel, renderModel, forward, inverse, IW, IH } from './dewarp.js';
import { detectQuad, refineDetection } from './detect.js';

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
// UVDoc stima come è piegata la pagina; il resto (superficie liscia, righe di testo) è in dewarp.js.
// Il modello si carica solo al primo uso (31 MB).
let uv = null;
const models = new Map(); // ultimi modelli di pagina, per foto e ritaglio

async function uvSession() {
  if (uv) return uv;
  const base = new URL('../vendor/', import.meta.url).href;
  const ort = await import('../vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = base + 'ort/';
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  const r = await fetch(base + 'paddle/uvdoc-grid.onnx');
  if (!r.ok) throw new Error('Modello per le pagine curve non disponibile');
  const session = await ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'] });
  uv = { ort, session };
  return uv;
}

// UVDoc lavora sulla foto attorno alla pagina (come nei dati su cui è addestrato), con uno sfondo
// scuro fuori dal quadrilatero, così vede una pagina sola anche con il libro aperto.
async function pageModel(src, q, aspect, key) {
  const hit = models.get(key);
  if (hit) {
    models.delete(key);
    models.set(key, hit);
    return hit;
  }
  const { ort, session } = await uvSession();
  const { x, box } = uvInput(src, q);
  const r = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, IH, IW]) });
  const m = buildModel(uvGrid(r[session.outputNames[0]].data, box, src.width, src.height), src, aspect);
  models.set(key, m);
  while (models.size > 3) models.delete(models.keys().next().value);
  return m;
}

// I tratti della gomma restano dove sono stati fatti anche se poi si accende o si spegne Distendi:
// ogni tratto ricorda su quale pagina è stato disegnato (g: 'f' piatta, 'd' distesa) e si sposta
// sull'altra passando per la foto. Le coordinate sono quelle della pagina ruotata.
function mapStrokes(erase, toDewarp, m, q, ow, oh, rot, SW, SH) {
  const want = toDewarp ? 'd' : 'f';
  if (!erase.some((s) => s.g && s.g !== want)) return erase;
  const H = homography(ow, oh, q);
  const Hi = invert3(H);
  const k = ((rot % 4) + 4) % 4;
  const unrot = ([x, y]) => { for (let i = 0; i < k; i++) [x, y] = [y, 1 - x]; return [x, y]; };
  const rerot = ([x, y]) => { for (let i = 0; i < k; i++) [x, y] = [1 - y, x]; return [x, y]; };
  return erase.map((s) => {
    if (!s.g || s.g === want) return s;
    const pts = s.pts.map((p) => {
      const [x, y] = unrot(p);
      if (toDewarp) {
        const [sx, sy] = applyH(H, x * ow, y * oh);
        return rerot(inverse(m, sx / SW, sy / SH, x, y));
      }
      const n = forward(m, x, y);
      const [X, Y] = applyH(Hi, n[0] * SW, n[1] * SH);
      return rerot([X / ow, Y / oh]);
    });
    return { ...s, g: want, pts };
  });
}
function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

// params: { quad, rotation, filter, brightness, contrast, erase, dewarp }
// opts: { maxSide, quality, thumb }
// Foto già decodificate, per le anteprime dell'editor: ogni ritocco non deve rileggere il JPEG intero.
const bmpCache = new Map();
async function getBitmap(blob, key) {
  if (!key) return { bmp: await decode(blob), own: true };
  const hit = bmpCache.get(key);
  if (hit) {
    bmpCache.delete(key);
    bmpCache.set(key, hit);
    return { bmp: hit, own: false };
  }
  const bmp = await decode(blob);
  bmpCache.set(key, bmp);
  while (bmpCache.size > 2) {
    const [k0, v] = bmpCache.entries().next().value;
    bmpCache.delete(k0);
    release(v);
  }
  return { bmp, own: false };
}

export async function render(blob, params = {}, opts = {}) {
  const maxSide = opts.maxSide || 2400;
  const { bmp, own } = await getBitmap(blob, opts.cacheKey);
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
    const erase = params.erase || [];
    const remap = erase.some((s) => s.g && s.g !== (params.dewarp ? 'd' : 'f'));
    const model = params.dewarp || remap ? await pageModel(src, q, ow / oh, `${blob.size}|${JSON.stringify(qn)}`) : null;
    let img = params.dewarp ? renderModel(model, src, ow, oh) : warp(src, q, ow, oh);
    const strokes = remap ? mapStrokes(erase, !!params.dewarp, model, q, ow, oh, params.rotation || 0, cw, ch) : erase;
    img = rotate(img, params.rotation || 0);

    // Nitidezza misurata prima dei filtri, su una versione ridotta.
    let sharp = null;
    if (opts.measure) {
      const g = toGray(img);
      sharp = sharpness(g, img.width, img.height) * (Math.max(img.width, img.height) / 2400) ** 2;
    }
    applyFilter(img, { ...params, erase: strokes });
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
    if (own) release(bmp);
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
    const grayAt = (side) => {
      const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * k);
      const h = Math.round(bmp.height * k);
      const c = canvas(w, h);
      const x = ctx2d(c);
      x.imageSmoothingQuality = 'high';
      x.drawImage(bmp, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h).data;
      const g = new Uint8Array(w * h);
      for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      return { g, w, h };
    };
    const a = grayAt(400);
    let found = detectQuad(a.g, a.w, a.h);
    // bordi rimisurati su un'immagine più grande
    if (found) { const b = grayAt(1200); found = refineDetection(b.g, b.w, b.h, found); }
    return { found, width: bmp.width, height: bmp.height };
  } finally {
    release(bmp);
  }
}
