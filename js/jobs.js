// Esegue le elaborazioni pesanti in Web Worker, così l'interfaccia non si blocca.
// Due worker: uno per la coda in background (le pagine scattate), uno per ciò che si sta guardando
// (anteprime dell'editor, riconoscimento): le anteprime non aspettano mai la coda.
// Se il browser non supporta OffscreenCanvas nei worker, ripiega sul thread principale.

let seq = 0;
let fallback = null;
const lanes = { fg: null, bg: null };
const pending = new Map();

function startWorker(lane) {
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
      for (const [id, p] of pending) if (p.lane === lane) { p.reject(new Error('worker')); pending.delete(id); }
      lanes[lane] = null;
    };
    return w;
  } catch {
    return null;
  }
}

async function call(lane, op, ...args) {
  if (!lanes[lane] && fallback === null) lanes[lane] = startWorker(lane);
  const worker = lanes[lane];
  if (!worker) {
    if (!fallback) fallback = await import('./render.js');
    return fallback[op](...args);
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, lane });
    worker.postMessage({ id, op, args });
  });
}

// opts.lane: 'bg' per la coda; tutto il resto va nel worker interattivo
// Distendi carica un modello pesante: per non tenerlo in memoria due volte si usa sempre il worker di fondo.
export const renderPage = (blob, params, opts = {}) => call(opts.lane === 'bg' || (params && params.dewarp) ? 'bg' : 'fg', 'render', blob, params, opts);
export const resizeImage = (blob, opts) => call('bg', 'resize', blob, opts);
export const detectPage = (blob) => call('fg', 'detect', blob);
