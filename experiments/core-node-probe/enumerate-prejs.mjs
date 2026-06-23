// Enumerate all Module.X assignments from the glue's pre.js section
// by pattern-matching the shipped mgba.js. This documents the JS-layer
// API surface (V2/V7 evidence) even though we cannot fully boot in Node.
import fs from 'node:fs';
const src = fs.readFileSync(
  new URL('./node_modules/@thenick775/mgba-wasm/dist/mgba.js', import.meta.url),
  'utf8'
);
const re = /Module\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
const hits = new Set();
for (const m of src.matchAll(re)) hits.add(m[1]);
const list = [...hits].sort();
console.log(`Module.* assignments found: ${list.length}`);
for (const n of list) console.log('  ', n);

// Also pull the EMSCRIPTEN_KEEPALIVE export list that pre.js cwraps.
const cwrapRe = /cwrap\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
const cwraps = new Set();
for (const m of src.matchAll(cwrapRe)) cwraps.add(m[1]);
console.log(`\nC functions cwrap()'d in pre.js: ${cwraps.size}`);
for (const n of [...cwraps].sort()) console.log('  ', n);
