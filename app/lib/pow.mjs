import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(here, 'pow-worker.mjs');

// A solved PoW response is single-use: the server rejects replays with
// INVALID_POW_RESPONSE (40301). So we solve ahead of time and consume one per request.
export class PowSolver {
  constructor({ size = 2, safetyMs = 30_000 } = {}) {
    this.size = size;
    this.safetyMs = safetyMs;
    this.workers = [];
    this.pending = new Map();
    this.seq = 0;
    this.ready = this.#spawnAll();
  }

  #spawnAll() {
    const waits = [];
    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(WORKER_PATH);
      worker.unref();
      const slot = { worker, busy: false, ready: false };
      this.workers.push(slot);
      waits.push(new Promise((resolve, reject) => {
        const onMessage = (msg) => {
          if (msg && msg.type === 'ready') {
            slot.ready = true;
            resolve();
          } else if (msg && msg.type === 'load-error') {
            reject(new Error('pow worker load failed: ' + msg.message));
          } else {
            const entry = this.pending.get(msg.id);
            if (!entry) return;
            this.pending.delete(msg.id);
            slot.busy = false;
            entry.resolve(msg);
          }
        };
        worker.on('message', onMessage);
        worker.on('error', (err) => {
          slot.busy = false;
          reject(err);
        });
      }));
    }
    return Promise.all(waits);
  }

  #freeSlot() {
    return this.workers.find((w) => w.ready && !w.busy) || null;
  }

  #run(challenge) {
    const slot = this.#freeSlot();
    if (!slot) return Promise.reject(new Error('no free pow worker'));
    slot.busy = true;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        slot.busy = false;
        reject(new Error('pow solve timed out'));
      }, this.safetyMs);
      this.pending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      slot.worker.postMessage({ type: 'solve', id, challenge });
    });
  }

  /**
   * Solve a challenge. Splits the search space across idle workers only when the
   * challenge is large enough to be worth the coordination cost.
   */
  async solve(challenge) {
    await this.ready;
    const deadline = Date.now() + this.safetyMs;
    while (!this.#freeSlot()) {
      if (Date.now() > deadline) throw new Error('all pow workers busy');
      await new Promise((r) => setTimeout(r, 50));
    }
    const res = await this.#run(challenge);
    if (!res.ok) throw new Error('pow solve failed: ' + res.error);
    return res.answer;
  }

  buildHeader(answer, targetPath) {
    return Buffer.from(JSON.stringify({
      algorithm: answer.algorithm,
      challenge: answer.challenge,
      salt: answer.salt,
      answer: answer.answer,
      signature: answer.signature,
      target_path: targetPath,
    }), 'utf8').toString('base64');
  }

  get idleWorkers() {
    return this.workers.filter((w) => w.ready && !w.busy).length;
  }
}