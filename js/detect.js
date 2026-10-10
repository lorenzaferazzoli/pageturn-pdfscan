// Riconoscimento della pagina su un'immagine piccola in scala di grigi.
// Idea: la carta è la regione chiara più grande; se ne prendono i 4 angoli.
import { otsu } from './proc.js';

// gray: Uint8Array w×h. Restituisce { quad (normalizzato TL,TR,BR,BL), score } oppure null.
export function detectQuad(gray, w, h) {
  const n = w * h;
  // Sfocatura 3×3 per togliere rumore e testo minuto.
  const b = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const Y = y + dy;
        if (Y < 0 || Y >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx;
          if (X < 0 || X >= w) continue;
          s += gray[Y * w + X]; c++;
        }
      }
      b[y * w + x] = s / c;
    }
  }
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[b[i]]++;
  const t = otsu(hist, n);
  // Troppo poco contrasto tra carta e sfondo: niente da rilevare.
  let lo = 0; let hi = 0; let nl = 0; let nh = 0;
  for (let i = 0; i < 256; i++) {
    if (i <= t) { lo += i * hist[i]; nl += hist[i]; } else { hi += i * hist[i]; nh += hist[i]; }
  }
  if (!nl || !nh || hi / nh - lo / nl < 28) return null;

  // Chiusura morfologica leggera: le righe di testo non devono spezzare la pagina.
  let bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = b[i] > t ? 1 : 0;
  bin = erode(dilate(bin, w, h), w, h);

  // Componente connessa più grande.
  const lab = new Int32Array(n);
  const stack = new Int32Array(n);
  let best = -1;
  let bestSize = 0;
  let label = 0;
  for (let i = 0; i < n; i++) {
    if (!bin[i] || lab[i]) continue;
    label++;
    let sp = 0;
    stack[sp++] = i;
    lab[i] = label;
    let size = 0;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      if (x > 0 && bin[p - 1] && !lab[p - 1]) { lab[p - 1] = label; stack[sp++] = p - 1; }
      if (x < w - 1 && bin[p + 1] && !lab[p + 1]) { lab[p + 1] = label; stack[sp++] = p + 1; }
      if (p >= w && bin[p - w] && !lab[p - w]) { lab[p - w] = label; stack[sp++] = p - w; }
      if (p < n - w && bin[p + w] && !lab[p + w]) { lab[p + w] = label; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; best = label; }
  }
  const frac = bestSize / n;
  if (frac < 0.12 || frac > 0.985) return null;

  // Angoli: punti estremi lungo le diagonali, provati con due orientamenti.
  const cand = [cornersAt(lab, best, w, h, 0), cornersAt(lab, best, w, h, Math.PI / 4)];
  let q = null;
  let qa = 0;
  for (const c of cand) {
    if (!c) continue;
    const a = area(c);
    if (a > qa) { qa = a; q = c; }
  }
  if (!q || !convex(q)) return null;
  const fill = bestSize / qa; // quanto la regione riempie il quadrilatero
  if (fill < 0.82 || minAngle(q) < 50) return null;
  return { quad: q.map(([x, y]) => [x / w, y / h]), score: Math.min(1, fill) };
}

function dilate(s, w, h) {
  const o = new Uint8Array(s.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      o[i] = s[i] || (x > 0 && s[i - 1]) || (x < w - 1 && s[i + 1]) || (y > 0 && s[i - w]) || (y < h - 1 && s[i + w]) ? 1 : 0;
    }
  }
  return o;
}

function erode(s, w, h) {
  const o = new Uint8Array(s.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      o[i] = s[i] && (x === 0 || s[i - 1]) && (x === w - 1 || s[i + 1]) && (y === 0 || s[i - w]) && (y === h - 1 || s[i + w]) ? 1 : 0;
    }
  }
  return o;
}

function cornersAt(lab, L, w, h, rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  // Quattro direzioni diagonali ruotate di rot.
  const dirs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([dx, dy]) => [dx * c - dy * s, dx * s + dy * c]);
  const best = [-Infinity, -Infinity, -Infinity, -Infinity];
  const pts = [null, null, null, null];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lab[y * w + x] !== L) continue;
      for (let k = 0; k < 4; k++) {
        const v = x * dirs[k][0] + y * dirs[k][1];
        if (v > best[k]) { best[k] = v; pts[k] = [x + 0.5, y + 0.5]; }
      }
    }
  }
  if (pts.some((p) => !p)) return null;
  return orderQuad(pts);
}

// Ordina 4 punti come TL, TR, BR, BL.
export function orderQuad(p) {
  const cx = p.reduce((a, q) => a + q[0], 0) / 4;
  const cy = p.reduce((a, q) => a + q[1], 0) / 4;
  const s = [...p].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // atan2 ordina da -π: il primo è in alto a sinistra circa; ruota finché TL = min(x+y).
  let k = 0;
  for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[k][0] + s[k][1]) k = i;
  return [s[k], s[(k + 1) % 4], s[(k + 2) % 4], s[(k + 3) % 4]];
}

export function area(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (!z) continue;
    if (!sign) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

function minAngle(q) {
  let m = 180;
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4];
    const b = q[i];
    const c = q[(i + 1) % 4];
    const v1 = [a[0] - b[0], a[1] - b[1]];
    const v2 = [c[0] - b[0], c[1] - b[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
    m = Math.min(m, (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
  }
  return m;
}

// Differenza media tra due immagini piccole in grigio (0–255).
export function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i += 2) s += Math.abs(a[i] - b[i]);
  return (s * 2) / a.length;
}

export function quadDelta(a, b) {
  if (!a || !b) return 1;
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}
