import { render, resize, detect, detectUV } from './render.js';

const ops = { render, resize, detect, detectUV };

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const result = await ops[op](...args);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
