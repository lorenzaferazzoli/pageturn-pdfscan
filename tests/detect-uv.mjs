// Bordi rimisurati con UVDoc (quando il modello di Distendi è già sul telefono): le foto si importano
// nell'app vera, in Chromium, e si confrontano i bordi trovati con quelli giusti (sovrapposizione delle
// aree, 1 = identici). Foto sintetiche di tests/fixtures/detect e, se ci sono, foto vere con i bordi
// corretti a mano in tests/fixtures/real/libri (non pubblicate: la prova si salta se mancano).
//   node tests/detect-uv.mjs
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'tests/out');
mkdirSync(out, { recursive: true });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };

const sets = [{ name: 'sintetiche', dir: 'tests/fixtures/detect' }];
if (existsSync(join(root, 'tests/fixtures/real/libri/quads.json'))) sets.push({ name: 'foto vere', dir: 'tests/fixtures/real/libri' });

const PORT = 8094;
const server = spawn('node', ['server/server.js'], { cwd: root, env: { ...process.env, PORT, DATA_DIR: join(out, 'data-uv') }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch();

async function importAll(files) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'it-IT' });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('[data-a="new"]');
  await page.evaluate(async () => { const { db } = window.__pageturn; await db.kvSet('uvLoaded2', true); await db.createProject('Bordi'); });
  await page.reload();
  await page.click('.proj');
  const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-a="import"]')]);
  await ch.setFiles(files);
  await page.waitForFunction((n) => { const S = window.__pageturn.S; return S.project.order.length === n && [...S.pages.values()].every((p) => p.status === 'done'); }, files.length, { timeout: 900000, polling: 1000 });
  const params = await page.evaluate(() => { const S = window.__pageturn.S; return S.project.order.map((id) => S.pages.get(id).params); });
  await ctx.close();
  return params;
}

// sovrapposizione di due quadrilateri (intersezione / unione), su una griglia
function iou(a, b) {
  const N = 400;
  const inside = (q, x, y) => {
    let s = 0;
    for (let j = 0; j < 4; j++) {
      const [ax, ay] = q[j]; const [bx, by] = q[(j + 1) % 4];
      const z = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (!s) s = Math.sign(z); else if (z && Math.sign(z) !== s) return false;
    }
    return true;
  };
  let i = 0; let u = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const ia = inside(a, (x + 0.5) / N, (y + 0.5) / N); const ib = inside(b, (x + 0.5) / N, (y + 0.5) / N);
    if (ia && ib) i++; if (ia || ib) u++;
  }
  return u ? i / u : 0;
}

try {
  for (const set of sets) {
    const gt = JSON.parse(readFileSync(join(root, set.dir, 'quads.json'), 'utf8'));
    const names = Object.keys(gt);
    const t0 = Date.now();
    const params = await importAll(names.map((n) => join(root, set.dir, `${n}.jpg`)));
    const v = names.map((n, i) => iou(params[i].quad, gt[n].map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))])));
    names.forEach((n, i) => console.log(`  ${n.padEnd(26)} ${v[i].toFixed(3)}`));
    const med = [...v].sort((a, b) => a - b)[v.length >> 1];
    console.log(`  ${set.name}: ${names.length} foto in ${Math.round((Date.now() - t0) / 1000)} s`);
    check(params.every((p) => !p.auto), `${set.name}: bordi rimisurati una volta sola`);
    check(med >= 0.92, `${set.name}: sovrapposizione mediana ${med.toFixed(3)}`);
    check(v.filter((x) => x >= 0.9).length >= names.length * 0.85, `${set.name}: ${v.filter((x) => x >= 0.9).length} su ${names.length} sopra 0,90`);
  }
} catch (e) {
  check(false, `errore: ${e.message}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(fails.length ? `\n${fails.length} problemi` : '\nTutto ok');
process.exit(fails.length ? 1 : 0);
