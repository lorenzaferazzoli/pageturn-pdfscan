import * as db from './db.js';
import * as queue from './queue.js';
import * as sync from './sync.js';
import { Camera } from './camera.js';
import { icon } from './icons.js';
import { renderPage, detectPage, detectPageUV } from './jobs.js';
import { splitQuad, FULL_QUAD, homography } from './proc.js';
import { ENGINES as OCR_ENGINES } from './ocr.js';
import { tr, trp, sp, locale, setLang, langPref, LANGS } from './i18n.js';

export const VERSION = '1.9.0';
export const REPO = 'https://github.com/lorenzaferazzoli/pageturn-pdfscan';

// ---------- utilità ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = $('#app');
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function ago(t) {
  if (!t) return tr('mai');
  const s = (Date.now() - t) / 1000;
  if (s < 50) return tr('ora');
  if (s < 3600) return tr('{n} min fa', { n: Math.round(s / 60) });
  if (s < 86400) return Math.round(s / 3600) === 1 ? tr('1 ora fa') : tr('{n} ore fa', { n: Math.round(s / 3600) });
  if (s < 172800) return tr('ieri');
  return new Date(t).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

function bytes(n) {
  const f = (v, d) => v.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });
  if (!n) return '0 MB';
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} kB`;
  if (n < 1e9) return `${f(n / 1e6, n < 1e7 ? 1 : 0)} MB`;
  return `${f(n / 1e9, 1)} GB`;
}

// «3 pagine»: le forme singolare e plurale italiane sono la chiave della traduzione
const plural = (n, one, many) => trp(n, one, many);

function toast(msg, action, ms = 3800) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  const kill = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  };
  if (action) el.querySelector('button').onclick = () => { kill(); action.run(); };
  $('#toasts').append(el);
  setTimeout(kill, action ? ms + 3000 : ms);
}

// ---------- fogli dal basso ----------
function sheet(html, { onClose, dismissable = true } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheetwrap';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  const close = () => {
    if (!wrap.isConnected) return;
    wrap.remove();
    onClose && onClose();
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap && dismissable) close();
    if (e.target.closest('[data-close]')) close();
  });
  document.body.append(wrap);
  // swap: nuovo contenuto nello stesso foglio, senza animazione (es. cambio di lingua)
  const swap = (h) => {
    const old = wrap.firstElementChild;
    const el = document.createElement('div');
    el.className = 'sheet still';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `<div class="grab"></div>${h}`;
    old.replaceWith(el);
    el.scrollTop = old.scrollTop;
    return { el, close, swap };
  };
  return { el: wrap.firstElementChild, close, swap };
}

const shead = (title) => `<div class="shead"><h2>${esc(title)}</h2><button class="close" data-close aria-label="${tr('Chiudi')}">${icon('x')}</button></div>`;

function confirmSheet(title, text, ok, danger = false) {
  return new Promise((resolve) => {
    let v = false;
    const s = sheet(
      `${shead(title)}<p style="margin:0;color:var(--text-2)">${esc(text)}</p>
       <div class="actions"><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>
       <button class="btn" data-close>${tr('Annulla')}</button></div>`,
      { onClose: () => resolve(v) },
    );
    $('[data-ok]', s.el).onclick = () => { v = true; s.close(); };
  });
}

// Su iPhone:
// - la tastiera si apre solo se il campo riceve il fuoco subito, dentro il tocco che apre il foglio
//   (con un ritardo il campo resta «a metà» e non si riesce a scrivere);
// - con la tastiera aperta il foglio sale sopra la tastiera, così «Salva» resta visibile;
// - un tocco fuori dal foglio non lo chiude (con la tastiera che si abbassa finiva lì per sbaglio):
//   si annulla con la X.
function promptSheet(title, value, ok, placeholder = '') {
  return new Promise((resolve) => {
    let v = null;
    let unfit = () => {};
    const s = sheet(
      `${shead(title)}<form class="pform"><div class="card"><div class="li"><input class="field full" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" enterkeyhint="done" maxlength="80" autocomplete="off"></div></div>
       <div class="actions"><button class="btn primary" type="submit" data-ok>${esc(ok)}</button></div></form>`,
      { dismissable: false, onClose: () => { unfit(); resolve(v); } },
    );
    const inp = $('input', s.el);
    $('form', s.el).onsubmit = (e) => {
      e.preventDefault();
      v = inp.value.trim() || value;
      inp.blur();
      s.close();
    };
    inp.focus();
    try { inp.setSelectionRange(0, inp.value.length); } catch { /* */ }
    unfit = aboveKeyboard(s.el.parentElement);
  });
}

// Tiene un foglio dal basso sopra la tastiera del telefono (visualViewport). Ritorna la funzione che smette.
function aboveKeyboard(wrap) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const fit = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    wrap.style.paddingBottom = kb > 40 ? `${kb}px` : '';
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
  return () => { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); };
}

function menuSheet(title, items) {
  const s = sheet(`${shead(title)}<div class="card">${items
    .map((it, i) => `<button class="li ${it.cls || ''}" data-i="${i}"><span>${esc(it.label)}</span>${icon(it.icon)}</button>`)
    .join('')}</div>`);
  $$('[data-i]', s.el).forEach((b) => (b.onclick = () => { s.close(); items[+b.dataset.i].run(); }));
}

// Condivisione (menu di iOS: «Salva su File», Drive, AirDrop…) con ripiego sul download.
async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  download(blob, name);
  return true;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Foglio «file pronto»: la condivisione su iOS deve partire da un tocco.
function fileReadySheet(blob, name, title, onSaved) {
  const s = sheet(`${shead(title)}
    <div class="card"><div class="li"><span>${esc(name)}</span><span class="r">${bytes(blob.size)}</span></div></div>
    <div class="actions">
      <button class="btn primary" data-share>${icon('share-2')} ${tr('Salva in File o Drive')}</button>
      <button class="btn" data-dl>${icon('download')} ${tr('Scarica')}</button>
    </div>`);
  $('[data-share]', s.el).onclick = async () => { if (await shareFile(blob, name)) { onSaved && onSaved(); s.close(); } };
  $('[data-dl]', s.el).onclick = () => { download(blob, name); onSaved && onSaved(); s.close(); };
}

// ---------- tema ----------
async function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('pageturn-theme', t); } catch { /* privato */ }
  await db.kvSet('theme', t);
}

async function applyLang(l) {
  setLang(l);
  await db.kvSet('lang', l);
}

// ---------- miniature ----------
// Cache delle miniature per pagina. Una pagina in rielaborazione continua a mostrare la miniatura
// precedente (con un piccolo indicatore) invece di uno spazio vuoto.
const thumbs = new Map(); // pageId → { url, rev, done }
function thumbValid(page, c) {
  if (!c) return false;
  if (page.status !== 'done') return true; // in elaborazione: va bene anche quella vecchia
  return c.done && c.rev === page.rev;
}
let thumbBatch = null;
function thumbURL(page) {
  const c = thumbs.get(page.id);
  if (thumbValid(page, c)) return Promise.resolve(c.url);
  // le richieste dello stesso momento si leggono in un'unica transazione
  if (!thumbBatch) {
    const batch = { pages: new Map(), waiters: new Map() };
    thumbBatch = batch;
    setTimeout(async () => {
      thumbBatch = null;
      const list = [...batch.pages.values()];
      let blobs = [];
      try { blobs = await db.getBlobs(list.map((p) => `${p.id}:thumb`)); } catch { /* */ }
      list.forEach((p, i) => {
        const old = thumbs.get(p.id);
        let url = null;
        if (blobs[i]) {
          if (old) URL.revokeObjectURL(old.url);
          url = URL.createObjectURL(blobs[i]);
          thumbs.set(p.id, { url, rev: p.rev, done: p.status === 'done' });
        } else if (old) url = old.url;
        for (const w of batch.waiters.get(p.id) || []) w(url);
      });
      // limite di memoria: le più vecchie si liberano
      while (thumbs.size > 1500) {
        const [k, v] = thumbs.entries().next().value;
        URL.revokeObjectURL(v.url);
        thumbs.delete(k);
      }
    }, 0);
  }
  thumbBatch.pages.set(page.id, page);
  return new Promise((res) => {
    const ws = thumbBatch.waiters.get(page.id) || [];
    ws.push(res);
    thumbBatch.waiters.set(page.id, ws);
  });
}
function dropThumbs() {
  for (const c of thumbs.values()) URL.revokeObjectURL(c.url);
  thumbs.clear();
}

// ---------- stato ----------
const S = {
  view: 'home',
  project: null,
  pages: new Map(),
  select: false,
  reorder: false,
  selected: new Set(),
  cleanup: null,
};

function newParams(quad) {
  return {
    quad: quad || FULL_QUAD,
    rotation: 0,
    filter: (S.project && S.project.filter) || 'whiten',
    brightness: 0,
    contrast: 0,
    sharpness: 50,
    erase: [],
  };
}

function newPage(quad, extra = {}) {
  return {
    id: db.uid(),
    projectId: S.project.id,
    created: Date.now(),
    rev: 1,
    status: 'pending',
    params: newParams(quad),
    synced: false,
    ...extra,
  };
}

function show(html, cls = '') {
  if (S.cleanup) { const c = S.cleanup; S.cleanup = null; c(); }
  const el = document.createElement('section');
  el.className = `screen ${cls}`;
  el.innerHTML = html;
  app.replaceChildren(el);
  return el;
}

async function loadProject(id) {
  if (!S.project || S.project.id !== id) { editHistory.clear(); S.gridScroll = 0; }
  S.project = await db.getProject(id);
  S.pages = await db.getPages(id);
  return S.project;
}

// ---------- foto importate (rullino, fotocamera di iOS) ----------
async function importFiles(files, { replaceId, index } = {}) {
  if (!files.length) return [];
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
  if (!list.length) return [];
  const t = list.length > 1 ? toastProgress(tr('Importo {n} foto…', { n: list.length })) : null;
  const ids = [];
  try {
    for (let i = 0; i < list.length; i++) {
      // Prima si salva la foto così com'è, poi si cerca la pagina.
      let blob = list[i];
      let det = null;
      try {
        const r = await detectPage(blob);
        det = r.found;
      } catch {
        // formato non leggibile dal browser (es. HEIC su browser non Apple)
        toast(tr('Questo formato di immagine non è supportato'));
        continue;
      }
      const items = pagesFor(blob, det, !replaceId && S.project.double);
      S.project = await db.addPages(S.project.id, items, {
        replaceId: i === 0 ? replaceId : undefined,
        index: index != null ? index + ids.length : undefined,
      });
      for (const it of items) { S.pages.set(it.page.id, it.page); queue.enqueue(it.page.id); ids.push(it.page.id); }
      t && t.set(tr('Importo {i} di {n}…', { i: i + 1, n: list.length }));
    }
  } catch (e) {
    storageError(e);
  } finally {
    t && t.done();
  }
  sync.kick();
  return ids;
}

// Pagine da creare per una foto: una sola, oppure due se è attiva la doppia pagina
// (divise lungo la piega trovata, o a metà se la piega non si vede).
function pagesFor(blob, det, double) {
  if (double && det) {
    const [l, r] = det.halves || splitQuad(det.full || det.quad);
    const a = newPage(l);
    const b = newPage(r, { origId: a.id });
    return [{ page: a, orig: blob }, { page: b, orig: null }];
  }
  // pagina singola: i bordi si rimisurano con UVDoc durante l'elaborazione (vedi queue.js)
  const page = newPage(det ? det.quad : null);
  page.params.auto = true;
  return [{ page, orig: blob }];
}

function toastProgress(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${icon('loader-2', 'spinner')}<span>${esc(msg)}</span>`;
  $('#toasts').append(el);
  return {
    set: (m) => ($('span', el).textContent = m),
    done: () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); },
  };
}

function storageError(e) {
  console.error(e);
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message))) {
    sheet(`${shead(tr('Spazio esaurito'))}<p style="color:var(--text-2);margin:0">${tr('Il telefono non ha più spazio per le scansioni. Esporta un backup o un PDF e libera spazio eliminando i libri già esportati.')}</p>
      <div class="actions"><button class="btn" data-close>${tr('Ok')}</button></div>`);
  } else {
    toast(tr('Salvataggio non riuscito. Riprova.'));
  }
}

// =====================================================================
// HOME
// =====================================================================
async function home() {
  S.view = 'home';
  S.project = null;
  const projects = await db.listProjects();
  const hideBanner = await db.kvGet('hideInstall', false);
  const el = show(`
    <div class="nav"><div class="side"></div><div class="title"></div>
      <div class="side r"><button class="iconbtn" data-a="settings" aria-label="${tr('Impostazioni')}">${icon('settings')}</button></div></div>
    <div class="scroll">
      <div class="head"><h1 class="large">Pageturn</h1></div>
      ${!standalone && !hideBanner ? `<div class="banner">${icon('device-floppy')}<div><b>${tr('Aggiungi Pageturn alla schermata Home')}</b>
        ${isIOS ? tr('Dal pulsante Condividi del browser (Safari, Opera, Chrome…) scegli «Aggiungi alla schermata Home».') : tr('Installa l’app dal menu del browser.')}${sp()}${tr('Così le scansioni non vengono cancellate dal browser.')}</div><button class="x" data-a="hidebanner" aria-label="${tr('Nascondi')}">${icon('x')}</button></div>` : ''}
      ${projects.length ? `<div class="group">${projects.map((p) => `
        <div class="proj" data-a="open" data-id="${p.id}" role="button" tabindex="0">
          <div class="cover" data-cover="${p.order[0] || ''}">${icon('book-2')}</div>
          <div class="meta"><div class="name">${esc(p.name)}</div><div class="sub">${plural(p.order.length, 'pagina', 'pagine')} · ${ago(p.updated)}</div></div>
          <button class="more" data-a="pmenu" data-id="${p.id}" aria-label="${tr('Opzioni')}">${icon('dots')}</button>
        </div>`).join('')}</div>`
        : `<div class="empty"><div class="big">${icon('book')}</div><h2>${tr('Inizia il tuo primo libro')}</h2><p>${tr('Ogni pagina viene salvata appena la scatti, anche se l’app si chiude.')}</p></div>`}
    </div>
    <div class="bar"><button class="btn primary" data-a="new">${icon('plus')} ${tr('Nuovo libro')}</button></div>`);

  // copertine
  for (const c of $$('[data-cover]', el)) {
    const id = c.dataset.cover;
    if (!id) continue;
    db.getBlob(`${id}:thumb`).then((b) => {
      if (!b || !c.isConnected) return;
      const url = URL.createObjectURL(b);
      c.innerHTML = `<img src="${url}" alt="">`;
      c.firstChild.onload = () => URL.revokeObjectURL(url);
    });
  }

  el.onclick = async (e) => {
    const t = e.target.closest('[data-a]');
    if (!t) return;
    const a = t.dataset.a;
    if (a === 'new') {
      const d = new Date().toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
      const name = await promptSheet(tr('Nuovo libro'), '', tr('Crea e scansiona'), tr('Libro del {d}', { d }));
      if (name === null) return;
      const p = await db.createProject(name || tr('Libro del {d}', { d }));
      await loadProject(p.id);
      camera();
    } else if (a === 'open') {
      await loadProject(t.dataset.id);
      project();
    } else if (a === 'pmenu') {
      e.stopPropagation();
      const p = await db.getProject(t.dataset.id);
      projectMenu(p, home);
    } else if (a === 'settings') {
      settings();
    } else if (a === 'hidebanner') {
      await db.kvSet('hideInstall', true);
      t.closest('.banner').remove();
    }
  };
}

function projectMenu(p, after) {
  menuSheet(p.name, [
    { label: tr('Rinomina'), icon: 'pencil', run: async () => {
      const n = await promptSheet(tr('Rinomina'), p.name, tr('Salva'));
      if (n) { p.name = n; p.updated = Date.now(); await db.putProject(p); sync.pushProject(p); after(); }
    } },
    { label: tr('Esporta backup (.zip)'), icon: 'file-zip', run: () => backupFlow(p) },
    { label: tr('Elimina libro'), icon: 'trash', cls: 'danger', run: async () => {
      const ok = await confirmSheet(tr('Eliminare il libro?'), tr('«{name}» e le sue {n} pagine verranno eliminati da questo dispositivo. Il backup sul server, se c’è, resta.', { name: p.name, n: p.order.length }), tr('Elimina'), true);
      if (ok) { await db.deleteProject(p.id); toast(tr('Libro eliminato')); home(); }
    } },
  ]);
}

async function backupFlow(p) {
  const t = toastProgress(tr('Preparo il backup…'));
  try {
    const { buildBackup, slug } = await import('./export.js');
    const blob = await buildBackup(p, ({ done, total }) => t.set(`${tr('Preparo il backup…')} ${done}/${total}`));
    t.done();
    fileReadySheet(blob, `${slug(p.name)}-backup.zip`, tr('Backup pronto'), async () => {
      const fresh = await db.getProject(p.id);
      fresh.lastBackup = Date.now();
      fresh.pagesSinceBackup = 0;
      await db.putProject(fresh);
      if (S.project && S.project.id === p.id) S.project = fresh;
    });
  } catch (e) {
    t.done();
    toast(tr('Backup non riuscito: {e}', { e: e.message }));
  }
}

// =====================================================================
// PAGINE DEL LIBRO
// =====================================================================
let io = null;

function blurMedian() {
  const v = [...S.pages.values()].map((p) => p.sharp).filter((x) => x != null).sort((a, b) => a - b);
  return v.length >= 4 ? v[v.length >> 1] : null;
}

function isBlurry(p, med) {
  if (p.sharp == null || p.blurOk) return false;
  if (med) return p.sharp < med * 0.33;
  return p.sharp < 18;
}

function thumbHTML(p, i, med) {
  const warn = p.status === 'error' || isBlurry(p, med);
  const sel = S.selected.has(p.id);
  // una pagina già elaborata almeno una volta ha una miniatura: si mostra anche mentre si rielabora
  const hasThumb = p.status === 'done' || p.width || thumbs.has(p.id);
  const c = thumbs.get(p.id);
  const img = c && thumbValid(p, c) ? `<img alt="" src="${c.url}" data-id="${p.id}">` : `<img alt="" data-src="${p.id}">`;
  return `<button class="th ${warn ? 'warn' : ''} ${sel ? 'sel' : ''}" data-id="${p.id}">
    <div class="img">${p.status === 'error' ? icon('alert-triangle') : hasThumb ? img : icon('loader-2', 'spinner spin')}</div>
    ${p.status === 'pending' && hasThumb ? `<span class="pend">${icon('loader-2', 'spinner')}</span>` : ''}
    ${warn ? '<span class="badge">!</span>' : ''}
    ${S.select ? `<span class="check">${sel ? icon('check') : ''}</span>` : ''}
    <div class="n">${i + 1}${p.status === 'error' ? ` · ${tr('errore')}` : warn ? ` · ${tr('sfocata')}` : ''}</div></button>`;
}

function statusHTML() {
  const pages = [...S.pages.values()];
  const n = S.project.order.length;
  const pend = pages.filter((p) => p.status === 'pending').length;
  const st = sync.getState();
  let dot = 'ok';
  const parts = [plural(n, 'pagina', 'pagine')];
  if (pend) { parts.push(tr('elaboro {n}', { n: pend })); dot = 'busy'; } else parts.push(tr('tutto salvato'));
  if (st.status === 'syncing') { parts.push(tr('invio al server ({n})', { n: st.pending })); dot = 'busy'; }
  else if (st.status === 'ok') parts.push(tr('copia sul server'));
  else if (st.status === 'error') { parts.push(tr('server non raggiungibile')); if (dot !== 'busy') dot = 'warn'; }
  return `<span class="dot ${dot === 'ok' ? '' : dot}"></span>${parts.join(' · ')}`;
}

async function project() {
  S.view = 'project';
  S.pages = await db.getPages(S.project.id); // stato aggiornato (la coda lavora anche fuori da questa schermata)
  const P = S.project;
  const med = blurMedian();
  const pages = P.order.map((id) => S.pages.get(id)).filter(Boolean);
  const mode = S.reorder ? 'reorder' : S.select ? 'select' : 'normal';
  const nav =
    mode === 'normal'
      ? `<div class="side"><button class="link" data-a="back">${icon('chevron-left')}${tr('Libri')}</button></div><div class="title"></div>
         <div class="side r"><button class="iconbtn" data-a="import" aria-label="${tr('Importa foto')}">${icon('photo-plus')}</button>
         <button class="iconbtn" data-a="select" aria-label="${tr('Seleziona')}">${icon('checkbox')}</button>
         <button class="iconbtn" data-a="menu" aria-label="${tr('Altro')}">${icon('dots')}</button></div>`
      : mode === 'select'
        ? `<div class="side"><button class="link" data-a="all">${S.selected.size === pages.length && pages.length ? tr('Deseleziona') : tr('Seleziona tutte')}</button></div>
           <div class="title">${S.selected.size ? plural(S.selected.size, 'selezionata', 'selezionate') : tr('Seleziona pagine')}</div>
           <div class="side r"><button class="link" data-a="done">${tr('Fine')}</button></div>`
        : `<div class="side"></div><div class="title">${tr('Riordina')}</div><div class="side r"><button class="link" data-a="done">${tr('Fine')}</button></div>`;
  const bottom =
    mode === 'normal'
      ? `<div class="bar"><button class="btn primary" data-a="scan">${icon('camera')} ${tr('Scansiona')}</button><button class="btn" data-a="export" ${pages.length ? '' : 'disabled'}>${tr('Esporta')}</button></div>`
      : mode === 'select'
        ? `<div class="toolbar"><button class="tool" data-a="srotate">${icon('rotate-clockwise')}${tr('Ruota')}</button>
           <button class="tool" data-a="sfilter">${icon('adjustments-horizontal')}${tr('Filtro')}</button>
           <button class="tool" data-a="sdewarp">${icon('wave-sine')}${tr('Distendi')}</button>
           <button class="tool" data-a="sexport">${icon('share-2')}${tr('Esporta')}</button>
           <button class="tool danger" data-a="sdelete">${icon('trash')}${tr('Elimina')}</button></div>`
        : `<div class="modehint" style="padding-bottom:calc(env(safe-area-inset-bottom) + 16px)">${tr('Tieni premuta una pagina e trascinala nella nuova posizione')}</div>`;
  const prevScroll = S.gridScroll || 0;
  const el = show(`
    <div class="nav">${nav}</div>
    <div class="scroll">
      <div class="head"><h1 class="large">${esc(P.name)}</h1><div class="status" id="st">${statusHTML()}</div></div>
      ${pages.length
        ? `<div class="grid ${mode === 'reorder' ? 'reorder' : ''}" id="grid">${pages.map((p, i) => thumbHTML(p, i, med)).join('')}</div>`
        : `<div class="empty"><div class="big">${icon('camera')}</div><h2>${tr('Nessuna pagina')}</h2><p>${tr('Tocca Scansiona per iniziare, oppure importa foto dal rullino.')}</p></div>`}
    </div>
    ${bottom}`);

  const scroller = $('.scroll', el);
  scroller.scrollTop = prevScroll;
  scroller.addEventListener('scroll', () => { S.gridScroll = scroller.scrollTop; }, { passive: true });

  // caricamento pigro delle miniature
  if (io) io.disconnect();
  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const img = en.target;
      io.unobserve(img);
      const p = S.pages.get(img.dataset.src);
      if (p) thumbURL(p).then((u) => u && (img.src = u));
    }
  }, { root: $('.scroll', el), rootMargin: '400px' });
  $$('img[data-src]', el).forEach((i) => io.observe(i));

  const onPage = (e) => {
    const p = e.detail;
    if (p.projectId !== P.id || S.view !== 'project') return;
    S.pages.set(p.id, p);
    const old = $(`.th[data-id="${p.id}"]`, el);
    if (old) {
      const i = P.order.indexOf(p.id);
      old.outerHTML = thumbHTML(p, i, blurMedian());
      const img = $(`.th[data-id="${p.id}"] img[data-src]`, el);
      if (img) io.observe(img);
    }
    $('#st', el).innerHTML = statusHTML();
  };
  const onSync = () => { const s = $('#st', el); if (s) s.innerHTML = statusHTML(); };
  queue.events.addEventListener('page', onPage);
  sync.events.addEventListener('change', onSync);
  S.cleanup = () => {
    queue.events.removeEventListener('page', onPage);
    sync.events.removeEventListener('change', onSync);
    if (io) io.disconnect();
  };

  if (mode === 'reorder') enableReorder(el);

  el.onclick = async (e) => {
    const t = e.target.closest('[data-a], .th');
    if (!t) return;
    if (t.classList.contains('th')) {
      if (S.reorder) return;
      const id = t.dataset.id;
      if (S.select) {
        S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
        return updateSelection(el, pages);
      }
      return editor(id);
    }
    const a = t.dataset.a;
    if (a === 'back') { S.select = S.reorder = false; S.selected.clear(); home(); }
    else if (a === 'scan') camera();
    else if (a === 'import') pickPhotos();
    else if (a === 'select') { S.select = true; S.selected.clear(); project(); }
    else if (a === 'done') { S.select = S.reorder = false; S.selected.clear(); project(); }
    else if (a === 'all') {
      if (S.selected.size === pages.length) S.selected.clear();
      else pages.forEach((p) => S.selected.add(p.id));
      updateSelection(el, pages);
    } else if (a === 'menu') {
      menuSheet(P.name, [
        { label: tr('Riordina pagine'), icon: 'arrows-move', run: () => { S.reorder = true; project(); } },
        { label: tr('Rinomina'), icon: 'pencil', run: async () => {
          const n = await promptSheet(tr('Rinomina'), P.name, tr('Salva'));
          if (n) { P.name = n; await db.putProject(P); sync.pushProject(P); project(); }
        } },
        { label: tr('Esporta backup (.zip)'), icon: 'file-zip', run: () => backupFlow(P) },
        { label: tr('Elimina libro'), icon: 'trash', cls: 'danger', run: async () => {
          const ok = await confirmSheet(tr('Eliminare il libro?'), tr('«{name}» e le sue {n} pagine verranno eliminati da questo dispositivo. Il backup sul server, se c’è, resta.', { name: P.name, n: P.order.length }), tr('Elimina'), true);
          if (ok) { await db.deleteProject(P.id); toast(tr('Libro eliminato')); home(); }
        } },
      ]);
    } else if (a === 'export') exportSheet();
    else if (a === 'sexport') {
      // solo le pagine selezionate, nell'ordine del libro
      if (!S.selected.size) return toast(tr('Seleziona prima le pagine'));
      exportSheet(P.order.filter((id) => S.selected.has(id)));
    } else if (a === 'sdelete') {
      if (!S.selected.size) return toast(tr('Seleziona prima le pagine'));
      const n = S.selected.size;
      if (!(await confirmSheet(tr('Eliminare {pages}?', { pages: plural(n, 'pagina', 'pagine') }), tr('Le pagine verranno eliminate da questo dispositivo.'), tr('Elimina'), true))) return;
      S.project = await db.deletePages(P.id, [...S.selected]);
      for (const id of S.selected) S.pages.delete(id);
      sync.pushProject(S.project);
      S.selected.clear();
      S.select = false;
      toast(plural(n, 'pagina eliminata', 'pagine eliminate'));
      project();
    } else if (a === 'srotate' || a === 'sfilter' || a === 'sdewarp') {
      if (!S.selected.size) return toast(tr('Seleziona prima le pagine'));
      const applyAll = async (fn) => {
        for (const id of S.selected) {
          const p = S.pages.get(id);
          fn(p.params);
          p.rev++;
          p.status = 'pending';
          p.synced = false;
          await db.putPage(p);
          queue.enqueue(p.id);
        }
        sync.kick();
        project();
      };
      if (a === 'srotate') applyAll((pr) => { pr.rotation = ((pr.rotation || 0) + 1) % 4; pr.erase = []; });
      else if (a === 'sdewarp') {
        const all = [...S.selected].every((id) => S.pages.get(id).params.dewarp);
        applyAll((pr) => { pr.erase = tagStrokes(pr.erase, pr.dewarp); pr.dewarp = !all; });
        if (!all) db.kvSet('uvLoaded2', true);
        toast(all ? tr('Pagine non più distese') : tr('Distendo le pagine curve in background'), null, 2600);
      }
      else {
        menuSheet(tr('Filtro per le pagine selezionate'), FILTER_LIST.map(([k, label]) => ({
          label: tr(label), icon: 'adjustments-horizontal', run: async () => {
            await applyAll((pr) => { pr.filter = k; });
            P.filter = k; // diventa il filtro predefinito per le prossime pagine
            await db.putProject(P);
          },
        })));
      }
    }
  };
}

// Selezione aggiornata sul posto: niente ridisegno della griglia, la posizione resta quella.
function updateSelection(el, pages) {
  for (const th of $$('.th', el)) {
    const on = S.selected.has(th.dataset.id);
    th.classList.toggle('sel', on);
    const ck = $('.check', th);
    if (ck) ck.innerHTML = on ? icon('check') : '';
  }
  const t = $('.nav .title', el);
  if (t) t.textContent = S.selected.size ? plural(S.selected.size, 'selezionata', 'selezionate') : tr('Seleziona pagine');
  const all = $('[data-a="all"]', el);
  if (all) all.textContent = S.selected.size === pages.length && pages.length ? tr('Deseleziona') : tr('Seleziona tutte');
}

// Ogni tratto della gomma ricorda su quale pagina è stato fatto (g: 'f' piatta, 'd' distesa):
// accendendo o spegnendo Distendi si sposta con la pagina invece di sparire.
const tagStrokes = (erase, dewarp) => (erase || []).map((s) => (s.g ? s : { ...s, g: dewarp ? 'd' : 'f' }));
const FILTER_LIST = [['original', 'Originale'], ['whiten', 'Sbianca'], ['gray', 'Grigi'], ['bw', 'B/N']];

function pickPhotos(opts = {}) {
  const inp = $('#pick-photos');
  inp.value = '';
  inp.onchange = async () => {
    const files = [...inp.files];
    if (!files.length) return;
    const ids = await importFiles(files, opts);
    if (ids.length && S.view === 'project') project();
    if (ids.length) toast(plural(ids.length, 'foto importata', 'foto importate'));
  };
  inp.click();
}

// Riordino con trascinamento (tenendo premuto).
function enableReorder(el) {
  const grid = $('#grid', el);
  if (!grid) return;
  let drag = null;
  grid.addEventListener('pointerdown', (e) => {
    const th = e.target.closest('.th');
    if (!th) return;
    e.preventDefault();
    const r = th.getBoundingClientRect();
    const clone = th.cloneNode(true);
    clone.classList.add('drag');
    clone.style.width = `${r.width}px`;
    clone.style.left = `${r.left}px`;
    clone.style.top = `${r.top}px`;
    document.body.append(clone);
    th.classList.add('ghost');
    drag = { th, clone, dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    grid.setPointerCapture(e.pointerId);
  });
  grid.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.clone.style.left = `${e.clientX - drag.dx}px`;
    drag.clone.style.top = `${e.clientY - drag.dy}px`;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const target = over && over.closest('.th');
    if (target && target !== drag.th && target.parentNode === grid) {
      const tb = target.getBoundingClientRect();
      const after = e.clientX > tb.left + tb.width / 2;
      grid.insertBefore(drag.th, after ? target.nextSibling : target);
    }
    // scorrimento automatico vicino ai bordi
    const sc = $('.scroll', el);
    const sr = sc.getBoundingClientRect();
    if (e.clientY < sr.top + 60) sc.scrollTop -= 12;
    else if (e.clientY > sr.bottom - 60) sc.scrollTop += 12;
  });
  const end = async () => {
    if (!drag) return;
    drag.clone.remove();
    drag.th.classList.remove('ghost');
    drag = null;
    const order = $$('.th', grid).map((t) => t.dataset.id);
    $$('.th .n', grid).forEach((n, i) => (n.textContent = String(i + 1)));
    S.project.order = order;
    S.project.updated = Date.now();
    await db.putProject(S.project);
    sync.pushProject(S.project);
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);
}

// =====================================================================
// FOTOCAMERA
// =====================================================================
let wakeLock = null;

async function camera({ replaceId } = {}) {
  S.view = 'camera';
  const P = S.project;
  let double = !!P.double;
  let count = P.order.length;
  const el = show(`
    <video playsinline muted autoplay></video>
    <svg class="overlay" id="ov"><path id="qfill" fill="rgba(93,202,165,0.10)"/><path id="qline" fill="none" stroke-width="3" stroke-linecap="round"/></svg>
    <div class="flash" id="flash"></div>
    <div class="top">
      <button class="circle glass" data-a="close" aria-label="${tr('Chiudi')}">${icon('x')}</button>
      <span class="pill glass" id="pill">${esc(P.name)} · ${count}</span>
      <span style="display:flex;gap:8px"><button class="circle glass" data-a="torch" id="torch" hidden aria-label="${tr('Torcia')}">${icon('bolt')}</button>
      <span class="circle glass" id="cloud" title="">${icon('cloud-check')}</span></span>
    </div>
    <div class="hint glass" id="hint"><span class="prog"><i id="prog"></i></span><span id="htext">${tr('Avvio la fotocamera…')}</span></div>
    <div class="bottom">
      <div class="modes">
        ${replaceId ? `<button class="on">${tr('Rifai la pagina')}</button>` : `<button data-a="auto" class="${P.manual ? '' : 'on'}">${tr('Auto')}</button><button data-a="manual" class="${P.manual ? 'on' : ''}">${tr('Manuale')}</button>
        <button data-a="double" class="${double ? 'on' : ''}">${tr('Doppia pagina')}</button>`}
      </div>
      <div class="shutterrow">
        <button class="last" data-a="close" aria-label="${tr('Vai alle pagine')}"><span id="lastimg"></span>${replaceId ? '' : `<span class="count" id="count" ${count ? '' : 'hidden'}>${count}</span>`}</button>
        <button class="shutter" data-a="shoot" aria-label="${tr('Scatta')}"><i></i></button>
        <button class="circle glass" data-a="native" aria-label="${tr('Fotocamera di iOS')}">${icon('camera-plus')}</button>
      </div>
    </div>`, 'cam');

  const video = $('video', el);
  const ov = $('#ov', el);
  let lastURL = null;
  let alive = true;
  const syncDot = () => {
    const st = sync.getState();
    const c = $('#cloud', el);
    if (!c) return;
    c.innerHTML = icon(st.status === 'error' ? 'cloud-off' : st.status === 'syncing' ? 'cloud-upload' : 'cloud-check');
    c.style.color = st.status === 'error' ? '#ef9f27' : '#5dcaa5';
  };
  syncDot();
  sync.events.addEventListener('change', syncDot);

  // ultima miniatura
  const lastId = P.order[P.order.length - 1];
  if (lastId && !replaceId) {
    db.getBlob(`${lastId}:thumb`).then((b) => {
      if (b && alive) { lastURL = URL.createObjectURL(b); $('#lastimg', el).innerHTML = `<img src="${lastURL}" alt="">`; }
    });
  }

  const drawQuad = ({ quad, phase, progress }) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const W = ov.clientWidth;
    const H = ov.clientHeight;
    ov.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const line = $('#qline', ov);
    const fill = $('#qfill', ov);
    const hint = $('#htext', el);
    $('#prog', el).style.width = `${Math.round((progress || 0) * 100)}%`;
    const manual = cam.auto === false;
    if (!quad || !vw) {
      line.setAttribute('d', '');
      fill.setAttribute('d', '');
      hint.textContent = phase === 'turn' ? tr('Gira pagina') : manual ? tr('Tocca il pulsante per scattare') : tr('Inquadra una pagina');
      return;
    }
    const s = Math.min(W / vw, H / vh);
    const ox = (W - vw * s) / 2;
    const oy = (H - vh * s) / 2;
    const p = quad.map(([x, y]) => [ox + x * vw * s, oy + y * vh * s]);
    fill.setAttribute('d', `M${p.map((q) => q.join(',')).join('L')}Z`);
    // angoli a «L»
    let d = '';
    for (let i = 0; i < 4; i++) {
      const a = p[i];
      const nx = p[(i + 1) % 4];
      const pv = p[(i + 3) % 4];
      const seg = (b) => {
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const k = Math.min(28, L * 0.18) / L;
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      };
      const n1 = seg(nx);
      const p1 = seg(pv);
      d += `M${p1.join(',')}L${a.join(',')}L${n1.join(',')}`;
    }
    line.setAttribute('d', d);
    const ready = phase === 'steady';
    line.setAttribute('stroke', phase === 'turn' ? 'rgba(255,255,255,0.5)' : ready ? '#5dcaa5' : '#ffffff');
    fill.setAttribute('fill', ready ? 'rgba(93,202,165,0.12)' : 'rgba(255,255,255,0.05)');
    hint.textContent = phase === 'turn' ? tr('Gira pagina') : manual ? tr('Pagina rilevata · scatta quando vuoi') : ready ? tr('Tieni fermo') : tr('Pagina rilevata');
  };

  const onCapture = async (blob, det) => {
    const f = $('#flash', el);
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
    try {
      const items = pagesFor(blob, det, double && !replaceId);
      S.project = await db.addPages(P.id, items, { replaceId });
      for (const it of items) { S.pages.set(it.page.id, it.page); queue.enqueue(it.page.id); }
      sync.kick();
      if (replaceId) {
        toast(tr('Pagina sostituita'));
        return editor(items[0].page.id);
      }
      count = S.project.order.length;
      $('#pill', el).textContent = `${P.name} · ${count}`;
      const c = $('#count', el);
      if (c) { c.hidden = false; c.textContent = count; }
      if (lastURL) URL.revokeObjectURL(lastURL);
      lastURL = URL.createObjectURL(blob);
      $('#lastimg', el).innerHTML = `<img src="${lastURL}" alt="">`;
      maybeRemindBackup();
    } catch (e) {
      storageError(e);
    }
  };

  const cam = new Camera(video, { onState: drawQuad, onCapture });
  cam.auto = replaceId ? false : !P.manual;

  const start = async () => {
    $('.msg', el)?.remove();
    try {
      await cam.start();
      if (cam.hasTorch()) $('#torch', el).hidden = false;
      try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* non supportato */ }
    } catch (e) {
      console.warn(e);
      const m = document.createElement('div');
      m.className = 'msg';
      m.innerHTML = `${icon('camera', 'big')}<div><b>${tr('Fotocamera non disponibile')}</b><br>
        ${location.protocol !== 'https:' && location.hostname !== 'localhost' ? tr('La fotocamera funziona solo con un indirizzo https.') : tr('Controlla di aver concesso il permesso di usare la fotocamera.')}</div>
        <button class="btn sm primary" data-a="retry">${tr('Riprova')}</button><button class="btn sm" data-a="native">${tr('Usa la fotocamera di iOS')}</button>`;
      el.append(m);
      $('#htext', el).textContent = tr('Fotocamera non disponibile');
    }
  };
  start();

  const onVis = () => {
    if (document.hidden) cam.stop();
    else if (alive && !cam.stream) start();
  };
  document.addEventListener('visibilitychange', onVis);
  S.cleanup = () => {
    alive = false;
    cam.stop();
    document.removeEventListener('visibilitychange', onVis);
    sync.events.removeEventListener('change', syncDot);
    if (lastURL) URL.revokeObjectURL(lastURL);
    try { wakeLock && wakeLock.release(); } catch { /* */ }
    wakeLock = null;
  };

  let torchOn = false;
  el.onclick = async (e) => {
    const t = e.target.closest('[data-a]');
    if (!t) return;
    const a = t.dataset.a;
    if (a === 'close') {
      if (replaceId) return editor(replaceId);
      project();
    } else if (a === 'shoot') cam.manualShoot();
    else if (a === 'retry') start();
    else if (a === 'torch') {
      torchOn = !torchOn;
      if (await cam.setTorch(torchOn)) t.classList.toggle('on', torchOn);
    } else if (a === 'auto' || a === 'manual') {
      cam.auto = a === 'auto';
      P.manual = !cam.auto;
      await db.putProject(Object.assign(await db.getProject(P.id), { manual: P.manual }));
      $$('.modes [data-a="auto"], .modes [data-a="manual"]', el).forEach((b) => b.classList.toggle('on', b.dataset.a === a));
    } else if (a === 'double') {
      double = !double;
      P.double = double;
      await db.putProject(Object.assign(await db.getProject(P.id), { double }));
      t.classList.toggle('on', double);
      toast(double ? tr('Doppia pagina: ogni scatto diventa due pagine') : tr('Una pagina per scatto'), null, 2200);
    } else if (a === 'native') {
      const inp = $('#pick-camera');
      inp.value = '';
      inp.onchange = async () => {
        const ids = await importFiles([...inp.files], { replaceId });
        if (!ids.length) return;
        if (replaceId) return editor(ids[0]);
        count = S.project.order.length;
        $('#pill', el).textContent = `${P.name} · ${count}`;
        const c = $('#count', el);
        if (c) { c.hidden = false; c.textContent = count; }
        maybeRemindBackup();
      };
      inp.click();
    }
  };
}

let remindedAt = 0;
function maybeRemindBackup() {
  const p = S.project;
  if (sync.getState().status !== 'off') return;
  const n = p.pagesSinceBackup || 0;
  if (n < 50 || n - remindedAt < 50) return;
  remindedAt = n;
  toast(tr('{n} pagine senza una copia fuori dal telefono', { n }), { label: tr('Backup'), run: () => backupFlow(p) }, 6000);
}

// =====================================================================
// MODIFICA PAGINA
// =====================================================================
// Cronologia delle modifiche (annulla / ripeti), per pagina, finché si resta nel libro.
const editHistory = new Map();
const hist = (id) => {
  if (!editHistory.has(id)) editHistory.set(id, { undo: [], redo: [] });
  return editHistory.get(id);
};

// Rotazione di un punto normalizzato di k quarti di giro in senso orario (come la pagina).
const rotPt = ([x, y], k) => {
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) [x, y] = [1 - y, x];
  return [x, y];
};

// Parti di una pagina divisa lungo una linea dall'alto (xt) al basso (xb) dell'anteprima,
// nello spazio della pagina non ruotata; poi riportate nella foto originale.
function splitByLine(quad, k, xt, xb) {
  const P = rotPt([xt, 0], 4 - k);
  const Q = rotPt([xb, 1], 4 - k);
  let first;
  let second;
  if (k === 0) { first = [[0, 0], P, Q, [0, 1]]; second = [P, [1, 0], [1, 1], Q]; }
  else if (k === 2) { first = [Q, [1, 0], [1, 1], P]; second = [[0, 0], Q, P, [0, 1]]; }
  else if (k === 1) { first = [P, Q, [1, 1], [0, 1]]; second = [[0, 0], [1, 0], Q, P]; }
  else { first = [[0, 0], [1, 0], P, Q]; second = [Q, P, [1, 1], [0, 1]]; }
  const H = homography(1, 1, quad);
  const map = ([u, v]) => {
    const z = H[6] * u + H[7] * v + H[8];
    return [(H[0] * u + H[1] * v + H[2]) / z, (H[3] * u + H[4] * v + H[5]) / z];
  };
  return [first.map(map), second.map(map)];
}

// Dalla foto originale all'anteprima: inversa dell'omografia del ritaglio, poi rotazione.
function origToPreview(quad, k, pt) {
  const H = homography(1, 1, quad);
  const [a, b, c, d, e, f, g, h] = H;
  // inversa 3×3
  const A = e - f * h; const B = f * g - d; const C = d * h - e * g;
  const D = c * h - b; const E = a - c * g; const F = b * g - a * h;
  const G = b * f - c * e; const Hh = c * d - a * f; const I = a * e - b * d;
  const [x, y] = pt;
  const z = C * x + F * y + I;
  return rotPt([(A * x + D * y + G) / z, (B * x + E * y + Hh) / z], k);
}

// ---------- vista libera: schermo intero con zoom e trascinamento ----------
// load(kind) restituisce il blob da mostrare: 'page' (pagina elaborata, piena risoluzione) o 'orig' (foto).
function openZoom(load) {
  const wrap = document.createElement('div');
  wrap.className = 'zoomview';
  wrap.innerHTML = `<div class="ztop">
      <button class="circle glass" data-z="close" aria-label="${tr('Chiudi')}">${icon('x')}</button>
      <div class="seg zseg"><button data-z="page" class="on">${tr('Pagina')}</button><button data-z="orig">${tr('Foto originale')}</button></div>
      <span class="zpct"></span></div>
    <div class="zarea"><img alt="" draggable="false"><span class="zbusy">${icon('loader-2', 'spinner')}</span></div>
    <div class="zhint">${tr('Pizzica o doppio tocco per ingrandire, trascina per spostarti')}</div>`;
  document.body.append(wrap);
  const area = $('.zarea', wrap);
  const img = $('img', wrap);
  const busy = $('.zbusy', wrap);
  const pct = $('.zpct', wrap);
  let url = null;
  let nw = 0;
  let nh = 0;
  let s = 1;
  let tx = 0;
  let ty = 0;
  let fit = 1;
  let kind = 'page';
  let loadTok = 0;

  const AW = () => area.clientWidth;
  const AH = () => area.clientHeight;
  function clamp() {
    const w = nw * s;
    const h = nh * s;
    tx = w <= AW() ? (AW() - w) / 2 : Math.min(0, Math.max(AW() - w, tx));
    ty = h <= AH() ? (AH() - h) / 2 : Math.min(0, Math.max(AH() - h, ty));
  }
  function apply() {
    clamp();
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    pct.textContent = nw ? `${Math.round(s * 100)}%` : '';
  }
  function toFit() {
    fit = Math.min(AW() / nw, AH() / nh);
    s = fit;
    apply();
  }
  // zoom attorno a un punto dello schermo (cx, cy relativi all'area)
  function zoomAt(ns, cx, cy) {
    ns = Math.min(Math.max(ns, fit * 0.9), Math.max(4, fit * 2));
    const ix = (cx - tx) / s;
    const iy = (cy - ty) / s;
    s = ns;
    tx = cx - ix * s;
    ty = cy - iy * s;
    apply();
  }

  async function show(k) {
    kind = k;
    $$('.zseg button', wrap).forEach((b) => b.classList.toggle('on', b.dataset.z === k));
    const my = ++loadTok;
    busy.hidden = false;
    try {
      const blob = await load(k);
      if (my !== loadTok || !wrap.isConnected) return;
      const u = URL.createObjectURL(blob);
      const im = new Image();
      im.src = u;
      await im.decode().catch(() => {});
      if (my !== loadTok || !wrap.isConnected) { URL.revokeObjectURL(u); return; }
      // stesso punto relativo quando si passa da pagina a foto
      const keep = nw && s > fit * 1.05 ? { fx: (AW() / 2 - tx) / (nw * s), fy: (AH() / 2 - ty) / (nh * s), rel: s / fit } : null;
      if (url) URL.revokeObjectURL(url);
      url = u;
      img.src = u;
      nw = im.naturalWidth;
      nh = im.naturalHeight;
      img.style.width = `${nw}px`;
      img.style.height = `${nh}px`;
      toFit();
      if (keep) {
        s = fit * keep.rel;
        tx = AW() / 2 - keep.fx * nw * s;
        ty = AH() / 2 - keep.fy * nh * s;
        apply();
      }
    } catch (e) {
      toast(tr('Immagine non disponibile: {e}', { e: e.message }));
    } finally {
      if (my === loadTok) busy.hidden = true;
    }
  }

  // gesti: un dito trascina, due dita pizzicano, doppio tocco alterna adatta / 100%
  const pts = new Map();
  let g = null;
  let lastTap = null;
  const local = (e) => { const b = area.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  function startGesture() {
    const v = [...pts.values()];
    if (v.length >= 2) {
      const [a, b] = v;
      g = { pinch: true, d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], s, tx, ty };
    } else if (v.length === 1) {
      g = { pinch: false, p: v[0], tx, ty, moved: false };
    } else g = null;
  }
  area.addEventListener('pointerdown', (e) => {
    area.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    startGesture();
  });
  area.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, local(e));
    const v = [...pts.values()];
    if (g.pinch && v.length >= 2) {
      const [a, b] = v;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ns = Math.min(Math.max(g.s * (d / g.d), fit * 0.9), Math.max(4, fit * 2));
      const ix = (g.m[0] - g.tx) / g.s;
      const iy = (g.m[1] - g.ty) / g.s;
      s = ns;
      tx = m[0] - ix * s;
      ty = m[1] - iy * s;
      apply();
    } else if (!g.pinch) {
      const p = v[0];
      if (Math.hypot(p[0] - g.p[0], p[1] - g.p[1]) > 6) g.moved = true;
      tx = g.tx + p[0] - g.p[0];
      ty = g.ty + p[1] - g.p[1];
      apply();
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    const wasTap = g && !g.pinch && !g.moved && pts.size === 1;
    pts.delete(e.pointerId);
    startGesture();
    if (!wasTap) { lastTap = null; return; }
    const now = Date.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(p[0] - lastTap.p[0], p[1] - lastTap.p[1]) < 30) {
      lastTap = null;
      if (s > fit * 1.05) toFit();
      else zoomAt(Math.max(1, fit * 2.5), p[0], p[1]); // 100%: un pixel dell'immagine per punto dello schermo
    } else lastTap = { t: now, p };
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
  area.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [cx, cy] = local(e);
    zoomAt(s * Math.exp(-e.deltaY / 300), cx, cy);
  }, { passive: false });
  const ro = new ResizeObserver(() => { if (nw) { const was = s <= fit * 1.01; fit = Math.min(AW() / nw, AH() / nh); if (was) s = fit; apply(); } });
  ro.observe(area);

  function close() {
    loadTok++;
    ro.disconnect();
    if (url) URL.revokeObjectURL(url);
    wrap.remove();
  }
  wrap.addEventListener('click', (e) => {
    const t = e.target.closest('[data-z]');
    if (!t) return;
    if (t.dataset.z === 'close') close();
    else if (t.dataset.z !== kind) show(t.dataset.z);
  });
  show('page');
}

// Pagine elaborate già lette (la corrente e le vicine): passare da una pagina all'altra è immediato.
const procCache = new Map(); // pageId → { rev, blob }
async function procBlob(page) {
  const c = procCache.get(page.id);
  if (c && c.rev === page.rev) return c.blob;
  const blob = await db.getBlob(`${page.id}:proc`);
  if (blob) {
    procCache.set(page.id, { rev: page.rev, blob });
    while (procCache.size > 5) procCache.delete(procCache.keys().next().value);
  }
  return blob;
}
function prefetchNeighbors(P, idx) {
  for (const j of [idx + 1, idx - 1]) {
    const id = P.order[j];
    const p = id && S.pages.get(id);
    if (p && p.status === 'done') procBlob(p).then((b) => { if (b) { const im = new Image(); im.src = URL.createObjectURL(b); im.decode().catch(() => {}).finally(() => URL.revokeObjectURL(im.src)); } });
  }
}

async function editor(pageId) {
  S.view = 'editor';
  const P = S.project;
  let page = S.pages.get(pageId) || (await db.getPage(pageId));
  if (!page) return project();
  const idx = P.order.indexOf(pageId);
  const params = structuredClone(page.params);
  let orig = null;
  const origP = db.getBlob(db.origKey(page)).then((b) => (orig = b));
  const cacheKey = `${db.origKey(page)}`;
  let mode = 'view';
  let dirty = false;
  let pvURL = null;
  let origURL = null;
  let token = 0;
  let pvTimer = 0;
  let keepStrokes = false;
  // geometria (ritaglio, rotazione, Distendi) dell'immagine mostrata: la gomma lavora solo se coincide
  const geomKey = (pr) => JSON.stringify([pr.quad || null, pr.rotation || 0, !!pr.dewarp]);
  let shownGeom = page.status === 'done' ? geomKey(page.params) : null;
  let pw = page.width || 3;
  let ph = page.height || 4;

  const el = show(`
    <div class="nav">
      <div class="side"><button class="link" data-a="back">${icon('chevron-left')}${tr('Pagine')}</button></div>
      <div class="title" style="display:flex;align-items:center;justify-content:center;gap:2px">
        <button class="iconbtn plain" data-a="prev" aria-label="${tr('Pagina precedente')}" ${idx > 0 ? '' : 'style="visibility:hidden"'}>${icon('chevron-left')}</button>
        <span>${tr('Pagina {i} di {n}', { i: idx + 1, n: P.order.length })}</span>
        <button class="iconbtn plain" data-a="next" aria-label="${tr('Pagina successiva')}" ${idx < P.order.length - 1 ? '' : 'style="visibility:hidden"'}>${icon('chevron-right')}</button>
      </div>
      <div class="side r"><button class="link" data-a="done">${tr('Fatto')}</button></div>
    </div>
    <div class="stage" id="stage"><img id="pv" alt=""><svg id="ov"></svg><canvas id="cv"></canvas><canvas id="loupe" class="loupe" hidden></canvas><span class="busy" id="busy" hidden>${icon('loader-2', 'spinner')}</span>
      <div class="histbtns"><button class="circle glass" data-a="undo" aria-label="${tr('Annulla modifica')}">${icon('arrow-back-up')}</button><button class="circle glass" data-a="redoh" aria-label="${tr('Ripeti')}">${icon('arrow-forward-up')}</button></div>
      <button class="circle glass zoombtn" data-a="zoom" aria-label="${tr('Schermo intero con zoom')}">${icon('arrows-maximize')}</button></div>
    <div id="controls"></div>`);
  const stage = $('#stage', el);
  const pv = $('#pv', el);
  const ov = $('#ov', el);
  const cv = $('#cv', el);
  const controls = $('#controls', el);

  // Immagine iniziale: subito la miniatura (già in memoria), poi la pagina elaborata. Se la pagina
  // è in rielaborazione si mostra intanto la versione precedente e si calcola l'anteprima.
  const th0 = thumbs.get(page.id);
  if (th0) pv.src = th0.url;
  $('#busy', el).hidden = false;
  showProc().then((ok) => {
    if (!ok || page.status !== 'done') preview();
    else $('#busy', el).hidden = true;
    prefetchNeighbors(P, idx);
  });

  async function showProc() {
    const blob = await procBlob(page);
    if (!blob || S.view !== 'editor' || token) return false;
    const u = URL.createObjectURL(blob);
    const im = new Image();
    im.src = u;
    try { await im.decode(); } catch { /* */ }
    if (token) { URL.revokeObjectURL(u); return false; } // nel frattempo è partita un'anteprima
    pv.src = u;
    pvURL = u;
    shownGeom = geomKey(page.params);
    return true;
  }

  // onShown: chiamata quando la nuova immagine è davvero visibile (per togliere i tratti provvisori senza sfarfallio)
  function setPreview(blob, onShown) {
    const u = URL.createObjectURL(blob);
    pv.onload = () => {
      pv.onload = null;
      if (keepStrokes && mode !== 'erase') { cv.width = cv.height = 0; keepStrokes = false; }
      if (onShown) onShown();
    };
    pv.src = u;
    if (pvURL) URL.revokeObjectURL(pvURL);
    pvURL = u;
  }

  function preview(delay = 0) {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(async () => {
      const my = ++token;
      $('#busy', el).hidden = false;
      const gk = geomKey(params);
      const nInc = (params.erase || []).length; // tratti della gomma compresi in questa anteprima
      try {
        await origP;
        const r = await renderPage(orig, params, { maxSide: 1200, quality: 0.86, cacheKey });
        if (my !== token || mode === 'crop') return;
        pw = r.width;
        ph = r.height;
        setPreview(r.blob, () => {
          shownGeom = gk;
          // gomma: i tratti ora sono nell'immagine vera, restano disegnati solo quelli più recenti
          if (mode === 'erase' && eraseCtx) { eraseBase = Math.min(nInc, params.erase.length); redrawStrokes(); }
        });
      } catch (e) {
        console.warn(e);
      } finally {
        if (my === token) $('#busy', el).hidden = true;
      }
    }, delay);
  }

  function change() {
    dirty = true;
    preview(110);
  }

  // ---- annulla / ripeti ----
  const H0 = hist(page.id);
  let lastMark = 0;
  // da chiamare prima di ogni modifica: i movimenti continui dei cursori diventano un solo passo
  function mark(group = '') {
    const now = Date.now();
    if (group && group === mark.g && now - lastMark < 800) { lastMark = now; return; }
    mark.g = group;
    lastMark = now;
    H0.undo.push({ t: 'p', params: structuredClone(params) });
    if (H0.undo.length > 60) H0.undo.shift();
    H0.redo.length = 0;
    histButtons();
  }
  function allBadge() {
    const x = $('#allbadge', el);
    if (x) x.hidden = !P.applyAll;
  }
  function histButtons() {
    const u = $('[data-a="undo"]', el);
    const r = $('[data-a="redoh"]', el);
    if (u) u.style.opacity = H0.undo.length ? 1 : 0.35;
    if (r) r.style.opacity = H0.redo.length ? 1 : 0.35;
  }
  async function stepHistory(from, to) {
    const e = from.pop();
    if (!e) return;
    mark.g = '';
    if (e.t === 'p') {
      to.push({ t: 'p', params: structuredClone(params) });
      for (const k of Object.keys(params)) delete params[k];
      Object.assign(params, structuredClone(e.params));
      dirty = true;
      toView(true);
      histButtons();
    } else if (e.t === 'split') {
      if (from === H0.undo) {
        // annulla la divisione: via la pagina gemella, torna il ritaglio di prima
        S.project = await db.deletePages(P.id, [e.twinId]);
        S.pages.delete(e.twinId);
        sync.pushProject(S.project);
        to.push({ t: 'split', line: e.line, params: structuredClone(e.params) });
        Object.assign(params, structuredClone(e.params));
        dirty = true;
        await commit();
        toast(tr('Divisione annullata'));
        editor(page.id);
      } else {
        Object.assign(params, structuredClone(e.params));
        await doSplit(e.line[0], e.line[1], { keepRedo: true });
      }
    }
  }

  // rettangolo occupato dall'immagine dentro lo stage (object-fit: contain, margine 10px)
  function imgRect(nw, nh) {
    const W = stage.clientWidth - 20;
    const H = stage.clientHeight - 20;
    const s = Math.min(W / nw, H / nh);
    return { x: 10 + (W - nw * s) / 2, y: 10 + (H - nh * s) / 2, w: nw * s, h: nh * s };
  }

  // ---- pannelli ----
  function panelView() {
    ov.innerHTML = '';
    if (!keepStrokes) cv.width = cv.height = 0; // i tratti della gomma restano finché arriva l'anteprima nuova
    if (params.sharpness == null) params.sharpness = 50;
    const pct = (v, lo, hi) => ((v - lo) / (hi - lo)) * 100;
    const sl = (k, label, lo = -100, hi = 100) => `<label class="slider"><span>${label}</span>
      <input type="range" min="${lo}" max="${hi}" step="1" value="${params[k]}" data-k="${k}" data-lo="${lo}" data-hi="${hi}" style="--p:${pct(params[k], lo, hi)}%">
      <span class="v">${lo < 0 && params[k] > 0 ? '+' : ''}${params[k]}</span></label>`;
    controls.innerHTML = `
      <div class="panel">
        <div class="allbadge" id="allbadge" ${P.applyAll ? '' : 'hidden'}>${icon('copy')} ${tr('Le modifiche valgono per tutte le pagine')}</div>
        <div class="seg" role="tablist">${FILTER_LIST.map(([k, l]) => `<button data-f="${k}" class="${params.filter === k ? 'on' : ''}">${tr(l)}</button>`).join('')}</div>
        <div class="sliders">${sl('brightness', tr('Luminosità'))}${sl('contrast', tr('Contrasto'))}${sl('sharpness', tr('Nitidezza'), 0, 100)}</div>
      </div>
      <div class="toolbar" style="margin-top:10px">
        <button class="tool" data-a="crop">${icon('crop')}${tr('Ritaglia')}</button>
        <button class="tool" data-a="split">${icon('columns-2')}${tr('Dividi')}</button>
        <button class="tool" data-a="rotate">${icon('rotate-clockwise')}${tr('Ruota')}</button>
        <button class="tool ${params.dewarp ? 'on' : ''}" data-a="dewarp">${icon('wave-sine')}${tr('Distendi')}</button>
        <button class="tool" data-a="erase">${icon('eraser')}${tr('Gomma')}</button>
        <button class="tool" data-a="redo">${icon('camera-rotate')}${tr('Rifai')}</button>
        <button class="tool" data-a="more">${icon('dots')}${tr('Altro')}</button>
      </div>`;
    $$('[data-f]', controls).forEach((b) => (b.onclick = () => {
      mark();
      params.filter = b.dataset.f;
      $$('[data-f]', controls).forEach((x) => x.classList.toggle('on', x === b));
      change();
    }));
    $$('input[type=range]', controls).forEach((r) => (r.oninput = () => {
      mark(r.dataset.k);
      params[r.dataset.k] = +r.value;
      const lo = +r.dataset.lo;
      r.style.setProperty('--p', `${pct(+r.value, lo, +r.dataset.hi)}%`);
      r.nextElementSibling.textContent = `${lo < 0 && +r.value > 0 ? '+' : ''}${r.value}`;
      change();
    }));
  }

  // ---- ritaglio ----
  let quad = null;
  let ow = 0;
  let oh = 0;
  async function panelCrop() {
    mode = 'crop';
    token++;
    $('#busy', el).hidden = true;
    quad = structuredClone(params.quad || FULL_QUAD);
    await origP;
    if (!origURL) origURL = URL.createObjectURL(orig);
    pv.src = origURL;
    await pv.decode().catch(() => {});
    ow = pv.naturalWidth;
    oh = pv.naturalHeight;
    controls.innerHTML = `
      <div class="modehint">${tr('Trascina gli angoli, o il centro di un lato per spostarlo tutto')}</div>
      <div class="row2"><button class="btn sm" style="flex:1" data-c="detect">${icon('wand')} ${tr('Rileva')}</button>
      <button class="btn sm" style="flex:1" data-c="full">${tr('Tutta la foto')}</button></div>
      <div class="bar"><button class="btn" data-c="cancel">${tr('Annulla')}</button><button class="btn primary" data-c="apply">${tr('Applica')}</button></div>`;
    drawCrop();
    controls.onclick = async (e) => {
      const c = e.target.closest('[data-c]');
      if (!c) return;
      const k = c.dataset.c;
      if (k === 'detect') {
        await origP;
        let found = null;
        if (await queue.uvReady()) found = await detectPageUV(orig).catch(() => null);
        if (!found) found = (await detectPage(orig)).found;
        if (found) { quad = found.quad; drawCrop(); } else toast(tr('Bordi non trovati: sistemali a mano'));
      } else if (k === 'full') { quad = structuredClone(FULL_QUAD); drawCrop(); }
      else if (k === 'cancel') toView(!pvURL);
      else if (k === 'apply') {
        mark();
        params.quad = quad;
        delete params.auto; // bordi scelti qui: non si rimisurano più da soli
        params.erase = []; // i tratti della gomma non corrispondono più
        dirty = true;
        toView(true);
      }
    };
  }

  function drawCrop() {
    const r = imgRect(ow, oh);
    ov.setAttribute('viewBox', `0 0 ${stage.clientWidth} ${stage.clientHeight}`);
    const p = quad.map(([x, y]) => [r.x + x * r.w, r.y + y * r.h]);
    const mids = p.map((a2, i) => { const b2 = p[(i + 1) % 4]; return [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2, Math.atan2(b2[1] - a2[1], b2[0] - a2[0])]; });
    ov.innerHTML = `<path class="quadline" d="M${p.map((q) => q.join(',')).join('L')}Z"/>`
      + mids.map(([x, y, ang]) => `<rect class="handle" x="${x - 14}" y="${y - 5}" width="28" height="10" rx="5" transform="rotate(${(ang * 180) / Math.PI} ${x} ${y})"/>`).join('')
      + p.map(([x, y], i) => `<circle class="handle" data-h="${i}" cx="${x}" cy="${y}" r="11"/>`).join('');
  }

  let dragH = -1;
  let edgeDrag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (mode === 'crop') {
      const r = imgRect(ow, oh);
      const b = stage.getBoundingClientRect();
      const x = e.clientX - b.left;
      const y = e.clientY - b.top;
      let best = -1;
      let bd = 48;
      quad.forEach(([qx, qy], i) => {
        const d = Math.hypot(r.x + qx * r.w - x, r.y + qy * r.h - y);
        if (d < bd) { bd = d; best = i; }
      });
      // a metà di un lato: si sposta tutto il lato, parallelo a sé stesso
      edgeDrag = null;
      if (best < 0) {
        let be = 36;
        for (let i = 0; i < 4; i++) {
          const a2 = quad[i];
          const b2 = quad[(i + 1) % 4];
          const mx = r.x + ((a2[0] + b2[0]) / 2) * r.w;
          const my = r.y + ((a2[1] + b2[1]) / 2) * r.h;
          const d = Math.hypot(mx - x, my - y);
          if (d < be) { be = d; edgeDrag = { i, x0: x, y0: y, q0: structuredClone(quad) }; }
        }
      }
      dragH = best;
      if (best >= 0) { stage.setPointerCapture(e.pointerId); drawLoupe(quad[best]); }
      else if (edgeDrag) stage.setPointerCapture(e.pointerId);
    } else if (mode === 'erase') {
      if (e.target.closest('button')) return;
      eraseStart(e);
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (mode === 'crop' && dragH >= 0) {
      const r = imgRect(ow, oh);
      const b = stage.getBoundingClientRect();
      quad[dragH] = [
        Math.min(1, Math.max(0, (e.clientX - b.left - r.x) / r.w)),
        Math.min(1, Math.max(0, (e.clientY - b.top - r.y) / r.h)),
      ];
      drawCrop();
      drawLoupe(quad[dragH]);
    } else if (mode === 'crop' && edgeDrag) {
      const r = imgRect(ow, oh);
      const b = stage.getBoundingClientRect();
      const { i, q0 } = edgeDrag;
      const a2 = q0[i];
      const b2 = q0[(i + 1) % 4];
      // solo lo spostamento perpendicolare al lato
      const ex = (b2[0] - a2[0]) * r.w;
      const ey = (b2[1] - a2[1]) * r.h;
      const L = Math.hypot(ex, ey) || 1;
      const nx = -ey / L;
      const ny = ex / L;
      const dx = e.clientX - b.left - edgeDrag.x0;
      const dy = e.clientY - b.top - edgeDrag.y0;
      const t = dx * nx + dy * ny;
      const cl = (v) => Math.min(1, Math.max(0, v));
      for (const j of [i, (i + 1) % 4]) quad[j] = [cl(q0[j][0] + (t * nx) / r.w), cl(q0[j][1] + (t * ny) / r.h)];
      drawCrop();
      drawLoupe([(quad[i][0] + quad[(i + 1) % 4][0]) / 2, (quad[i][1] + quad[(i + 1) % 4][1]) / 2]);
    } else if (mode === 'erase') eraseMove(e);
  });
  // Lente: ingrandimento attorno all'angolo che si sta spostando, dal lato opposto al dito.
  const loupe = $('#loupe', el);
  function drawLoupe(pt) {
    const S2 = 128;
    const Z = 3; // ingrandimento rispetto all'immagine sullo schermo
    const dpr = devicePixelRatio || 1;
    loupe.hidden = false;
    loupe.width = loupe.height = S2 * dpr;
    const r = imgRect(ow, oh);
    // a sinistra o a destra, lontano dal dito
    const left = pt[0] > 0.5;
    loupe.style.left = left ? '12px' : '';
    loupe.style.right = left ? '' : '12px';
    const x = loupe.getContext('2d');
    const k = ow / r.w; // pixel della foto per pixel dello schermo
    const half = (S2 / 2 / Z) * k;
    const cx = pt[0] * ow;
    const cy = pt[1] * oh;
    x.save();
    x.scale(dpr, dpr);
    x.fillStyle = '#111';
    x.fillRect(0, 0, S2, S2);
    x.imageSmoothingQuality = 'high';
    x.drawImage(pv, cx - half, cy - half, half * 2, half * 2, 0, 0, S2, S2);
    // lati del ritaglio dentro la lente
    const toL = ([qx, qy]) => [((qx * ow - cx) / half) * (S2 / 2) + S2 / 2, ((qy * oh - cy) / half) * (S2 / 2) + S2 / 2];
    x.strokeStyle = 'rgba(91,155,224,0.95)';
    x.lineWidth = 2;
    x.beginPath();
    quad.forEach((q, i) => { const [a2, b2] = toL(q); i ? x.lineTo(a2, b2) : x.moveTo(a2, b2); });
    x.closePath();
    x.stroke();
    // mirino
    x.strokeStyle = '#fff';
    x.lineWidth = 1.5;
    x.beginPath();
    x.moveTo(S2 / 2 - 10, S2 / 2); x.lineTo(S2 / 2 + 10, S2 / 2);
    x.moveTo(S2 / 2, S2 / 2 - 10); x.lineTo(S2 / 2, S2 / 2 + 10);
    x.stroke();
    x.restore();
  }

  const up = () => {
    loupe.hidden = true;
    if (mode === 'crop') { dragH = -1; edgeDrag = null; }
    else if (mode === 'erase') eraseEnd();
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  // ---- gomma ----
  // I tratti si disegnano subito sopra l'anteprima, senza rielaborare la pagina a ogni tratto:
  // la pagina si rielabora una volta sola, quando si tocca Fine.
  let brush = 3; // % della larghezza
  let stroke = null;
  let eraseBase = 0; // tratti già presenti nell'anteprima quando si è aperta la gomma
  let eraseCtx = null;
  let paper = 'rgb(255,255,255)';
  // La tela dei tratti deve avere esattamente le misure dell'area mostrata: va dimensionata dopo
  // aver cambiato i controlli (l'area dell'immagine cambia altezza) e ogni volta che si ridimensiona.
  function fitCanvas() {
    if (!eraseCtx) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(stage.clientWidth * dpr);
    cv.height = Math.round(stage.clientHeight * dpr);
    eraseCtx.setTransform(cv.width / stage.clientWidth, 0, 0, cv.height / stage.clientHeight, 0, 0);
    eraseCtx.lineCap = eraseCtx.lineJoin = 'round';
    redrawStrokes();
  }
  function panelErase() {
    mode = 'erase';
    ov.innerHTML = '';
    eraseCtx = cv.getContext('2d');
    params.erase = params.erase || [];
    eraseBase = params.erase.length;
    paper = paperColor();
    controls.innerHTML = `
      <div class="modehint">${tr('Passa il dito su macchie, segni e dita sul bordo')}</div>
      <div class="panel"><div class="sliders"><label class="slider"><span>${tr('Pennello')}</span>
        <input type="range" min="1" max="10" step="0.5" value="${brush}" id="brush" style="--p:${((brush - 1) / 9) * 100}%"><span class="v"></span></label></div></div>
      <div class="bar"><button class="btn" data-c="undo">${icon('arrow-back-up')} ${tr('Annulla tratto')}</button><button class="btn primary" data-c="ok">${tr('Fine')}</button></div>`;
    fitCanvas();
    const b = $('#brush', controls);
    b.oninput = () => { brush = +b.value; b.style.setProperty('--p', `${((brush - 1) / 9) * 100}%`); };
    controls.onclick = (e) => {
      const c = e.target.closest('[data-c]');
      if (!c) return;
      if (c.dataset.c === 'undo') {
        if (!params.erase.length) return;
        mark();
        params.erase.pop();
        eraseBase = Math.min(eraseBase, params.erase.length);
        redrawStrokes();
        dirty = true;
        preview(150);
      } else {
        // tratti non ancora nell'anteprima: restano visibili finché arriva quella nuova
        const pending = params.erase.length > eraseBase;
        eraseCtx = null;
        keepStrokes = pending;
        toView(pending);
      }
    };
  }

  // colore della carta nell'anteprima (bianco con i filtri da documento)
  function paperColor() {
    if (params.filter !== 'original') return 'rgb(255,255,255)';
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const x = c.getContext('2d');
      x.drawImage(pv, 0, 0, 8, 8);
      const d = x.getImageData(0, 0, 8, 8).data;
      let best = 0;
      for (let i = 4; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > d[best] + d[best + 1] + d[best + 2]) best = i;
      return `rgb(${d[best]},${d[best + 1]},${d[best + 2]})`;
    } catch {
      return 'rgb(255,255,255)';
    }
  }

  function toScreen([px, py], r) {
    return [r.x + px * r.w, r.y + py * r.h];
  }
  function drawSeg(a, b2, rad, r) {
    const x = eraseCtx;
    x.strokeStyle = paper;
    x.lineWidth = rad * r.w * 2;
    const A = toScreen(a, r);
    const B = toScreen(b2, r);
    x.beginPath();
    x.moveTo(A[0], A[1]);
    x.lineTo(B[0] + (A[0] === B[0] && A[1] === B[1] ? 0.01 : 0), B[1]);
    x.stroke();
  }
  function redrawStrokes() {
    if (!eraseCtx) return;
    const r = shownRect();
    eraseCtx.clearRect(0, 0, cv.width, cv.height);
    for (const st of params.erase.slice(eraseBase)) {
      for (let i = 0; i < st.pts.length; i++) drawSeg(st.pts[Math.max(0, i - 1)], st.pts[i], st.r, r);
    }
  }

  // rettangolo dell'immagine davvero mostrata (non le dimensioni salvate, che possono essere di una versione precedente)
  const shownRect = () => imgRect(pv.naturalWidth || pw, pv.naturalHeight || ph);
  function erasePt(e) {
    const r = shownRect();
    const b = stage.getBoundingClientRect();
    return [(e.clientX - b.left - r.x) / r.w, (e.clientY - b.top - r.y) / r.h];
  }
  function eraseStart(e) {
    if (!eraseCtx) return;
    // finché l'anteprima non è aggiornata (es. dopo un ritaglio) i tratti finirebbero nel punto sbagliato
    if (shownGeom !== geomKey(params)) { toast(tr('Attendi l’anteprima aggiornata'), null, 1500); return; }
    stage.setPointerCapture(e.pointerId);
    const p0 = erasePt(e);
    stroke = { r: brush / 100, pts: [p0] };
    drawSeg(p0, p0, stroke.r, shownRect());
    eraseLoupe(p0);
  }
  function eraseMove(e) {
    if (!stroke) return;
    const r = shownRect();
    // anche i punti intermedi che il telefono raccoglie tra due eventi
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const p1 = erasePt(ev);
      const p0 = stroke.pts[stroke.pts.length - 1];
      if (Math.hypot((p1[0] - p0[0]) * r.w, (p1[1] - p0[1]) * r.h) < 1.5) continue;
      stroke.pts.push(p1);
      drawSeg(p0, p1, stroke.r, r);
    }
    eraseLoupe(stroke.pts[stroke.pts.length - 1]);
  }
  // Lente della gomma: il dito copre il punto, la lente mostra cosa si sta cancellando.
  function eraseLoupe(pt) {
    const S2 = 128;
    const Z = 2.5;
    const dpr = devicePixelRatio || 1;
    const r = shownRect();
    loupe.hidden = false;
    loupe.width = loupe.height = S2 * dpr;
    const left = pt[0] > 0.5;
    loupe.style.left = left ? '12px' : '';
    loupe.style.right = left ? '' : '12px';
    const x = loupe.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = '#111';
    x.fillRect(0, 0, S2, S2);
    // punto del dito sullo schermo, e porzione attorno ingrandita: anteprima + tratti
    const sx = r.x + pt[0] * r.w;
    const sy = r.y + pt[1] * r.h;
    const half = S2 / 2 / Z;
    const kx = (pv.naturalWidth || 1) / r.w;
    x.imageSmoothingQuality = 'high';
    x.drawImage(pv, (sx - half - r.x) * kx, (sy - half - r.y) * kx, half * 2 * kx, half * 2 * kx, 0, 0, S2, S2);
    const cr = cv.width / stage.clientWidth;
    x.drawImage(cv, (sx - half) * cr, (sy - half) * cr, half * 2 * cr, half * 2 * cr, 0, 0, S2, S2);
    // cerchio del pennello
    x.strokeStyle = 'rgba(24,95,165,0.9)';
    x.lineWidth = 1.5;
    x.beginPath();
    x.arc(S2 / 2, S2 / 2, (brush / 100) * r.w * Z, 0, Math.PI * 2);
    x.stroke();
  }

  function eraseEnd() {
    loupe.hidden = true;
    if (!stroke) return;
    mark();
    params.erase.push({ r: stroke.r, g: params.dewarp ? 'd' : 'f', pts: stroke.pts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]) });
    stroke = null;
    dirty = true;
    preview(250); // risultato vero poco dopo il tratto; intanto il tratto resta disegnato
  }

  function toView(rerender) {
    mode = 'view';
    controls.onclick = null;
    panelView();
    if (rerender) preview();
    else if (pvURL) pv.src = pvURL;
  }

  // ---- salvataggio ----
  // Aspetto della pagina che può valere per tutto il libro (non il ritaglio, la rotazione o la gomma).
  const LOOK = ['filter', 'brightness', 'contrast', 'sharpness', 'dewarp'];
  async function commit() {
    if (!dirty) return;
    const before = page.params || {};
    const lookChanged = LOOK.some((k) => (before[k] ?? null) !== (params[k] ?? null));
    if (P.applyAll && lookChanged) await applyLookToAll();
    page = (await db.getPage(page.id)) || page;
    page.params = structuredClone(params);
    page.rev = (page.rev || 0) + 1;
    page.status = 'pending';
    page.synced = false;
    await db.putPage(page);
    S.pages.set(page.id, page);
    queue.enqueue(page.id, true);
    sync.kick();
    dirty = false;
  }

  async function applyLookToAll() {
    const all = await db.getPages(P.id);
    for (const p of all.values()) {
      if (p.id === page.id) continue;
      if (LOOK.every((k) => (p.params[k] ?? null) === (params[k] ?? null))) continue;
      if (!!p.params.dewarp !== !!params.dewarp) p.params.erase = tagStrokes(p.params.erase, p.params.dewarp);
      for (const k of LOOK) p.params[k] = params[k];
      p.rev = (p.rev || 0) + 1;
      p.status = 'pending';
      p.synced = false;
      await db.putPage(p);
      S.pages.set(p.id, p);
      queue.enqueue(p.id);
    }
    // e le prossime pagine scattate nascono con lo stesso aspetto
    P.filter = params.filter;
    await db.putProject(Object.assign((await db.getProject(P.id)) || P, { filter: params.filter }));
  }

  const ro = new ResizeObserver(() => {
    if (mode === 'crop') drawCrop();
    else if (mode === 'split') drawSplit();
    else if (mode === 'erase') fitCanvas();
  });
  ro.observe(stage);

  S.cleanup = () => {
    ro.disconnect();
    clearTimeout(pvTimer);
    token++;
    if (pvURL) URL.revokeObjectURL(pvURL);
    if (origURL) URL.revokeObjectURL(origURL);
  };

  panelView();
  histButtons();

  el.onclick = async (e) => {
    const t = e.target.closest('[data-a]');
    if (!t) return;
    const a = t.dataset.a;
    if (a === 'back' || a === 'done') { await commit(); project(); }
    else if (a === 'prev' || a === 'next') {
      await commit();
      const j = idx + (a === 'prev' ? -1 : 1);
      if (P.order[j]) editor(P.order[j]);
    } else if (a === 'crop') panelCrop();
    else if (a === 'erase') panelErase();
    else if (a === 'zoom') {
      openZoom(async (kind) => {
        await origP;
        if (kind === 'orig') return orig;
        const fresh = S.pages.get(page.id) || page;
        if (!dirty && fresh.status === 'done' && fresh.rev === page.rev) {
          const b = await procBlob(fresh);
          if (b) return b;
        }
        // modifiche non ancora salvate: la pagina a piena risoluzione si calcola adesso
        return (await renderPage(orig, params, { maxSide: 2400, quality: 0.92, cacheKey })).blob;
      });
    } else if (a === 'undo') stepHistory(H0.undo, H0.redo);
    else if (a === 'redoh') stepHistory(H0.redo, H0.undo);
    else if (a === 'rotate') {
      mark();
      // anche i tratti della gomma ruotano con la pagina
      const asp = pw / ph;
      params.erase = (params.erase || []).map((s) => ({ ...s, r: s.r * asp, pts: s.pts.map(([x, y]) => [1 - y, x]) }));
      params.rotation = ((params.rotation || 0) + 1) % 4;
      [pw, ph] = [ph, pw];
      change();
    } else if (a === 'dewarp') {
      mark();
      params.erase = tagStrokes(params.erase, params.dewarp);
      params.dewarp = !params.dewarp;
      t.classList.toggle('on', params.dewarp);
      if (params.dewarp && !(await db.kvGet('uvLoaded2', false))) {
        toast(tr('Scarico il modello per le pagine curve (31 MB), solo la prima volta'), null, 5000);
        db.kvSet('uvLoaded2', true);
      }
      change();
    } else if (a === 'split') panelSplit();
    else if (a === 'redo') { await commit(); camera({ replaceId: page.id }); }
    else if (a === 'more') {
      menuSheet(tr('Pagina {i}', { i: idx + 1 }), [
        { label: P.applyAll ? tr('Modifiche a tutte le pagine: attivo') : tr('Modifiche a tutte le pagine: disattivo'), icon: 'copy', run: async () => {
          P.applyAll = !P.applyAll;
          await db.putProject(Object.assign((await db.getProject(P.id)) || P, { applyAll: P.applyAll }));
          if (P.applyAll) {
            toast(tr('Filtro, luminosità, contrasto, nitidezza e Distendi ora valgono per tutte le pagine'));
            dirty = true;
            await applyLookToAll();
          } else toast(tr('Le modifiche valgono solo per questa pagina'));
          allBadge();
        } },
        { label: tr('Nuova pagina dopo questa'), icon: 'square-plus', run: async () => { await commit(); pickPhotos({ index: idx + 1 }); } },
        { label: tr('Ripristina la foto originale'), icon: 'arrow-back-up', run: () => {
          mark();
          Object.assign(params, { quad: FULL_QUAD, rotation: 0, filter: 'original', brightness: 0, contrast: 0, sharpness: 50, erase: [], dewarp: false });
          delete params.auto;
          dirty = true;
          toView(true);
        } },
        ...(isBlurry(page, blurMedian()) ? [{ label: tr('Non è sfocata, togli l’avviso'), icon: 'check', run: async () => {
          page.blurOk = true; await db.putPage(page); S.pages.set(page.id, page); toast(tr('Avviso rimosso'));
        } }] : []),
        { label: tr('Elimina pagina'), icon: 'trash', cls: 'danger', run: async () => {
          if (!(await confirmSheet(tr('Eliminare la pagina?'), tr('La pagina {i} verrà eliminata.', { i: idx + 1 }), tr('Elimina'), true))) return;
          S.project = await db.deletePages(P.id, [page.id]);
          S.pages.delete(page.id);
          sync.pushProject(S.project);
          dirty = false;
          const next = S.project.order[Math.min(idx, S.project.order.length - 1)];
          next ? editor(next) : project();
        } },
      ]);
    }
  };

  // ---- dividi: linea di taglio regolabile, posizionata sulla piega se si trova ----
  let line = [0.5, 0.5];
  let dragL = null;
  async function panelSplit() {
    if (!pvURL) { toast(tr('Attendi l’anteprima della pagina')); return; }
    mode = 'split';
    ov.innerHTML = '';
    line = [0.5, 0.5];
    controls.innerHTML = `
      <div class="modehint">${tr('Sposta la linea sulla piega tra le due pagine. Trascina i cerchi per inclinarla')}</div>
      <div class="bar"><button class="btn" data-c="cancel">${tr('Annulla')}</button><button class="btn primary" data-c="apply">${tr('Dividi')}</button></div>`;
    drawSplit();
    controls.onclick = async (e) => {
      const c = e.target.closest('[data-c]');
      if (!c) return;
      if (c.dataset.c === 'cancel') { ov.innerHTML = ''; toView(false); }
      else { ov.innerHTML = ''; await doSplit(line[0], line[1]); }
    };
    // posizione iniziale: la piega trovata nella foto, se cade dentro questa pagina
    try {
      await origP;
      const r = await detectPage(orig);
      const sp = r.found && r.found.spine;
      if (sp && mode === 'split') {
        const k = params.rotation || 0;
        const a = origToPreview(params.quad || FULL_QUAD, k, sp[0]);
        const b = origToPreview(params.quad || FULL_QUAD, k, sp[1]);
        if (Math.abs(b[1] - a[1]) > 0.5) {
          const at = (y) => a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
          const xt = at(0);
          const xb = at(1);
          if (xt > 0.05 && xt < 0.95 && xb > 0.05 && xb < 0.95) { line = [xt, xb]; drawSplit(); }
        }
      }
    } catch { /* resta al centro */ }
  }

  function drawSplit() {
    if (mode !== 'split') return;
    const r = imgRect(pv.naturalWidth || pw, pv.naturalHeight || ph);
    ov.setAttribute('viewBox', `0 0 ${stage.clientWidth} ${stage.clientHeight}`);
    const T = [r.x + line[0] * r.w, r.y];
    const B = [r.x + line[1] * r.w, r.y + r.h];
    ov.innerHTML = `<line x1="${T[0]}" y1="${T[1]}" x2="${B[0]}" y2="${B[1]}" style="stroke:var(--accent);stroke-width:3;stroke-dasharray:8 6"/>
      <circle class="handle" cx="${T[0]}" cy="${T[1]}" r="12"/><circle class="handle" cx="${B[0]}" cy="${B[1]}" r="12"/>`;
  }

  stage.addEventListener('pointerdown', (e) => {
    if (mode !== 'split') return;
    const r = imgRect(pv.naturalWidth || pw, pv.naturalHeight || ph);
    const b = stage.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    const dt = Math.hypot(x - (r.x + line[0] * r.w), y - r.y);
    const db2 = Math.hypot(x - (r.x + line[1] * r.w), y - (r.y + r.h));
    dragL = dt < 44 ? 'top' : db2 < 44 ? 'bottom' : 'both';
    dragL = { which: dragL, x0: x, l0: line.slice() };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (mode !== 'split' || !dragL) return;
    const r = imgRect(pv.naturalWidth || pw, pv.naturalHeight || ph);
    const b = stage.getBoundingClientRect();
    const dx = (e.clientX - b.left - dragL.x0) / r.w;
    const cl = (v) => Math.min(0.97, Math.max(0.03, v));
    if (dragL.which === 'top') line[0] = cl(dragL.l0[0] + dx);
    else if (dragL.which === 'bottom') line[1] = cl(dragL.l0[1] + dx);
    else { line[0] = cl(dragL.l0[0] + dx); line[1] = cl(dragL.l0[1] + dx); }
    drawSplit();
  });
  stage.addEventListener('pointerup', () => { dragL = null; });

  async function doSplit(xt, xb, { keepRedo = false } = {}) {
    const before = structuredClone(params);
    const [L, R] = splitByLine(params.quad || FULL_QUAD, params.rotation || 0, xt, xb);
    params.quad = L;
    delete params.auto;
    params.erase = [];
    dirty = true;
    await commit();
    const twin = newPage(R, { origId: page.origId || page.id });
    twin.params = { ...structuredClone(params), quad: R };
    S.project = await db.addPages(P.id, [{ page: twin, orig: null }], { index: idx + 1 });
    S.pages.set(twin.id, twin);
    queue.enqueue(twin.id, true);
    sync.kick();
    H0.undo.push({ t: 'split', twinId: twin.id, line: [xt, xb], params: before });
    if (!keepRedo) H0.redo.length = 0;
    toast(tr('Pagina divisa in due'));
    editor(page.id);
  }
}

// =====================================================================
// ESPORTA
// =====================================================================
// only: id delle pagine da esportare (le selezionate); senza, tutto il libro
async function exportSheet(only) {
  const pick = (proj) => (only ? { ...proj, order: proj.order.filter((id) => only.includes(id)) } : proj);
  const P = pick(S.project);
  const E = await import('./export.js');
  const o = { kind: 'pdf', ocr: true, engine: 'paddle', ita: true, eng: true, quality: 'medium', size: 'image', ...(await db.kvGet('exportOpts', {})) };
  const st = sync.getState();
  const s = sheet(`${shead(only ? tr('Esporta {pages}', { pages: plural(P.order.length, 'pagina', 'pagine') }) : tr('Esporta'))}
    <div class="seg" id="kind"><button data-k="pdf">PDF</button><button data-k="img">${tr('Immagini')}</button></div>
    <div id="opts"></div>
    <div class="gl">${tr('Backup')}</div>
    <div class="card">
      <div class="li"><span>${tr('Ultimo backup')}</span><span class="r">${ago(P.lastBackup)}</span></div>
      <button class="li accent" data-a="backup"><span>${tr('Esporta progetto (.zip)')}</span>${icon('download')}</button>
      <button class="li" data-a="server"><span>${tr('Backup automatico')}</span><span class="r">${st.status === 'off' ? tr('non attivo') : st.status === 'error' ? tr('errore') : st.status === 'syncing' ? tr('in corso') : tr('attivo')}${icon('chevron-right')}</span></button>
    </div>
    <div class="actions"><button class="btn primary" id="go"></button></div>`);

  const draw = async () => {
    $$('#kind button', s.el).forEach((b) => b.classList.toggle('on', b.dataset.k === o.kind));
    const qseg = `<div class="seg" id="q">${Object.entries(E.QUALITY).map(([k, v]) => `<button data-q="${k}" class="${o.quality === k ? 'on' : ''}">${tr(v.label)}</button>`).join('')}</div>`;
    const sw = (id, on) => `<span class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></span>`;
    $('#opts', s.el).innerHTML =
      (o.kind === 'pdf'
        ? `<div class="gl">${tr('Formato pagina')}</div>
          <div class="seg" id="psize"><button data-s="image" class="${o.size === 'image' ? 'on' : ''}">${tr('Come la foto')}</button><button data-s="a4" class="${o.size === 'a4' ? 'on' : ''}">${tr('A4 con margini')}</button></div>
          ${o.size === 'a4' ? `<p class="note">${tr('Ogni pagina viene centrata su un foglio A4 con 1 cm di margine: tutte della stessa misura, pronte da stampare.')}</p>` : ''}
          <div class="gl">PDF</div><div class="card">
            <label class="li"><span>${tr('Testo ricercabile (OCR)')}</span>${sw('ocr', o.ocr)}</label>
            ${o.ocr && o.engine === 'tesseract' ? `<label class="li"><span>${tr('Italiano')}</span>${sw('ita', o.ita)}</label><label class="li"><span>${tr('Inglese')}</span>${sw('eng', o.eng)}</label>` : ''}
          </div>
          ${o.ocr ? `<div class="gl">${tr('Riconoscimento del testo')}</div>
            <div class="seg" id="engine">${Object.entries(OCR_ENGINES).map(([k, v]) => `<button data-e="${k}" class="${o.engine === k ? 'on' : ''}">${tr(v.label)} · ${v.name}</button>`).join('')}</div>
            <p class="note">${o.engine === 'paddle'
              ? tr('Più preciso su foto, pagine curve e caratteri piccoli. Riconosce italiano, inglese e le altre lingue con alfabeto latino. La prima volta scarica circa 27 MB.')
              : tr('Circa tre volte più veloce, meno preciso sulle foto difficili. La prima volta scarica circa 10 MB.')}${sp()}${tr('Tutto avviene sul telefono, poi funziona anche offline.')}</p>` : ''}`
        : '') +
      `<div class="gl">${tr('Qualità')}</div>${qseg}<p class="note" id="est">${tr('Stima in corso…')}</p>`;
    $('#go', s.el).textContent = o.kind === 'pdf' ? tr('Crea PDF') : tr('Crea immagini (.zip)');
    for (const id of ['ocr', 'ita', 'eng']) {
      const i = $(`#${id}`, s.el);
      if (i) i.onchange = () => { o[id] = i.checked; save(); draw(); };
    }
    $$('#q button', s.el).forEach((b) => (b.onclick = () => { o.quality = b.dataset.q; save(); draw(); }));
    $$("#engine button", s.el).forEach((b) => (b.onclick = () => { o.engine = b.dataset.e; save(); draw(); }));
    $$('#psize button', s.el).forEach((b) => (b.onclick = () => { o.size = b.dataset.s; save(); draw(); }));
    const est = await E.estimate(P, o.quality);
    const el = $('#est', s.el);
    if (el) el.textContent = `${plural(P.order.length, 'pagina', 'pagine')} · ${tr('circa {size}', { size: bytes(est) })}`;
  };
  const save = () => db.kvSet('exportOpts', o);
  $$('#kind button', s.el).forEach((b) => (b.onclick = () => { o.kind = b.dataset.k; save(); draw(); }));
  draw();

  s.el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-a]');
    if (!t) return;
    if (t.dataset.a === 'backup') { s.close(); backupFlow(S.project); }
    else if (t.dataset.a === 'server') { s.close(); settings(); }
  });

  $('#go', s.el).onclick = async () => {
    const langs = [o.ita && 'ita', o.eng && 'eng'].filter(Boolean);
    if (o.kind === 'pdf' && o.ocr && o.engine === 'tesseract' && !langs.length) return toast(tr('Scegli almeno una lingua'));
    s.close();
    const ctrl = new AbortController();
    const prog = sheet(`${shead(o.kind === 'pdf' ? tr('Creo il PDF') : tr('Preparo le immagini'))}
      <div class="progress"><i id="bar"></i></div><div class="ptext" id="ptext">${tr('Preparazione…')}</div>
      <p class="note" style="text-align:center">${tr('Tieni l’app aperta. Le pagine restano salvate anche se interrompi.')}</p>
      <div class="actions"><button class="btn" data-close>${tr('Annulla')}</button></div>`, { dismissable: false, onClose: () => ctrl.abort() });
    const upd = (frac, text) => {
      const b = $('#bar', prog.el);
      if (b) b.style.width = `${Math.round(frac * 100)}%`;
      const t = $('#ptext', prog.el);
      if (t) t.textContent = text;
    };
    try {
      await waitProcessing((left) => upd(0, tr('Finisco di elaborare le pagine ({n})…', { n: left })), ctrl.signal, P.order);
      const fresh = pick(await db.getProject(P.id));
      // nel nome del file, le pagine esportate (es. «libro-p3-7_10»)
      const part = only ? `-p${pageRanges(S.project.order, only)}` : '';
      let blob;
      let name;
      if (o.kind === 'pdf') {
        blob = await E.buildPdf(fresh, {
          quality: o.quality, ocr: o.ocr, engine: o.engine, langs, size: o.size, signal: ctrl.signal,
          onProgress: ({ phase, done, total, detail }) => {
            if (phase === 'ocr') upd((done / total) * 0.85, detail ? tr(detail) : tr('Riconosco il testo: pagina {i} di {n}', { i: Math.min(total, Math.floor(done) + 1), n: total }));
            else upd(o.ocr ? 0.85 + (done / total) * 0.15 : done / total, tr('Impagino: {i} di {n}', { i: done, n: total }));
          },
        });
        name = `${E.slug(fresh.name)}${part}.pdf`;
      } else {
        blob = await E.buildImagesZip(fresh, { quality: o.quality, onProgress: ({ done, total }) => upd(done / total, tr('Pagina {i} di {n}', { i: done + 1, n: total })) });
        name = `${E.slug(fresh.name)}${part}-${E.slug(tr('immagini'))}.zip`;
      }
      if (ctrl.signal.aborted) return;
      prog.close();
      fileReadySheet(blob, name, o.kind === 'pdf' ? tr('PDF pronto') : tr('Immagini pronte'));
    } catch (err) {
      prog.close();
      if (err.name !== 'AbortError') {
        console.error(err);
        toast(tr('Esportazione non riuscita: {e}', { e: err.message }));
      }
    }
  };
}

// numeri di pagina in forma compatta: 3, 4, 5, 7 → «3-5_7»
function pageRanges(order, ids) {
  const nums = order.map((id, i) => (ids.includes(id) ? i + 1 : 0)).filter(Boolean);
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    i = j;
  }
  return out.join('_');
}

function waitProcessing(onLeft, signal, order = S.project.order) {
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (signal.aborted) return reject(new DOMException('annullato', 'AbortError'));
      const pages = await db.getPages(S.project.id);
      const left = order.filter((id) => pages.get(id) && pages.get(id).status === 'pending').length;
      if (!left) return resolve();
      onLeft(left);
      queue.resume();
      setTimeout(check, 600);
    };
    check();
  });
}

// =====================================================================
// IMPOSTAZIONI
// =====================================================================
async function settings(prev) {
  const theme = await db.kvGet('theme', 'auto');
  const cfg = sync.config();
  let est = null;
  let persisted = null;
  try { est = await navigator.storage.estimate(); } catch { /* */ }
  try { persisted = await navigator.storage.persisted(); } catch { /* */ }
  const st = sync.getState();
  const lang = langPref();
  const html = `${shead(tr('Impostazioni'))}
    <div class="gl" style="margin-top:4px">${tr('Aspetto')}</div>
    <div class="seg" id="theme">${[['auto', tr('Automatico')], ['light', tr('Chiaro')], ['dark', tr('Scuro')]].map(([k, l]) => `<button data-t="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div>

    <div class="gl">${tr('Lingua')}</div>
    <div class="seg" id="lang">${[['auto', tr('Automatica')], ...LANGS].map(([k, l]) => `<button data-l="${k}" class="${lang === k ? 'on' : ''}" ${k === 'auto' ? '' : `lang="${k}"`}>${l}</button>`).join('')}</div>

    <div class="gl">${tr('Backup automatico sul server')}</div>
    <div class="card">
      <label class="li"><span>${tr('Attivo')}</span><span class="switch"><input type="checkbox" id="sen" ${cfg.enabled ? 'checked' : ''}><i></i></span></label>
      <label class="li"><span>${tr('Indirizzo')}</span><input type="url" id="surl" placeholder="https://pageturn.example.com" value="${esc(cfg.url)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="li"><span>${tr('Codice')}</span><input type="password" id="stok" placeholder="${tr('facoltativo')}" value="${esc(cfg.token)}"></label>
      <div class="li"><span>${tr('Stato')}</span><span class="r" id="sst">${syncText(st)}</span></div>
      <button class="li accent" data-a="test"><span>${tr('Verifica connessione')}</span>${icon('server')}</button>
      <button class="li accent" data-a="restore"><span>${tr('Ripristina dal server')}</span>${icon('download')}</button>
    </div>
    <p class="note">${tr('Ogni foto viene inviata al tuo server appena scattata, così resta una copia anche se perdi il telefono. Il server è incluso nel progetto (cartella server).')}</p>

    <div class="gl">${tr('Archivio sul dispositivo')}</div>
    <div class="card">
      <div class="li"><span>${tr('Spazio usato')}</span><span class="r">${est ? (est.quota ? tr('{used} di {quota}', { used: bytes(est.usage), quota: bytes(est.quota) }) : bytes(est.usage)) : tr('non disponibile')}</span></div>
      <div class="li"><span>${tr('Protetto dalla pulizia')}</span><span class="r">${persisted ? tr('sì') : standalone ? tr('non confermato') : tr('no, installa l’app')}</span></div>
      <button class="li accent" data-a="import"><span>${tr('Importa un backup (.zip)')}</span>${icon('upload')}</button>
    </div>

    <div class="gl">${tr('Informazioni')}</div>
    <div class="card">
      <div class="li"><span>${tr('Versione')}</span><span class="r">${VERSION}</span></div>
      <div class="li"><span>${tr('Ambiente')}</span><span class="r" style="max-width:62%">${esc(envInfo())}</span></div>
      <a class="li accent" href="${REPO}" target="_blank" rel="noopener" style="text-decoration:none"><span>${tr('Codice sorgente su GitHub')}</span>${icon('chevron-right')}</a>
    </div>
    <p class="note">${tr('Pageturn è open source (licenza GPL-3.0). Le scansioni restano sul tuo dispositivo e sul tuo server: nessun dato passa da altri servizi.')}</p>`;
  const s = prev ? prev.swap(html) : sheet(html);

  $$('#theme button', s.el).forEach((b) => (b.onclick = () => {
    applyTheme(b.dataset.t);
    $$('#theme button', s.el).forEach((x) => x.classList.toggle('on', x === b));
  }));
  // Cambiando lingua si ridisegna la schermata sotto il foglio e si traduce il foglio sul posto,
  // senza chiuderlo e riaprirlo.
  $$('#lang button', s.el).forEach((b) => (b.onclick = async () => {
    if (b.dataset.l === langPref()) return;
    $$('#lang button', s.el).forEach((x) => x.classList.toggle('on', x === b));
    await applyLang(b.dataset.l);
    if (S.view === 'home') await home();
    else if (S.view === 'project') await project();
    settings(s);
  }));
  const save = async () => {
    await sync.configure({ enabled: $('#sen', s.el).checked, url: $('#surl', s.el).value.trim(), token: $('#stok', s.el).value });
  };
  $('#sen', s.el).onchange = async () => {
    if ($('#sen', s.el).checked && !$('#surl', s.el).value.trim()) { $('#surl', s.el).focus(); }
    await save();
  };
  $('#surl', s.el).onchange = save;
  $('#stok', s.el).onchange = save;
  const onSync = (e) => { const x = $('#sst', s.el); if (x) x.textContent = syncText(e.detail); };
  sync.events.addEventListener('change', onSync);
  const close0 = s.close;
  s.el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-a]');
    if (!t) return;
    if (t.dataset.a === 'test') {
      await save();
      try {
        await sync.health();
        toast(tr('Server raggiungibile'));
        sync.kick();
      } catch (err) {
        toast(tr('Server non raggiungibile: {err}', { err: err.message }));
      }
    } else if (t.dataset.a === 'restore') {
      await save();
      restoreSheet();
    } else if (t.dataset.a === 'import') {
      const inp = $('#pick-backup');
      inp.value = '';
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        const tp = toastProgress(tr('Importo il backup…'));
        try {
          const { importBackup } = await import('./export.js');
          const p = await importBackup(f);
          tp.done();
          close0();
          queue.resume();
          toast(tr('«{name}» importato', { name: p.name }));
          if (S.view === 'home') home();
        } catch (err) {
          tp.done();
          toast(tr(err.message));
        }
      };
      inp.click();
    }
  });
  const obs = new MutationObserver(() => { if (!s.el.isConnected) { sync.events.removeEventListener('change', onSync); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
}

// Dove sta girando l'app: utile per capire problemi legati al browser.
function envInfo() {
  const ua = navigator.userAgent;
  const browser = /OPT\/|OPR\/|Opera/.test(ua) ? 'Opera' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /EdgiOS|Edg\//.test(ua) ? 'Edge' : /Safari/.test(ua) ? 'Safari' : 'browser';
  const engine = navigator.userAgentData ? 'Chromium' : /AppleWebKit/.test(ua) ? 'WebKit' : /Gecko\//.test(ua) ? 'Gecko' : '?';
  const parts = [standalone ? tr('app installata') : `${browser}`, engine];
  parts.push(navigator.serviceWorker && navigator.serviceWorker.controller ? tr('offline sì') : tr('offline no'));
  parts.push(self.crossOriginIsolated ? tr('OCR multithread') : tr('OCR a 1 thread'));
  return parts.join(' · ');
}

function syncText(st) {
  if (st.status === 'off') return tr('non attivo');
  if (st.status === 'syncing') return tr('invio in corso ({n})', { n: st.pending });
  if (st.status === 'error') return st.error || tr('errore');
  return tr('tutto sul server');
}

async function restoreSheet() {
  let list;
  try {
    list = await sync.remoteProjects();
  } catch (e) {
    return toast(tr('Server non raggiungibile: {err}', { err: e.message }));
  }
  if (!list.length) return toast(tr('Sul server non ci sono libri'));
  menuSheet(tr('Ripristina dal server'), list.map((p) => ({
    label: `${p.name} · ${plural(p.pages, 'pagina', 'pagine')}`,
    icon: 'download',
    run: async () => {
      const t = toastProgress(tr('Scarico…'));
      try {
        const proj = await sync.restore(p.id, (i, n) => t.set(tr('Scarico {i} di {n}…', { i: i + 1, n })));
        t.done();
        queue.resume();
        toast(tr('«{name}» ripristinato', { name: proj.name }));
        await loadProject(proj.id);
        project();
      } catch (e) {
        t.done();
        toast(tr('Ripristino non riuscito: {err}', { err: e.message }));
      }
    },
  })));
}

// =====================================================================
// AVVIO
// =====================================================================
// Le pagine elaborate aggiornano lo stato ovunque ci si trovi.
queue.events.addEventListener('page', (e) => {
  const p = e.detail;
  if (S.project && p.projectId === S.project.id) S.pages.set(p.id, p);
});

async function boot() {
  const theme = await db.kvGet('theme', 'auto');
  applyTheme(theme);
  // la lingua è già stata letta da localStorage; l'archivio vince se localStorage è stato svuotato
  const lang = await db.kvGet('lang', null);
  if (lang && lang !== langPref()) await applyLang(lang);
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch { /* */ }
  queue.resume();
  sync.init();
  home();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller; // alla prima visita non si ricarica
    const reg = await navigator.serviceWorker.register('sw.js').catch(() => null);
    if (reg) {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast(tr('È pronta una nuova versione'), { label: tr('Aggiorna'), run: () => w.postMessage('skip') }, 8000);
          }
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading || !hadController) return;
        reloading = true;
        if (S.view !== 'camera') location.reload();
      });
    }
  }
}

boot().catch((e) => {
  console.error(e);
  app.innerHTML = `<div class="empty"><h2>${tr('Qualcosa non va')}</h2><p>${esc(e.message)}</p></div>`;
});

// per i test
window.__pageturn = { S, db, queue, sync };
