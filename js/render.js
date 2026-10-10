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

// params: { quad, rotation, filter, brightness, contrast, erase }
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
