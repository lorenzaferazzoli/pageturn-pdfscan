// Copia le librerie in vendor/ e genera js/icons.js.
// Serve solo a chi aggiorna le dipendenze: i file generati sono già nel repository.
//   npm install && npm run vendor
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const v = join(root, 'vendor');

// vendor/paddle (modelli scaricati a parte) si conserva
for (const d of ['tesseract', 'tessdata', 'ort']) rmSync(join(v, d), { recursive: true, force: true });
for (const f of ['pdf-lib.esm.min.js', 'fflate.js']) rmSync(join(v, f), { force: true });
mkdirSync(join(v, 'tesseract', 'core'), { recursive: true });
mkdirSync(join(v, 'tessdata'), { recursive: true });

const copy = (from, to) => cpSync(join(nm, from), join(v, to));
copy('pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.esm.min.js');
copy('fflate/esm/browser.js', 'fflate.js');
copy('tesseract.js/dist/tesseract.esm.min.js', 'tesseract/tesseract.esm.min.js');
copy('tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js');
// Solo i core LSTM: l'app usa oem=1, quindi i core "legacy" non servono.
for (const f of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
  copy(`tesseract.js-core/${f}.wasm.js`, `tesseract/core/${f}.wasm.js`);
}
copy('@tesseract.js-data/ita/4.0.0_best_int/ita.traineddata.gz', 'tessdata/ita.traineddata.gz');
// ONNX Runtime (solo il backend WebAssembly) per PaddleOCR.
mkdirSync(join(v, 'ort'), { recursive: true });
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) copy(`onnxruntime-web/dist/${f}`, `ort/${f}`);
// I modelli PaddleOCR (PP-OCRv5 mobile: rilevamento + riconoscimento latino) non stanno su npm:
// si scaricano da https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models (Apache-2.0)
// e si mettono in vendor/paddle come det.onnx, rec-latin.onnx, dict-latin.txt. Vedi scripts/paddle-models.sh.
copy('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tessdata/eng.traineddata.gz');

const icons = [
  'x', 'chevron-left', 'chevron-right', 'cloud-check', 'cloud-off', 'cloud-upload', 'camera', 'camera-plus',
  'camera-rotate', 'photo-plus', 'checkbox', 'dots', 'crop', 'columns-2', 'rotate-clockwise', 'eraser',
  'download', 'upload', 'share-2', 'settings', 'plus', 'trash', 'book-2', 'bolt', 'arrow-back-up', 'check',
  'alert-triangle', 'wand', 'grip-vertical', 'pencil', 'file-zip', 'server', 'info-circle', 'arrows-move',
  'loader-2', 'device-floppy', 'photo', 'file-type-pdf', 'square-plus', 'book', 'adjustments-horizontal', 'wave-sine',
];
const out = {};
for (const name of icons) {
  const svg = readFileSync(join(nm, '@tabler/icons/icons/outline', `${name}.svg`), 'utf8');
  out[name] = [...svg.matchAll(/<(path|circle|rect|line|polyline)\b([^>]*)\/>/g)]
    .filter((m) => !m[2].includes('stroke="none"'))
    .map((m) => `<${m[1]}${m[2].replace(/\s+/g, ' ').trimEnd()}/>`)
    .join('');
}
writeFileSync(
  join(root, 'js', 'icons.js'),
  `// Generato da scripts/vendor.mjs — icone Tabler (MIT), https://tabler.io/icons\n` +
    `const P = ${JSON.stringify(out, null, 0)};\n` +
    `export function icon(name, cls = '') {\n` +
    `  return \`<svg class="ic \${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${P[name] || ''}</svg>\`;\n` +
    `}\n`,
);
console.log('vendor ok,', icons.length, 'icone');
