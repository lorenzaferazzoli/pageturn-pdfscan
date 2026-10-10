// Prova di carico: 120 pagine importate di fila, l'interfaccia deve restare reattiva.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const N = +process.argv[2] || 120;
const server = spawn('node', ['server/server.js'], { env: { ...process.env, PORT: 8098, DATA_DIR: 'tests/out/d4' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, locale: 'it-IT' });
await p.goto('http://localhost:8098/');
await p.waitForSelector('text=Nuovo libro');
await p.click('text=Nuovo libro');
await p.fill('.sheet input', 'Carico');
await p.click('text=Crea e scansiona');
await p.waitForSelector('.cam');
await p.click('.top [data-a="close"]');
await p.waitForSelector('[data-a="import"]');
const t0 = Date.now();
const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('[data-a="import"]')]);
await fc.setFiles(Array.from({ length: N }, () => 'tests/fixtures/photo.jpg'));
// misura i blocchi del thread principale durante l'elaborazione
const maxGap = await p.evaluate(async (N) => {
  let last = performance.now(); let gap = 0;
  const id = setInterval(() => { const n = performance.now(); gap = Math.max(gap, n - last - 50); last = n; }, 50);
  while (true) {
    const S = window.__pageturn.S;
    const pages = await window.__pageturn.db.getPages(S.project.id);
    if (pages.size >= N && [...pages.values()].every((x) => x.status === 'done')) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  clearInterval(id);
  return Math.round(gap);
}, N);
console.log(`${N} pagine importate ed elaborate in ${((Date.now() - t0) / 1000).toFixed(1)} s; blocco massimo dell'interfaccia ${maxGap} ms`);
await p.click('[data-a="back"]');
await p.click('.proj');
const t1 = Date.now();
await p.waitForSelector('#grid');
console.log(`griglia di ${N} pagine aperta in ${Date.now() - t1} ms`);
await b.close(); server.kill();
