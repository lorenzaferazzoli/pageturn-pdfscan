// Genera le icone PNG da icons/icon.svg (serve Playwright: npm i -D playwright).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const svg = readFileSync('icons/icon.svg', 'utf8');
const b = await chromium.launch();
const p = await b.newPage();
for (const [name, size, bg] of [['icon-512.png', 512, 'transparent'], ['icon-192.png', 192, 'transparent'], ['apple-touch-icon.png', 180, '#185FA5']]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<html><body style="margin:0;background:${bg}">${svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`);
  await p.screenshot({ path: `icons/${name}`, omitBackground: bg === 'transparent' });
}
await b.close();
