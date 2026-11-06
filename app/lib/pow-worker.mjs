import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.join(here, '..', 'vendor', 'pow-bundle.js'), 'utf8');
const chunk = fs.readFileSync(path.join(here, '..', 'vendor', 'pow-chunk.js'), 'utf8');

const sandbox = {
  console,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  Uint32Array,
  Array,
  ArrayBuffer,
  DataView,
  Promise,
  Math,
  Date,
  Error,
  TypeError,
  RangeError,
  Symbol,
  Object,
  String,
  Number,
  Boolean,
  JSON,
  performance,
  crypto: globalThis.crypto,
  queueMicrotask,
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.window = sandbox;

let result = null;
sandbox.postMessage = (msg) => { result = msg; };

vm.createContext(sandbox);
// The bundle pulls its real worker chunk through importScripts when the entry
// module is evaluated; that evaluation is async, so onmessage appears later.
sandbox.importScripts = () => { vm.runInContext(chunk, sandbox, { filename: 'pow-chunk.js' }); };

function loadBundle() {
  try {
    vm.runInContext(bundle, sandbox, { filename: 'pow-bundle.js' });
  } catch {
    // The bundle tries to resolve chunk 8138 eagerly; the chunk is already
    // inlined above, so a resolution failure here is expected and harmless.
  }
}

function waitForHandler(timeoutMs = 15_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (typeof sandbox.onmessage === 'function') return resolve(sandbox.onmessage);
      if (Date.now() - started > timeoutMs) return reject(new Error('pow handler never appeared'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

loadBundle();

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'solve') return;
  const { id, challenge } = msg;
  const started = Date.now();
  try {
    const handler = await waitForHandler();
    result = null;
    handler({
      data: {
        type: 'pow-challenge',
        challenge: { ...challenge, expireAt: challenge.expire_at ?? challenge.expireAt },
      },
    });
    if (!result || result.type !== 'pow-answer') {
      throw new Error(result && result.error ? String(result.error.message || result.error) : 'no answer produced');
    }
    parentPort.postMessage({ id, ok: true, answer: result.answer, solveMs: Date.now() - started });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});

waitForHandler().then(
  () => parentPort.postMessage({ type: 'ready' }),
  (err) => parentPort.postMessage({ type: 'load-error', message: String(err.message || err) }),
);