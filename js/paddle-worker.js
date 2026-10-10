// Worker dell'OCR PaddleOCR: carica ONNX Runtime e i modelli una volta, poi riconosce una pagina per messaggio.
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { createPaddle } from './paddle.js';

const base = new URL('../vendor/', import.meta.url).href;
ort.env.wasm.wasmPaths = base + 'ort/';
// Più thread solo se la pagina è "cross-origin isolated" (il service worker aggiunge le intestazioni).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

let engine = null;

async function load(progress) {
  if (engine) return engine;
  const get = async (name, i) => {
    const r = await fetch(base + 'paddle/' + name);
    if (!r.ok) throw new Error(`Modello OCR non disponibile (${name})`);
    progress(i);
    return name.endsWith('.txt') ? r.text() : new Uint8Array(await r.arrayBuffer());
  };
  const [det, rec, dict] = [await get('det.onnx', 1), await get('rec-latin.onnx', 2), await get('dict-latin.txt', 3)];
  engine = await createPaddle({ ort, det, rec, dict, detSide: 960 });
  return engine;
}

async function pixels(blob) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  bmp.close();
  return x.getImageData(0, 0, c.width, c.height);
}

self.onmessage = async (e) => {
  const { id, blob } = e.data;
  const post = (m) => self.postMessage({ id, ...m });
  try {
    await load((i) => post({ progress: { status: 'loading', step: i } }));
    const img = await pixels(blob);
    const r = await engine.recognize(img, (f) => post({ progress: { status: 'recognizing', progress: f } }));
    post({ ok: true, result: { ...r, width: img.width, height: img.height } });
  } catch (err) {
    post({ ok: false, error: String((err && err.message) || err) });
  }
};
