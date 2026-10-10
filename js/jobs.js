// Esegue le elaborazioni pesanti in un Web Worker, così l'interfaccia non si blocca.
// Se il browser non supporta OffscreenCanvas nei worker, ripiega sul thread principale.

let worker = null;
let seq = 0;
const pending = new Map();
let fallback = null;

function startWorker() {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const w = new Worker(new URL('./proc-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
    w.onerror = () => {
      // Il worker è caduto (memoria): si riparte con uno nuovo, i lavori in corso falliscono e vengono ritentati.
      for (const p of pending.values()) p.reject(new Error('worker'));
      pending.clear();
      worker = null;
    };
    return w;
  } catch {
    return null;
  }
}

async function call(op, ...args) {
  if (!worker && fallback === null) worker = startWorker();
  if (!worker) {
    if (!fallback) fallback = await import('./render.js');
    return fallback[op](...args);
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args });
  });
}

export const renderPage = (blob, params, opts) => call('render', blob, params, opts);
export const resizeImage = (blob, opts) => call('resize', blob, opts);
export const detectPage = (blob) => call('detect', blob);
