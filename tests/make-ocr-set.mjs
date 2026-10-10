// Pagine di prova per confrontare i motori OCR (testo noto → errore misurabile).
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('tests/fixtures/ocr', { recursive: true });
const pages = {
  romanzo: { font: '33px/1.55 Georgia, serif', text: [
    'Quando Lucia tornò in paese, l’autunno aveva già spogliato i castagni. Nessuno l’aspettava alla stazione: soltanto un cane',
    'magro, che la seguì fino alla piazza e poi sparì dietro la chiesa. «Perché sei tornata?» le chiese la zia, senza alzare gli occhi',
    'dal ricamo. Lucia non rispose subito; guardò il fuoco, le mani screpolate, la finestra appannata. «Perché qui, almeno, so chi sono.»',
  ] },
  manuale: { font: "25px/1.45 'Times New Roman', serif", text: [
    '3.2 Il condizionamento operante. Secondo Skinner (1938), la probabilità che un comportamento venga emesso dipende dalle sue',
    'conseguenze: il rinforzo positivo aumenta la frequenza della risposta, mentre la punizione tende a ridurla. Negli esperimenti',
    'con la cosiddetta «Skinner box», un ratto impara a premere una leva per ottenere cibo; il tasso di risposta varia secondo il',
    'programma di rinforzo (a rapporto fisso, a rapporto variabile, a intervallo fisso o variabile). È importante distinguere',
    'il rinforzo negativo – che rimuove uno stimolo avversivo – dalla punizione, con cui viene spesso confuso¹.',
    '¹ Per una rassegna critica si veda Bandura, A. (1977). Social Learning Theory. Englewood Cliffs, NJ: Prentice-Hall, pp. 45–67.',
  ] },
};
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1240, height: 1754 } });
for (const [name, { font, text }] of Object.entries(pages)) {
  await p.setContent(`<html><body style="margin:0;background:#fff;font:${font};color:#1a1a1a;padding:120px 110px">${text.map((l, i) => `<p style="margin:0 0 ${i === text.length - 2 && name === 'manuale' ? 60 : 18}px;text-align:justify;${l.startsWith('¹') ? 'font-size:20px' : ''}">${l}</p>`).join('')}</body></html>`);
  await p.screenshot({ path: `tests/fixtures/ocr/${name}.png` });
  writeFileSync(`tests/fixtures/ocr/${name}.txt`, text.join('\n'));
}
await b.close();
