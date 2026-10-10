// Esportazione: PDF (con testo ricercabile invisibile), immagini, backup del progetto.
import {
  PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState, beginText, endText,
  setFontAndSize, setTextRenderingMode, TextRenderingMode, setTextMatrix, showText, setCharacterSqueeze,
} from '../vendor/pdf-lib.esm.min.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../vendor/fflate.js';
import * as db from './db.js';
import { resizeImage } from './jobs.js';
import { recognize, terminate, engineKey } from './ocr.js';
import { PROC } from './queue.js';
import { tr } from './i18n.js';

export const QUALITY = {
  low: { maxSide: 1600, quality: 0.65, label: 'Bassa' },
  medium: { maxSide: 2400, quality: 0.82, label: 'Media' },
  high: { maxSide: 2400, quality: 0.92, label: 'Alta' },
};

const PAGE_LONG = 684; // punti tipografici: 9,5 pollici, circa 24 cm
const A4 = [595.28, 841.89];
const MARGIN = 28.35; // 1 cm

async function pageImage(id, q) {
  const proc = await db.getBlob(`${id}:proc`);
  if (!proc) throw new Error(tr('Pagina non ancora elaborata'));
  if (q === 'high') return { blob: proc };
  return resizeImage(proc, QUALITY[q]);
}

async function bytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

// Stima della dimensione del PDF dalle pagine già elaborate.
export async function estimate(project, q) {
  let tot = 0;
  let n = 0;
  for (const id of project.order.slice(0, 12)) {
    const b = await db.getBlob(`${id}:proc`);
    if (b) { tot += b.size; n++; }
  }
  if (!n) return 0;
  const k = q === 'low' ? 0.3 : q === 'high' ? 1 : 0.65;
  return (tot / n) * project.order.length * k;
}

function sanitize(font, s) {
  try {
    font.encodeText(s);
    return s;
  } catch {
    const t = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '');
    return t;
  }
}

// onProgress({ phase: 'ocr'|'pdf', done, total, detail })
export async function buildPdf(project, { quality = 'medium', ocr = true, engine = 'paddle', langs = ['ita', 'eng'], size = 'image', onProgress, signal } = {}) {
  const pages = await db.getPages(project.id);
  const ids = project.order.filter((id) => pages.has(id));
  const total = ids.length;

  if (ocr) {
    const key = engineKey(engine, langs);
    for (let i = 0; i < total; i++) {
      if (signal && signal.aborted) throw new DOMException('annullato', 'AbortError');
      const p = pages.get(ids[i]);
      if (p.ocr && p.ocr.rev === p.rev && p.ocr.langs === key) continue;
      onProgress && onProgress({ phase: 'ocr', done: i, total });
      let proc = await db.getBlob(`${p.id}:proc`);
      if (!proc) continue;
      let ow = p.width;
      let oh = p.height;
      // Tesseract legge meglio caratteri grandi: le pagine piccole si ingrandiscono (Paddle lo fa da sé).
      if (engine === 'tesseract' && Math.max(ow, oh) < 2000) {
        const big = await resizeImage(proc, { maxSide: 2400, quality: 0.92, up: true });
        proc = big.blob;
        ow = big.width;
        oh = big.height;
      }
      const r = await recognize(proc, { engine, langs }, (m) => {
        if (!onProgress) return;
        if (m.status === 'recognizing') onProgress({ phase: 'ocr', done: i + (m.progress || 0), total });
        else onProgress({ phase: 'ocr', done: i, total, detail: 'Preparo il riconoscimento del testo' });
      });
      p.ocr = { rev: p.rev, langs: key, width: r.width || ow, height: r.height || oh, words: r.words, text: r.text };
      await db.putPage(p);
    }
    await terminate(); // libera la memoria del motore OCR
  }

  const doc = await PDFDocument.create();
  doc.setTitle(project.name);
  doc.setCreator('Pageturn');
  doc.setProducer('Pageturn');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < total; i++) {
    if (signal && signal.aborted) throw new DOMException('annullato', 'AbortError');
    onProgress && onProgress({ phase: 'pdf', done: i, total });
    const p = pages.get(ids[i]);
    const img = await pageImage(p.id, quality);
    const jpg = await doc.embedJpg(await bytes(img.blob));
    let page;
    let box;
    if (size === 'a4') {
      // A4 (verticale, o orizzontale per le pagine più larghe che alte), 1 cm di margine, immagine centrata
      const land = p.width > p.height;
      const PW = land ? A4[1] : A4[0];
      const PH = land ? A4[0] : A4[1];
      const k = Math.min((PW - 2 * MARGIN) / p.width, (PH - 2 * MARGIN) / p.height);
      const w = p.width * k;
      const h = p.height * k;
      page = doc.addPage([PW, PH]);
      box = { x: (PW - w) / 2, y: (PH - h) / 2, w, h, PH };
    } else {
      // tutte le pagine con la stessa misura fisica (lato lungo ≈ 24 cm), qualunque sia la risoluzione della foto
      const k = PAGE_LONG / Math.max(p.width, p.height);
      page = doc.addPage([p.width * k, p.height * k]);
      box = { x: 0, y: 0, w: p.width * k, h: p.height * k, PH: p.height * k };
    }
    page.drawImage(jpg, { x: box.x, y: box.y, width: box.w, height: box.h });
    if (ocr && p.ocr && p.ocr.words.length) addTextLayer(page, font, p.ocr, box);
  }
  onProgress && onProgress({ phase: 'pdf', done: total, total });
  const out = await doc.save({ useObjectStreams: true });
  return new Blob([out], { type: 'application/pdf' });
}

// Testo invisibile sopra l'immagine: selezionabile e ricercabile, allineato alle parole.
function addTextLayer(page, font, ocr, box) {
  page.setFont(font);
  const key = page.fontKey;
  const sx = box.w / ocr.width;
  const sy = box.h / ocr.height;
  const top = box.y + box.h; // il PDF ha l'origine in basso
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const [x0, y0, x1, y1, raw] of ocr.words) {
    const t = sanitize(font, raw);
    if (!t) continue;
    const h = (y1 - y0) * sy;
    const w = (x1 - x0) * sx;
    const size = Math.max(1, h * 0.95);
    const tw = font.widthOfTextAtSize(t, size);
    if (!tw) continue;
    const squeeze = Math.max(10, Math.min(500, (w / tw) * 100));
    ops.push(
      setFontAndSize(key, size),
      setCharacterSqueeze(squeeze),
      setTextMatrix(1, 0, 0, 1, box.x + x0 * sx, top - y1 * sy + h * 0.2),
      showText(font.encodeText(t)),
    );
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

// Pagine come immagini JPEG (zip).
export async function buildImagesZip(project, { quality = 'medium', onProgress } = {}) {
  const files = {};
  const n = project.order.length;
  const pad = String(n).length;
  for (let i = 0; i < n; i++) {
    onProgress && onProgress({ phase: 'img', done: i, total: n });
    const img = await pageImage(project.order[i], quality);
    files[`${slug(project.name)}-${String(i + 1).padStart(pad, '0')}.jpg`] = [await bytes(img.blob), { level: 0 }];
  }
  return new Blob([zipSync(files)], { type: 'application/zip' });
}

export async function buildText(project) {
  const pages = await db.getPages(project.id);
  return project.order.map((id, i) => `--- Pagina ${i + 1} ---\n${(pages.get(id)?.ocr?.text || '').trim()}`).join('\n\n');
}

// ---------- backup ----------

// Backup completo: foto originali + impostazioni di ogni pagina, così si può rielaborare tutto.
export async function buildBackup(project, onProgress) {
  const pages = await db.getPages(project.id);
  const files = {};
  const list = [];
  const n = project.order.length;
  for (let i = 0; i < n; i++) {
    onProgress && onProgress({ phase: 'zip', done: i, total: n });
    const p = pages.get(project.order[i]);
    if (!p) continue;
    const key = db.origKey(p);
    const name = `originali/${p.origId || p.id}.jpg`;
    if (!files[name]) {
      const orig = await db.getBlob(key);
      if (!orig) continue;
      files[name] = [await bytes(orig), { level: 0 }];
    }
    const { ocr, ...rest } = p;
    list.push(rest);
  }
  const meta = { format: 'pageturn-backup', version: 1, exported: Date.now(), project: { ...project }, pages: list };
  files['progetto.json'] = strToU8(JSON.stringify(meta, null, 1));
  return new Blob([zipSync(files)], { type: 'application/zip' });
}

// Ripristina un backup come nuovo progetto (non sovrascrive nulla di esistente).
export async function importBackup(file) {
  const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
  if (!z['progetto.json']) throw new Error(tr('Questo file non è un backup di Pageturn'));
  const meta = JSON.parse(strFromU8(z['progetto.json']));
  const existing = await db.getProject(meta.project.id);
  const project = await db.createProject(existing ? tr('{name} (ripristino)', { name: meta.project.name }) : meta.project.name);
  const items = [];
  const newId = new Map(meta.pages.map((p) => [p.id, db.uid()]));
  const written = new Set();
  for (const p of meta.pages) {
    const src = p.origId || p.id;
    const data = z[`originali/${src}.jpg`];
    if (!data) continue;
    const id = newId.get(p.id);
    const origId = newId.get(src) || db.uid();
    const page = { ...p, id, origId: origId === id ? undefined : origId, projectId: project.id, status: 'pending', rev: (p.rev || 0) + 1, synced: false };
    const first = !written.has(src);
    written.add(src);
    items.push({ page, orig: first ? new Blob([data], { type: 'image/jpeg' }) : null });
    if (items.length >= 20) await db.addPages(project.id, items.splice(0));
  }
  if (items.length) await db.addPages(project.id, items);
  const fresh = await db.getProject(project.id);
  fresh.pagesSinceBackup = 0;
  fresh.lastBackup = meta.exported;
  await db.putProject(fresh);
  return fresh;
}

// Nome di file: senza accenti, ma con le lettere di ogni alfabeto (un titolo cinese resta cinese).
export function slug(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || tr('scansione');
}

export { PROC };
