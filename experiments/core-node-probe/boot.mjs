// V1/V2/V7 de-risk probe.
// Goal: load @thenick775/mgba-wasm in vanilla Node, inspect API surface,
// and observe exactly where/why it fails without browser globals.
import mGBA from '@thenick775/mgba-wasm';

const result = {
  node: process.version,
  steps: [],
  moduleKeys: null,
  error: null,
};

function step(name, ok, detail) {
  result.steps.push({ name, ok, detail });
  console.log(`[${ok ? 'OK' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

try {
  step('import default', typeof mGBA === 'function', `typeof=${typeof mGBA}`);
} catch (e) {
  step('import default', false, e.message);
}

// Attempt 1: plain init with NO canvas (what V1 asks).
let mod = null;
try {
  mod = await mGBA({});
  step('mGBA({}) resolved', !!mod, `typeof=${typeof mod}`);
} catch (e) {
  step('mGBA({}) resolved', false, `${e.name}: ${e.message}`);
}

// Attempt 2: init with a minimal stub canvas (Emscripten Browser.* code paths
// touch canvas.getContext and canvas.addEventListener). Mirrors what gbajs3 does.
if (!mod) {
  const fakeCanvas = {
    width: 240,
    height: 160,
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 240, height: 160 }),
    getContext: (type) => {
      // Return a minimal object, no real GL. mGBA uses WebGL2 for rendering.
      return null;
    },
    setAttribute: () => {},
  };
  try {
    mod = await mGBA({ canvas: fakeCanvas });
    step('mGBA({canvas:stub}) resolved', !!mod);
  } catch (e) {
    step('mGBA({canvas:stub}) resolved', false, `${e.name}: ${e.message}`);
  }
}

if (mod) {
  const keys = Object.keys(mod).sort();
  result.moduleKeys = keys;
  console.log('\nModule keys (' + keys.length + '):');
  for (const k of keys) {
    const v = mod[k];
    console.log(`  ${k} :: ${typeof v}`);
  }
  // Sanity-check the important methods.
  for (const m of ['saveState', 'loadState', 'getSave', 'addCoreCallbacks',
                   'FSInit', 'loadGame', 'buttonPress', 'filePaths']) {
    step(`has Module.${m}`, typeof mod[m] === 'function');
  }
} else {
  console.log('\nModule never initialized; cannot enumerate keys.');
}

import('node:fs').then(fs => {
  fs.writeFileSync(
    new URL('./boot-result.json', import.meta.url),
    JSON.stringify(result, null, 2)
  );
});
