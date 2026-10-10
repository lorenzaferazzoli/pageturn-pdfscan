// Riconoscimento della pagina su un'immagine piccola in scala di grigi.
// Idea: la carta è la regione chiara più grande; se ne prendono i 4 angoli.
import { otsu, homography } from './proc.js';

// gray: Uint8Array w×h. Restituisce oppure null:
//   quad: la pagina da usare (TL,TR,BR,BL normalizzati); full: tutta la regione chiara;
//   spine: la piega del libro aperto, se c'è; halves: [sinistra, destra] divise lungo la piega.
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

  // Angoli iniziali: punti estremi lungo le diagonali, provati con due orientamenti.
  const cand = [cornersAt(lab, best, w, h, 0), cornersAt(lab, best, w, h, Math.PI / 4)];
  let q = null;
  let qa = 0;
  for (const c of cand) {
    if (!c) continue;
    const a = area(c);
    if (a > qa) { qa = a; q = c; }
  }
  if (!q || !convex(q)) return null;
  // Angoli precisi: una retta per ogni bordo, poi le intersezioni. Un dito su un angolo
  // o un angolo smussato non spostano più il punto, perché conta tutto il lato.
  const refined = refineCorners(lab, best, w, h, q);
  if (refined && convex(refined) && minAngle(refined) >= 50) q = refined;
  qa = area(q);
  const fill = bestSize / qa; // quanto la regione riempie il quadrilatero
  if (fill < 0.8 || minAngle(q) < 50) return null;
  const norm = (pts) => pts.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
  const full = norm(q);

  // Libro aperto: si cerca la piega tra le due pagine.
  const sp = findSpine(b, w, h, q);
  let quad = full;
  let halves = null;
  let spine = null;
  if (sp) {
    spine = norm(sp.line);
    halves = [norm([q[0], sp.line[0], sp.line[1], q[3]]), norm([sp.line[0], q[1], q[2], sp.line[1]])];
    // Con lo scatto singolo si tiene la pagina intera: quella più larga, se l'altra si vede solo in parte.
    if (sp.f < 0.42) quad = halves[1];
    else if (sp.f > 0.58) quad = halves[0];
  }
  return { quad, full, spine, halves, score: Math.min(1, fill) };
}

// Bordo della regione: pixel della componente con almeno un vicino fuori.
function boundary(lab, L, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (lab[i] !== L) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || lab[i - 1] !== L || lab[i + 1] !== L || lab[i - w] !== L || lab[i + w] !== L) {
        pts.push([x + 0.5, y + 0.5]);
      }
    }
  }
  return pts;
}

// Retta ai minimi quadrati totali: { p (punto), d (direzione) }.
function fitLine(pts) {
  let mx = 0; let my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let xx = 0; let yy = 0; let xy = 0;
  for (const [x, y] of pts) { xx += (x - mx) ** 2; yy += (y - my) ** 2; xy += (x - mx) * (y - my); }
  const th = 0.5 * Math.atan2(2 * xy, xx - yy);
  return { p: [mx, my], d: [Math.cos(th), Math.sin(th)] };
}

function intersect(a, b) {
  const det = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.abs(det) < 1e-6) return null;
  const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / det;
  return [a.p[0] + t * a.d[0], a.p[1] + t * a.d[1]];
}

function refineCorners(lab, L, w, h, q) {
  const pts = boundary(lab, L, w, h);
  const diag = Math.hypot(w, h);
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const A = q[k];
    const B = q[(k + 1) % 4];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (len < 8) return null;
    const d = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
    const nrm = [-d[1], d[0]];
    // punti vicini al lato, lontani dagli angoli (dove ci sono dita e smussature)
    let sel = pts.filter(([x, y]) => {
      const t = ((x - A[0]) * d[0] + (y - A[1]) * d[1]) / len;
      const dist = Math.abs((x - A[0]) * nrm[0] + (y - A[1]) * nrm[1]);
      return t > 0.12 && t < 0.88 && dist < diag * 0.05;
    });
    if (sel.length < 8) return null;
    let line = fitLine(sel);
    // seconda passata: solo i punti davvero sulla retta (tolgono pieghe, dita, ombre)
    for (const tol of [3, 1.6]) {
      const dist = (pt) => Math.abs((pt[0] - line.p[0]) * -line.d[1] + (pt[1] - line.p[1]) * line.d[0]);
      const near = sel.filter((pt) => dist(pt) < tol);
      if (near.length < 8) break;
      line = fitLine(near);
      sel = near;
    }
    lines.push(line);
  }
  const out = [];
  for (let k = 0; k < 4; k++) {
    const c = intersect(lines[(k + 3) % 4], lines[k]);
    if (!c) return null;
    // il nuovo angolo non può allontanarsi troppo da quello iniziale né uscire dall'immagine
    if (Math.hypot(c[0] - q[k][0], c[1] - q[k][1]) > diag * 0.12) return null;
    if (c[0] < -w * 0.04 || c[0] > w * 1.04 || c[1] < -h * 0.04 || c[1] > h * 1.04) return null;
    out.push(c);
  }
  return out;
}

// Cerca la piega di un libro aperto dentro il quadrilatero q: una linea quasi verticale, continua
// dall'alto in basso (il bordo di una pagina o l'ombra della rilegatura).
// Restituisce { line: [puntoAlto, puntoBasso] in pixel, f: posizione da 0 a 1 } oppure null.
function findSpine(g, w, h, q) {
  const top = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
  const side = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
  const RW = 180;
  const RH = Math.max(90, Math.min(260, Math.round((RW * side) / top)));
  const H = homography(RW, RH, q);
  const r = new Float32Array(RW * RH);
  for (let v = 0; v < RH; v++) {
    for (let u = 0; u < RW; u++) {
      const z = H[6] * u + H[7] * v + H[8];
      const x = Math.min(w - 1, Math.max(0, Math.round((H[0] * u + H[1] * v + H[2]) / z)));
      const y = Math.min(h - 1, Math.max(0, Math.round((H[3] * u + H[4] * v + H[5]) / z)));
      r[v * RW + u] = g[y * w + x];
    }
  }
  // Per ogni colonna: in quante righe c'è un salto netto di luminosità (bordo continuo) e quanto è scura.
  const v0 = Math.round(RH * 0.06);
  const v1 = Math.round(RH * 0.94);
  const half = Math.round((v0 + v1) / 2);
  const cons = (a, b) => {
    const out = new Float32Array(RW);
    for (let u = 2; u < RW - 2; u++) {
      let c = 0;
      for (let v = a; v < b; v++) {
        const o = v * RW;
        let m = 0;
        for (let k = -1; k <= 1; k++) m = Math.max(m, Math.abs(r[o + u + k + 1] - r[o + u + k - 1]));
        if (m > 9) c++;
      }
      out[u] = c / (b - a);
    }
    return out;
  };
  const cAll = cons(v0, v1);
  const cTop = cons(v0, half);
  const cBot = cons(half, v1);
  const lum = new Float32Array(RW);
  for (let u = 0; u < RW; u++) {
    let s = 0;
    for (let v = v0; v < v1; v++) s += r[v * RW + u];
    lum[u] = s / (v1 - v0);
  }
  const lo = Math.round(RW * 0.1);
  const hi = Math.round(RW * 0.9);
  const win = Math.round(RW * 0.1);
  let best = -1;
  let bestScore = 0;
  for (let u = lo; u <= hi; u++) {
    let ml = 0; let mr = 0; let sl = 0; let sr = 0; let nl = 0; let nr = 0;
    for (let k = Math.max(0, u - win); k < u - 2; k++) { ml = Math.max(ml, lum[k]); sl += lum[k]; nl++; }
    for (let k = u + 3; k <= Math.min(RW - 1, u + win); k++) { mr = Math.max(mr, lum[k]); sr += lum[k]; nr++; }
    const valley = Math.max(0, Math.min(ml, mr) - lum[u]);
    const step = Math.abs(sl / Math.max(1, nl) - sr / Math.max(1, nr)); // le due pagine hanno luce diversa
    // bordo continuo in entrambe le metà, oppure una valle d'ombra marcata con un bordo abbastanza continuo
    // la piega può essere inclinata: nell'altra metà si cerca qualche colonna più in là
    const nb = (arr) => { let m = 0; for (let k = Math.max(lo, u - 6); k <= Math.min(hi, u + 6); k++) m = Math.max(m, arr[k]); return m; };
    const t = cTop[u];
    const bt = nb(cBot);
    const b2 = cBot[u];
    const tt = nb(cTop);
    const edge = (t > 0.55 && bt > 0.5) || (b2 > 0.55 && tt > 0.5)
      // bordo molto netto in una metà e debole nell'altra: vale solo se le due parti hanno luminosità diversa
      || (step > 5 && ((t > 0.8 && bt > 0.3) || (b2 > 0.8 && tt > 0.3)));
    const ok = edge || (valley > 14 && cAll[u] > 0.3);
    if (!ok) continue;
    const score = Math.max(t + bt, b2 + tt) / 2 + valley / 40;
    if (score > bestScore) { bestScore = score; best = u; }
  }
  if (best < 0) return null;
  // la piega può essere inclinata: posizione migliore separatamente in alto e in basso
  const near = (arr) => {
    let m = best;
    for (let u = Math.max(lo, best - 7); u <= Math.min(hi, best + 7); u++) if (arr[u] > arr[m]) m = u;
    return m;
  };
  const ut = near(cTop);
  const ub = near(cBot);
  const map = (u, v) => {
    const z = H[6] * u + H[7] * v + H[8];
    return [(H[0] * u + H[1] * v + H[2]) / z, (H[3] * u + H[4] * v + H[5]) / z];
  };
  // dalla metà alta e bassa si estende la retta fino ai bordi superiore e inferiore
  const yt = (v0 + half) / 2;
  const yb = (half + v1) / 2;
  const slope = (ub - ut) / (yb - yt);
  const uAt = (v) => ut + (v - yt) * slope;
  return { line: [map(uAt(0) + 0.5, 0), map(uAt(RH) + 0.5, RH)], f: (uAt(RH / 2) + 0.5) / RW };
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
