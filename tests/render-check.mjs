// Elabora tests/fixtures/photo.jpg con ogni filtro e salva il risultato in tests/out/.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
mkdirSync('tests/out', { recursive: true });
const server = spawn('node', ['server/server.js'], { env: { ...process.env, PORT: 8097, DATA_DIR: 'tests/out/d3' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('http://localhost:8097/');
const photo = readFileSync(process.argv[2] || 'tests/fixtures/photo.jpg').toString('base64');
const res = await p.evaluate(async (b64) => {
  const jobs = await import('/js/jobs.js');
  const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' });
  const d = await jobs.detectPage(blob);
  const out = {};
  for (const filter of ['original', 'whiten', 'gray', 'bw']) {
    const t = performance.now();
    const r = await jobs.renderPage(blob, { quad: d.found.quad, filter }, { maxSide: 2400 });
    const buf = new Uint8Array(await r.blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    out[filter] = { b64: btoa(s), ms: Math.round(performance.now() - t), w: r.width, h: r.height };
  }
  return out;
}, photo);
for (const [k, v] of Object.entries(res)) { writeFileSync(`tests/out/render-${k}.jpg`, Buffer.from(v.b64, 'base64')); console.log(k, v.w, v.h, `${v.ms} ms`); }
await b.close(); server.kill();
