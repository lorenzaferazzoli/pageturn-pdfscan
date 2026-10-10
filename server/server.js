#!/usr/bin/env node
// Server di Pageturn: serve l'app e riceve il backup automatico delle pagine.
// Nessuna dipendenza: basta Node 18 o superiore.
//
//   node server/server.js
//
// Variabili d'ambiente:
//   PORT          porta (predefinita 8080)
//   DATA_DIR      dove salvare i backup (predefinita ./data)
//   PAGETURN_TOKEN codice di accesso; se impostato, l'app deve inserirlo nelle impostazioni
//   TLS_CERT, TLS_KEY  percorsi di certificato e chiave per servire direttamente in https
//   CORS_ORIGIN   origine ammessa per l'app ospitata altrove (es. https://utente.github.io); predefinito *

import http from 'node:http';
import https from 'node:https';
import { createReadStream, readFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, rename, stat, rm } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = +process.env.PORT || 8080;
const DATA = normalize(process.env.DATA_DIR || join(ROOT, 'data'));
const TOKEN = process.env.PAGETURN_TOKEN || '';
const CORS = process.env.CORS_ORIGIN || '*';
const MAX_IMAGE = 40 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
// Cartelle dell'app che si possono servire (niente data/, server/, node_modules/).
const PUBLIC = ['index.html', 'sw.js', 'manifest.webmanifest', 'css/', 'js/', 'vendor/', 'icons/', 'LICENSE'];

const ID = /^[a-z0-9-]{1,64}$/i;

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

function authorized(req) {
  if (!TOKEN) return true;
  const got = Buffer.from(String(req.headers['x-pageturn-token'] || ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function body(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('troppo grande'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Scrittura atomica: prima un file temporaneo, poi la rinomina.
async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function readJSON(path, def) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return def; }
}

async function api(req, res, parts) {
  // parts: ['api', ...]
  if (parts[1] === 'health') {
    return send(res, 200, { pageturn: true, version: 1, auth: !!TOKEN, authorized: authorized(req) });
  }
  if (!authorized(req)) return send(res, 401, { error: 'codice di accesso errato' });
  if (parts[1] !== 'projects') return send(res, 404, { error: 'non trovato' });
  const [, , pid, sub, id, leaf] = parts;
  if (pid && !ID.test(pid)) return send(res, 400, { error: 'id non valido' });
  if (id && !ID.test(id)) return send(res, 400, { error: 'id non valido' });
  const pdir = pid ? join(DATA, pid) : null;

  // GET /api/projects
  if (!pid && req.method === 'GET') {
    const out = [];
    const dirs = existsSync(DATA) ? await readdir(DATA, { withFileTypes: true }) : [];
    for (const d of dirs) {
      if (!d.isDirectory() || !ID.test(d.name)) continue;
      const p = await readJSON(join(DATA, d.name, 'project.json'), null);
      if (p) out.push({ id: p.id, name: p.name, pages: (p.order || []).length, updated: p.updated });
    }
    return send(res, 200, out.sort((a, b) => (b.updated || 0) - (a.updated || 0)));
  }
  // PUT /api/projects/:pid
  if (pid && !sub && req.method === 'PUT') {
    const p = JSON.parse((await body(req, MAX_JSON)).toString('utf8'));
    if (p.id !== pid) return send(res, 400, { error: 'id diverso' });
    await writeAtomic(join(pdir, 'project.json'), JSON.stringify(p));
    return send(res, 200, { ok: true });
  }
  // GET /api/projects/:pid
  if (pid && !sub && req.method === 'GET') {
    const project = await readJSON(join(pdir, 'project.json'), null);
    if (!project) return send(res, 404, { error: 'non trovato' });
    const pages = [];
    const files = existsSync(join(pdir, 'pages')) ? await readdir(join(pdir, 'pages')) : [];
    for (const f of files) if (f.endsWith('.json')) pages.push(await readJSON(join(pdir, 'pages', f), null));
    return send(res, 200, { project, pages: pages.filter(Boolean) });
  }
  if (pid && sub === 'pages' && id) {
    const base = join(pdir, 'pages', id);
    if (leaf === 'image') {
      if (req.method === 'PUT') {
        await writeAtomic(`${base}.jpg`, await body(req, MAX_IMAGE));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        try {
          const s = await stat(`${base}.jpg`);
          res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': s.size, 'cache-control': 'no-store' });
          return createReadStream(`${base}.jpg`).pipe(res);
        } catch { return send(res, 404, { error: 'non trovato' }); }
      }
    } else if (!leaf) {
      if (req.method === 'PUT') {
        const p = JSON.parse((await body(req, MAX_JSON)).toString('utf8'));
        if (p.id !== id) return send(res, 400, { error: 'id diverso' });
        await writeAtomic(`${base}.json`, JSON.stringify(p));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        await rm(`${base}.json`, { force: true });
        await rm(`${base}.jpg`, { force: true });
        return send(res, 200, { ok: true });
      }
    }
  }
  return send(res, 405, { error: 'metodo non ammesso' });
}

async function staticFile(req, res, path) {
  let rel = decodeURIComponent(path).replace(/^\/+/, '') || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  if (!PUBLIC.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p))) return send(res, 404, 'Non trovato', 'text/plain');
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) return send(res, 403, 'Vietato', 'text/plain');
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error();
    const noCache = rel === 'index.html' || rel === 'sw.js';
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'content-length': s.size,
      'cache-control': noCache ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'Non trovato', 'text/plain');
  }
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'api') {
    res.setHeader('access-control-allow-origin', CORS);
    res.setHeader('access-control-allow-methods', 'GET, PUT, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-pageturn-token');
    res.setHeader('access-control-max-age', '86400');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      return await api(req, res, parts);
    } catch (e) {
      return send(res, e.code === 413 ? 413 : 500, { error: e.message });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Metodo non ammesso', 'text/plain');
  return staticFile(req, res, url.pathname);
}

await mkdir(DATA, { recursive: true });
const server = process.env.TLS_CERT && process.env.TLS_KEY
  ? https.createServer({ cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }, handler)
  : http.createServer(handler);
server.listen(PORT, () => {
  const proto = process.env.TLS_CERT ? 'https' : 'http';
  console.log(`Pageturn: ${proto}://localhost:${PORT}  (backup in ${DATA}${TOKEN ? ', con codice di accesso' : ''})`);
});
