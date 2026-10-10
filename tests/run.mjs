// Prova completa nel browser (Chromium) con una finta fotocamera.
//   npm i && npm test
// Crea le immagini di prova, avvia il server, scansiona, modifica, esporta e controlla il PDF.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const fx = join(root, 'tests/fixtures');
const out = join(root, 'tests/out');
const PORT = 8095;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!existsSync(join(fx, 'cam.y4m'))) {
  execFileSync('node', ['tests/make-fixtures.mjs'], { cwd: root, stdio: 'inherit' });
  execFileSync('python3', ['tests/make-photo.py'], { cwd: root, stdio: 'inherit' });
  execFileSync('python3', ['tests/make-video.py'], { cwd: root, stdio: 'inherit' });
}

const dataDir = join(out, 'data');
const server = spawn('node', ['server/server.js'], { cwd: root, env: { ...process.env, PORT, DATA_DIR: dataDir }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 600));

const fails = [];
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${join(fx, 'cam.y4m')}`],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  permissions: ['camera'], acceptDownloads: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = (n) => page.screenshot({ path: join(out, `${n}.png`) });

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('text=Inizia il tuo primo libro');
  await shot('01-home-vuota');

  // nuovo libro → fotocamera
  await page.click('text=Nuovo libro');
  await page.fill('.sheet input', 'Psicologia generale');
  await page.click('text=Crea e scansiona');
  await page.waitForSelector('.cam video');
  await page.waitForFunction(() => document.querySelector('#htext')?.textContent.includes('Tieni fermo') || document.querySelector('#htext')?.textContent.includes('rilevata'), null, { timeout: 15000 });
  await shot('02-fotocamera-rilevata');
  await page.waitForFunction(() => (window.__pageturn.S.project.order.length >= 2), null, { timeout: 30000 });
  const n = await page.evaluate(() => window.__pageturn.S.project.order.length);
  check(n >= 2, `scatto automatico con cambio pagina (${n} pagine)`);
  await shot('03-fotocamera-dopo-scatti');
  await page.click('.top [data-a="close"]');

  // pagine elaborate
  await page.waitForFunction(() => document.querySelectorAll('.th img[src]').length >= 2, null, { timeout: 30000 });
  await shot('04-pagine');

  // importa foto (una nitida, una sfocata)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-a="import"]')]);
  await chooser.setFiles([join(fx, 'photo.jpg'), join(fx, 'photo-blur.jpg'), join(fx, 'photo.jpg'), join(fx, 'photo.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('.th img[src]').length >= 6, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  const quad = await page.evaluate(() => {
    const S = window.__pageturn.S;
    return S.pages.get(S.project.order[2]).params.quad;
  });
  const exp = [[0.235, 0.215], [0.78, 0.185], [0.82, 0.86], [0.18, 0.815]];
  const err = Math.max(...quad.map((q, i) => Math.hypot(q[0] - exp[i][0], q[1] - exp[i][1])));
  check(err < 0.03, `bordi della pagina rilevati nella foto importata (errore ${err.toFixed(3)})`);
  const warn = await page.$$eval('.th.warn', (e) => e.length);
  check(warn === 1, `una sola pagina segnalata come sfocata (${warn})`);
  await shot('05-pagine-importate');

  // libro aperto e doppia pagina: due foto importate con la doppia pagina attiva diventano quattro pagine
  await page.evaluate(async () => { const { S, db } = window.__pageturn; S.project.double = true; await db.putProject(S.project); });
  const [ch2] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-a="import"]')]);
  await ch2.setFiles([join(fx, 'real/due-pagine.jpg')]);
  await page.waitForFunction(() => window.__pageturn.S.project.order.length === 8, null, { timeout: 30000 });
  const halves = await page.evaluate(() => { const S = window.__pageturn.S; return S.project.order.slice(-2).map((id) => S.pages.get(id).params.quad); });
  // la piega della foto di prova è a metà del libro (circa x = 0,50 in alto, 0,51 in basso)
  const spineX = halves[0][1][0];
  check(Math.abs(spineX - 0.5) < 0.03 && Math.abs(halves[1][0][0] - spineX) < 1e-6, `doppia pagina divisa sulla piega (x = ${spineX.toFixed(3)})`);
  await page.evaluate(async () => {
    const { S, db } = window.__pageturn;
    S.project = await db.deletePages(S.project.id, S.project.order.slice(-2));
    S.project.double = false;
    await db.putProject(S.project);
  });
  // foto vera di un libro aperto (non pubblicata nel repository: la prova si salta se manca)
  if (existsSync(join(fx, 'real/libro-aperto.jpg'))) {
    const [ch3] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-a="import"]')]);
    await ch3.setFiles([join(fx, 'real/libro-aperto.jpg')]);
    await page.waitForFunction(() => window.__pageturn.S.project.order.length === 7, null, { timeout: 30000 });
    const one = await page.evaluate(() => { const S = window.__pageturn.S; return S.pages.get(S.project.order.at(-1)).params.quad; });
    check(one[0][0] > 0.2 && one[3][0] > 0.2, `libro aperto: tenuta solo la pagina intera (bordo sinistro a x = ${one[0][0].toFixed(3)})`);
    await page.evaluate(async () => { const { S, db } = window.__pageturn; S.project = await db.deletePages(S.project.id, S.project.order.slice(-1)); });
  }
  await page.click('[data-a="back"]');
  await page.click('.proj');
  await page.waitForSelector('#grid');

  // editor
  await page.click('.th >> nth=2');
  await page.waitForSelector('#pv[src]');
  await page.waitForTimeout(600);
  await shot('06-modifica-sbianca');
  await page.click('[data-f="bw"]');
  await page.waitForTimeout(1200);
  await shot('07-modifica-bn');
  await page.click('[data-f="whiten"]');
  await page.click('[data-a="crop"]');
  await page.waitForTimeout(500);
  // trascinando un angolo compare la lente
  const h0 = await page.locator('.handle').first().boundingBox();
  await page.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2);
  await page.mouse.down();
  await page.mouse.move(h0.x + h0.width / 2 + 6, h0.y + h0.height / 2 + 6, { steps: 3 });
  check(await page.isVisible('#loupe'), 'lente di ingrandimento sul ritaglio');
  await shot('08-ritaglio');
  await page.mouse.up();
  // trascinando il centro del lato alto si sposta tutto il lato
  const qBefore = await page.$$eval('#ov circle.handle', (c) => c.map((e) => [+e.getAttribute('cx'), +e.getAttribute('cy')]));
  const mx = (qBefore[0][0] + qBefore[1][0]) / 2;
  const my = (qBefore[0][1] + qBefore[1][1]) / 2;
  const sbx = await page.locator('#stage').boundingBox();
  await page.mouse.move(sbx.x + mx, sbx.y + my);
  await page.mouse.down();
  await page.mouse.move(sbx.x + mx, sbx.y + my + 30, { steps: 4 });
  await page.mouse.up();
  const qAfter = await page.$$eval('#ov circle.handle', (c) => c.map((e) => [+e.getAttribute('cx'), +e.getAttribute('cy')]));
  check(qAfter[0][1] - qBefore[0][1] > 15 && qAfter[1][1] - qBefore[1][1] > 15 && Math.abs(qAfter[2][1] - qBefore[2][1]) < 1, 'lato del ritaglio spostato tutto insieme');
  await page.click('[data-c="cancel"]');
  // gomma: un tratto sulla pagina
  await page.click('[data-a="erase"]');
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3);
  await page.mouse.down();
  const tStroke = Date.now();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.32, { steps: 30 });
  await page.mouse.up();
  const strokeMs = Date.now() - tStroke;
  check(strokeMs < 1500, `tratto della gomma fluido (${strokeMs} ms per 30 movimenti)`);
  // un secondo tratto subito dopo, senza attendere
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.52, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  await shot('09-gomma');
  await page.click('[data-c="ok"]');
  await page.click('[data-a="done"]');
  await page.waitForSelector('#grid');
  const erased = await page.evaluate(() => { const S = window.__pageturn.S; return S.pages.get(S.project.order[2]).params.erase.length; });
  check(erased === 2, `tratti della gomma salvati (${erased})`);

  // pagina curva: Distendi
  await page.click('.th >> nth=3');
  await page.waitForSelector('#pv[src]');
  await page.click('[data-a="dewarp"]');
  await page.waitForFunction(() => document.querySelector('#busy') && !document.querySelector('#busy').hidden, null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#busy').hidden, null, { timeout: 90000 });
  await shot('09b-distendi');
  await page.click('[data-a="done"]');
  await page.waitForSelector('#grid');
  check(await page.evaluate(() => { const S = window.__pageturn.S; return S.pages.get(S.project.order[3]).params.dewarp === true; }), 'pagina distesa (UVDoc)');

  // annulla / ripeti
  await page.click('.th >> nth=2');
  await page.waitForSelector('#pv[src]');
  await page.click('[data-f="bw"]');
  await page.click('[data-a="undo"]');
  const fUndo = await page.$eval('[data-f].on', (e) => e.dataset.f);
  await page.click('[data-a="redoh"]');
  const fRedo = await page.$eval('[data-f].on', (e) => e.dataset.f);
  check(fUndo === 'whiten' && fRedo === 'bw', `annulla e ripeti (${fUndo} → ${fRedo})`);
  await page.click('[data-a="undo"]');
  await page.click('[data-a="done"]');
  await page.waitForSelector('#grid');

  // modifiche a tutte le pagine
  await page.click('.th >> nth=1');
  await page.waitForSelector('#pv[src]');
  await page.click('[data-a="more"]');
  await page.click('text=Modifiche a tutte le pagine');
  await page.click('[data-f="gray"]');
  await page.click('[data-a="done"]');
  await page.waitForSelector('#grid');
  const grays = await page.evaluate(() => { const S = window.__pageturn.S; return S.project.order.map((id) => S.pages.get(id).params.filter); });
  check(grays.every((f) => f === 'gray'), `filtro applicato a tutte le pagine (${grays.join(',')})`);
  await page.click('.th >> nth=1');
  await page.waitForSelector('#pv[src]');
  await page.click('[data-f="whiten"]');
  await page.click('[data-a="more"]');
  await page.click('text=Modifiche a tutte le pagine');
  await page.click('[data-a="done"]');
  await page.waitForSelector('#grid');

  // dividi con la linea regolabile
  await page.click('.th >> nth=0');
  await page.waitForSelector('#pv[src]');
  await page.waitForTimeout(500);
  await page.click('[data-a="split"]');
  await page.waitForSelector('#ov circle');
  await page.waitForTimeout(400);
  await shot('09c-dividi');
  // la linea si sposta trascinandola
  const sb = await page.locator('#stage').boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 + 20, sb.y + sb.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.click('[data-c="apply"]');
  await page.waitForFunction(() => window.__pageturn.S.project.order.length === 7);
  check(true, 'pagina divisa in due');
  await page.waitForSelector('#pv[src]');
  await page.click('[data-a="undo"]');
  await page.waitForFunction(() => window.__pageturn.S.project.order.length === 6);
  await page.waitForSelector('#pv[src]');
  await page.click('[data-a="redoh"]');
  await page.waitForFunction(() => window.__pageturn.S.project.order.length === 7);
  check(true, 'divisione annullata e ripetuta');
  await page.click('[data-a="done"]');
  await page.waitForSelector('#grid');

  // tema scuro
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await shot('10-pagine-scuro');

  // esporta PDF con OCR
  await page.waitForFunction(() => [...window.__pageturn.S.pages.values()].every((p) => p.status === 'done'), null, { timeout: 60000 }).catch(() => {});
  await page.click('[data-a="export"]');
  await page.waitForSelector('#go');
  await page.waitForTimeout(500);
  await shot('11-esporta-scuro');
  await page.click('#go');
  await page.waitForSelector('text=PDF pronto', { timeout: 240000 });
  await shot('12-pdf-pronto');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-dl]')]);
  const pdf = join(out, 'libro.pdf');
  await dl.saveAs(pdf);
  const txt = execFileSync('pdftotext', [pdf, '-']).toString();
  writeFileSync(join(out, 'libro.txt'), txt);
  const flat = txt.replace(/\s+/g, ' ');
  check(/memoria di lavoro è il sistema/i.test(flat) && /visuospaziale/.test(flat), 'PDF ricercabile con PaddleOCR (italiano, accenti compresi)');
  const pages = +(execFileSync('pdfinfo', [pdf]).toString().match(/Pages:\s+(\d+)/) || [])[1];
  check(pages === 7, `PDF con 7 pagine (${pages})`);
  check(await page.evaluate(() => crossOriginIsolated), 'pagina isolata (OCR con più thread)');

  // formato A4 con margini
  await page.click('[data-a="export"]');
  await page.waitForSelector('#go');
  await page.click('[data-s="a4"]');
  await page.click('[data-e="tesseract"]');
  await page.click('#go');
  await page.waitForSelector('text=PDF pronto', { timeout: 240000 });
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('[data-dl]')]);
  const pdf3 = join(out, 'libro-a4.pdf');
  await dl3.saveAs(pdf3);
  const sizes = execFileSync('pdfinfo', ['-f', '1', '-l', '20', pdf3]).toString().match(/size:\s+[\d.]+ x [\d.]+/g) || [];
  check(sizes.length === 7 && sizes.every((x) => /595\.28 x 841\.89|841\.89 x 595\.28/.test(x)), `PDF A4: ${sizes.length} pagine A4`);
  check(/memoria di lavoro è il sistema/i.test(execFileSync('pdftotext', [pdf3, '-']).toString().replace(/\s+/g, ' ')), 'testo ricercabile anche in A4');
  await page.click('[data-a="export"]');
  await page.click('[data-s="image"]');
  await page.click('[data-e="paddle"]');
  await page.click('.sheet [data-close]');

  // stesso PDF con Tesseract
  await page.click('[data-a="export"]');
  await page.waitForSelector('#go');
  await page.click('[data-e="tesseract"]');
  await page.click('#go');
  await page.waitForSelector('text=PDF pronto', { timeout: 240000 });
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('[data-dl]')]);
  const pdf2 = join(out, 'libro-tesseract.pdf');
  await dl2.saveAs(pdf2);
  const flat2 = execFileSync('pdftotext', [pdf2, '-']).toString().replace(/\s+/g, ' ');
  check(/memoria di lavoro è il sistema/i.test(flat2), 'PDF ricercabile anche con Tesseract');
  await page.click('[data-a="export"]');
  await page.click('[data-e="paddle"]');
  await page.click('.sheet [data-close]');

  // backup zip ed importazione
  await page.emulateMedia({ colorScheme: 'light' });
  await page.click('[data-a="menu"]');
  await page.click('text=Esporta backup (.zip)');
  await page.waitForSelector('text=Backup pronto', { timeout: 60000 });
  const [dz] = await Promise.all([page.waitForEvent('download'), page.click('[data-dl]')]);
  const zip = join(out, 'backup.zip');
  await dz.saveAs(zip);
  const list = execFileSync('unzip', ['-l', zip]).toString();
  check(/progetto\.json/.test(list) && (list.match(/originali\//g) || []).length === 6, 'backup con 6 foto originali (la pagina divisa ne condivide una)');

  // backup automatico sul server
  await page.waitForFunction(() => window.__pageturn.sync.getState().status === 'ok', null, { timeout: 30000 });
  const proj = readdirSync(dataDir).filter((d) => !d.startsWith('.'));
  const files = proj.length ? readdirSync(join(dataDir, proj[0], 'pages')) : [];
  check(files.filter((f) => f.endsWith('.jpg')).length === 7, `backup automatico: ${files.filter((f) => f.endsWith('.jpg')).length} foto sul server`);

  await page.click('[data-a="back"]');
  await page.waitForSelector('.proj');
  await shot('13-home');
  await page.click('[data-a="settings"]');
  await page.waitForTimeout(300);
  await shot('14-impostazioni');
  // importa il backup
  const [bc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-a="import"]')]);
  await bc.setFiles(zip);
  await page.waitForSelector('text=(ripristino)', { timeout: 30000 });
  const projects = await page.$$eval('.proj', (e) => e.length);
  check(projects === 2, 'backup importato come nuovo libro');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('15-home-scuro');
} catch (e) {
  console.error(e);
  fails.push(String(e.message || e));
  await shot('errore').catch(() => {});
} finally {
  // Tesseract segnala a console i dizionari facoltativi che non trova: non è un errore.
  const bad = errors.filter((e) => !/favicon|Failed to load resource.*404|special-words|\.(user-words|user-patterns|bigram)|Image too small to scale|Line cannot be recognized/.test(e));
  check(!bad.length, `nessun errore in console${bad.length ? `: ${bad.join(' | ')}` : ''}`);
  await browser.close();
  server.kill();
}
console.log(fails.length ? `\n${fails.length} problemi` : '\nTutto ok');
process.exit(fails.length ? 1 : 0);
