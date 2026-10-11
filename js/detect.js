// Riconoscimento della pagina su un'immagine piccola in scala di grigi.
// Idea: la carta è la regione chiara più grande; se ne prendono i 4 angoli.
import { otsu, homography } from './proc.js';

// gray: Uint8Array w×h. Restituisce oppure null:
//   quad: la pagina da usare (TL,TR,BR,BL normalizzati); full: tutta la regione chiara;
//   spine: la piega del libro aperto, se c'è; halves: [sinistra, destra] divise lungo la piega.
// fast: per il mirino dal vivo; se la regione chiara dà già una pagina convincente non si cercano le rette.
// spine: false per non cercare la piega (mirino).
export function detectQuad(gray, w, h, { fast = false, spine = true } = {}) {
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
  const regionOk0 = nl && nh && hi / nh - lo / nl >= 28;
  // dal vivo basta la regione chiara (come prima): le rette e la piega si cercano allo scatto
  if (fast) {
    const rq0 = regionOk0 ? regionQuad(b, w, h, t) : null;
    return rq0 && convex(rq0) && minAngle(rq0) >= 50 ? finish(b, w, h, rq0, 1, false) : null;
  }
  // Per i bordi si sfoca di più: le righe di testo diventano una macchia grigia, i bordi della pagina restano.
  const r = Math.max(1, Math.round(Math.max(w, h) / 140));
  const bb = boxBlur(boxBlur(b, w, h, r), w, h, r);
  const edges = sobel(bb, w, h);
  const regionOk = nl && nh && hi / nh - lo / nl >= 28;
  const rq = regionOk ? regionQuad(b, w, h, t) : null;
  // si tiene il quadrilatero con più bordi "veri" sotto i lati e carta più chiara all'interno
  let q = null;
  let qs = 0;
  if (rq && convex(rq) && minAngle(rq) >= 50) { q = rq; qs = scoreQuad(edges, bb, w, h, rq, 28); }
  if (!fast || qs < 0.6) {
    // prima una stima rapida su pochi punti, poi il calcolo completo solo sui migliori
    const cands = houghQuads(edges, w, h, rq)
      .filter((c) => convex(c) && minAngle(c) >= 50)
      .map((c) => [scoreQuad(edges, bb, w, h, c, 10), c])
      .sort((x, y) => y[0] - x[0])
      .slice(0, 24);
    for (const [, c] of cands) {
      const sc = scoreQuad(edges, bb, w, h, c, 28);
      if (sc > qs) { qs = sc; q = c; }
    }
  }
  if (!q || qs < 0.38) return null;
  return finish(b, w, h, q, qs, spine);
}

// Regione chiara più grande (la carta su uno sfondo più scuro) e suoi angoli.
function regionQuad(b, w, h, t) {
  const n = w * h;

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
  return q;
}

function finish(b, w, h, q, fill, spineSearch = true) {
  const norm = (pts) => pts.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
  const full = norm(q);

  // Libro aperto: si cerca la piega tra le due pagine.
  const sp = spineSearch ? findSpine(b, w, h, q) : null;
  let quad = full;
  let halves = null;
  let spine = null;
  const spineScore = sp ? sp.score : 0;
  if (sp) {
    spine = norm(sp.line);
    halves = [norm([q[0], sp.line[0], sp.line[1], q[3]]), norm([sp.line[0], q[1], q[2], sp.line[1]])];
    // Con lo scatto singolo si tiene la pagina intera: quella più larga, se l'altra si vede solo in parte.
    if (sp.f < 0.42) quad = halves[1];
    else if (sp.f > 0.58) quad = halves[0];
  }
  return { quad, full, spine, halves, spineScore, score: Math.min(1, fill) };
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
  // Luminosità della sola carta per colonna (un percentile alto: il testo non conta).
  const pap = new Float32Array(RW);
  const col = new Float32Array(v1 - v0);
  for (let u = 0; u < RW; u++) {
    for (let v = v0; v < v1; v++) col[v - v0] = r[v * RW + u];
    col.sort();
    pap[u] = col[Math.floor(col.length * 0.92)];
  }
  const lo = Math.round(RW * 0.06);
  const hi = Math.round(RW * 0.94);
  const win = Math.round(RW * 0.1);
  // salto della carta in u (le due pagine prendono luce diversa), al netto di una luce che cala
  // piano piano da un lato all'altro: quattro tratti accanto (a b | c d), il salto tra b e c meno
  // la pendenza dei tratti esterni
  const med = (a, b) => {
    const v = [];
    for (let k = Math.max(0, a); k <= Math.min(RW - 1, b); k++) v.push(pap[k]);
    v.sort((x, y) => x - y);
    return v.length ? v[v.length >> 1] : 0;
  };
  const paperJump = (u) => {
    const a = med(u - 13, u - 8);
    const b = med(u - 7, u - 2);
    const c = med(u + 2, u + 7);
    const d = med(u + 8, u + 13);
    return Math.abs(c - b - (b - a + (d - c)) / 2);
  };
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
    // Un bordo continuo da solo non basta: anche il margine di una colonna di testo giustificato è
    // netto e continuo dall'alto in basso. La piega in più ha una linea d'ombra (valle), oppure un
    // bordo nettissimo in tutte e due le metà, oppure carta di luce diversa ai due lati.
    const cont = (t > 0.55 && bt > 0.5) || (b2 > 0.55 && tt > 0.5);
    const strong = (t >= 0.85 && bt >= 0.85) || (b2 >= 0.85 && tt >= 0.85);
    const oneSide = step > 5 && ((t > 0.8 && bt > 0.3) || (b2 > 0.8 && tt > 0.3));
    const edge = (cont || oneSide) && (valley >= 6.5 || strong || paperJump(u) > 14);
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
  return { line: [map(uAt(0) + 0.5, 0), map(uAt(RH) + 0.5, RH)], f: (uAt(RH / 2) + 0.5) / RW, score: bestScore };
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

// ---------- bordi dritti (trasformata di Hough) ----------

// Gradienti di Sobel (divisi per 4: valori comparabili ai livelli di grigio).
function sobel(g, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const m = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1]; const b = g[i - w]; const c = g[i - w + 1];
      const d = g[i - 1]; const f = g[i + 1];
      const p = g[i + w - 1]; const q = g[i + w]; const r = g[i + w + 1];
      const X = (c + 2 * f + r - a - 2 * d - p) / 4;
      const Y = (p + 2 * q + r - a - 2 * b - c) / 4;
      gx[i] = X; gy[i] = Y; m[i] = Math.hypot(X, Y);
    }
  }
  return { gx, gy, m };
}

// Rette candidate per i bordi, poi tutte le combinazioni alto/basso/sinistra/destra.
function houghQuads({ gx, gy, m }, w, h, rq) {
  const diag = Math.ceil(Math.hypot(w, h));
  const NT = 180;
  const NR = 2 * diag + 1;
  const acc = new Float32Array(NT * NR);
  const cos = new Float32Array(NT);
  const sin = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { cos[t] = Math.cos((t * Math.PI) / NT); sin[t] = Math.sin((t * Math.PI) / NT); }
  // soglia: i bordi più forti dell'immagine, ma almeno un salto netto
  const hist = new Uint32Array(256);
  for (let i = 0; i < m.length; i++) hist[Math.min(255, m[i] | 0)]++;
  let T = 255;
  for (let acc = 0; T > 0 && acc < m.length * 0.1; T--) acc += hist[T];
  T = Math.max(9, T);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (m[i] < T) continue;
      // si vota solo vicino alla direzione del gradiente (la normale della retta)
      let t0 = Math.round((Math.atan2(gy[i], gx[i]) * NT) / Math.PI);
      t0 = ((t0 % NT) + NT) % NT;
      for (let dt = -5; dt <= 5; dt++) {
        const t = (t0 + dt + NT) % NT;
        const r = Math.round(x * cos[t] + y * sin[t]) + diag;
        acc[t * NR + r] += m[i];
      }
    }
  }
  // massimi locali
  let max = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > max) max = acc[i];
  const peaks = [];
  for (let t = 0; t < NT; t++) {
    for (let r = 0; r < NR; r++) {
      const v = acc[t * NR + r];
      if (v < max * 0.04) continue;
      let ok = true;
      for (let dt = -4; dt <= 4 && ok; dt++) {
        const tt = (t + dt + NT) % NT;
        const rr0 = t + dt < 0 || t + dt >= NT ? NR - 1 - r : r; // all'altro capo θ e ρ si invertono
        for (let dr = -6; dr <= 6; dr++) {
          const rr = rr0 + dr;
          if (rr < 0 || rr >= NR || (dt === 0 && dr === 0)) continue;
          if (acc[tt * NR + rr] > v) { ok = false; break; }
        }
      }
      if (ok) peaks.push({ t, r: r - diag, v });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const lines = peaks.slice(0, 60).map(({ t, r }) => ({ c: cos[t], s: sin[t], r, deg: (t * 180) / NT }));
  // orizzontali (normale quasi verticale) e verticali
  // rette per due punti, nella stessa forma (normale c,s e distanza r)
  const through = (p, q) => {
    let nx = -(q[1] - p[1]);
    let ny = q[0] - p[0];
    const L = Math.hypot(nx, ny) || 1;
    nx /= L; ny /= L;
    if (ny < 0 || (ny === 0 && nx < 0)) { nx = -nx; ny = -ny; }
    return { c: nx, s: ny, r: p[0] * nx + p[1] * ny, deg: (Math.atan2(ny, nx) * 180) / Math.PI };
  };
  const hor = lines.filter((l) => Math.abs(l.deg - 90) < 35).slice(0, 7);
  const ver = lines.filter((l) => Math.abs(l.deg - 90) > 55).slice(0, 7);
  // anche i lati della regione chiara e i bordi dell'immagine (pagina che esce dall'inquadratura)
  if (rq) {
    hor.push(through(rq[0], rq[1]), through(rq[3], rq[2]));
    ver.push(through(rq[0], rq[3]), through(rq[1], rq[2]));
  }
  hor.push(through([0, 1], [w, 1]), through([0, h - 2], [w, h - 2]));
  ver.push(through([1, 0], [1, h]), through([w - 2, 0], [w - 2, h]));
  const yAt = (l, x) => (l.r - x * l.c) / l.s;
  const xAt = (l, y) => (l.r - y * l.s) / l.c;
  const inter = (a, b) => {
    const det = a.c * b.s - a.s * b.c;
    if (Math.abs(det) < 1e-6) return null;
    return [(a.r * b.s - b.r * a.s) / det, (a.c * b.r - b.c * a.r) / det];
  };
  const out = [];
  for (let i = 0; i < hor.length; i++) {
    for (let j = i + 1; j < hor.length; j++) {
      let [top, bot] = [hor[i], hor[j]];
      if (yAt(top, w / 2) > yAt(bot, w / 2)) [top, bot] = [bot, top];
      if (yAt(bot, w / 2) - yAt(top, w / 2) < h * 0.42) continue;
      for (let k = 0; k < ver.length; k++) {
        for (let l = k + 1; l < ver.length; l++) {
          let [lef, rig] = [ver[k], ver[l]];
          if (xAt(lef, h / 2) > xAt(rig, h / 2)) [lef, rig] = [rig, lef];
          if (xAt(rig, h / 2) - xAt(lef, h / 2) < w * 0.3) continue;
          const q = [inter(top, lef), inter(top, rig), inter(bot, rig), inter(bot, lef)];
          if (q.some((p) => !p || p[0] < -w * 0.05 || p[0] > w * 1.05 || p[1] < -h * 0.05 || p[1] > h * 1.05)) continue;
          const d = (p, o) => Math.hypot(p[0] - o[0], p[1] - o[1]);
          if (Math.min(d(q[0], q[1]), d(q[3], q[2])) < w * 0.2 || Math.min(d(q[0], q[3]), d(q[1], q[2])) < h * 0.22) continue;
          out.push(q);
        }
      }
    }
  }
  return out;
}

// Punteggio di un quadrilatero: quanta parte dei lati poggia su un bordo vero (gradiente
// perpendicolare al lato), quanto l'interno è più chiaro dell'esterno, quanto è grande.
function scoreQuad({ gx, gy }, g, w, h, q, N = 28) {
  const A = area(q) / (w * h);
  if (A < 0.12 || A > 1.02) return 0;
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const sideE = [];
  let con = 0;
  let conN = 0;
  for (let k = 0; k < 4; k++) {
    const a = q[k];
    const b = q[(k + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let nx = -(b[1] - a[1]) / len;
    let ny = (b[0] - a[0]) / len;
    // normale verso l'esterno
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
    let hit = 0;
    let cnt = 0;
    for (let i = 0; i < N; i++) {
      const tt = 0.06 + (0.88 * i) / (N - 1);
      const px = a[0] + (b[0] - a[0]) * tt;
      const py = a[1] + (b[1] - a[1]) * tt;
      if (px < 3 || py < 3 || px > w - 4 || py > h - 4) continue; // sul bordo dell'immagine: nessuna prova
      cnt++;
      let best = 0;
      for (const o of [-1.5, 0, 1.5]) {
        const X = Math.round(px + nx * o);
        const Y = Math.round(py + ny * o);
        const j = Y * w + X;
        best = Math.max(best, Math.abs(gx[j] * nx + gy[j] * ny));
      }
      if (best > 8) hit++;
      const ix = Math.round(px - nx * 4); const iy = Math.round(py - ny * 4);
      const ox = Math.round(px + nx * 4); const oy = Math.round(py + ny * 4);
      if (ix >= 0 && iy >= 0 && ix < w && iy < h && ox >= 0 && oy >= 0 && ox < w && oy < h) {
        conN++;
        if (g[iy * w + ix] - g[oy * w + ox] > 5) con++;
      }
    }
    sideE.push(cnt >= N * 0.5 ? hit / cnt : 0.3);
  }
  const meanE = sideE.reduce((s, v) => s + v, 0) / 4;
  const minE = Math.min(...sideE);
  const contrast = conN ? con / conN : 0;
  return 0.5 * meanE + 0.15 * minE + 0.25 * contrast + 0.1 * Math.sqrt(Math.min(1, A));
}

function boxBlur(g, w, h, r) {
  const t = new Float32Array(w * h);
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += g[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t[y * w + x] = acc / (2 * r + 1);
      acc += g[y * w + Math.min(w - 1, x + r + 1)] - g[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      o[y * w + x] = acc / (2 * r + 1);
      acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
    }
  }
  return o;
}

// ---------- rifinitura su un'immagine più grande ----------
// Il riconoscimento lavora a 400 px. Qui ogni lato si rimisura su un'immagine più grande (circa 1200 px)
// in tanti punti: per ciascuno si cerca, lungo la perpendicolare, dove la carta finisce (il bordo più
// esterno tra quelli netti), poi una retta robusta per tutti i punti. Per la piega del libro aperto si
// cerca invece la linea d'ombra più scura. Se i punti non bastano o non sono d'accordo, il lato resta
// com'era.
export function refineDetection(gray, w, h, det, { out: OUT = 0.06, inn: INN = 0.025 } = {}) {
  if (!det || !det.full) return det;
  try {
    const g = boxBlur(boxBlur(gray, w, h, 1), w, h, 1);
    const px = (q) => q.map(([x, y]) => [x * w, y * h]);
    const F = px(det.full);
    const diag = Math.hypot(w, h);
    const cx = (F[0][0] + F[1][0] + F[2][0] + F[3][0]) / 4;
    const cy = (F[0][1] + F[1][1] + F[2][1] + F[3][1]) / 4;
    const at = (x, y) => {
      if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return -1;
      const X = Math.floor(x); const Y = Math.floor(y); const fx = x - X; const fy = y - Y; const i = Y * w + X;
      return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
    };
    const B = Math.max(4, Math.round(diag * 0.006));
    const lines = [];
    for (let k = 0; k < 4; k++) {
      const A = F[k];
      const C = F[(k + 1) % 4];
      const len = Math.hypot(C[0] - A[0], C[1] - A[1]);
      const d = [(C[0] - A[0]) / len, (C[1] - A[1]) / len];
      let n = [-d[1], d[0]]; // verso l'interno
      if ((cx - A[0]) * n[0] + (cy - A[1]) * n[1] < 0) n = [-n[0], -n[1]];
      const out = Math.round(diag * OUT);
      const inn = Math.round(diag * INN);
      const pts = [];
      const M = 48;
      for (let i = 0; i < M; i++) {
        const t = 0.08 + (0.84 * i) / (M - 1);
        const P = [A[0] + (C[0] - A[0]) * t, A[1] + (C[1] - A[1]) * t];
        // profilo lungo la normale: s < 0 verso l'esterno
        const prof = new Float32Array(out + inn + 2 * B + 6);
        let okp = true;
        for (let j = 0; j < prof.length; j++) {
          const s = j - out - B - 3;
          const v = at(P[0] + n[0] * s, P[1] + n[1] * s);
          if (v < 0) { okp = false; break; }
          prof[j] = v;
        }
        if (!okp) continue; // lato sul bordo della foto: non c'è niente da misurare
        const cs = new Float32Array(prof.length + 1);
        for (let j = 0; j < prof.length; j++) cs[j + 1] = cs[j] + prof[j];
        const mean = (a, b) => (cs[b + 1] - cs[a]) / (b - a + 1);
        const E = new Float32Array(out + inn + 1);
        let emax = 0;
        for (let s = -out; s <= inn; s++) {
          const j = s + out + B + 3;
          const e = mean(j + 2, j + 1 + B) - mean(j - 1 - B, j - 2);
          E[s + out] = e;
          if (e > emax) emax = e;
        }
        if (emax < 12) continue;
        // il bordo più esterno tra quelli forti (il testo e le ombre stanno dentro la pagina)
        let best = -1;
        for (let s = 1; s < E.length - 1; s++) {
          if (E[s] >= Math.max(12, emax * 0.55) && E[s] >= E[s - 1] && E[s] >= E[s + 1]) { best = s; break; }
        }
        if (best < 0) continue;
        const den = E[best - 1] - 2 * E[best] + E[best + 1];
        const sub = best - out + (den ? (0.5 * (E[best - 1] - E[best + 1])) / den : 0);
        pts.push([P[0] + n[0] * sub, P[1] + n[1] * sub]);
      }
      lines.push(robustLine(pts, M, diag));
    }
    const sideLine = (k) => lines[k] || { p: F[k], d: [F[(k + 1) % 4][0] - F[k][0], F[(k + 1) % 4][1] - F[k][1]].map((v, _, a) => v / Math.hypot(...a)) };
    const RF = [];
    for (let k = 0; k < 4; k++) {
      const c = intersect(sideLine((k + 3) % 4), sideLine(k));
      if (!c || Math.hypot(c[0] - F[k][0], c[1] - F[k][1]) > diag * (Math.max(OUT, INN) + 0.01)) return det;
      RF.push(c);
    }
    if (!convex(RF) || minAngle(RF) < 50) return det;
    const norm = (q) => q.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
    const full = norm(RF);
    if (!det.spine) return { ...det, full, quad: det.quad === det.full ? full : full };
    // la piega: linea d'ombra più scura vicino a quella trovata
    const S = px(det.spine);
    const topL = sideLine(0);
    const botL = sideLine(2);
    const sd = [S[1][0] - S[0][0], S[1][1] - S[0][1]];
    const sl = Math.hypot(...sd);
    const sn = [-sd[1] / sl, sd[0] / sl];
    const W = Math.round(diag * 0.03);
    const R = Math.max(3, Math.round(diag * 0.004));
    const spts = [];
    const MS = 32;
    for (let i = 0; i < MS; i++) {
      const t = 0.1 + (0.8 * i) / (MS - 1);
      const P = [S[0][0] + sd[0] * t, S[0][1] + sd[1] * t];
      let bestV = 0;
      let bestS = null;
      for (let s = -W; s <= W; s++) {
        const c0 = at(P[0] + sn[0] * s, P[1] + sn[1] * s);
        if (c0 < 0) { bestS = null; break; }
        let l = 0; let r = 0;
        for (let j = R; j < 3 * R; j++) {
          l += at(P[0] + sn[0] * (s - j), P[1] + sn[1] * (s - j));
          r += at(P[0] + sn[0] * (s + j), P[1] + sn[1] * (s + j));
        }
        const v = Math.min(l, r) / (2 * R) - c0;
        if (v > bestV) { bestV = v; bestS = s; }
      }
      if (bestS !== null && bestV >= 6) spts.push([P[0] + sn[0] * bestS, P[1] + sn[1] * bestS]);
    }
    const spl = robustLine(spts, MS, diag) || { p: S[0], d: [sd[0] / sl, sd[1] / sl] };
    const st = intersect(spl, topL);
    const sb = intersect(spl, botL);
    if (!st || !sb) return { ...det, full };
    const spine = norm([st, sb]);
    const halves = [norm([RF[0], st, sb, RF[3]]), norm([st, RF[1], RF[2], sb])];
    const same = (a, b) => a && b && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-9 && Math.abs(p[1] - b[i][1]) < 1e-9);
    const quad = det.halves && same(det.quad, det.halves[0]) ? halves[0] : det.halves && same(det.quad, det.halves[1]) ? halves[1] : full;
    return { ...det, full, spine, halves, quad };
  } catch {
    return det;
  }
}

// Retta per molti punti, togliendo quelli fuori posto; null se non sono abbastanza d'accordo.
function robustLine(pts, M, diag, T = [0.004, 0.002], need = [0.4, 0.35], min = 10) {
  if (pts.length < Math.max(min, M * need[0])) return null;
  let sel = pts;
  let line = fitLine(sel);
  for (const f of T) {
    const dist = (pt) => Math.abs((pt[0] - line.p[0]) * -line.d[1] + (pt[1] - line.p[1]) * line.d[0]);
    const near = sel.filter((pt) => dist(pt) < Math.max(1.2, diag * f));
    if (near.length < Math.max(min, M * need[1])) return null;
    line = fitLine(near);
    sel = near;
  }
  return line;
}

// Retta che passa vicino al maggior numero di punti (si provano le rette per due punti), poi rifinita
// sui punti vicini: i punti sbagliati, anche tanti, non la spostano. null se d'accordo sono pochi.
function votedLine(pts, M, diag, tol = 0.006, need = 0.3) {
  const T = Math.max(1.5, diag * tol);
  const min = Math.max(8, Math.ceil(M * need));
  if (pts.length < min) return null;
  const near = (L, t) => pts.filter((q) => Math.abs((q[0] - L.p[0]) * -L.d[1] + (q[1] - L.p[1]) * L.d[0]) < t);
  let best = null;
  let bestN = 0;
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const dx = pts[b][0] - pts[a][0];
      const dy = pts[b][1] - pts[a][1];
      const l = Math.hypot(dx, dy);
      if (l < diag * 0.05) continue;
      const L = { p: pts[a], d: [dx / l, dy / l] };
      const n = near(L, T).length;
      if (n > bestN) { bestN = n; best = L; }
    }
  }
  if (!best || bestN < min) return null;
  let L = fitLine(near(best, T));
  for (const t of [T, T * 0.7]) {
    const sel = near(L, t);
    if (sel.length < min) break;
    L = fitLine(sel);
  }
  return L;
}

// ---------- bordi a partire da una stima (UVDoc) ----------
// La stima di UVDoc è buona su tre lati, ma in basso scende spesso oltre la pagina (sul resto del
// libro, sulla mano, sul pavimento) e dal lato della piega va spesso sull'altra pagina. Per ogni lato,
// in 48 punti, si guarda la foto lungo la perpendicolare, mediata lungo il lato (così il testo diventa
// un grigio uniforme), e si parte dall'interno della pagina andando verso fuori:
// - il bordo è il primo salto da chiaro a scuro oltre il quale non c'è più carta. Per dire "carta" si
//   usa un valore alto tra i campioni lungo il lato: tra le righe di testo c'è sempre carta bianca,
//   su un muro, un mobile o il resto del libro no. Il confronto è con la carta lì vicino, perché la
//   pagina può essere in ombra;
// - sui lati lunghi, se prima del bordo si incontra una valle stretta con carta da tutte e due le parti
//   e il margine liscio dentro, è la piega in mezzo al libro: si tiene la più profonda.
// Poi una retta per i punti che vanno d'accordo; se un lato non si trova, resta quello della stima.
export function snapQuad(gray, w, h, qn, { out: OUT = 0.03, inn: INN = 0.25 } = {}) {
  const g = boxBlur(boxBlur(gray, w, h, 1), w, h, 1);
  const F = qn.map(([x, y]) => [x * w, y * h]);
  const diag = Math.hypot(w, h);
  const cx = (F[0][0] + F[1][0] + F[2][0] + F[3][0]) / 4;
  const cy = (F[0][1] + F[1][1] + F[2][1] + F[3][1]) / 4;
  const at = (x, y) => {
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return -1;
    const X = Math.floor(x); const Y = Math.floor(y); const fx = x - X; const fy = y - Y; const i = Y * w + X;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  };
  const B = Math.max(4, Math.round(diag * 0.006)); // bande per misurare un salto
  const K = Math.max(8, Math.round(diag * 0.025)); // tratto in cui cercare la carta
  const sideLen = (k) => Math.hypot(F[(k + 1) % 4][0] - F[k][0], F[(k + 1) % 4][1] - F[k][1]);
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const A = F[k];
    const C = F[(k + 1) % 4];
    const len = sideLen(k);
    const d = [(C[0] - A[0]) / len, (C[1] - A[1]) / len];
    let n = [-d[1], d[0]]; // verso l'interno
    if ((cx - A[0]) * n[0] + (cy - A[1]) * n[1] < 0) n = [-n[0], -n[1]];
    let ext = 0;
    for (const P of F) ext = Math.max(ext, (P[0] - A[0]) * n[0] + (P[1] - A[1]) * n[1]);
    // la piega sta su un lato lungo e verticale (la pagina è più alta che larga): sugli altri lati
    // le righe di testo sembrerebbero pieghe
    const fold = len >= 0.9 * Math.max(sideLen((k + 1) % 4), sideLen((k + 3) % 4)) && Math.abs(d[1]) > Math.abs(d[0]);
    const vmax = Math.round(diag * 0.07);
    const out = Math.round(diag * OUT);
    const inn = Math.round(Math.min(diag * INN, ext * 0.45));
    const off = out + K + B + 4;
    const L = off + inn + B + 4;
    const M = 48;
    const hw = (1.5 * 0.84 * len) / (M - 1); // mezza larghezza del tratto mediato lungo il lato
    const nt = Math.max(1, Math.round(hw / 3)); // un campione ogni 3 px circa
    const prof = new Float32Array(L); // media lungo il lato
    const pm = new Float32Array(L); // la carta: un valore alto tra i campioni lungo il lato
    const cs = new Float64Array(L + 1);
    const buf = new Float32Array(2 * nt + 1);
    const pts = [];
    for (let i = 0; i < M; i++) {
      const t = 0.08 + (0.84 * i) / (M - 1);
      const P = [A[0] + (C[0] - A[0]) * t, A[1] + (C[1] - A[1]) * t];
      let first = 0; // i primi campioni possono cadere fuori dalla foto
      let bad = false;
      for (let j = 0; j < L; j++) {
        const s = j - off;
        let sum = 0;
        let c = 0;
        for (let u = -nt; u <= nt; u++) {
          const v = at(P[0] + n[0] * s + (d[0] * u * hw) / nt, P[1] + n[1] * s + (d[1] * u * hw) / nt);
          if (v >= 0) { sum += v; buf[c++] = v; }
        }
        if (c < nt) { if (s < 0) { first = j + 1; continue; } bad = true; break; }
        prof[j] = sum / c;
        const b = buf.subarray(0, c).sort();
        pm[j] = b[Math.floor((c - 1) * 0.8)];
      }
      if (bad) continue;
      for (let j = 0; j < L; j++) cs[j + 1] = cs[j] + prof[j];
      const mean = (a, b) => (cs[b + 1] - cs[a]) / (b - a + 1);
      const max = (a, b) => { let m = 0; for (let j = Math.max(a, first); j <= b; j++) if (pm[j] > m) m = pm[j]; return m; };
      // livello della carta, verso l'interno
      const deep = Array.from(pm.subarray(off + (inn >> 1), off + inn + 1)).sort((x, y) => x - y);
      const Pl = deep[Math.floor(deep.length * 0.9)];
      const dl = Math.max(12, Pl * 0.1);
      const E = (j) => (j - 2 - B < first ? 0 : mean(j + 2, j + 1 + B) - mean(j - 1 - B, j - 2));
      let hit = null;
      let valley = null;
      let vdepth = 0;
      for (let s = inn - B - 2; s > -out; s--) {
        const j = s + off;
        if (j - 3 - K < first) break;
        const e = E(j);
        if (e >= dl && e >= E(j - 1) && e >= E(j + 1)) {
          const lp = Math.min(Pl, max(j + 3, j + 3 + K));
          if (max(j - 3 - K, j - 3) <= lp - Math.max(12, lp * 0.1)) {
            const e0 = E(j - 1); const e2 = E(j + 1); const den = e0 - 2 * e + e2;
            hit = s + (den ? (0.5 * (e0 - e2)) / den : 0);
            break;
          }
        }
        if (!fold || s > vmax) continue;
        const v = pm[j];
        let isMin = true;
        for (let q = j - B; q <= j + B && isMin; q++) if (pm[q] < v) isMin = false;
        if (!isMin) continue;
        const mo = max(j - K, j - 1);
        const depth = Math.min(mo, max(j + 1, j + K)) - v;
        if (depth < Math.max(10, Pl * 0.1) || depth <= vdepth || mo < Pl - 2 * dl) continue;
        // dentro la piega c'è il margine: carta liscia (tolta la pendenza dell'ombra)
        const a = j + B; const b = j + K;
        const ya = (pm[a] + pm[a + 1] + pm[a + 2] + pm[a + 3]) / 4;
        const yb = (pm[b] + pm[b - 1] + pm[b - 2] + pm[b - 3]) / 4;
        let dev = 0;
        for (let q = a; q <= b; q++) dev = Math.max(dev, Math.abs(pm[q] - (ya + ((yb - ya) * (q - a - 1.5)) / (b - a - 3))));
        if (dev > Pl * 0.09) continue;
        const v0 = pm[j - 1]; const v2 = pm[j + 1]; const den = v0 - 2 * v + v2;
        valley = s + (den ? (0.5 * (v0 - v2)) / den : 0);
        vdepth = depth;
      }
      if (valley !== null) hit = valley;
      if (hit !== null) pts.push([P[0] + n[0] * hit, P[1] + n[1] * hit]);
    }
    lines.push(votedLine(pts, M, diag) || { p: A, d });
  }
  const R = [];
  for (let k = 0; k < 4; k++) {
    const c = intersect(lines[(k + 3) % 4], lines[k]);
    if (!c) return qn;
    R.push(c);
  }
  if (!convex(R) || minAngle(R) < 45) return qn;
  return R.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
}

// Libro aperto e piatto: una stima che prende tutte e due le pagine si taglia lungo la piega, e si
// tiene la pagina intera come fa il riconoscimento classico. spine: [alto, basso] normalizzati.
export function splitAtSpine(q, spine) {
  if (!spine) return q;
  const L = (a, b) => ({ p: a, d: [b[0] - a[0], b[1] - a[1]] });
  const sp = L(spine[0], spine[1]);
  const st = intersect(sp, L(q[0], q[1]));
  const sb = intersect(sp, L(q[3], q[2]));
  if (!st || !sb) return q;
  const f = ((st[0] - q[0][0]) / (q[1][0] - q[0][0]) + (sb[0] - q[3][0]) / (q[2][0] - q[3][0])) / 2;
  if (f > 0.1 && f < 0.42) return [st, q[1], q[2], sb];
  if (f > 0.58 && f < 0.9) return [q[0], st, sb, q[3]];
  return q;
}
