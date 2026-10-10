// Distendi (pagine curve), in tre passi:
//  1. UVDoc stima una griglia di 45×31 punti: dove cade nella foto ogni punto della pagina distesa.
//  2. I punti, presi uno per uno, tremano un po' e le righe vengono ondulate: si sostituiscono con una
//     superficie liscia (B-spline: morbida lungo la riga, quasi dritta lungo l'altezza, come un foglio
//     piegato verso la rilegatura).
//  3. Si seguono le righe di testo della pagina distesa e si corregge quel che resta storto con un
//     campo di spostamento liscio. Senza testo questo passo non fa nulla.
// Poi si campiona la foto a piena risoluzione. Tutte le coordinate della foto sono normalizzate (0..1),
// così lo stesso modello vale per l'anteprima e per la pagina finale.

export const IW = 488;
export const IH = 712;
export const GW = 31;
export const GH = 45;

// ---------- B-spline uniformi agli estremi ("clamped") ----------
const knotCache = new Map();
function knots(K, d) {
  const k = `${K}|${d}`;
  let kn = knotCache.get(k);
  if (!kn) {
    const inner = K - d - 1;
    kn = new Float64Array(K + d + 1);
    for (let i = 0; i <= K + d; i++) kn[i] = i <= d ? 0 : i >= K ? 1 : (i - d) / (inner + 1);
    knotCache.set(k, kn);
  }
  return kn;
}
const scratch = new Float64Array(64);
// valori delle K funzioni di base in t (0..1), scritti in out
function basis(K, d, t, out) {
  const kn = knots(K, d);
  const n = K + d;
  const N = scratch;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 0; i < n; i++) N[i] = kn[i] <= t && t < kn[i + 1] ? 1 : 0;
  if (t >= 1) {
    for (let i = 0; i < n; i++) N[i] = 0;
    let i = n - 1;
    while (i > 0 && kn[i] === kn[i + 1]) i--;
    N[i] = 1;
  }
  for (let p = 1; p <= d; p++) {
    for (let i = 0; i < n - p; i++) {
      let v = 0;
      const a = kn[i + p] - kn[i];
      if (a > 0) v += ((t - kn[i]) / a) * N[i];
      const b = kn[i + p + 1] - kn[i + 1];
      if (b > 0) v += ((kn[i + p + 1] - t) / b) * N[i + 1];
      N[i] = v;
    }
  }
  for (let i = 0; i < K; i++) out[i] = N[i];
  return out;
}
const deg = (K) => Math.min(3, K - 1);

// ---------- piccola algebra ----------
function solveSym(M, b, n) {
  // eliminazione di Gauss con pivot parziale; M (n×n) e b vengono modificati
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    const dg = M[c * n + c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / dg;
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / (M[r * n + r] || 1e-12);
  }
  return x;
}

// pseudo-inversa (BᵀB)⁻¹Bᵀ di una matrice di base n×K valutata in n punti equidistanti
function pinvBasis(n, K) {
  const d = deg(K);
  const B = new Float64Array(n * K);
  const row = new Float64Array(K);
  for (let i = 0; i < n; i++) { basis(K, d, i / (n - 1), row); B.set(row, i * K); }
  const P = new Float64Array(K * n);
  for (let j = 0; j < n; j++) {
    const M = new Float64Array(K * K);
    for (let a = 0; a < K; a++) for (let c = 0; c < K; c++) { let s = 0; for (let i = 0; i < n; i++) s += B[i * K + a] * B[i * K + c]; M[a * K + c] = s; }
    const e = new Float64Array(K);
    for (let a = 0; a < K; a++) e[a] = B[j * K + a];
    const x = solveSym(M, e, K);
    for (let a = 0; a < K; a++) P[a * n + j] = x[a];
  }
  return { B, P };
}

// ---------- 1. ingresso per UVDoc ----------
// La foto attorno alla pagina, ridotta a 488×712 con la media dei pixel, scura fuori dal quadrilatero.
export function uvInput(src, q) {
  const { width: W, height: H, data: d } = src;
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const m = 0.04 * Math.max(W, H);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - m));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - m));
  const x1 = Math.min(W, Math.ceil(Math.max(...xs) + m));
  const y1 = Math.min(H, Math.ceil(Math.max(...ys) + m));
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);
  const n = IW * IH;
  const x = new Float32Array(3 * n);
  const inside = (px, py) => {
    let sgn = 0;
    for (let j = 0; j < 4; j++) {
      const [ax, ay] = q[j];
      const [bx, by] = q[(j + 1) % 4];
      const z = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (!z) continue;
      if (!sgn) sgn = Math.sign(z);
      else if (Math.sign(z) !== sgn) return false;
    }
    return true;
  };
  const kx = bw / IW;
  const ky = bh / IH;
  for (let ty = 0; ty < IH; ty++) {
    const sy0 = y0 + ty * ky;
    const ya = Math.min(H - 1, Math.floor(sy0));
    const yb = Math.min(H, Math.max(ya + 1, Math.ceil(sy0 + ky)));
    for (let tx = 0; tx < IW; tx++) {
      const i = ty * IW + tx;
      const sx0 = x0 + tx * kx;
      if (!inside(sx0 + kx / 2, sy0 + ky / 2)) { x[i] = 0.15; x[n + i] = 0.13; x[2 * n + i] = 0.12; continue; }
      const xa = Math.min(W - 1, Math.floor(sx0));
      const xb = Math.min(W, Math.max(xa + 1, Math.ceil(sx0 + kx)));
      let r = 0; let g = 0; let b = 0; let c = 0;
      for (let yy = ya; yy < yb; yy++) {
        for (let xx = xa; xx < xb; xx++) {
          const o = (yy * W + xx) * 4;
          r += d[o]; g += d[o + 1]; b += d[o + 2]; c++;
        }
      }
      const f = 1 / (255 * c);
      x[i] = r * f; x[n + i] = g * f; x[2 * n + i] = b * f;
    }
  }
  return { x, box: [x0, y0, bw, bh] };
}

// Uscita di UVDoc (2×45×31, coordinate -1..1 dell'ingresso) → punti della foto normalizzati 0..1.
export function uvGrid(out, box, W, H) {
  const [x0, y0, bw, bh] = box;
  const n = GW * GH;
  const G = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const px = ((out[i] + 1) / 2) * (IW - 1);
    const py = ((out[n + i] + 1) / 2) * (IH - 1);
    G[i] = (x0 + ((px + 0.5) * bw) / IW) / W;
    G[n + i] = (y0 + ((py + 0.5) * bh) / IH) / H;
  }
  return G;
}

// ---------- 2. superficie liscia ----------
function fitOnce(G, Ku, Kv) {
  const u = pinvBasis(GW, Ku);
  const v = pinvBasis(GH, Kv);
  const n = GW * GH;
  const C = [new Float64Array(Kv * Ku), new Float64Array(Kv * Ku)];
  let err = 0;
  for (let ch = 0; ch < 2; ch++) {
    const g = G.subarray(ch * n, (ch + 1) * n);
    // T = Pv · G  (Kv × GW)
    const T = new Float64Array(Kv * GW);
    for (let b = 0; b < Kv; b++) for (let j = 0; j < GW; j++) { let s = 0; for (let i = 0; i < GH; i++) s += v.P[b * GH + i] * g[i * GW + j]; T[b * GW + j] = s; }
    // C = T · Puᵀ  (Kv × Ku)
    const c = C[ch];
    for (let b = 0; b < Kv; b++) for (let a = 0; a < Ku; a++) { let s = 0; for (let j = 0; j < GW; j++) s += T[b * GW + j] * u.P[a * GW + j]; c[b * Ku + a] = s; }
    for (let i = 0; i < GH; i++) {
      for (let j = 0; j < GW; j++) {
        let s = 0;
        for (let b = 0; b < Kv; b++) for (let a = 0; a < Ku; a++) s += v.B[i * Kv + b] * c[b * Ku + a] * u.B[j * Ku + a];
        err += (s - g[i * GW + j]) ** 2;
      }
    }
  }
  return { Ku, Kv, C, err: Math.sqrt(err / n) };
}

// Morbida lungo le righe (6 punti di controllo), quasi dritta lungo l'altezza (3): la piega della
// rilegatura è verticale. Se la pagina è girata di lato vale il contrario, e si sceglie quella che sta
// meglio ai punti.
export function fitSurface(G) {
  const a = fitOnce(G, 6, 3);
  const b = fitOnce(G, 3, 6);
  return b.err < a.err * 0.8 ? b : a;
}

const bu = new Float64Array(16);
const bv = new Float64Array(16);
// punto della foto (normalizzato) per il punto (u, v) della pagina distesa, 0..1
function surf(m, u, v, out) {
  basis(m.Ku, deg(m.Ku), u, bu);
  basis(m.Kv, deg(m.Kv), v, bv);
  let x = 0;
  let y = 0;
  const cx = m.C[0];
  const cy = m.C[1];
  for (let b = 0; b < m.Kv; b++) {
    const w = bv[b];
    if (!w) continue;
    for (let a = 0; a < m.Ku; a++) {
      const k = w * bu[a];
      if (!k) continue;
      x += cx[b * m.Ku + a] * k;
      y += cy[b * m.Ku + a] * k;
    }
  }
  out[0] = x;
  out[1] = y;
  return out;
}

// ---------- 3. righe di testo ----------
const FX = 10;
const FY = 8;
const fa = new Float64Array(16);
const fb = new Float64Array(16);
function field(f, a, b) {
  basis(FX, 3, a, fa);
  basis(FY, 3, b, fb);
  let s = 0;
  for (let j = 0; j < FY; j++) {
    if (!fb[j]) continue;
    for (let i = 0; i < FX; i++) if (fa[i]) s += f.C[j * FX + i] * fb[j] * fa[i];
  }
  return s > f.lim ? f.lim : s < -f.lim ? -f.lim : s;
}

// Punto della foto per il punto (u, v) della pagina finita: prima le correzioni (l'ultima per prima),
// poi la superficie.
const tmp2 = new Float64Array(2);
export function forward(m, u, v, out = new Float64Array(2)) {
  for (let k = m.fields.length - 1; k >= 0; k--) {
    const f = m.fields[k];
    if (f.axis === 'y') v += field(f, u, v);
    else u += field(f, v, u);
  }
  return surf(m, u, v, out);
}

// Mappa sulla griglia: ogni `step` pixel il punto della foto (in pixel), poi interpolazione bilineare.
function lattice(m, ow, oh, SW, SH, step) {
  // un nodo in più a destra e in basso: l'interpolazione non esce mai dalla griglia
  const LW = Math.floor((ow - 1) / step) + 2;
  const LH = Math.floor((oh - 1) / step) + 2;
  const L = new Float32Array(LW * LH * 2);
  const o = tmp2;
  for (let j = 0; j < LH; j++) {
    const v = Math.min(1, (j * step) / Math.max(1, oh - 1));
    for (let i = 0; i < LW; i++) {
      const u = Math.min(1, (i * step) / Math.max(1, ow - 1));
      forward(m, u, v, o);
      const k = (j * LW + i) * 2;
      L[k] = o[0] * SW - 0.5;
      L[k + 1] = o[1] * SH - 0.5;
    }
  }
  return { L, LW, LH };
}

// Campiona la foto (RGBA) o una sua versione in grigi (1 canale) secondo il modello.
export function renderModel(m, src, ow, oh, { gray = false, step = 4 } = {}) {
  const { width: SW, height: SH, data: sd } = src;
  const { L, LW } = lattice(m, ow, oh, SW, SH, step);
  const out = gray ? new Float32Array(ow * oh) : new Uint8ClampedArray(ow * oh * 4);
  const inv = 1 / step;
  for (let y = 0; y < oh; y++) {
    const j = Math.floor(y * inv);
    const fy = y * inv - j;
    for (let x = 0; x < ow; x++) {
      const i = Math.floor(x * inv);
      const fx = x * inv - i;
      const k00 = (j * LW + i) * 2;
      const k01 = k00 + 2;
      const k10 = k00 + LW * 2;
      const k11 = k10 + 2;
      const sx = (L[k00] * (1 - fx) + L[k01] * fx) * (1 - fy) + (L[k10] * (1 - fx) + L[k11] * fx) * fy;
      const sy = (L[k00 + 1] * (1 - fx) + L[k01 + 1] * fx) * (1 - fy) + (L[k10 + 1] * (1 - fx) + L[k11 + 1] * fx) * fy;
      // bilineare sulla foto
      let ax = Math.floor(sx);
      let ay = Math.floor(sy);
      let tx = sx - ax;
      let ty = sy - ay;
      if (ax < 0) { ax = 0; tx = 0; } else if (ax >= SW - 1) { ax = SW - 2; tx = 1; }
      if (ay < 0) { ay = 0; ty = 0; } else if (ay >= SH - 1) { ay = SH - 2; ty = 1; }
      const p = (ay * SW + ax) * 4;
      const q = p + SW * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w01 = tx * (1 - ty);
      const w10 = (1 - tx) * ty;
      const w11 = tx * ty;
      if (gray) {
        const r = sd[p] * w00 + sd[p + 4] * w01 + sd[q] * w10 + sd[q + 4] * w11;
        const g = sd[p + 1] * w00 + sd[p + 5] * w01 + sd[q + 1] * w10 + sd[q + 5] * w11;
        const b = sd[p + 2] * w00 + sd[p + 6] * w01 + sd[q + 2] * w10 + sd[q + 6] * w11;
        out[y * ow + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      } else {
        const o = (y * ow + x) * 4;
        out[o] = sd[p] * w00 + sd[p + 4] * w01 + sd[q] * w10 + sd[q + 4] * w11;
        out[o + 1] = sd[p + 1] * w00 + sd[p + 5] * w01 + sd[q + 1] * w10 + sd[q + 5] * w11;
        out[o + 2] = sd[p + 2] * w00 + sd[p + 6] * w01 + sd[q + 2] * w10 + sd[q + 6] * w11;
        out[o + 3] = 255;
      }
    }
  }
  return gray ? out : { data: out, width: ow, height: oh };
}

// massimo su una finestra (2r+1) lungo le righe e poi lungo le colonne
function dilate(g, w, h, r) {
  const t = new Float32Array(w * h);
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const a = Math.max(0, x - r);
      const b = Math.min(w - 1, x + r);
      for (let k = a; k <= b; k++) if (g[row + k] > m) m = g[row + k];
      t[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      const a = Math.max(0, y - r);
      const b = Math.min(h - 1, y + r);
      for (let k = a; k <= b; k++) if (t[k * w + x] > m) m = t[k * w + x];
      o[y * w + x] = m;
    }
  }
  return o;
}

// sfocatura gaussiana approssimata con tre medie mobili
function boxBlur1(a, n, stride, count, step, r) {
  const tmp = new Float32Array(n);
  for (let c = 0; c < count; c++) {
    const base = c * step;
    let s = 0;
    for (let k = -r; k <= r; k++) s += a[base + Math.min(n - 1, Math.max(0, k)) * stride];
    for (let i = 0; i < n; i++) {
      tmp[i] = s / (2 * r + 1);
      s += a[base + Math.min(n - 1, i + r + 1) * stride] - a[base + Math.max(0, i - r) * stride];
    }
    for (let i = 0; i < n; i++) a[base + i * stride] = tmp[i];
  }
}
function gauss(g, w, h, sigma) {
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  const a = Float32Array.from(g);
  for (let p = 0; p < 3; p++) {
    boxBlur1(a, w, 1, h, w, r);
    boxBlur1(a, h, w, w, 1, r);
  }
  return a;
}
function gauss1(p, sigma) {
  const r = Math.ceil(sigma * 3);
  const k = [];
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp((-i * i) / (2 * sigma * sigma)); k.push(v); s += v; }
  const o = new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) {
    let v = 0;
    for (let j = -r; j <= r; j++) v += p[Math.min(p.length - 1, Math.max(0, i + j))] * k[j + r];
    o[i] = v / s;
  }
  return o;
}

function peaks(p, minH, dist) {
  const c = [];
  for (let i = 1; i < p.length - 1; i++) if (p[i] >= minH && p[i] > p[i - 1] && p[i] >= p[i + 1]) c.push(i);
  c.sort((a, b) => p[b] - p[a]);
  const keep = [];
  for (const i of c) if (keep.every((k) => Math.abs(k - i) >= dist)) keep.push(i);
  keep.sort((a, b) => a - b);
  return keep.map((i) => {
    const d = p[i - 1] - 2 * p[i] + p[i + 1];
    return i + (d ? (0.5 * (p[i - 1] - p[i + 1])) / d : 0);
  });
}

const NS = 24;
// Tratti di riga: per ogni striscia verticale i picchi dell'inchiostro, uniti con la striscia accanto.
export function trackLines(g, w, h) {
  const bg = gauss(dilate(g, w, h, 7), w, h, 10);
  const ink = new Float32Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = Math.max(0, (bg[i] - g[i]) / Math.max(bg[i], 1) - 0.18);
  const sw = w / NS;
  const cols = [];
  for (let s = 0; s < NS; s++) {
    const cx = (s + 0.5) * sw;
    const a = Math.floor(Math.max(0, cx - sw));
    const b = Math.floor(Math.min(w, cx + sw));
    const p = new Float64Array(h);
    for (let y = 0; y < h; y++) { let v = 0; const r = y * w; for (let x = a; x < b; x++) v += ink[r + x]; p[y] = v; }
    const ps = gauss1(p, 3);
    let mx = 0;
    for (let y = 0; y < h; y++) if (ps[y] > mx) mx = ps[y];
    cols.push(mx > 0 ? peaks(ps, mx * 0.2, 6) : []);
  }
  const diffs = [];
  for (const c of cols) if (c.length > 3) for (let i = 1; i < c.length; i++) diffs.push(c[i] - c[i - 1]);
  if (!diffs.length) return { segs: [], sp: 0 };
  diffs.sort((a, b) => a - b);
  const sp = diffs[diffs.length >> 1];
  const used = cols.map((c) => new Uint8Array(c.length));
  const nearest = (c, y) => { let j = 0; for (let k = 1; k < c.length; k++) if (Math.abs(c[k] - y) < Math.abs(c[j] - y)) j = k; return j; };
  const segs = [];
  for (let s = 0; s < NS; s++) {
    for (let i = 0; i < cols[s].length; i++) {
      if (used[s][i]) continue;
      used[s][i] = 1;
      let y = cols[s][i];
      const pts = [[(s + 0.5) * sw, y]];
      let slope = 0;
      for (let t = s + 1; t < NS && cols[t].length; t++) {
        const c = cols[t];
        const j = nearest(c, y + slope);
        if (used[t][j] || Math.abs(c[j] - (y + slope)) > sp * 0.25) break;
        const prev = cols[t - 1];
        if (nearest(prev, c[j]) !== nearest(prev, y)) break;
        slope = 0.6 * slope + 0.4 * (c[j] - y);
        y = c[j];
        used[t][j] = 1;
        pts.push([(t + 0.5) * sw, y]);
      }
      if (pts.length >= 5) segs.push(pts);
    }
  }
  return { segs, sp };
}

// Campo liscio dy(x, y) che porta ogni tratto all'altezza media: righe dritte e orizzontali.
export function correctionField(segs, w, h, sp, lam = 0.02) {
  const X = [];
  const Y = [];
  const D = [];
  for (const s of segs) {
    let ym = 0;
    for (const p of s) ym += p[1];
    ym /= s.length;
    for (const [x, y] of s) {
      if (Math.abs(y - ym) >= sp * 0.6) continue;
      X.push(x / w); Y.push(ym / h); D.push((y - ym) / h);
    }
  }
  const N = D.length;
  if (N < 40) return null;
  const n = FX * FY;
  const A = new Float64Array(N * n);
  for (let k = 0; k < N; k++) {
    basis(FX, 3, X[k], fa);
    basis(FY, 3, Y[k], fb);
    for (let j = 0; j < FY; j++) for (let i = 0; i < FX; i++) A[k * n + j * FX + i] = fb[j] * fa[i];
  }
  // regolarizzazione: differenze seconde tra coefficienti vicini
  const R = new Float64Array(n * n);
  const addRow = (i0, i1, i2) => {
    const idx = [i0, i1, i2];
    const val = [1, -2, 1];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) R[idx[a] * n + idx[b]] += val[a] * val[b];
  };
  for (let j = 0; j < FY; j++) for (let i = 1; i < FX - 1; i++) addRow(j * FX + i - 1, j * FX + i, j * FX + i + 1);
  for (let i = 0; i < FX; i++) for (let j = 1; j < FY - 1; j++) addRow((j - 1) * FX + i, j * FX + i, (j + 1) * FX + i);
  const solveW = (wt) => {
    const M = new Float64Array(n * n);
    const b = new Float64Array(n);
    for (let k = 0; k < N; k++) {
      const row = k * n;
      const wk = wt[k];
      for (let a = 0; a < n; a++) {
        const va = A[row + a] * wk;
        if (!va) continue;
        b[a] += va * D[k];
        for (let c = 0; c < n; c++) M[a * n + c] += va * A[row + c];
      }
    }
    for (let a = 0; a < n * n; a++) M[a] += lam * N * R[a];
    for (let a = 0; a < n; a++) M[a * n + a] += 1e-3 * N;
    return solveSym(M, b, n);
  };
  let C = solveW(new Float64Array(N).fill(1));
  // seconda passata: i punti lontani contano meno
  const res = new Float64Array(N);
  for (let k = 0; k < N; k++) { let s = 0; for (let a = 0; a < n; a++) s += A[k * n + a] * C[a]; res[k] = s - D[k]; }
  const sorted = Array.from(res, Math.abs).sort((a, b) => a - b);
  const sc = 1.4826 * sorted[N >> 1] + 1e-9;
  C = solveW(Float64Array.from(res, (r) => 1 / Math.max(1, Math.abs(r) / (2.5 * sc))));
  return { C, lim: sp / h, n: N };
}

// Altezza su cui si cercano le righe (indipendente dalla risoluzione dell'uscita).
const AH = 1000;
function analysisSize(aspect) {
  const w = Math.max(200, Math.round(AH * aspect));
  return [w, AH];
}
function transpose(g, w, h) {
  const t = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[x * h + y] = g[y * w + x];
  return t;
}

// Foto ridotta di un fattore intero (media dei pixel), per cercare le righe senza scalettature.
function reduce(src, f) {
  const { width: W, height: H, data: d } = src;
  const w = Math.floor(W / f);
  const h = Math.floor(H / f);
  const o = new Uint8ClampedArray(w * h * 4);
  const k = 1 / (f * f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let g = 0; let b = 0;
      for (let yy = y * f; yy < y * f + f; yy++) {
        for (let xx = x * f; xx < x * f + f; xx++) { const i = (yy * W + xx) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      }
      const i = (y * w + x) * 4;
      o[i] = r * k; o[i + 1] = g * k; o[i + 2] = b * k; o[i + 3] = 255;
    }
  }
  return { data: o, width: w, height: h };
}

// Modello completo dalla griglia di UVDoc: superficie e correzioni sulle righe di testo.
export function buildModel(G, src, aspect, iters = 2) {
  const m = { ...fitSurface(G), fields: [] };
  const [aw, ah] = analysisSize(aspect);
  // la pagina nella foto è molto più grande dell'immagine di analisi: prima si riduce la foto
  const n = GW * GH;
  let ext = 0;
  for (let j = 0; j < GW; j++) ext = Math.max(ext, Math.abs(G[n + (GH - 1) * GW + j] - G[n + j]) * src.height);
  const f = Math.floor(ext / (1.3 * ah));
  if (f >= 2) src = reduce(src, f);
  let axis = null;
  for (let it = 0; it < iters; it++) {
    const g = renderModel(m, src, aw, ah, { gray: true });
    let tr = null;
    if (axis !== 'x') {
      const t = trackLines(g, aw, ah);
      const f = t.segs.length ? correctionField(t.segs, aw, ah, t.sp) : null;
      if (f) tr = { axis: 'y', f };
    }
    // righe verticali (pagina girata di lato)
    if (!tr && axis !== 'y') {
      const t = trackLines(transpose(g, aw, ah), ah, aw);
      const f = t.segs.length ? correctionField(t.segs, ah, aw, t.sp) : null;
      if (f) tr = { axis: 'x', f };
    }
    if (!tr) break;
    axis = tr.axis;
    m.fields.push({ axis, C: tr.f.C, lim: tr.f.lim });
  }
  return m;
}

// Punto della pagina finita per un punto della foto (normalizzati): Newton partendo da (u0, v0).
export function inverse(m, nx, ny, u0, v0) {
  let u = u0;
  let v = v0;
  const p = new Float64Array(2);
  const pu = new Float64Array(2);
  const pv = new Float64Array(2);
  const e = 1e-4;
  for (let it = 0; it < 30; it++) {
    forward(m, u, v, p);
    const rx = p[0] - nx;
    const ry = p[1] - ny;
    if (rx * rx + ry * ry < 1e-14) break;
    forward(m, u + e, v, pu);
    forward(m, u, v + e, pv);
    const a = (pu[0] - p[0]) / e;
    const b = (pv[0] - p[0]) / e;
    const c = (pu[1] - p[1]) / e;
    const d = (pv[1] - p[1]) / e;
    const det = a * d - b * c || 1e-12;
    u -= (d * rx - b * ry) / det;
    v -= (-c * rx + a * ry) / det;
    u = Math.min(1.2, Math.max(-0.2, u));
    v = Math.min(1.2, Math.max(-0.2, v));
  }
  return [u, v];
}
