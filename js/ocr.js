// Riconoscimento del testo, sul dispositivo, con due motori:
//  - PaddleOCR (PP-OCRv5, modello per le lingue latine): più preciso su foto, pagine curve e caratteri piccoli.
//  - Tesseract: più veloce, sceglie le lingue una per una.
// Motori e modelli sono in vendor/ e vengono messi in cache al primo uso: poi funziona offline.

export const ENGINES = {
  paddle: { label: 'Preciso', name: 'PaddleOCR' },
  tesseract: { label: 'Veloce', name: 'Tesseract' },
};

const base = new URL('../vendor/', import.meta.url).href;

// ---------- Tesseract ----------
let tess = null;
let tessLangs = '';

async function tesseract(langs, onProgress) {
  const key = langs.join('+');
  if (tess && tessLangs === key) return tess;
  if (tess) await tess.terminate();
  const T = await import('../vendor/tesseract/tesseract.esm.min.js');
  const createWorker = T.createWorker || (T.default && T.default.createWorker);
  tess = await createWorker(langs, 1, {
    workerPath: base + 'tesseract/worker.min.js',
    corePath: base + 'tesseract/core',
    langPath: base + 'tessdata',
    workerBlobURL: false,
    gzip: true,
    logger: (m) => onProgress && onProgress(m),
  });
  tessLangs = key;
  return tess;
}

async function recognizeTesseract(blob, langs, onProgress) {
  const w = await tesseract(langs, onProgress);
  const { data } = await w.recognize(blob, {}, { text: true, blocks: true });
  const words = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        for (const wd of l.words || []) {
          const t = (wd.text || '').trim();
          if (!t || wd.confidence < 25) continue;
          const bb = wd.bbox;
          words.push([bb.x0, bb.y0, bb.x1, bb.y1, t]);
        }
      }
    }
  }
  return { text: data.text || '', words };
}

// ---------- PaddleOCR (in un worker) ----------
let pw = null;
let seq = 0;
const jobs = new Map();

function paddleWorker() {
  if (pw) return pw;
  pw = new Worker(new URL('./paddle-worker.js', import.meta.url), { type: 'module' });
  pw.onmessage = (e) => {
    const j = jobs.get(e.data.id);
    if (!j) return;
    if (e.data.progress) return j.onProgress && j.onProgress(e.data.progress);
    jobs.delete(e.data.id);
    if (e.data.ok) j.resolve(e.data.result);
    else j.reject(new Error(e.data.error));
  };
  pw.onerror = (e) => {
    for (const j of jobs.values()) j.reject(new Error(e.message || 'Errore del motore OCR'));
    jobs.clear();
    pw = null;
  };
  return pw;
}

let mainPaddle = null;
async function paddleMainThread(blob, onProgress) {
  // ripiego senza OffscreenCanvas nei worker: stesso motore nel thread principale
  if (!mainPaddle) {
    const ort = await import('../vendor/ort/ort.wasm.min.mjs');
    const { createPaddle } = await import('./paddle.js');
    ort.env.wasm.wasmPaths = base + 'ort/';
    ort.env.wasm.numThreads = 1;
    const get = (n) => fetch(base + 'paddle/' + n).then((r) => (n.endsWith('.txt') ? r.text() : r.arrayBuffer()).then((x) => (typeof x === 'string' ? x : new Uint8Array(x))));
    onProgress({ status: 'loading' });
    mainPaddle = await createPaddle({ ort, det: await get('det.onnx'), rec: await get('rec-latin.onnx'), dict: await get('dict-latin.txt'), detSide: 960 });
  }
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const img = x.getImageData(0, 0, c.width, c.height);
  c.width = c.height = 0;
  const r = await mainPaddle.recognize(img, (f) => onProgress({ status: 'recognizing', progress: f }));
  return { ...r, width: img.width, height: img.height };
}

function recognizePaddle(blob, onProgress) {
  if (typeof OffscreenCanvas === 'undefined') return paddleMainThread(blob, onProgress);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, onProgress });
    paddleWorker().postMessage({ id, blob });
  });
}

// ---------- interfaccia comune ----------
// Restituisce { text, words: [[x0,y0,x1,y1,testo], ...] } in pixel dell'immagine passata.
// onProgress riceve { status: 'loading' | 'recognizing', progress? }.
export async function recognize(blob, { engine = 'paddle', langs = ['ita', 'eng'] } = {}, onProgress = () => {}) {
  if (engine === 'tesseract') {
    return recognizeTesseract(blob, langs, (m) => {
      if (m.status === 'recognizing text') onProgress({ status: 'recognizing', progress: m.progress });
      else if (m.status && /load|init/.test(m.status)) onProgress({ status: 'loading' });
    });
  }
  return recognizePaddle(blob, onProgress);
}

export function engineKey(engine, langs) {
  return engine === 'tesseract' ? `tess:${langs.join('+')}` : 'paddle:v5-latin';
}

// Libera la memoria dei motori (dopo un'esportazione).
export async function terminate() {
  if (tess) await tess.terminate();
  tess = null;
  tessLangs = '';
  if (pw) pw.terminate();
  pw = null;
  mainPaddle = null;
}
