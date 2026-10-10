// Elaborazione immagini senza dipendenze. Lavora su oggetti {data, width, height}
// (RGBA, come ImageData) e gira sia nel worker sia nel thread principale.

export const FILTERS = ['original', 'whiten', 'gray', 'bw'];

// ---------- geometria ----------

// Omografia che porta il rettangolo (0,0)-(w,h) sul quadrilatero q (TL, TR, BR, BL, in pixel).
export function homography(w, h, q) {
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const [x, y] = q[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const s = solve(A, b);
  return [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], 1];
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Dimensioni naturali della pagina raddrizzata, limitate a maxSide.
export function outputSize(q, maxSide) {
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const k = Math.min(1, maxSide / Math.max(w, h));
  return [Math.max(8, Math.round(w * k)), Math.max(8, Math.round(h * k))];
}

// Raddrizza il quadrilatero q dell'immagine src in un rettangolo outW×outH (bilineare).
export function warp(src, q, outW, outH) {
  const H = homography(outW, outH, q);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sd = src.data;
  const sw = src.width;
  const sh = src.height;
  let o = 0;
  for (let v = 0; v < outH; v++) {
    const vy = v + 0.5;
    for (let u = 0; u < outW; u++) {
      const ux = u + 0.5;
      const z = H[6] * ux + H[7] * vy + H[8];
      let x = (H[0] * ux + H[1] * vy + H[2]) / z - 0.5;
      let y = (H[3] * ux + H[4] * vy + H[5]) / z - 0.5;
      if (x < 0) x = 0; else if (x > sw - 1.001) x = sw - 1.001;
      if (y < 0) y = 0; else if (y > sh - 1.001) y = sh - 1.001;
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      out[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
      out[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
      out[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      out[o + 3] = 255;
      o += 4;
    }
  }
  return { data: out, width: outW, height: outH };
}

// Rotazione di k quarti di giro in senso orario.
export function rotate(img, k) {
  k = ((k % 4) + 4) % 4;
  if (!k) return img;
  const { width: w, height: h, data: d } = img;
  const W = k % 2 ? h : w;
  const H = k % 2 ? w : h;
  const o = new Uint32Array(W * H);
  const s = new Uint32Array(d.buffer, d.byteOffset, w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X;
      let Y;
      if (k === 1) { X = h - 1 - y; Y = x; } else if (k === 2) { X = w - 1 - x; Y = h - 1 - y; } else { X = y; Y = w - 1 - x; }
      o[Y * W + X] = s[y * w + x];
    }
  }
  return { data: new Uint8ClampedArray(o.buffer), width: W, height: H };
}

// Divide un quadrilatero in metà sinistra e destra lungo i punti medi dei lati alto e basso.
export function splitQuad(q) {
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const mt = mid(q[0], q[1]);
  const mb = mid(q[3], q[2]);
  return [[q[0], mt, mb, q[3]], [mt, q[1], q[2], mb]];
}

export const FULL_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];

// ---------- sfondo e filtri ----------

// Stima dell'illuminazione della carta: per blocchi, media dei pixel più chiari,
// poi espansione e sfocatura. Restituisce una mappa piccola RGB (Float32).
export function backgroundMap(img) {
  const { width: w, height: h, data: d } = img;
  const B = Math.max(8, Math.round(Math.max(w, h) / 64));
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const map = new Float32Array(bw * bh * 3);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      const x0 = bx * B;
      const y0 = by * B;
      const x1 = Math.min(w, x0 + B);
      const y1 = Math.min(h, y0 + B);
      let n = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * w + x) * 4;
          hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
          n++;
        }
      }
      let t = 255;
      let acc = 0;
      const want = Math.max(1, n * 0.12);
      while (t > 0 && acc + hist[t] < want) acc += hist[t--];
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * w + x) * 4;
          if (((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) >= t) {
            r += d[i]; g += d[i + 1]; b += d[i + 2]; c++;
          }
        }
      }
      const j = (by * bw + bx) * 3;
      map[j] = r / c; map[j + 1] = g / c; map[j + 2] = b / c;
    }
  }
  // Espansione mirata: un blocco molto più scuro dei vicini (testo fitto, figura) prende il valore del vicino più chiaro.
  const lum = (m, j) => m[j] * 0.3 + m[j + 1] * 0.59 + m[j + 2] * 0.11;
  const dil = new Float32Array(map.length);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let best = (y * bw + x) * 3;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= bw || Y >= bh) continue;
          const j = (Y * bw + X) * 3;
          if (lum(map, j) > lum(map, best)) best = j;
        }
      }
      const k0 = (y * bw + x) * 3;
      // si sostituisce solo se il blocco è molto più scuro (testo fitto o figura), non lungo un'ombra graduale
      if (lum(map, best) - lum(map, k0) < 40) best = k0;
      dil[k0] = map[best]; dil[k0 + 1] = map[best + 1]; dil[k0 + 2] = map[best + 2];
    }
  }
  let cur = dil;
  for (let pass = 0; pass < 1; pass++) {
    const nx = new Float32Array(cur.length);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let r = 0; let g = 0; let b = 0; let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const X = x + dx;
            const Y = y + dy;
            if (X < 0 || Y < 0 || X >= bw || Y >= bh) continue;
            const j = (Y * bw + X) * 3;
            r += cur[j]; g += cur[j + 1]; b += cur[j + 2]; c++;
          }
        }
        const k = (y * bw + x) * 3;
        nx[k] = r / c; nx[k + 1] = g / c; nx[k + 2] = b / c;
      }
    }
    cur = nx;
  }
  return { map: cur, bw, bh, B };
}

// Valore di sfondo interpolato nel punto (x, y).
function bgAt(bg, x, y, out) {
  const fx = Math.min(bg.bw - 1, Math.max(0, x / bg.B - 0.5));
  const fy = Math.min(bg.bh - 1, Math.max(0, y / bg.B - 0.5));
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = Math.min(bg.bw - 1, x0 + 1);
  const y1 = Math.min(bg.bh - 1, y0 + 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const m = bg.map;
  for (let c = 0; c < 3; c++) {
    const a = m[(y0 * bg.bw + x0) * 3 + c] * (1 - ax) + m[(y0 * bg.bw + x1) * 3 + c] * ax;
    const b = m[(y1 * bg.bw + x0) * 3 + c] * (1 - ax) + m[(y1 * bg.bw + x1) * 3 + c] * ax;
    out[c] = Math.max(24, a * (1 - ay) + b * ay);
  }
  return out;
}

// Applica filtro, luminosità e contrasto, e la gomma. Modifica img sul posto.
// brightness e contrast vanno da -100 a 100.
export function applyFilter(img, { filter = 'whiten', brightness = 0, contrast = 0, sharpness = 50, erase = [] } = {}) {
  const sharp = Math.max(0, Math.min(100, sharpness ?? 50)) / 100;
  const { width: w, height: h, data: d } = img;
  const needBg = filter !== 'original' || erase.length;
  const bg = needBg ? backgroundMap(img) : null;
  const px = [0, 0, 0];

  // Tabella per curva tonale + luminosità/contrasto.
  const cf = contrast >= 0 ? 1 + contrast / 50 : 1 + contrast / 120;
  // Curva tonale; per i filtri da documento il nero è il punto più scuro dell'inchiostro di questa
  // pagina (livelli automatici): testo stampato chiaro o foto poco contrastata diventano nero pieno.
  const makeLut = (ink) => {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      let x = v;
      if (filter === 'whiten' || filter === 'gray') {
        x = Math.min(1, Math.max(0, (v - ink) / (232 - ink)));
        x = 255 * Math.pow(x, 1.4);
      }
      x = (x - 128) * cf + 128 + brightness * 1.1;
      lut[v] = x;
    }
    return lut;
  };
  let lut = makeLut(25);

  if (filter === 'original') {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
    }
  } else {
    // Livelli automatici: il punto più scuro dell'inchiostro, stimato su un campione già normalizzato.
    if (filter === 'whiten' || filter === 'gray') {
      const hist = new Uint32Array(256);
      let tot = 0;
      for (let y = 0; y < h; y += 4) {
        for (let x = 0; x < w; x += 4) {
          bgAt(bg, x, y, px);
          const i = (y * w + x) * 4;
          const l = Math.min(255, ((d[i] * 77) / px[0] + (d[i + 1] * 150) / px[1] + (d[i + 2] * 29) / px[2])) | 0;
          hist[l]++;
          tot++;
        }
      }
      let ink = 0;
      for (let acc = 0; ink < 255 && acc + hist[ink] < tot * 0.012; ink++) acc += hist[ink];
      lut = makeLut(Math.max(15, Math.min(110, ink)));
    }
    // Normalizzazione dello sfondo (carta bianca, ombra della piega rimossa) e curva tonale in un'unica passata.
    const step = 4;
    const id = filter === 'bw';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x += step) {
        bgAt(bg, x, y, px);
        const fr = 255 / px[0];
        const fg = 255 / px[1];
        const fb = 255 / px[2];
        const xe = Math.min(w, x + step);
        for (let xx = x; xx < xe; xx++) {
          const i = (y * w + xx) * 4;
          const r = Math.min(255, d[i] * fr) | 0;
          const g = Math.min(255, d[i + 1] * fg) | 0;
          const b = Math.min(255, d[i + 2] * fb) | 0;
          if (filter === 'whiten') {
            d[i] = lut[r]; d[i + 1] = lut[g]; d[i + 2] = lut[b];
          } else {
            const l = (r * 77 + g * 150 + b * 29) >> 8;
            d[i] = d[i + 1] = d[i + 2] = id ? l : lut[l];
          }
        }
      }
    }
    if (filter === 'bw') {
      sharpenAll(img, sharp, 1.4);
      const hist = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
      let t = otsu(hist, w * h);
      t = Math.min(225, Math.max(90, t + 12 - brightness * 0.6));
      const soft = Math.max(6, 22 - contrast / 6);
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i];
        const o = v <= t - soft ? 0 : v >= t + soft ? 255 : ((v - (t - soft)) * 255) / (2 * soft);
        d[i] = d[i + 1] = d[i + 2] = o;
      }
    }
  }

  // Maschera di contrasto leggera sulla luminosità: contorni delle lettere più netti.
  if (filter !== 'bw') sharpenAll(img, sharp, filter === 'original' ? 0.8 : 1.2);

  // Filo di sfondo rimasto sui bordi (ritaglio non perfetto): con i filtri da documento diventa carta bianca.
  if (filter !== 'original') {
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.006));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x >= band && x < w - band && y >= band && y < h - band) { x = w - band - 1; continue; }
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255;
      }
    }
  }

  // Gomma: tratti in coordinate normalizzate, raggio relativo alla larghezza.
  if (erase.length) {
    for (const s of erase) {
      const r = Math.max(1, s.r * w);
      for (let k = 0; k < s.pts.length; k++) {
        const a = s.pts[k];
        const b = s.pts[k + 1] || a;
        const ax = a[0] * w; const ay = a[1] * h; const bx = b[0] * w; const by = b[1] * h;
        const len = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(len / (r * 0.5)));
        for (let j = 0; j <= n; j++) {
          const cx = ax + ((bx - ax) * j) / n;
          const cy = ay + ((by - ay) * j) / n;
          paintDisc(img, cx, cy, r, filter, bg, px, lut);
        }
      }
    }
  }
  return img;
}

function paintDisc(img, cx, cy, r, filter, bg, px, lut) {
  const { width: w, height: h, data: d } = img;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
      const i = (y * w + x) * 4;
      if (filter === 'original') {
        bgAt(bg, x, y, px);
        d[i] = lut[px[0] | 0]; d[i + 1] = lut[px[1] | 0]; d[i + 2] = lut[px[2] | 0];
      } else {
        d[i] = d[i + 1] = d[i + 2] = filter === 'bw' ? 255 : lut[255];
      }
    }
  }
}

export function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

// ---------- misure ----------

export function toGray(img) {
  const { width: w, height: h, data: d } = img;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}

// Nitidezza: varianza del laplaciano sulla parte centrale. Valori bassi = foto mossa.
export function sharpness(gray, w, h) {
  const x0 = Math.floor(w * 0.1);
  const x1 = Math.floor(w * 0.9);
  const y0 = Math.floor(h * 0.1);
  const y1 = Math.floor(h * 0.9);
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
    for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) {
      const i = y * w + x;
      const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      s += l; s2 += l * l; n++;
    }
  }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

// Nitidezza su due scale (contorni fini delle lettere e tratti interi), proporzionale alla pagina.
// Un'unica passata: luminosità, due sfocature a scatola calcolate insieme, correzione applicata.
function sharpenAll(img, sharp, k) {
  if (sharp <= 0) return;
  const R = Math.max(1, Math.round(Math.max(img.width, img.height) / 1200)) + 1;
  sharpen2(img, sharp * k * 0.8, sharp * k * 0.5, R);
}

function sharpen2(img, a1, a2, R) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const L = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) L[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  // somme orizzontali su 3 e su 2R+1 pixel
  const H1 = new Uint16Array(n);
  const H2 = new Uint16Array(n);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s2 = 0;
    for (let x = -R; x <= R; x++) s2 += L[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      const i = o + x;
      H1[i] = L[x > 0 ? i - 1 : i] + L[i] + L[x < w - 1 ? i + 1 : i];
      H2[i] = s2;
      s2 += L[o + Math.min(w - 1, x + R + 1)] - L[o + Math.max(0, x - R)];
    }
  }
  const k1 = a1 / 9;
  const k2 = a2 / ((2 * R + 1) * (2 * R + 1));
  const col = new Uint32Array(w); // somme verticali correnti della scala grande
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -R; y <= R; y++) s += H2[Math.min(h - 1, Math.max(0, y)) * w + x];
    col[x] = s;
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const up = (y > 0 ? y - 1 : y) * w;
    const dn = (y < h - 1 ? y + 1 : y) * w;
    const add = Math.min(h - 1, y + R + 1) * w;
    const sub = Math.max(0, y - R) * w;
    for (let x = 0; x < w; x++) {
      const i = o + x;
      const l = L[i];
      const delta = (9 * l - H1[up + x] - H1[i] - H1[dn + x]) * k1 + ((2 * R + 1) * (2 * R + 1) * l - col[x]) * k2;
      col[x] += H2[add + x] - H2[sub + x];
      if (delta > -1 && delta < 1) continue;
      const q = i * 4;
      d[q] += delta; d[q + 1] += delta; d[q + 2] += delta;
    }
  }
  return img;
}

// Maschera di contrasto (unsharp mask): si aggiunge la differenza dalla luminosità sfocata (media su (2r+1)²).
export function sharpen(img, amount, r = 1) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const L = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) L[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  const T = new Float32Array(n);
  const B = new Float32Array(n);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += L[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      T[o + x] = acc / k;
      acc += L[o + Math.min(w - 1, x + r + 1)] - L[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += T[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      B[y * w + x] = acc / k;
      acc += T[Math.min(h - 1, y + r + 1) * w + x] - T[Math.max(0, y - r) * w + x];
    }
  }
  for (let j = 0; j < n; j++) {
    const delta = (L[j] - B[j]) * amount;
    if (delta > -1 && delta < 1) continue;
    const i = j * 4;
    d[i] += delta; d[i + 1] += delta; d[i + 2] += delta;
  }
  return img;
}
