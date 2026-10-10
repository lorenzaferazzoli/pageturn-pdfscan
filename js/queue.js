// Coda di elaborazione: una pagina alla volta, in background, ripresa all'avvio.
import * as db from './db.js';
import { renderPage } from './jobs.js';

export const PROC = { maxSide: 2400, quality: 0.82, thumb: 360 };

export const events = new EventTarget();
const queue = [];
const queued = new Set();
let running = false;

export function enqueue(pageId, front = false) {
  if (queued.has(pageId)) return;
  queued.add(pageId);
  if (front) queue.unshift(pageId);
  else queue.push(pageId);
  pump();
}

export function size() {
  return queue.length + (running ? 1 : 0);
}

export async function resume() {
  const list = await db.pendingPages();
  list.sort((a, b) => a.created - b.created).forEach((p) => enqueue(p.id));
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      queued.delete(id);
      await processOne(id);
    }
  } finally {
    running = false;
    events.dispatchEvent(new CustomEvent('idle'));
  }
}

async function processOne(id, attempt = 0) {
  const page = await db.getPage(id);
  if (!page) return;
  const orig = await db.getBlob(db.origKey(page));
  if (!orig) return;
  const rev = page.rev;
  try {
    const r = await renderPage(orig, page.params, { ...PROC, measure: true });
    const fresh = await db.getPage(id);
    if (!fresh) return; // eliminata nel frattempo
    if (fresh.rev !== rev) return enqueue(id, true); // modificata nel frattempo: si rifà
    await db.putBlobs([[`${id}:proc`, r.blob], [`${id}:thumb`, r.thumb]]);
    fresh.status = 'done';
    fresh.width = r.width;
    fresh.height = r.height;
    if (r.sharp != null && fresh.sharp == null) fresh.sharp = r.sharp;
    await db.putPage(fresh);
    events.dispatchEvent(new CustomEvent('page', { detail: fresh }));
  } catch (err) {
    console.warn('elaborazione', id, err);
    if (attempt < 2) return processOne(id, attempt + 1);
    page.status = 'error';
    await db.putPage(page);
    events.dispatchEvent(new CustomEvent('page', { detail: page }));
  }
}
