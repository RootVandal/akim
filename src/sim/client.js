// Promise wrapper around the traffic worker.

export class TrafficClient {
  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.onProgress = null;
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { this.onProgress && this.onProgress(m.f, m.stage); return; }
      if (m.type === 'error') { console.error('[traffic worker]', m.message); if (this.initReject) this.initReject(new Error(m.message)); return; }
      if (m.type === 'ready') { this.initResolve(m); return; }
      if (m.type === 'restored') { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); } return; }
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p(m); }
    };
  }

  init(opts = {}) {
    return new Promise((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
      this.worker.postMessage({ type: 'init', ...opts });
    });
  }

  call(msg) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ ...msg, id });
    });
  }

  step(ctx) { return this.call({ type: 'step', ...ctx }); }

  restore(state) { return this.call({ type: 'restore', ...state }); }
}
