// Disegna il riconoscimento (pagina scelta in verde, regione intera in giallo, piega in rosso) su tests/out/detect-*.png
//   node tests/detect-check.mjs [larghezza di analisi]
import { detectQuad } from '../js/detect.js';
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
const AW = +process.argv[2] || 200;
mkdirSync('tests/out', { recursive: true });
const files = ['tests/fixtures/photo.jpg', 'tests/fixtures/photo-blur.jpg', ...readdirSync('tests/fixtures/real').filter((f) => /\.(jpe?g|png)$/.test(f)).map((f) => `tests/fixtures/real/${f}`)];
for (const f of files) {
  const out = execFileSync('python3', ['-c', `import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('L');k=${AW}/max(im.size);im=im.resize((round(im.width*k),round(im.height*k)),Image.BILINEAR);sys.stdout.buffer.write(im.width.to_bytes(4,'little')+im.height.to_bytes(4,'little')+im.tobytes())`, f]);
  const w = out.readUInt32LE(0); const h = out.readUInt32LE(4);
  const t = performance.now();
  const r = detectQuad(new Uint8Array(out.buffer, out.byteOffset + 8, w * h), w, h);
  const ms = (performance.now() - t).toFixed(1);
  const name = f.split('/').pop().replace(/\.\w+$/, '');
  console.log(name.padEnd(16), `${ms} ms`, r ? `piega: ${r.spine ? 'sì' : 'no'} · pagina: ${r.quad.map((p) => p.map((v) => v.toFixed(3)).join(',')).join(' ')}` : 'niente');
  writeFileSync('tests/out/_det.json', JSON.stringify(r));
  execFileSync('python3', ['-c', `
import json;from PIL import Image,ImageDraw
im=Image.open('${f}').convert('RGB');d=ImageDraw.Draw(im);r=json.load(open('tests/out/_det.json'))
W,H=im.size
P=lambda q:[(x*W,y*H) for x,y in q]
if r:
  d.line(P(r['full'])+[P(r['full'])[0]],fill=(240,200,0),width=3)
  d.line(P(r['quad'])+[P(r['quad'])[0]],fill=(30,200,90),width=5)
  if r['spine']: d.line(P(r['spine']),fill=(230,40,40),width=4)
im.thumbnail((700,700));im.save('tests/out/detect-${name}.png')`]);
}
