// Fotocamera nell'app con riconoscimento della pagina e scatto automatico.
import { detectQuad, frameDiff, quadDelta } from './detect.js';

const AW = 220; // larghezza del fotogramma di analisi dal vivo
const SHOT_W = 400; // allo scatto si rifà il riconoscimento più preciso (piega del libro compresa)

export class Camera {
  constructor(video, { onState, onCapture }) {
    this.video = video;
    this.onState = onState;
    this.onCapture = onCapture;
    this.auto = true;
    this.stream = null;
    this.timer = 0;
    this.small = document.createElement('canvas');
    this.sctx = this.small.getContext('2d', { willReadFrequently: true });
    this.reset();
  }

  reset() {
    this.phase = 'search'; // search → steady → (scatto) → turn → search
    this.prevGray = null;
    this.lastShotGray = null;
    this.prevQuad = null;
    this.steadySince = 0;
    this.sawMotion = false;
    this.busy = false;
  }

  async start() {
    const tries = [
      { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      { facingMode: { ideal: 'environment' } },
    ];
    let err;
    for (const video of tries) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        break;
      } catch (e) {
        err = e;
      }
    }
    if (!this.stream) throw err || new Error('camera');
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    // Messa a fuoco continua, quando il dispositivo lo permette.
    const track = this.track();
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch { /* non supportato */ }
    this.reset();
    this.loop();
  }

  track() {
    return this.stream && this.stream.getVideoTracks()[0];
  }

  hasTorch() {
    const t = this.track();
    try {
      return !!(t && t.getCapabilities && t.getCapabilities().torch);
    } catch {
      return false;
    }
  }

  async setTorch(on) {
    try {
      await this.track().applyConstraints({ advanced: [{ torch: on }] });
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  loop() {
    if (!this.stream) return;
    this.timer = setTimeout(() => {
      try {
        this.analyze();
      } catch (e) {
        console.warn(e);
      }
      this.loop();
    }, 140);
  }

  grabSmall() {
    const v = this.video;
    if (!v.videoWidth) return null;
    const w = AW;
    const h = Math.round((v.videoHeight / v.videoWidth) * AW);
    this.small.width = w;
    this.small.height = h;
    this.sctx.drawImage(v, 0, 0, w, h);
    const d = this.sctx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return { g, w, h };
  }

  analyze() {
    if (this.busy) return;
    const f = this.grabSmall();
    if (!f) return;
    // di norma basta la regione chiara (veloce); se non trova la pagina si cercano anche le linee
    // dei bordi (sfondi chiari, libro tenuto in mano), ma solo un fotogramma su tre: negli altri due
    // si tiene l'ultimo risultato delle linee.
    this.tick = (this.tick || 0) + 1;
    let found = detectQuad(f.g, f.w, f.h, { fast: true });
    if (found) this.lineHit = null;
    else if (this.tick % 3 === 0) {
      found = detectQuad(f.g, f.w, f.h, { spine: false });
      this.lineHit = found ? { found, tick: this.tick } : null;
    } else if (this.lineHit && this.tick - this.lineHit.tick < 3) found = this.lineHit.found;
    const motion = frameDiff(f.g, this.prevGray);
    this.prevGray = f.g;
    const quad = found ? found.quad : null;
    const qMove = quadDelta(quad, this.prevQuad);
    this.prevQuad = quad;
    const now = performance.now();
    const still = motion < 4.5 && qMove < 0.02;
    let progress = 0;

    if (this.phase === 'turn') {
      // Dopo uno scatto si aspetta che la pagina venga girata: movimento, poi di nuovo fermo.
      if (motion > 9 || !quad) this.sawMotion = true;
      if (this.sawMotion && still && quad && frameDiff(f.g, this.lastShotGray) > 6) {
        this.phase = 'search';
      }
    }
    if (this.phase === 'search' || this.phase === 'steady') {
      if (quad && still) {
        if (this.phase !== 'steady') {
          this.phase = 'steady';
          this.steadySince = now;
        }
        progress = Math.min(1, (now - this.steadySince) / 650);
        if (this.auto && progress >= 1) {
          this.shoot(quad, f.g);
          progress = 0;
        }
      } else {
        this.phase = 'search';
      }
    }
    this.onState({ quad, phase: this.phase, progress, auto: this.auto });
  }

  // Scatto: fotogramma a piena risoluzione del video.
  async shoot(quad, gray) {
    if (this.busy || !this.stream) return;
    this.busy = true;
    try {
      const v = this.video;
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      // riconoscimento preciso sul fotogramma scattato
      const k = SHOT_W / Math.max(c.width, c.height);
      const s = document.createElement('canvas');
      s.width = Math.round(c.width * k);
      s.height = Math.round(c.height * k);
      const sx = s.getContext('2d', { willReadFrequently: true });
      sx.drawImage(c, 0, 0, s.width, s.height);
      const d = sx.getImageData(0, 0, s.width, s.height).data;
      const g = new Uint8Array(s.width * s.height);
      for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      const det = detectQuad(g, s.width, s.height) || (quad ? { quad, full: quad, halves: null, spine: null } : null);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      c.width = c.height = 0; // libera la memoria subito (Safari)
      this.lastShotGray = gray || (this.grabSmall() || {}).g;
      this.phase = 'turn';
      this.sawMotion = false;
      await this.onCapture(blob, det);
    } finally {
      this.busy = false;
    }
  }

  manualShoot() {
    const f = this.grabSmall();
    const found = f ? detectQuad(f.g, f.w, f.h) : null;
    return this.shoot(found ? found.quad : null, f && f.g);
  }
}
