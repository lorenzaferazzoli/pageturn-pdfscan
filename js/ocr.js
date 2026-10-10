// Riconoscimento del testo con Tesseract.js, caricato solo quando serve.
// I file del motore e delle lingue sono in vendor/ e restano in cache per l'uso offline.

let worker = null;
let workerLangs = '';

const base = new URL('../vendor/', import.meta.url).href;

export async function getWorker(langs, onProgress) {
  const key = langs.join('+');
  if (worker && workerLangs === key) return worker;
  if (worker) await worker.terminate();
  const T = await import('../vendor/tesseract/tesseract.esm.min.js');
  const createWorker = T.createWorker || (T.default && T.default.createWorker);
  worker = await createWorker(langs, 1, {
    workerPath: base + 'tesseract/worker.min.js',
    corePath: base + 'tesseract/core',
    langPath: base + 'tessdata',
    workerBlobURL: false,
    gzip: true,
    logger: (m) => onProgress && onProgress(m),
  });
  workerLangs = key;
  return worker;
}

export async function terminate() {
  if (worker) await worker.terminate();
  worker = null;
  workerLangs = '';
}

// Restituisce { text, words: [[x0,y0,x1,y1,testo], ...], width, height } in pixel dell'immagine.
export async function recognize(blob, langs, onProgress) {
  const w = await getWorker(langs, onProgress);
  const { data } = await w.recognize(blob, {}, { text: true, blocks: true });
  const words = [];
  const walk = (blocks) => {
    for (const b of blocks || []) {
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
  };
  walk(data.blocks);
  return { text: data.text || '', words };
}
