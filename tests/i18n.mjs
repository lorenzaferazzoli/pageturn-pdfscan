// Traduzioni: ogni testo dell'interfaccia ha la versione inglese e cinese, e nelle schermate
// in inglese e in cinese non resta niente in italiano.
//   node tests/i18n.mjs        (schermate in tests/out/i18n-*.png)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { T } from '../js/i18n.js';

const root = new URL('..', import.meta.url).pathname;
const fx = join(root, 'tests/fixtures');
const out = join(root, 'tests/out');
mkdirSync(out, { recursive: true });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };

// ---------- 1. dizionario completo ----------
const src = readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js') && f !== 'i18n.js').map((f) => readFileSync(join(root, 'js', f), 'utf8')).join('\n');
const keys = new Set();
for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
for (const m of src.matchAll(/plural\([^,]+,\s*'([^']*)',\s*'([^']*)'\)/g)) keys.add(`${m[1]}|${m[2]}`);
// etichette passate a tr() da variabili: filtri, qualità, motori OCR, avanzamento
for (const m of src.match(/FILTER_LIST = .*/)[0].matchAll(/\['\w+', '([^']+)'\]/g)) keys.add(m[1]);
for (const m of src.matchAll(/label: '([^']+)'/g)) keys.add(m[1]);
for (const m of src.matchAll(/detail: '([^']+)'/g)) keys.add(m[1]);
const missing = [...keys].filter((k) => !T[k] || !T[k][0] || !T[k][1]);
check(missing.length === 0, `tutte le ${keys.size} frasi tradotte${missing.length ? `; mancano: ${missing.join(' / ')}` : ''}`);
const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const badVars = Object.entries(T).filter(([k, v]) => (Array.isArray(v[0]) ? v.flat() : v).some((x) => (k.includes('|') ? !x.includes('{n}') : vars(x) !== vars(k))));
check(badVars.length === 0, `segnaposto uguali in tutte le lingue${badVars.length ? `: ${badVars.map(([k]) => k).join(' / ')}` : ''}`);
const unused = Object.keys(T).filter((k) => !keys.has(k) && !src.includes(`'${k}'`));
check(unused.length === 0, `nessuna traduzione inutilizzata${unused.length ? `: ${unused.join(' / ')}` : ''}`);

// ---------- 2. schermate in inglese e cinese ----------
const PORT = 8096;
const server = spawn('node', ['server/server.js'], { cwd: root, env: { ...process.env, PORT, DATA_DIR: join(out, 'data-i18n') }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${join(fx, 'cam.y4m')}`],
});

const ITALIAN = /\b(pagin[ae]|libr[oi]|scatt[ao]|elimin\w*|esporta|annulla|seleziona|tutt[eoi]|della|delle|questo|questa|riprova|ripristin\w*|impostazioni|fotocamera|nessun[ao]?|sfocata|attivo)\b/i;

async function run(locale, lang, bookName) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'], locale,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const col = lang === 'en' ? 0 : 1;
  const left = new Set();
  const shot = async (n) => {
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    return page.screenshot({ path: join(out, `i18n-${lang}-${n}.png`) });
  };
  const collect = async () => {
    const texts = await page.evaluate(() => {
      const r = []; // i nomi delle lingue (#lang) restano nella loro lingua
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const t = w.currentNode.textContent.trim(); if (t && !w.currentNode.parentElement.closest('[hidden], #lang')) r.push(t); }
      document.querySelectorAll('[aria-label],[placeholder],[title]').forEach((e) => ['aria-label', 'placeholder', 'title'].forEach((a) => e.getAttribute(a) && r.push(e.getAttribute(a))));
      return r;
    });
    for (const t of texts) {
      if (t.includes(bookName)) continue;
      const row = T[t];
      if ((row && !Array.isArray(row[0]) && row[col] !== t) || ITALIAN.test(t)) left.add(t);
    }
  };

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('[data-a="new"]');
  check(await page.evaluate(() => document.documentElement.lang) === (lang === 'zh' ? 'zh-CN' : lang), `${lang}: lingua scelta dal telefono (${locale})`);
  await collect();
  await shot('1-home');

  await page.click('[data-a="settings"]');
  await page.waitForSelector('#lang');
  await page.waitForTimeout(400);
  await collect();
  await shot('2-impostazioni');
  await page.click('.sheet [data-close]');

  await page.click('[data-a="new"]');
  await page.fill('.sheet input', bookName);
  await page.click('.sheet [data-ok]');
  await page.waitForSelector('.cam video');
  await page.waitForTimeout(2500);
  await collect();
  await shot('3-fotocamera');
  await page.click('.top [data-a="close"]');

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-a="import"]')]);
  await chooser.setFiles([join(fx, 'photo.jpg'), join(fx, 'photo-blur.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('.th img[src]').length >= 2, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  await collect();
  await shot('4-pagine');
  await page.click('[data-a="menu"]');
  await page.waitForTimeout(300);
  await collect();
  await page.click('.sheet [data-close]');
  await page.click('[data-a="select"]');
  await page.click('[data-a="all"]');
  await collect();
  await shot('5-selezione');
  await page.click('[data-a="done"]');

  await page.click('.th >> nth=-1');
  await page.waitForSelector('#pv[src]');
  await page.waitForTimeout(600);
  await collect();
  await shot('6-modifica');
  for (const tool of ['crop', 'split', 'erase']) {
    await page.click(`[data-a="${tool}"]`);
    await page.waitForTimeout(500);
    await collect();
    await shot(`7-${tool}`);
    await page.click('[data-c="cancel"], [data-c="ok"]');
    await page.waitForTimeout(300);
  }
  await page.click('[data-a="more"]');
  await page.waitForTimeout(300);
  await collect();
  await shot('8-altro');
  await page.click('.sheet [data-close]');
  await page.click('[data-a="zoom"]');
  await page.waitForTimeout(500);
  await collect();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('.proj');
  await page.click('.proj');
  await page.waitForSelector('#grid');

  await page.click('[data-a="export"]');
  await page.waitForSelector('#go');
  await page.waitForTimeout(800);
  await collect();
  await shot('9-esporta');

  check(left.size === 0, `${lang}: nessun testo rimasto in italiano${left.size ? `: ${[...left].join(' / ')}` : ''}`);
  check(errors.length === 0, `${lang}: nessun errore${errors.length ? `: ${errors.join(' / ')}` : ''}`);

  // la scelta nelle impostazioni vince sulla lingua del telefono e resta dopo il riavvio
  await page.click('.sheet [data-close]');
  await page.click('[data-a="back"]');
  await page.click('[data-a="settings"]');
  await page.click('#lang [data-l="it"]');
  await page.waitForSelector('text=Impostazioni');
  await page.reload();
  await page.waitForSelector('[data-a="new"]');
  const it = await page.textContent('#app');
  check(/Nuovo libro/.test(it), `${lang}: passaggio all'italiano dalle impostazioni, mantenuto dopo il riavvio`);
  await ctx.close();
}

try {
  await run('en-US', 'en', 'Test book');
  await run('zh-CN', 'zh', '测试书');
} catch (e) {
  check(false, `errore: ${e.message}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(fails.length ? `\n${fails.length} problemi` : '\nTutto ok');
process.exit(fails.length ? 1 : 0);
