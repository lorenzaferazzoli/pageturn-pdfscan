// Archivio locale (IndexedDB). Ogni scatto viene scritto qui prima di qualsiasi
// elaborazione: se Safari si chiude, la foto c'è già.
//
// projects: { id, name, created, updated, order: [pageId], lastBackup, pagesSinceBackup }
// pages:    { id, projectId, created, rev, status: 'pending'|'done'|'error', params, width, height, sharp, ocr, synced }
// blobs:    chiave `${pageId}:orig` | `:proc` | `:thumb` → Blob

const DB_NAME = 'pageturn';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      const p = db.createObjectStore('pages', { keyPath: 'id' });
      p.createIndex('projectId', 'projectId');
      db.createObjectStore('blobs');
      db.createObjectStore('kv');
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('abort'));
  });
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const uid = () =>
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

export async function listProjects() {
  const db = await open();
  const all = await req(db.transaction('projects').objectStore('projects').getAll());
  return all.sort((a, b) => b.updated - a.updated);
}

export async function getProject(id) {
  const db = await open();
  return req(db.transaction('projects').objectStore('projects').get(id));
}

export async function putProject(p) {
  const db = await open();
  const tx = db.transaction('projects', 'readwrite');
  tx.objectStore('projects').put(p);
  await done(tx);
  return p;
}

export async function createProject(name) {
  const now = Date.now();
  return putProject({ id: uid(), name, created: now, updated: now, order: [], lastBackup: 0, pagesSinceBackup: 0 });
}

export async function getPages(projectId) {
  const db = await open();
  const pages = await req(db.transaction('pages').objectStore('pages').index('projectId').getAll(projectId));
  return new Map(pages.map((p) => [p.id, p]));
}

export async function getPage(id) {
  const db = await open();
  return req(db.transaction('pages').objectStore('pages').get(id));
}

export async function putPage(page) {
  const db = await open();
  const tx = db.transaction('pages', 'readwrite');
  tx.objectStore('pages').put(page);
  await done(tx);
  return page;
}

export async function getBlob(key) {
  const db = await open();
  return req(db.transaction('blobs').objectStore('blobs').get(key));
}

// Più blob in un'unica transazione (miniature della griglia).
export async function getBlobs(keys) {
  const db = await open();
  const st = db.transaction('blobs').objectStore('blobs');
  return Promise.all(keys.map((k) => req(st.get(k))));
}

export async function putBlobs(entries) {
  const db = await open();
  const tx = db.transaction('blobs', 'readwrite');
  const s = tx.objectStore('blobs');
  for (const [k, v] of entries) s.put(v, k);
  await done(tx);
}

// Una pagina divisa in due condivide la foto originale con la gemella (origId).
export const origKey = (p) => `${p.origId || p.id}:orig`;

// Elimina pagine dentro una transazione aperta; la foto originale resta finché qualche pagina la usa.
async function removeIn(tx, projectId, ids) {
  const pagesStore = tx.objectStore('pages');
  const blobs = tx.objectStore('blobs');
  const all = await req(pagesStore.index('projectId').getAll(projectId));
  const set = new Set(ids);
  const keep = all.filter((p) => !set.has(p.id));
  const used = new Set(keep.map(origKey));
  for (const p of all.filter((x) => set.has(x.id))) {
    pagesStore.delete(p.id);
    blobs.delete(`${p.id}:proc`);
    blobs.delete(`${p.id}:thumb`);
    if (!used.has(origKey(p))) blobs.delete(origKey(p));
  }
}

// Salva in un'unica transazione: foto originale, record della pagina e posizione nel progetto.
// items: [{ page, orig }] (orig può mancare se la pagina usa la foto di un'altra).
// index: posizione d'inserimento (fine se assente). replaceId: pagina da sostituire (riscatto).
export async function addPages(projectId, items, { index, replaceId } = {}) {
  const db = await open();
  const tx = db.transaction(['projects', 'pages', 'blobs'], 'readwrite');
  const ps = tx.objectStore('projects');
  const project = await req(ps.get(projectId));
  if (!project) throw new Error('Progetto non trovato');
  const ids = [];
  for (const { page, orig } of items) {
    if (orig) tx.objectStore('blobs').put(orig, origKey(page));
    tx.objectStore('pages').put(page);
    ids.push(page.id);
  }
  let order = project.order.slice();
  if (replaceId) {
    const at = order.indexOf(replaceId);
    order.splice(at < 0 ? order.length : at, at < 0 ? 0 : 1, ...ids);
    await removeIn(tx, projectId, [replaceId]);
  } else if (index != null) {
    order.splice(index, 0, ...ids);
  } else {
    order = order.concat(ids);
  }
  project.order = order;
  project.updated = Date.now();
  project.pagesSinceBackup = (project.pagesSinceBackup || 0) + (replaceId ? 0 : ids.length);
  ps.put(project);
  await done(tx);
  return project;
}

export async function deletePages(projectId, ids) {
  const db = await open();
  const tx = db.transaction(['projects', 'pages', 'blobs'], 'readwrite');
  const ps = tx.objectStore('projects');
  const project = await req(ps.get(projectId));
  const set = new Set(ids);
  project.order = project.order.filter((id) => !set.has(id));
  project.updated = Date.now();
  ps.put(project);
  await removeIn(tx, projectId, ids);
  await done(tx);
  return project;
}

export async function deleteProject(id) {
  const pages = await getPages(id);
  const db = await open();
  const tx = db.transaction(['projects', 'pages', 'blobs'], 'readwrite');
  tx.objectStore('projects').delete(id);
  for (const p of pages.values()) {
    tx.objectStore('pages').delete(p.id);
    for (const k of [`${p.id}:proc`, `${p.id}:thumb`, origKey(p)]) tx.objectStore('blobs').delete(k);
  }
  await done(tx);
}

export async function pendingPages() {
  const db = await open();
  const all = await req(db.transaction('pages').objectStore('pages').getAll());
  return all.filter((p) => p.status !== 'done');
}

export async function unsyncedPages() {
  const db = await open();
  const all = await req(db.transaction('pages').objectStore('pages').getAll());
  return all.filter((p) => !p.synced);
}

export async function kvGet(k, def) {
  const db = await open();
  const v = await req(db.transaction('kv').objectStore('kv').get(k));
  return v === undefined ? def : v;
}

export async function kvSet(k, v) {
  const db = await open();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(v, k);
  await done(tx);
}
