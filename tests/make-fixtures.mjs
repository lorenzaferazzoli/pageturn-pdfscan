// Crea immagini di prova: una pagina di libro fotografata storta su un tavolo scuro.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
const text = `Capitolo terzo. La memoria di lavoro è il sistema che mantiene e manipola le informazioni
per brevi periodi di tempo. Secondo il modello di Baddeley e Hitch, essa comprende un esecutivo
centrale, un circuito fonologico e un taccuino visuospaziale. Gli studi sperimentali hanno mostrato
che la capacità di questo sistema è limitata e che le prestazioni peggiorano quando due compiti
competono per la stessa componente. In seguito venne aggiunto il buffer episodico, che collega
la memoria di lavoro alla memoria a lungo termine e integra informazioni provenienti da fonti diverse.`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1240, height: 1754 } });
await p.setContent(`<html><body style="margin:0;background:#f3ead6;font:34px/1.55 Georgia,serif;color:#222;padding:130px 120px">
<h1 style="font-size:58px;margin:0 0 50px">Psicologia generale</h1>${text.split('\n').map(l=>`<p style="margin:0 0 24px;text-align:justify">${l}</p>`).join('')}
<p style="margin-top:60px;text-align:center;color:#555">— 47 —</p></body></html>`);
await p.screenshot({ path: 'tests/fixtures/page-flat.png' });
await b.close();
// Foto: carta ingiallita con ombra laterale (piega), prospettiva, tavolo scuro.
execFileSync('convert', ['tests/fixtures/page-flat.png',
  '(', '-size', '1240x1754', 'gradient:', '-rotate', '90', '-level', '0%,180%', '-evaluate', 'pow', '0.35', ')',
  '-compose', 'multiply', '-composite',
  '-virtual-pixel', 'background', '-background', '#2b211c', '-extent', '2000x2600-380-420',
  '-distort', 'Perspective', '380,420 470,560  1620,420 1560,480  1620,2174 1640,2240  380,2174 360,2120',
  '-attenuate', '0.4', '+noise', 'Gaussian', '-resize', '50%', '-quality', '88', 'tests/fixtures/photo.jpg']);
execFileSync('convert', ['tests/fixtures/photo.jpg', '-blur', '0x6', 'tests/fixtures/photo-blur.jpg']);
console.log('ok');
