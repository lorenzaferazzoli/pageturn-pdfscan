import * as db from './db.js';
import * as queue from './queue.js';
import * as sync from './sync.js';
import { Camera } from './camera.js';
import { icon } from './icons.js';
import { renderPage, detectPage } from './jobs.js';
import { splitQuad, FULL_QUAD, homography } from './proc.js';
import { ENGINES as OCR_ENGINES } from './ocr.js';

export const VERSION = '1.3.0';
export const REPO = 'https://github.com/lorenzaferazzoli/pageturn-pdfscan';

// ---------- utilità ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = $('#app');
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function ago(t) {
  if (!t) return 'mai';
  const s = (Date.now() - t) / 1000;
  if (s < 50) return 'ora';
  if (s < 3600) return `${Math.round(s / 60)} min fa`;
  if (s < 86400) return `${Math.round(s / 3600)} ${Math.round(s / 3600) === 1 ? 'ora' : 'ore'} fa`;
  if (s < 172800) return 'ieri';
  return new Date(t).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}

function bytes(n) {
  if (!n) return '0 MB';
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace('.', ',')} MB`;
  return `${(n / 1e9).toFixed(1).replace('.', ',')} GB`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

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
  return { el: wrap.firstElementChild, close };
}

const shead = (title) => `<div class="shead"><h2>${esc(title)}</h2><button class="close" data-close aria-label="Chiudi">${icon('x')}</button></div>`;

function confirmSheet(title, text, ok, danger = false) {
  return new Promise((resolve) => {
    let v = false;
    const s = sheet(
      `${shead(title)}<p style="margin:0;color:var(--text-2)">${esc(text)}</p>
       <div class="actions"><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button>
       <button class="btn" data-close>Annulla</button></div>`,
      { onClose: () => resolve(v) },
    );
    $('[data-ok]', s.el).onclick = () => { v = true; s.close(); };
  });
}

function promptSheet(title, value, ok, placeholder = '') {
  return new Promise((resolve) => {
    let v = null;
    const s = sheet(
      `${shead(title)}<div class="card"><div class="li"><input class="field full" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" enterkeyhint="done" maxlength="80"></div></div>
       <div class="actions"><button class="btn primary" data-ok>${esc(ok)}</button></div>`,
      { onClose: () => resolve(v) },
    );
    const inp = $('input', s.el);
    const done = () => { v = inp.value.trim() || value; s.close(); };
    $('[data-ok]', s.el).onclick = done;
    inp.onkeydown = (e) => e.key === 'Enter' && done();
    setTimeout(() => { inp.focus(); inp.select(); }, 250);
  });
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
      <button class="btn primary" data-share>${icon('share-2')} Salva in File o Drive</button>
      <button class="btn" data-dl>${icon('download')} Scarica</button>
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

// ---------- miniature ----------
const thumbs = new Map(); // pageId → { url, rev }
async function thumbURL(page) {
  const c = thumbs.get(page.id);
  if (c && c.rev === page.rev && c.status === page.status) return c.url;
  const b = await db.getBlob(`${page.id}:thumb`);
  if (c) URL.revokeObjectURL(c.url);
  if (!b) { thumbs.delete(page.id); return null; }
  const url = URL.createObjectURL(b);
  thumbs.set(page.id, { url, rev: page.rev, status: page.status });
  return url;
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
  if (!S.project || S.project.id !== id) editHistory.clear();
  S.project = await db.getProject(id);
  S.pages = await db.getPages(id);
  return S.project;
}

// ---------- foto importate (rullino, fotocamera di iOS) ----------
async function importFiles(files, { replaceId, index } = {}) {
  if (!files.length) return [];
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
  if (!list.length) return [];
  const t = list.length > 1 ? toastProgress(`Importo ${list.length} foto…`) : null;
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
        toast('Questo formato di immagine non è supportato');
        continue;
      }
      const items = pagesFor(blob, det, !replaceId && S.project.double);
      S.project = await db.addPages(S.project.id, items, {
        replaceId: i === 0 ? replaceId : undefined,
        index: index != null ? index + ids.length : undefined,
      });
      for (const it of items) { S.pages.set(it.page.id, it.page); queue.enqueue(it.page.id); ids.push(it.page.id); }
      t && t.set(`Importo ${i + 1} di ${list.length}…`);
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
  return [{ page: newPage(det ? det.quad : null), orig: blob }];
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
    sheet(`${shead('Spazio esaurito')}<p style="color:var(--text-2);margin:0">Il telefono non ha più spazio per le scansioni. Esporta un backup o un PDF e libera spazio eliminando i libri già esportati.</p>
      <div class="actions"><button class="btn" data-close>Ok</button></div>`);
  } else {
    toast('Salvataggio non riuscito. Riprova.');
  }
}

// =====================================================================
// HOME
// =====================================================================
async function home() {
  S.view = 'home';
  S.project = null;
  dropThumbs();
  const projects = await db.listProjects();
  const hideBanner = await db.kvGet('hideInstall', false);
  const el = show(`
    <div class="nav"><div class="side"></div><div class="title"></div>
      <div class="side r"><button class="iconbtn" data-a="settings" aria-label="Impostazioni">${icon('settings')}</button></div></div>
    <div class="scroll">
      <div class="head"><h1 class="large">Pageturn</h1></div>
      ${!standalone && !hideBanner ? `<div class="banner">${icon('device-floppy')}<div><b>Aggiungi Pageturn alla schermata Home</b>
        ${isIOS ? 'Tocca Condividi in Safari, poi «Aggiungi alla schermata Home».' : 'Installa l’app dal menu del browser.'}
        Così le scansioni non vengono cancellate dal browser.</div><button class="x" data-a="hidebanner" aria-label="Nascondi">${icon('x')}</button></div>` : ''}
      ${projects.length ? `<div class="group">${projects.map((p) => `
        <div class="proj" data-a="open" data-id="${p.id}" role="button" tabindex="0">
          <div class="cover" data-cover="${p.order[0] || ''}">${icon('book-2')}</div>
          <div class="meta"><div class="name">${esc(p.name)}</div><div class="sub">${plural(p.order.length, 'pagina', 'pagine')} · ${ago(p.updated)}</div></div>
          <button class="more" data-a="pmenu" data-id="${p.id}" aria-label="Opzioni">${icon('dots')}</button>
        </div>`).join('')}</div>`
        : `<div class="empty"><div class="big">${icon('book')}</div><h2>Inizia il tuo primo libro</h2><p>Ogni pagina viene salvata appena la scatti, anche se l’app si chiude.</p></div>`}
    </div>
    <div class="bar"><button class="btn primary" data-a="new">${icon('plus')} Nuovo libro</button></div>`);

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
      const d = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
      const name = await promptSheet('Nuovo libro', '', 'Crea e scansiona', `Libro del ${d}`);
      if (name === null) return;
      const p = await db.createProject(name || `Libro del ${d}`);
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
    { label: 'Rinomina', icon: 'pencil', run: async () => {
      const n = await promptSheet('Rinomina', p.name, 'Salva');
      if (n) { p.name = n; p.updated = Date.now(); await db.putProject(p); sync.pushProject(p); after(); }
    } },
    { label: 'Esporta backup (.zip)', icon: 'file-zip', run: () => backupFlow(p) },
    { label: 'Elimina libro', icon: 'trash', cls: 'danger', run: async () => {
      const ok = await confirmSheet('Eliminare il libro?', `«${p.name}» e le sue ${p.order.length} pagine verranno eliminati da questo dispositivo. Il backup sul server, se c’è, resta.`, 'Elimina', true);
      if (ok) { await db.deleteProject(p.id); toast('Libro eliminato'); home(); }
    } },
  ]);
}

async function backupFlow(p) {
  const t = toastProgress('Preparo il backup…');
  try {
    const { buildBackup, slug } = await import('./export.js');
    const blob = await buildBackup(p, ({ done, total }) => t.set(`Preparo il backup… ${done}/${total}`));
    t.done();
    fileReadySheet(blob, `${slug(p.name)}-backup.zip`, 'Backup pronto', async () => {
      const fresh = await db.getProject(p.id);
      fresh.lastBackup = Date.now();
      fresh.pagesSinceBackup = 0;
      await db.putProject(fresh);
      if (S.project && S.project.id === p.id) S.project = fresh;
    });
  } catch (e) {
    t.done();
    toast(`Backup non riuscito: ${e.message}`);
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
  return `<button class="th ${warn ? 'warn' : ''} ${sel ? 'sel' : ''}" data-id="${p.id}">
    <div class="img">${p.status === 'done' ? `<img alt="" data-src="${p.id}">` : p.status === 'error' ? icon('alert-triangle') : icon('loader-2', 'spinner spin')}</div>
    ${warn ? '<span class="badge">!</span>' : ''}
    ${S.select ? `<span class="check">${sel ? icon('check') : ''}</span>` : ''}
    <div class="n">${i + 1}${p.status === 'error' ? ' · errore' : warn ? ' · sfocata' : ''}</div></button>`;
}

function statusHTML() {
  const pages = [...S.pages.values()];
  const n = S.project.order.length;
  const pend = pages.filter((p) => p.status === 'pending').length;
  const st = sync.getState();
  let dot = 'ok';
  const parts = [plural(n, 'pagina', 'pagine')];
  if (pend) { parts.push(`elaboro ${pend}`); dot = 'busy'; } else parts.push('tutto salvato');
  if (st.status === 'syncing') { parts.push(`invio al server (${st.pending})`); dot = 'busy'; }
  else if (st.status === 'ok') parts.push('copia sul server');
  else if (st.status === 'error') { parts.push('server non raggiungibile'); if (dot !== 'busy') dot = 'warn'; }
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
      ? `<div class="side"><button class="link" data-a="back">${icon('chevron-left')}Libri</button></div><div class="title"></div>
         <div class="side r"><button class="iconbtn" data-a="import" aria-label="Importa foto">${icon('photo-plus')}</button>
         <button class="iconbtn" data-a="select" aria-label="Seleziona">${icon('checkbox')}</button>
         <button class="iconbtn" data-a="menu" aria-label="Altro">${icon('dots')}</button></div>`
      : mode === 'select'
        ? `<div class="side"><button class="link" data-a="all">${S.selected.size === pages.length && pages.length ? 'Nessuna' : 'Tutte'}</button></div>
           <div class="title">${S.selected.size ? plural(S.selected.size, 'selezionata', 'selezionate') : 'Seleziona pagine'}</div>
           <div class="side r"><button class="link" data-a="done">Fine</button></div>`
        : `<div class="side"></div><div class="title">Riordina</div><div class="side r"><button class="link" data-a="done">Fine</button></div>`;
  const bottom =
    mode === 'normal'
      ? `<div class="bar"><button class="btn primary" data-a="scan">${icon('camera')} Scansiona</button><button class="btn" data-a="export" ${pages.length ? '' : 'disabled'}>Esporta</button></div>`
      : mode === 'select'
        ? `<div class="toolbar"><button class="tool" data-a="srotate">${icon('rotate-clockwise')}Ruota</button>
           <button class="tool" data-a="sfilter">${icon('adjustments-horizontal')}Filtro</button>
           <button class="tool" data-a="sdewarp">${icon('wave-sine')}Distendi</button>
           <button class="tool danger" data-a="sdelete">${icon('trash')}Elimina</button></div>`
        : `<div class="modehint" style="padding-bottom:calc(env(safe-area-inset-bottom) + 16px)">Tieni premuta una pagina e trascinala nella nuova posizione</div>`;
  const el = show(`
    <div class="nav">${nav}</div>
    <div class="scroll">
      <div class="head"><h1 class="large">${esc(P.name)}</h1><div class="status" id="st">${statusHTML()}</div></div>
      ${pages.length
        ? `<div class="grid ${mode === 'reorder' ? 'reorder' : ''}" id="grid">${pages.map((p, i) => thumbHTML(p, i, med)).join('')}</div>`
        : `<div class="empty"><div class="big">${icon('camera')}</div><h2>Nessuna pagina</h2><p>Tocca Scansiona per iniziare, oppure importa foto dal rullino.</p></div>`}
    </div>
    ${bottom}`);

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
        return project();
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
      project();
    } else if (a === 'menu') {
      menuSheet(P.name, [
        { label: 'Riordina pagine', icon: 'arrows-move', run: () => { S.reorder = true; project(); } },
        { label: 'Rinomina', icon: 'pencil', run: async () => {
          const n = await promptSheet('Rinomina', P.name, 'Salva');
          if (n) { P.name = n; await db.putProject(P); sync.pushProject(P); project(); }
        } },
        { label: 'Esporta backup (.zip)', icon: 'file-zip', run: () => backupFlow(P) },
        { label: 'Elimina libro', icon: 'trash', cls: 'danger', run: async () => {
          const ok = await confirmSheet('Eliminare il libro?', `«${P.name}» e le sue ${P.order.length} pagine verranno eliminati da questo dispositivo. Il backup sul server, se c’è, resta.`, 'Elimina', true);
          if (ok) { await db.deleteProject(P.id); toast('Libro eliminato'); home(); }
        } },
      ]);
    } else if (a === 'export') exportSheet();
    else if (a === 'sdelete') {
      if (!S.selected.size) return toast('Seleziona prima le pagine');
      const n = S.selected.size;
      if (!(await confirmSheet(`Eliminare ${plural(n, 'pagina', 'pagine')}?`, 'Le pagine verranno eliminate da questo dispositivo.', 'Elimina', true))) return;
      S.project = await db.deletePages(P.id, [...S.selected]);
      for (const id of S.selected) S.pages.delete(id);
      sync.pushProject(S.project);
      S.selected.clear();
      S.select = false;
      toast(`${plural(n, 'pagina eliminata', 'pagine eliminate')}`);
      project();
    } else if (a === 'srotate' || a === 'sfilter' || a === 'sdewarp') {
      if (!S.selected.size) return toast('Seleziona prima le pagine');
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
        applyAll((pr) => { pr.dewarp = !all; pr.erase = []; });
        toast(all ? 'Pagine non più distese' : 'Distendo le pagine curve in background', null, 2600);
      }
      else {
        menuSheet('Filtro per le pagine selezionate', FILTER_LIST.map(([k, label]) => ({
          label, icon: 'adjustments-horizontal', run: async () => {
            await applyAll((pr) => { pr.filter = k; });
            P.filter = k; // diventa il filtro predefinito per le prossime pagine
            await db.putProject(P);
          },
        })));
      }
    }
  };
}

const FILTER_LIST = [['original', 'Originale'], ['whiten', 'Sbianca'], ['gray', 'Grigi'], ['bw', 'B/N']];

function pickPhotos(opts = {}) {
  const inp = $('#pick-photos');
  inp.value = '';
  inp.onchange = async () => {
    const files = [...inp.files];
    if (!files.length) return;
    const ids = await importFiles(files, opts);
    if (ids.length && S.view === 'project') project();
    if (ids.length) toast(`${plural(ids.length, 'foto importata', 'foto importate')}`);
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
      const tr = target.getBoundingClientRect();
      const after = e.clientX > tr.left + tr.width / 2;
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
      <button class="circle glass" data-a="close" aria-label="Chiudi">${icon('x')}</button>
      <span class="pill glass" id="pill">${esc(P.name)} · ${count}</span>
      <span style="display:flex;gap:8px"><button class="circle glass" data-a="torch" id="torch" hidden aria-label="Torcia">${icon('bolt')}</button>
      <span class="circle glass" id="cloud" title="">${icon('cloud-check')}</span></span>
    </div>
    <div class="hint glass" id="hint"><span class="prog"><i id="prog"></i></span><span id="htext">Avvio la fotocamera…</span></div>
    <div class="bottom">
      <div class="modes">
        ${replaceId ? '<button class="on">Rifai la pagina</button>' : `<button data-a="auto" class="${P.manual ? '' : 'on'}">Auto</button><button data-a="manual" class="${P.manual ? 'on' : ''}">Manuale</button>
        <button data-a="double" class="${double ? 'on' : ''}">Doppia pagina</button>`}
      </div>
      <div class="shutterrow">
        <button class="last" data-a="close" aria-label="Vai alle pagine"><span id="lastimg"></span>${replaceId ? '' : `<span class="count" id="count" ${count ? '' : 'hidden'}>${count}</span>`}</button>
        <button class="shutter" data-a="shoot" aria-label="Scatta"><i></i></button>
        <button class="circle glass" data-a="native" aria-label="Fotocamera di iOS">${icon('camera-plus')}</button>
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
      hint.textContent = phase === 'turn' ? 'Gira pagina' : manual ? 'Tocca il pulsante per scattare' : 'Inquadra una pagina';
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
    hint.textContent = phase === 'turn' ? 'Gira pagina' : manual ? 'Pagina rilevata · scatta quando vuoi' : ready ? 'Tieni fermo' : 'Pagina rilevata';
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
        toast('Pagina sostituita');
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
      m.innerHTML = `${icon('camera', 'big')}<div><b>Fotocamera non disponibile</b><br>
        ${location.protocol !== 'https:' && location.hostname !== 'localhost' ? 'La fotocamera funziona solo con un indirizzo https.' : 'Controlla di aver concesso il permesso a Safari.'}</div>
        <button class="btn sm primary" data-a="retry">Riprova</button><button class="btn sm" data-a="native">Usa la fotocamera di iOS</button>`;
      el.append(m);
      $('#htext', el).textContent = 'Fotocamera non disponibile';
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
      toast(double ? 'Doppia pagina: ogni scatto diventa due pagine' : 'Una pagina per scatto', null, 2200);
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
  toast(`${n} pagine senza una copia fuori dal telefono`, { label: 'Backup', run: () => backupFlow(p) }, 6000);
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

async function editor(pageId) {
  S.view = 'editor';
  const P = S.project;
  let page = S.pages.get(pageId) || (await db.getPage(pageId));
  if (!page) return project();
  const idx = P.order.indexOf(pageId);
  const params = structuredClone(page.params);
  const orig = await db.getBlob(db.origKey(page));
  let mode = 'view';
  let dirty = false;
  let pvURL = null;
  let origURL = null;
  let token = 0;
  let pvTimer = 0;
  let pw = page.width || 3;
  let ph = page.height || 4;

  const el = show(`
    <div class="nav">
      <div class="side"><button class="link" data-a="back">${icon('chevron-left')}Pagine</button></div>
      <div class="title" style="display:flex;align-items:center;justify-content:center;gap:2px">
        <button class="iconbtn plain" data-a="prev" aria-label="Pagina precedente" ${idx > 0 ? '' : 'style="visibility:hidden"'}>${icon('chevron-left')}</button>
        <span>Pagina ${idx + 1} di ${P.order.length}</span>
        <button class="iconbtn plain" data-a="next" aria-label="Pagina successiva" ${idx < P.order.length - 1 ? '' : 'style="visibility:hidden"'}>${icon('chevron-right')}</button>
      </div>
      <div class="side r"><button class="link" data-a="done">Fatto</button></div>
    </div>
    <div class="stage" id="stage"><img id="pv" alt=""><svg id="ov"></svg><canvas id="cv"></canvas><canvas id="loupe" class="loupe" hidden></canvas><span class="busy" id="busy" hidden>${icon('loader-2', 'spinner')}</span>
      <div class="histbtns"><button class="circle glass" data-a="undo" aria-label="Annulla">${icon('arrow-back-up')}</button><button class="circle glass" data-a="redoh" aria-label="Ripeti">${icon('arrow-forward-up')}</button></div></div>
    <div id="controls"></div>`);
  const stage = $('#stage', el);
  const pv = $('#pv', el);
  const ov = $('#ov', el);
  const cv = $('#cv', el);
  const controls = $('#controls', el);

  // immagine iniziale: la versione già elaborata, se c'è
  const proc = page.status === 'done' ? await db.getBlob(`${page.id}:proc`) : null;
  if (proc) { pvURL = URL.createObjectURL(proc); pv.src = pvURL; } else preview();

  function setPreview(blob) {
    const u = URL.createObjectURL(blob);
    pv.src = u;
    if (pvURL) URL.revokeObjectURL(pvURL);
    pvURL = u;
  }

  function preview(delay = 0) {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(async () => {
      const my = ++token;
      $('#busy', el).hidden = false;
      try {
        const r = await renderPage(orig, params, { maxSide: 1300, quality: 0.86 });
        if (my !== token || mode === 'crop') return;
        pw = r.width;
        ph = r.height;
        setPreview(r.blob);
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
        toast('Divisione annullata');
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
    cv.width = cv.height = 0;
    const sl = (k, label) => `<label class="slider"><span>${label}</span>
      <input type="range" min="-100" max="100" step="1" value="${params[k]}" data-k="${k}" style="--p:${(params[k] + 100) / 2}%">
      <span class="v">${params[k] > 0 ? '+' : ''}${params[k]}</span></label>`;
    controls.innerHTML = `
      <div class="panel">
        <div class="allbadge" id="allbadge" ${P.applyAll ? '' : 'hidden'}>${icon('copy')} Le modifiche valgono per tutte le pagine</div>
        <div class="seg" role="tablist">${FILTER_LIST.map(([k, l]) => `<button data-f="${k}" class="${params.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="sliders">${sl('brightness', 'Luminosità')}${sl('contrast', 'Contrasto')}</div>
      </div>
      <div class="toolbar" style="margin-top:10px">
        <button class="tool" data-a="crop">${icon('crop')}Ritaglia</button>
        <button class="tool" data-a="split">${icon('columns-2')}Dividi</button>
        <button class="tool" data-a="rotate">${icon('rotate-clockwise')}Ruota</button>
        <button class="tool ${params.dewarp ? 'on' : ''}" data-a="dewarp">${icon('wave-sine')}Distendi</button>
        <button class="tool" data-a="erase">${icon('eraser')}Gomma</button>
        <button class="tool" data-a="redo">${icon('camera-rotate')}Rifai</button>
        <button class="tool" data-a="more">${icon('dots')}Altro</button>
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
      r.style.setProperty('--p', `${(+r.value + 100) / 2}%`);
      r.nextElementSibling.textContent = `${+r.value > 0 ? '+' : ''}${r.value}`;
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
    if (!origURL) origURL = URL.createObjectURL(orig);
    pv.src = origURL;
    await pv.decode().catch(() => {});
    ow = pv.naturalWidth;
    oh = pv.naturalHeight;
    controls.innerHTML = `
      <div class="modehint">Trascina gli angoli sui bordi della pagina</div>
      <div class="row2"><button class="btn sm" style="flex:1" data-c="detect">${icon('wand')} Rileva</button>
      <button class="btn sm" style="flex:1" data-c="full">Tutta la foto</button></div>
      <div class="bar"><button class="btn" data-c="cancel">Annulla</button><button class="btn primary" data-c="apply">Applica</button></div>`;
    drawCrop();
    controls.onclick = async (e) => {
      const c = e.target.closest('[data-c]');
      if (!c) return;
      const k = c.dataset.c;
      if (k === 'detect') {
        const r = await detectPage(orig);
        if (r.found) { quad = r.found.quad; drawCrop(); } else toast('Bordi non trovati: sistemali a mano');
      } else if (k === 'full') { quad = structuredClone(FULL_QUAD); drawCrop(); }
      else if (k === 'cancel') toView(!pvURL);
      else if (k === 'apply') {
        mark();
        params.quad = quad;
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
    ov.innerHTML = `<path class="quadline" d="M${p.map((q) => q.join(',')).join('L')}Z"/>${p.map(([x, y], i) => `<circle class="handle" data-h="${i}" cx="${x}" cy="${y}" r="11"/>`).join('')}`;
  }

  let dragH = -1;
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
      dragH = best;
      if (best >= 0) { stage.setPointerCapture(e.pointerId); drawLoupe(quad[best]); }
    } else if (mode === 'erase') {
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
    if (mode === 'crop') dragH = -1;
    else if (mode === 'erase') eraseEnd();
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  // ---- gomma ----
  let brush = 3; // % della larghezza
  let stroke = null;
  function panelErase() {
    mode = 'erase';
    ov.innerHTML = '';
    cv.width = stage.clientWidth * devicePixelRatio;
    cv.height = stage.clientHeight * devicePixelRatio;
    controls.innerHTML = `
      <div class="modehint">Passa il dito su macchie, segni e dita sul bordo</div>
      <div class="panel"><div class="sliders"><label class="slider"><span>Pennello</span>
        <input type="range" min="1" max="10" step="0.5" value="${brush}" id="brush" style="--p:${((brush - 1) / 9) * 100}%"><span class="v"></span></label></div></div>
      <div class="bar"><button class="btn" data-c="undo">${icon('arrow-back-up')} Annulla tratto</button><button class="btn primary" data-c="ok">Fine</button></div>`;
    const b = $('#brush', controls);
    b.oninput = () => { brush = +b.value; b.style.setProperty('--p', `${((brush - 1) / 9) * 100}%`); };
    controls.onclick = (e) => {
      const c = e.target.closest('[data-c]');
      if (!c) return;
      if (c.dataset.c === 'undo') {
        if (params.erase.length) { mark(); params.erase.pop(); change(); }
      } else toView(false);
    };
  }

  function erasePt(e) {
    const r = imgRect(pw, ph);
    const b = stage.getBoundingClientRect();
    return [(e.clientX - b.left - r.x) / r.w, (e.clientY - b.top - r.y) / r.h];
  }
  function eraseStart(e) {
    stage.setPointerCapture(e.pointerId);
    stroke = { r: brush / 100, pts: [erasePt(e)] };
    eraseDraw();
  }
  function eraseMove(e) {
    if (!stroke) return;
    stroke.pts.push(erasePt(e));
    eraseDraw();
  }
  function eraseEnd() {
    if (!stroke) return;
    mark();
    params.erase = params.erase || [];
    params.erase.push({ r: stroke.r, pts: stroke.pts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]) });
    stroke = null;
    const x = cv.getContext('2d');
    x.clearRect(0, 0, cv.width, cv.height);
    change();
  }
  function eraseDraw() {
    const x = cv.getContext('2d');
    const r = imgRect(pw, ph);
    const k = devicePixelRatio;
    x.clearRect(0, 0, cv.width, cv.height);
    x.strokeStyle = 'rgba(255,255,255,0.85)';
    x.fillStyle = 'rgba(255,255,255,0.85)';
    x.lineCap = x.lineJoin = 'round';
    x.lineWidth = stroke.r * r.w * 2 * k;
    x.beginPath();
    stroke.pts.forEach(([px, py], i) => {
      const X = (r.x + px * r.w) * k;
      const Y = (r.y + py * r.h) * k;
      i ? x.lineTo(X, Y) : x.moveTo(X, Y);
    });
    if (stroke.pts.length === 1) x.lineTo((r.x + stroke.pts[0][0] * r.w) * k + 0.1, (r.y + stroke.pts[0][1] * r.h) * k);
    x.stroke();
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
  const LOOK = ['filter', 'brightness', 'contrast', 'dewarp'];
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

  S.cleanup = () => {
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
    else if (a === 'undo') stepHistory(H0.undo, H0.redo);
    else if (a === 'redoh') stepHistory(H0.redo, H0.undo);
    else if (a === 'rotate') {
      mark();
      // anche i tratti della gomma ruotano con la pagina
      const asp = pw / ph;
      params.erase = (params.erase || []).map((s) => ({ r: s.r * asp, pts: s.pts.map(([x, y]) => [1 - y, x]) }));
      params.rotation = ((params.rotation || 0) + 1) % 4;
      [pw, ph] = [ph, pw];
      change();
    } else if (a === 'dewarp') {
      mark();
      params.dewarp = !params.dewarp;
      t.classList.toggle('on', params.dewarp);
      // i tratti della gomma erano sulla pagina non distesa
      params.erase = [];
      if (params.dewarp && !(await db.kvGet('uvLoaded', false))) {
        toast('Scarico il modello per le pagine curve (31 MB), solo la prima volta', null, 5000);
        db.kvSet('uvLoaded', true);
      }
      change();
    } else if (a === 'split') panelSplit();
    else if (a === 'redo') { await commit(); camera({ replaceId: page.id }); }
    else if (a === 'more') {
      menuSheet(`Pagina ${idx + 1}`, [
        { label: `Modifiche a tutte le pagine: ${P.applyAll ? 'attivo' : 'disattivo'}`, icon: 'copy', run: async () => {
          P.applyAll = !P.applyAll;
          await db.putProject(Object.assign((await db.getProject(P.id)) || P, { applyAll: P.applyAll }));
          if (P.applyAll) {
            toast('Filtro, luminosità, contrasto e Distendi ora valgono per tutte le pagine');
            dirty = true;
            await applyLookToAll();
          } else toast('Le modifiche valgono solo per questa pagina');
          allBadge();
        } },
        { label: 'Nuova pagina dopo questa', icon: 'square-plus', run: async () => { await commit(); pickPhotos({ index: idx + 1 }); } },
        { label: 'Ripristina la foto originale', icon: 'arrow-back-up', run: () => {
          mark();
          Object.assign(params, { quad: FULL_QUAD, rotation: 0, filter: 'original', brightness: 0, contrast: 0, erase: [], dewarp: false });
          dirty = true;
          toView(true);
        } },
        ...(isBlurry(page, blurMedian()) ? [{ label: 'Non è sfocata, togli l’avviso', icon: 'check', run: async () => {
          page.blurOk = true; await db.putPage(page); S.pages.set(page.id, page); toast('Avviso rimosso');
        } }] : []),
        { label: 'Elimina pagina', icon: 'trash', cls: 'danger', run: async () => {
          if (!(await confirmSheet('Eliminare la pagina?', `La pagina ${idx + 1} verrà eliminata.`, 'Elimina', true))) return;
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
    if (!pvURL) { toast('Attendi l’anteprima della pagina'); return; }
    mode = 'split';
    ov.innerHTML = '';
    line = [0.5, 0.5];
    controls.innerHTML = `
      <div class="modehint">Sposta la linea sulla piega tra le due pagine. Trascina i cerchi per inclinarla</div>
      <div class="bar"><button class="btn" data-c="cancel">Annulla</button><button class="btn primary" data-c="apply">Dividi</button></div>`;
    drawSplit();
    controls.onclick = async (e) => {
      const c = e.target.closest('[data-c]');
      if (!c) return;
      if (c.dataset.c === 'cancel') { ov.innerHTML = ''; toView(false); }
      else { ov.innerHTML = ''; await doSplit(line[0], line[1]); }
    };
    // posizione iniziale: la piega trovata nella foto, se cade dentro questa pagina
    try {
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
    toast('Pagina divisa in due');
    editor(page.id);
  }
}

// =====================================================================
// ESPORTA
// =====================================================================
async function exportSheet() {
  const P = S.project;
  const E = await import('./export.js');
  const o = { kind: 'pdf', ocr: true, engine: 'paddle', ita: true, eng: true, quality: 'medium', size: 'image', ...(await db.kvGet('exportOpts', {})) };
  const st = sync.getState();
  const s = sheet(`${shead('Esporta')}
    <div class="seg" id="kind"><button data-k="pdf">PDF</button><button data-k="img">Immagini</button></div>
    <div id="opts"></div>
    <div class="gl">Backup</div>
    <div class="card">
      <div class="li"><span>Ultimo backup</span><span class="r">${ago(P.lastBackup)}</span></div>
      <button class="li accent" data-a="backup"><span>Esporta progetto (.zip)</span>${icon('download')}</button>
      <button class="li" data-a="server"><span>Backup automatico</span><span class="r">${st.status === 'off' ? 'non attivo' : st.status === 'error' ? 'errore' : st.status === 'syncing' ? 'in corso' : 'attivo'}${icon('chevron-right')}</span></button>
    </div>
    <div class="actions"><button class="btn primary" id="go"></button></div>`);

  const draw = async () => {
    $$('#kind button', s.el).forEach((b) => b.classList.toggle('on', b.dataset.k === o.kind));
    const qseg = `<div class="seg" id="q">${Object.entries(E.QUALITY).map(([k, v]) => `<button data-q="${k}" class="${o.quality === k ? 'on' : ''}">${v.label}</button>`).join('')}</div>`;
    const sw = (id, on) => `<span class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></span>`;
    $('#opts', s.el).innerHTML =
      (o.kind === 'pdf'
        ? `<div class="gl">Formato pagina</div>
          <div class="seg" id="psize"><button data-s="image" class="${o.size === 'image' ? 'on' : ''}">Come la foto</button><button data-s="a4" class="${o.size === 'a4' ? 'on' : ''}">A4 con margini</button></div>
          ${o.size === 'a4' ? '<p class="note">Ogni pagina viene centrata su un foglio A4 con 1 cm di margine: tutte della stessa misura, pronte da stampare.</p>' : ''}
          <div class="gl">PDF</div><div class="card">
            <label class="li"><span>Testo ricercabile (OCR)</span>${sw('ocr', o.ocr)}</label>
            ${o.ocr && o.engine === 'tesseract' ? `<label class="li"><span>Italiano</span>${sw('ita', o.ita)}</label><label class="li"><span>Inglese</span>${sw('eng', o.eng)}</label>` : ''}
          </div>
          ${o.ocr ? `<div class="gl">Riconoscimento del testo</div>
            <div class="seg" id="engine">${Object.entries(OCR_ENGINES).map(([k, v]) => `<button data-e="${k}" class="${o.engine === k ? 'on' : ''}">${v.label} · ${v.name}</button>`).join('')}</div>
            <p class="note">${o.engine === 'paddle'
              ? 'Più preciso su foto, pagine curve e caratteri piccoli. Riconosce italiano, inglese e le altre lingue con alfabeto latino. La prima volta scarica circa 27 MB.'
              : 'Circa tre volte più veloce, meno preciso sulle foto difficili. La prima volta scarica circa 10 MB.'} Tutto avviene sul telefono, poi funziona anche offline.</p>` : ''}`
        : '') +
      `<div class="gl">Qualità</div>${qseg}<p class="note" id="est">Stima in corso…</p>`;
    $('#go', s.el).textContent = o.kind === 'pdf' ? 'Crea PDF' : 'Crea immagini (.zip)';
    for (const id of ['ocr', 'ita', 'eng']) {
      const i = $(`#${id}`, s.el);
      if (i) i.onchange = () => { o[id] = i.checked; save(); draw(); };
    }
    $$('#q button', s.el).forEach((b) => (b.onclick = () => { o.quality = b.dataset.q; save(); draw(); }));
    $$("#engine button", s.el).forEach((b) => (b.onclick = () => { o.engine = b.dataset.e; save(); draw(); }));
    $$('#psize button', s.el).forEach((b) => (b.onclick = () => { o.size = b.dataset.s; save(); draw(); }));
    const est = await E.estimate(P, o.quality);
    const el = $('#est', s.el);
    if (el) el.textContent = `${plural(P.order.length, 'pagina', 'pagine')} · circa ${bytes(est)}`;
  };
  const save = () => db.kvSet('exportOpts', o);
  $$('#kind button', s.el).forEach((b) => (b.onclick = () => { o.kind = b.dataset.k; save(); draw(); }));
  draw();

  s.el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-a]');
    if (!t) return;
    if (t.dataset.a === 'backup') { s.close(); backupFlow(P); }
    else if (t.dataset.a === 'server') { s.close(); settings(); }
  });

  $('#go', s.el).onclick = async () => {
    const langs = [o.ita && 'ita', o.eng && 'eng'].filter(Boolean);
    if (o.kind === 'pdf' && o.ocr && o.engine === 'tesseract' && !langs.length) return toast('Scegli almeno una lingua');
    s.close();
    const ctrl = new AbortController();
    const prog = sheet(`${shead(o.kind === 'pdf' ? 'Creo il PDF' : 'Preparo le immagini')}
      <div class="progress"><i id="bar"></i></div><div class="ptext" id="ptext">Preparazione…</div>
      <p class="note" style="text-align:center">Tieni l’app aperta. Le pagine restano salvate anche se interrompi.</p>
      <div class="actions"><button class="btn" data-close>Annulla</button></div>`, { dismissable: false, onClose: () => ctrl.abort() });
    const upd = (frac, text) => {
      const b = $('#bar', prog.el);
      if (b) b.style.width = `${Math.round(frac * 100)}%`;
      const t = $('#ptext', prog.el);
      if (t) t.textContent = text;
    };
    try {
      await waitProcessing((left) => upd(0, `Finisco di elaborare le pagine (${left})…`), ctrl.signal);
      const fresh = await db.getProject(P.id);
      let blob;
      let name;
      if (o.kind === 'pdf') {
        blob = await E.buildPdf(fresh, {
          quality: o.quality, ocr: o.ocr, engine: o.engine, langs, size: o.size, signal: ctrl.signal,
          onProgress: ({ phase, done, total, detail }) => {
            if (phase === 'ocr') upd((done / total) * 0.85, detail || `Riconosco il testo: pagina ${Math.min(total, Math.floor(done) + 1)} di ${total}`);
            else upd(o.ocr ? 0.85 + (done / total) * 0.15 : done / total, `Impagino: ${done} di ${total}`);
          },
        });
        name = `${E.slug(fresh.name)}.pdf`;
      } else {
        blob = await E.buildImagesZip(fresh, { quality: o.quality, onProgress: ({ done, total }) => upd(done / total, `Pagina ${done + 1} di ${total}`) });
        name = `${E.slug(fresh.name)}-immagini.zip`;
      }
      if (ctrl.signal.aborted) return;
      prog.close();
      fileReadySheet(blob, name, o.kind === 'pdf' ? 'PDF pronto' : 'Immagini pronte');
    } catch (err) {
      prog.close();
      if (err.name !== 'AbortError') {
        console.error(err);
        toast(`Esportazione non riuscita: ${err.message}`);
      }
    }
  };
}

function waitProcessing(onLeft, signal) {
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (signal.aborted) return reject(new DOMException('annullato', 'AbortError'));
      const pages = await db.getPages(S.project.id);
      const left = S.project.order.filter((id) => pages.get(id) && pages.get(id).status === 'pending').length;
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
async function settings() {
  const theme = await db.kvGet('theme', 'auto');
  const cfg = sync.config();
  let est = null;
  let persisted = null;
  try { est = await navigator.storage.estimate(); } catch { /* */ }
  try { persisted = await navigator.storage.persisted(); } catch { /* */ }
  const st = sync.getState();
  const s = sheet(`${shead('Impostazioni')}
    <div class="gl" style="margin-top:4px">Aspetto</div>
    <div class="seg" id="theme">${[['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(([k, l]) => `<button data-t="${k}" class="${theme === k ? 'on' : ''}">${l}</button>`).join('')}</div>

    <div class="gl">Backup automatico sul server</div>
    <div class="card">
      <label class="li"><span>Attivo</span><span class="switch"><input type="checkbox" id="sen" ${cfg.enabled ? 'checked' : ''}><i></i></span></label>
      <label class="li"><span>Indirizzo</span><input type="url" id="surl" placeholder="https://pageturn.casa.it" value="${esc(cfg.url)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="li"><span>Codice</span><input type="password" id="stok" placeholder="facoltativo" value="${esc(cfg.token)}"></label>
      <div class="li"><span>Stato</span><span class="r" id="sst">${syncText(st)}</span></div>
      <button class="li accent" data-a="test"><span>Verifica connessione</span>${icon('server')}</button>
      <button class="li accent" data-a="restore"><span>Ripristina dal server</span>${icon('download')}</button>
    </div>
    <p class="note">Ogni foto viene inviata al tuo server appena scattata, così resta una copia anche se perdi il telefono. Il server è incluso nel progetto (cartella server).</p>

    <div class="gl">Archivio sul dispositivo</div>
    <div class="card">
      <div class="li"><span>Spazio usato</span><span class="r">${est ? `${bytes(est.usage)}${est.quota ? ` di ${bytes(est.quota)}` : ''}` : 'non disponibile'}</span></div>
      <div class="li"><span>Protetto dalla pulizia</span><span class="r">${persisted ? 'sì' : standalone ? 'non confermato' : 'no, installa l’app'}</span></div>
      <button class="li accent" data-a="import"><span>Importa un backup (.zip)</span>${icon('upload')}</button>
    </div>

    <div class="gl">Informazioni</div>
    <div class="card">
      <div class="li"><span>Versione</span><span class="r">${VERSION}</span></div>
      <a class="li accent" href="${REPO}" target="_blank" rel="noopener" style="text-decoration:none"><span>Codice sorgente su GitHub</span>${icon('chevron-right')}</a>
    </div>
    <p class="note">Pageturn è open source (licenza GPL-3.0). Le scansioni restano sul tuo dispositivo e sul tuo server: nessun dato passa da altri servizi.</p>`);

  $$('#theme button', s.el).forEach((b) => (b.onclick = () => {
    applyTheme(b.dataset.t);
    $$('#theme button', s.el).forEach((x) => x.classList.toggle('on', x === b));
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
        toast('Server raggiungibile');
        sync.kick();
      } catch (err) {
        toast(`Server non raggiungibile: ${err.message}`);
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
        const tp = toastProgress('Importo il backup…');
        try {
          const { importBackup } = await import('./export.js');
          const p = await importBackup(f);
          tp.done();
          close0();
          queue.resume();
          toast(`«${p.name}» importato`);
          if (S.view === 'home') home();
        } catch (err) {
          tp.done();
          toast(err.message);
        }
      };
      inp.click();
    }
  });
  const obs = new MutationObserver(() => { if (!s.el.isConnected) { sync.events.removeEventListener('change', onSync); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
}

function syncText(st) {
  if (st.status === 'off') return 'non attivo';
  if (st.status === 'syncing') return `invio in corso (${st.pending})`;
  if (st.status === 'error') return st.error || 'errore';
  return 'tutto sul server';
}

async function restoreSheet() {
  let list;
  try {
    list = await sync.remoteProjects();
  } catch (e) {
    return toast(`Server non raggiungibile: ${e.message}`);
  }
  if (!list.length) return toast('Sul server non ci sono libri');
  menuSheet('Ripristina dal server', list.map((p) => ({
    label: `${p.name} · ${plural(p.pages, 'pagina', 'pagine')}`,
    icon: 'download',
    run: async () => {
      const t = toastProgress('Scarico…');
      try {
        const proj = await sync.restore(p.id, (i, n) => t.set(`Scarico ${i + 1} di ${n}…`));
        t.done();
        queue.resume();
        toast(`«${proj.name}» ripristinato`);
        await loadProject(proj.id);
        project();
      } catch (e) {
        t.done();
        toast(`Ripristino non riuscito: ${e.message}`);
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
            toast('È pronta una nuova versione', { label: 'Aggiorna', run: () => w.postMessage('skip') }, 8000);
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
  app.innerHTML = `<div class="empty"><h2>Qualcosa non va</h2><p>${esc(e.message)}</p></div>`;
});

// per i test
window.__pageturn = { S, db, queue, sync };
