// Stabilizzazione: finta fotocamera con 5 fotogrammi mossi e 1 nitido a ripetizione.
// Ogni scatto deve risultare nitido (si tiene il fotogramma migliore della raffica).
//   node tests/stabilizer.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
const S = 'tests/out/stab';
mkdirSync(S + '/burst', { recursive: true });
execFileSync('python3', ['-c', `
from PIL import Image, ImageFilter
a = Image.open('tests/fixtures/frame.png').convert('RGB'); b = a.filter(ImageFilter.GaussianBlur(2.2))
for i, f in enumerate(([b] * 5 + [a]) * 20): f.save('${S}/burst/f%03d.png' % i)`]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '15', '-i', `${S}/burst/f%03d.png`, '-pix_fmt', 'yuv420p', `${S}/burst.y4m`]);
const server = spawn('node', ['server/server.js'], { env: { ...process.env, PORT: 8096, DATA_DIR: S + '/d6' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${S}/burst.y4m`] });
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] })).newPage();
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto('http://localhost:8096/');
await p.click('text=Nuovo libro'); await p.fill('.sheet input', 'x'); await p.click('text=Crea e scansiona');
await p.waitForSelector('.cam video');
await p.waitForFunction(() => document.querySelector('video').videoWidth > 0);
await p.click('[data-a="manual"]');
for (let i = 0; i < 5; i++) {
  await p.waitForTimeout(700 + i * 130);
  await p.click('[data-a="shoot"]');
  await p.waitForFunction((n) => window.__pageturn.S.project.order.length === n, i + 1, { timeout: 10000 });
}
// nitidezza degli originali salvati, misurata come nell'app
const r = await p.evaluate(async () => {
  const { db, S } = window.__pageturn;
  const { sharpness } = await import('/js/proc.js');
  const out = [];
  for (const id of S.project.order) {
    const page = await db.getPage(id);
    const blob = await db.getBlob(db.origKey(page));
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(300, 300); const x = c.getContext('2d');
    x.drawImage(bmp, bmp.width / 2 - 150, bmp.height / 2 - 150, 300, 300, 0, 0, 300, 300);
    const d = x.getImageData(0, 0, 300, 300).data; const g = new Uint8Array(90000);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    out.push(Math.round(sharpness(g, 300, 300)));
  }
  return out;
});
console.log('nitidezza degli scatti:', r.join(', '), '(mosso ≈ 5, nitido ≈ 4300)');
const ok = r.every((v) => v > 1000);
console.log(ok ? '✓ tutti gli scatti nitidi' : '✗ scatti mossi');
process.exitCode = ok ? 0 : 1;
await b.close(); server.kill();
