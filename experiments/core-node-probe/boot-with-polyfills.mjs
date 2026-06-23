// Push further: polyfill Worker + browser globals with node:worker_threads shims,
// to see whether the module can progress past Worker-not-defined on Node.
// Expected outcome: still fails because Emscripten's ENVIRONMENT='web,worker' build
// does not target Node's worker_threads API (different worker contract).
import { Worker as NodeWorker } from 'node:worker_threads';

// The built module detects ENVIRONMENT_IS_NODE and expects distinct code paths.
// But the code branches only fire when Emscripten was built with ENVIRONMENT
// containing 'node'. Otherwise, Web/Worker branches run and construct
// `new Worker(url, { type: 'module', name: 'em-pthread' })` using DOM Worker.

class FakeWorker {
  constructor(url, opts) {
    console.log(`[shim] Worker constructed url=${url} opts=${JSON.stringify(opts)}`);
    this.url = url;
    this.opts = opts;
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(msg) { console.log('[shim] Worker.postMessage', Object.keys(msg || {})); }
  terminate() {}
  addEventListener(t, f) { this['on' + t] = f; }
  removeEventListener() {}
}

globalThis.Worker = FakeWorker;
globalThis.self = globalThis;
globalThis.document = { createElement: () => ({ getContext: () => null, style: {} }) };

try {
  const mGBA = (await import('@thenick775/mgba-wasm')).default;
  const fakeCanvas = {
    width: 240, height: 160, style: {},
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 240, height: 160 }),
    getContext: () => null,
  };
  const mod = await Promise.race([
    mGBA({ canvas: fakeCanvas }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout-5s')), 5000)),
  ]);
  console.log('[result] initialized. Keys:', Object.keys(mod).length);
  console.log(Object.keys(mod).sort().join('\n'));
} catch (e) {
  console.log(`[result] failed: ${e.name}: ${e.message}`);
  if (e.stack) console.log(e.stack.split('\n').slice(0, 10).join('\n'));
}
