// Backup automatico su un server Sfoglia (vedi server/server.js).
// Ogni foto originale viene caricata appena salvata; se la rete manca, si ritenta.
import * as db from './db.js';

export const events = new EventTarget();
let cfg = { enabled: false, url: '', token: '' };
let state = { status: 'off', pending: 0, error: '' };
let running = false;
let timer = 0;

export async function init() {
  const saved = await db.kvGet('sync', null);
  if (saved) cfg = saved;
  else {
    // Primo avvio: se l'app è servita da un server Sfoglia, il backup automatico si attiva da solo.
    const ok = await health(location.origin, '').catch(() => null);
    if (ok) {
      cfg = { enabled: true, url: location.origin, token: '' };
      await db.kvSet('sync', cfg);
    }
  }
  emit();
  kick();
  addEventListener('online', kick);
}

export function config() {
  return { ...cfg };
}

export function getState() {
  return { ...state };
}

export async function configure(next) {
  cfg = { ...cfg, ...next };
  await db.kvSet('sync', cfg);
  emit();
  kick();
}

function base() {
  return (cfg.url || '').replace(/\/+$/, '');
}

function headers(extra = {}) {
  return cfg.token ? { 'x-sfoglia-token': cfg.token, ...extra } : extra;
}

export async function health(url = base(), token = cfg.token) {
  const r = await fetch(`${url.replace(/\/+$/, '')}/api/health`, {
    headers: token ? { 'x-sfoglia-token': token } : {},
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(r.status === 401 ? 'Codice di accesso errato' : `Errore ${r.status}`);
  const j = await r.json();
  if (!j.sfoglia) throw new Error('Non è un server Sfoglia');
  if (j.auth && !j.authorized) throw new Error('Codice di accesso errato');
  return j;
}

function emit() {
  events.dispatchEvent(new CustomEvent('change', { detail: getState() }));
}

export function kick() {
  clearTimeout(timer);
  timer = setTimeout(run, 400);
}

async function put(path, body, type) {
  const r = await fetch(base() + path, { method: 'PUT', body, headers: headers({ 'content-type': type }) });
  if (!r.ok) throw new Error(r.status === 401 ? 'Codice di accesso errato' : `Errore del server (${r.status})`);
}

async function run() {
  if (running) return;
  if (!cfg.enabled || !cfg.url) {
    state = { status: 'off', pending: 0, error: '' };
    return emit();
  }
  running = true;
  try {
    const list = await db.unsyncedPages();
    state = { status: list.length ? 'syncing' : 'ok', pending: list.length, error: '' };
    emit();
    const seenProjects = new Set();
    for (const p of list) {
      if (!seenProjects.has(p.projectId)) {
        const proj = await db.getProject(p.projectId);
        if (!proj) continue;
        await put(`/api/projects/${proj.id}`, JSON.stringify(proj), 'application/json');
        seenProjects.add(p.projectId);
      }
      const orig = await db.getBlob(db.origKey(p));
      if (orig) await put(`/api/projects/${p.projectId}/pages/${p.id}/image`, orig, 'image/jpeg');
      const { ocr, origId, ...meta } = p;
      await put(`/api/projects/${p.projectId}/pages/${p.id}`, JSON.stringify(meta), 'application/json');
      const fresh = await db.getPage(p.id);
      if (fresh && fresh.rev === p.rev) {
        fresh.synced = true;
        await db.putPage(fresh);
      }
      state.pending = Math.max(0, state.pending - 1);
      emit();
    }
    state = { status: 'ok', pending: 0, error: '', at: Date.now() };
    emit();
  } catch (e) {
    state = { status: 'error', pending: state.pending, error: navigator.onLine ? String(e.message || e) : 'Sei offline' };
    emit();
    timer = setTimeout(run, 15000);
  } finally {
    running = false;
  }
}

// Ordine delle pagine ed eliminazioni: si aggiorna il progetto sul server.
export async function pushProject(project) {
  if (!cfg.enabled || !cfg.url) return;
  try {
    await put(`/api/projects/${project.id}`, JSON.stringify(project), 'application/json');
  } catch { /* riprova al prossimo giro */ }
}

export async function remoteProjects() {
  const r = await fetch(`${base()}/api/projects`, { headers: headers(), cache: 'no-store' });
  if (!r.ok) throw new Error(`Errore ${r.status}`);
  return r.json();
}

// Scarica dal server un progetto intero come nuovo progetto locale.
export async function restore(remoteId, onProgress) {
  const r = await fetch(`${base()}/api/projects/${remoteId}`, { headers: headers(), cache: 'no-store' });
  if (!r.ok) throw new Error(`Errore ${r.status}`);
  const { project: rp, pages } = await r.json();
  const local = await db.getProject(rp.id);
  const project = local ? await db.createProject(`${rp.name} (dal server)`) : await db.putProject({ ...rp, order: [] });
  const byId = new Map(pages.map((p) => [p.id, p]));
  const order = (rp.order || []).filter((id) => byId.has(id));
  let i = 0;
  for (const id of order) {
    onProgress && onProgress(i++, order.length);
    const img = await fetch(`${base()}/api/projects/${rp.id}/pages/${id}/image`, { headers: headers() });
    if (!img.ok) continue;
    const blob = await img.blob();
    const meta = byId.get(id);
    const page = { ...meta, id: local ? db.uid() : id, projectId: project.id, status: 'pending', synced: !local };
    await db.addPages(project.id, [{ page, orig: blob }]);
  }
  return db.getProject(project.id);
}
