// OCR con PaddleOCR PP-OCRv5 (rilevamento delle righe + riconoscimento latino) su ONNX Runtime.
// Nessuna dipendenza dal DOM: riceve l'oggetto `ort` e immagini {data RGBA, width, height}.

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

export async function createPaddle({ ort, det, rec, dict, detSide = 1280 }) {
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const detS = await ort.InferenceSession.create(det, opts);
  const recS = await ort.InferenceSession.create(rec, opts);
  // Come CTCLabelDecode di PaddleOCR: 0 = blank, poi il dizionario, poi lo spazio.
  const lines = dict.replace(/\r/g, '').split('\n').filter((l) => l !== '');
  const chars = ['', ...lines, ' '];

  async function detect(img) {
    const { width: W, height: H, data } = img;
    // anche le pagine piccole vengono portate a detSide: il testo minuto si rileva meglio
    const k = Math.min(2.5, detSide / Math.max(W, H));
    const w = Math.max(32, Math.round((W * k) / 32) * 32);
    const h = Math.max(32, Math.round((H * k) / 32) * 32);
    const sx = W / w;
    const sy = H / h;
    const x = new Float32Array(3 * w * h);
    const plane = w * h;
    // ridimensionamento bilineare + normalizzazione, canali in ordine BGR come in PaddleOCR
    for (let yy = 0; yy < h; yy++) {
      const fy = Math.min(H - 1.001, Math.max(0, (yy + 0.5) * sy - 0.5));
      const y0 = fy | 0;
      const ay = fy - y0;
      for (let xx = 0; xx < w; xx++) {
        const fx = Math.min(W - 1.001, Math.max(0, (xx + 0.5) * sx - 0.5));
        const x0 = fx | 0;
        const ax = fx - x0;
        const i00 = (y0 * W + x0) * 4;
        const i01 = i00 + 4;
        const i10 = i00 + W * 4;
        const i11 = i10 + 4;
        const o = yy * w + xx;
        for (let c = 0; c < 3; c++) {
          const v = (data[i00 + c] * (1 - ax) + data[i01 + c] * ax) * (1 - ay) + (data[i10 + c] * (1 - ax) + data[i11 + c] * ax) * ay;
          const ch = 2 - c; // R→2, G→1, B→0
          x[ch * plane + o] = (v / 255 - DET_MEAN[ch]) / DET_STD[ch];
        }
      }
    }
    const out = await detS.run({ [detS.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, h, w]) });
    const prob = out[detS.outputNames[0]].data;
    return boxes(prob, w, h, sx, sy);
  }

  // Post-elaborazione DB: regioni sopra soglia, orientamento dai momenti, rettangolo ruotato, espansione (unclip).
  // Ogni riquadro: { cx, cy, ux, uy, hw, hh } (centro, direzione della riga, semiassi), in pixel della pagina.
  function boxes(prob, w, h, sx, sy) {
    const n = w * h;
    const lab = new Uint8Array(n);
    const stack = new Int32Array(n);
    const pix = new Int32Array(n);
    const res = [];
    for (let i = 0; i < n; i++) {
      if (prob[i] <= 0.3 || lab[i]) continue;
      let sp = 0;
      let np = 0;
      stack[sp++] = i;
      lab[i] = 1;
      let sum = 0; let mx = 0; let my = 0;
      while (sp) {
        const p = stack[--sp];
        pix[np++] = p;
        const px = p % w;
        const py = (p - px) / w;
        sum += prob[p]; mx += px; my += py;
        if (px > 0 && prob[p - 1] > 0.3 && !lab[p - 1]) { lab[p - 1] = 1; stack[sp++] = p - 1; }
        if (px < w - 1 && prob[p + 1] > 0.3 && !lab[p + 1]) { lab[p + 1] = 1; stack[sp++] = p + 1; }
        if (py > 0 && prob[p - w] > 0.3 && !lab[p - w]) { lab[p - w] = 1; stack[sp++] = p - w; }
        if (py < h - 1 && prob[p + w] > 0.3 && !lab[p + w]) { lab[p + w] = 1; stack[sp++] = p + w; }
      }
      if (np < 10 || sum / np < 0.6) continue;
      const gid = i;
      const r = rectOf(pix, 0, np, w);
      if (!r) continue;
      // Riga curva (vicino alla rilegatura) o due righe unite: troppo alta rispetto allo spessore medio.
      // Si divide lungo la riga in tratti più corti, tagliando dove c'è meno inchiostro.
      const thick = np / r.bw;
      if (r.bh > thick * 2.2 && r.bw > thick * 10) {
        const parts = Math.ceil(r.bw / (thick * 9));
        const us = new Float32Array(np);
        for (let k = 0; k < np; k++) {
          const p = pix[k];
          us[k] = ((p % w) - r.mx) * r.ux + (((p - (p % w)) / w) - r.my) * r.uy;
        }
        const order = Array.from(pix.subarray(0, np)).map((p, k) => [us[k], p]).sort((a1, b1) => a1[0] - b1[0]);
        // istogramma lungo u per trovare i tagli nelle zone vuote
        const L = Math.ceil(r.u1 - r.u0) + 1;
        const hist = new Uint32Array(L);
        for (const [u] of order) hist[Math.min(L - 1, Math.max(0, Math.round(u - r.u0)))]++;
        const cuts = [];
        for (let j = 1; j < parts; j++) {
          const target = (L * j) / parts;
          let best = Math.round(target);
          for (let q = Math.round(target - L / parts / 4); q <= target + L / parts / 4; q++) {
            if (q > 0 && q < L && hist[q] < hist[best]) best = q;
          }
          cuts.push(best + r.u0);
        }
        let k0 = 0;
        const sorted = Int32Array.from(order.map((o) => o[1]));
        for (let j = 0; j <= cuts.length; j++) {
          let k1 = k0;
          while (k1 < np && (j === cuts.length || order[k1][0] < cuts[j])) k1++;
          const sub = rectOf(sorted, k0, k1, w);
          if (sub) pushRect(res, sub, sx, sy, gid);
          k0 = k1;
        }
      } else pushRect(res, r, sx, sy, gid);
    }
    return res;
  }

  // Rettangolo orientato (dai momenti del secondo ordine) dei pixel pix[k0..k1).
  function rectOf(pix, k0, k1, w) {
    const np = k1 - k0;
    if (np < 10) return null;
    let mx = 0; let my = 0;
    for (let k = k0; k < k1; k++) { const p = pix[k]; mx += p % w; my += (p - (p % w)) / w; }
    mx /= np; my /= np;
    let cxx = 0; let cyy = 0; let cxy = 0;
    for (let k = k0; k < k1; k++) {
      const p = pix[k];
      const dx = (p % w) - mx;
      const dy = ((p - (p % w)) / w) - my;
      cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
    }
    let th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    if (Math.abs(th) > Math.PI / 4) th = 0; // riga quasi verticale: si tiene orizzontale
    const ux = Math.cos(th);
    const uy = Math.sin(th);
    let u0 = Infinity; let u1 = -Infinity; let v0 = Infinity; let v1 = -Infinity;
    for (let k = k0; k < k1; k++) {
      const p = pix[k];
      const dx = (p % w) - mx;
      const dy = ((p - (p % w)) / w) - my;
      const u = dx * ux + dy * uy;
      const v = -dx * uy + dy * ux;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const bw = u1 - u0 + 1;
    const bh = v1 - v0 + 1;
    if (Math.min(bw, bh) < 3) return null;
    return { mx, my, ux, uy, u0, u1, v0, v1, bw, bh };
  }

  // Dal rettangolo nella mappa di rilevamento al riquadro in pixel della pagina, con l'espansione di DB.
  function pushRect(res, r, sx, sy, g) {
    const d = (r.bw * r.bh * 1.5) / (2 * (r.bw + r.bh));
    const cu = (r.u0 + r.u1) / 2;
    const cv = (r.v0 + r.v1) / 2;
    const s = (sx + sy) / 2;
    res.push({
      cx: (r.mx + cu * r.ux - cv * r.uy + 0.5) * sx,
      cy: (r.my + cu * r.uy + cv * r.ux + 0.5) * sy,
      ux: r.ux,
      uy: r.uy,
      hw: (r.bw / 2 + d) * s,
      hh: (r.bh / 2 + d) * s,
      g,
    });
  }

  // Riquadro allineato agli assi che contiene il rettangolo ruotato.
  const aabb = (b) => {
    const ex = Math.abs(b.ux) * b.hw + Math.abs(b.uy) * b.hh;
    const ey = Math.abs(b.uy) * b.hw + Math.abs(b.ux) * b.hh;
    return [b.cx - ex, b.cy - ey, b.cx + ex, b.cy + ey];
  };

  // Ritaglio di una riga (rettangolo ruotato) ridimensionato ad altezza 48, normalizzato, in ordine BGR.
  function crop(img, b) {
    const { width: W, height: Hh, data } = img;
    const H = 48;
    const w = Math.max(16, Math.min(3200, Math.ceil((H * b.hw * 1.25) / b.hh)));
    const x = new Float32Array(3 * H * w);
    const plane = H * w;
    const su = (2 * b.hw) / w;
    const sv = (2 * b.hh) / H;
    for (let yy = 0; yy < H; yy++) {
      const v = -b.hh + (yy + 0.5) * sv;
      for (let xx = 0; xx < w; xx++) {
        const u = -b.hw + (xx + 0.5) * su;
        const fx = Math.min(W - 1.001, Math.max(0, b.cx + u * b.ux - v * b.uy - 0.5));
        const fy = Math.min(Hh - 1.001, Math.max(0, b.cy + u * b.uy + v * b.ux - 0.5));
        const x0 = fx | 0;
        const y0 = fy | 0;
        const ax = fx - x0;
        const ay = fy - y0;
        const i00 = (y0 * W + x0) * 4;
        const i01 = i00 + 4;
        const i10 = i00 + W * 4;
        const i11 = i10 + 4;
        const o = yy * w + xx;
        for (let c = 0; c < 3; c++) {
          const val = (data[i00 + c] * (1 - ax) + data[i01 + c] * ax) * (1 - ay) + (data[i10 + c] * (1 - ax) + data[i11 + c] * ax) * ay;
          x[(2 - c) * plane + o] = val / 127.5 - 1;
        }
      }
    }
    return { x, w };
  }

  // Decodifica CTC con la posizione di ogni carattere (serve per i riquadri delle parole).
  // frac: parte della larghezza del tensore occupata da questa riga (le altre sono riempimento).
  function decode(b, p, off, T, C, frac) {
    const seq = [];
    let prev = 0;
    let score = 0;
    for (let i = 0; i < T; i++) {
      let best = 0;
      let bv = -Infinity;
      const o = off + i * C;
      for (let c = 0; c < C; c++) if (p[o + c] > bv) { bv = p[o + c]; best = c; }
      if (best && best !== prev) { seq.push([chars[best] ?? '', i]); score += bv; }
      prev = best;
    }
    const text = seq.map((q) => q[0]).join('');
    const words = [];
    let cur = null;
    for (const [ch, i] of seq) {
      if (ch === ' ') { if (cur) words.push(cur); cur = null; continue; }
      if (!cur) cur = { t: '', a: i, b: i };
      cur.t += ch;
      cur.b = i;
    }
    if (cur) words.push(cur);
    const Te = T * frac;
    const wordBoxes = words.map((wd) => {
      const ua = -b.hw + Math.min(1, wd.a / Te) * 2 * b.hw;
      const ub = -b.hw + Math.min(1, (wd.b + 1) / Te) * 2 * b.hw;
      const sub = { cx: b.cx + ((ua + ub) / 2) * b.ux, cy: b.cy + ((ua + ub) / 2) * b.uy, ux: b.ux, uy: b.uy, hw: (ub - ua) / 2, hh: b.hh * 0.8 };
      return [...aabb(sub), wd.t];
    });
    return { text: text.trim(), score: seq.length ? score / seq.length : 0, words: wordBoxes };
  }

  // Riconoscimento a gruppi di righe di larghezza simile (molto più veloce di una riga alla volta).
  async function recognizeLines(img, list, onProgress) {
    const crops = list.map((b, i) => ({ i, b, ...crop(img, b) })).sort((a, b) => a.w - b.w);
    const out = new Array(list.length);
    const BATCH = 1;
    for (let k = 0; k < crops.length; k += BATCH) {
      const group = crops.slice(k, k + BATCH);
      const wmax = Math.max(320, group[group.length - 1].w); // larghezza minima 320 come in PaddleOCR
      const H = 48;
      const x = new Float32Array(group.length * 3 * H * wmax); // il riempimento resta 0 (grigio medio), come in PaddleOCR
      group.forEach((g, j) => {
        for (let c = 0; c < 3; c++) {
          for (let yy = 0; yy < H; yy++) {
            const src = c * H * g.w + yy * g.w;
            x.set(g.x.subarray(src, src + g.w), j * 3 * H * wmax + c * H * wmax + yy * wmax);
          }
        }
      });
      const res = await recS.run({ [recS.inputNames[0]]: new ort.Tensor('float32', x, [group.length, 3, H, wmax]) });
      const t = res[recS.outputNames[0]];
      const [, T, C] = t.dims;
      group.forEach((g, j) => { out[g.i] = decode(g.b, t.data, j * T * C, T, C, g.w / wmax); });
      onProgress && onProgress(Math.min(1, (k + group.length) / crops.length));
    }
    return out;
  }

  // Risultato nello stesso formato del motore Tesseract: { text, words: [[x0,y0,x1,y1,testo]] }
  async function recognize(img, onProgress) {
    const found = await detect(img);
    // i tratti di una stessa riga curva restano insieme, nell'ordine in cui sono stati tagliati
    const groups = new Map();
    for (const b of found) {
      const r = aabb(b);
      const gr = groups.get(b.g);
      if (gr) { gr.bs.push(b); gr.r = [Math.min(gr.r[0], r[0]), Math.min(gr.r[1], r[1]), Math.max(gr.r[2], r[2]), Math.max(gr.r[3], r[3])]; }
      else groups.set(b.g, { bs: [b], r });
    }
    const bxs = [...groups.values()].sort((a, b) => a.r[1] - b.r[1]);
    // ordine di lettura: per righe (sovrapposizione verticale), poi da sinistra a destra
    const rows = [];
    for (const it of bxs) {
      const [, y0, , y1] = it.r;
      const row = rows.find((r) => Math.min(r.y1, y1) - Math.max(r.y0, y0) > 0.5 * Math.min(r.y1 - r.y0, y1 - y0));
      if (row) row.items.push(it);
      else rows.push({ y0, y1, items: [it] });
    }
    const all = rows.flatMap((r) => r.items.sort((a, b) => a.r[0] - b.r[0]).flatMap((it) => it.bs));
    const recs = await recognizeLines(img, all, onProgress);
    const byBox = new Map(all.map((b, i) => [b, recs[i]]));
    const lines = [];
    for (const r of rows) {
      const parts = [];
      for (const { bs } of r.items) {
        const segs = bs.map((b) => byBox.get(b)).filter((x) => x.text && x.score > 0.5);
        if (segs.length) parts.push({ text: segs.map((x) => x.text).join(' '), words: segs.flatMap((x) => x.words) });
      }
      if (parts.length) lines.push({ parts, y0: r.y0, y1: r.y1 });
    }
    const words = lines.flatMap((l) => l.parts.flatMap((p) => p.words));
    // paragrafi: una riga vuota quando lo spazio tra due righe è molto più grande del solito
    const gaps = lines.slice(1).map((l, i) => l.y0 - lines[i].y1).sort((a, b) => a - b);
    const med = gaps.length ? gaps[gaps.length >> 1] : 0;
    let text = '';
    lines.forEach((l, i) => {
      if (i) text += lines[i].y0 - lines[i - 1].y1 > Math.max(med * 2.2, 6) ? '\n\n' : '\n';
      text += l.parts.map((p) => p.text).join('  ');
    });
    return { text, words };
  }

  return { recognize, detect };
}
