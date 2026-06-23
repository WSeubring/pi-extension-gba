# vendor/mgba-wasm

Vendored mGBA WebAssembly build for pi-extension-gba. Implements SPEC
§7 Phase 0.5.

## Why vendor?

The upstream `@thenick775/mgba-wasm@2.4.1` npm package is built with
`-s ENVIRONMENT='web,worker'` only and exposes no JS-callable pixel-
access API (only `screenshot()` via the Emscripten VFS). Both are
blockers for a headless Node frame loop (verified empirically before
vendoring; internal verification notes).

## Layout

```
vendor/mgba-wasm/
├── README.md                                 (this file)
├── BUILD.md                                  authoritative build record
├── Dockerfile                                reproducible build container
├── build.sh                                  wrapper: runs Docker, copies artefacts
├── patches/
│   ├── 0001-add-node-environment.patch       CMake: add node to ENVIRONMENT,
│   │                                         drop pthreads, extend exports
│   └── 0002-export-getPixelBuffer.patch      C: expose outputBuffer pointer;
│                                             JS: wrap as Module.getPixelBuffer()
└── dist/                                     committed build artefacts
    ├── mgba.js              (consumed by src/emulator.ts)
    ├── mgba.wasm
    ├── mgba.d.ts
    └── mgba.wasm.map        (optional)
```

## Consuming the vendored build

`src/emulator.ts` imports from this directory, not from npm:

```ts
// Phase 1: wire this up in src/emulator.ts.
import mGBA from '../vendor/mgba-wasm/dist/mgba.js';
```

## Rebuilding

Requires Docker. Does not require Emscripten on the host.

```sh
cd vendor/mgba-wasm
./build.sh
```

See [`BUILD.md`](./BUILD.md) for pinned versions, patch rationale,
verification checks, and known risks.

## Status

**`dist/` is populated from a green Docker build** (authoring session,
2026-04-18). Artefacts:

| File              | Size      | Notes                                              |
|-------------------|-----------|----------------------------------------------------|
| `dist/mgba.js`    | 461 KiB   | Emscripten glue, ES module                         |
| `dist/mgba.wasm`  | 1.88 MiB  | Compiled core                                      |
| `dist/mgba.d.ts`  | 16 KiB    | TS declarations (with vendored `getPixelBuffer`)    |
| `dist/mgba.wasm.map` | 386 KiB | Source map (optional, can be gitignored if size is an issue) |

Post-build smoke checks passed (see BUILD.md §Verification checklist):

- `_getPixelBuffer`, `_getPixelBufferSize`, `_getPixelBufferStride`,
  `_getPixelBufferWidth`, `_getPixelBufferHeight` all appear as wasm
  exports in `mgba.js`.
- `Module.getPixelBuffer` and `Module.getPixelBufferDimensions` are
  wrapped in the JS glue.
- `ENVIRONMENT_IS_NODE` is referenced 17 times in `mgba.js` (vs. 0
  on hot paths in the upstream shipped build).
- Only 2 `fetch(` references remain in `mgba.js`, both gated by
  `ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER`.

The Phase 0.5 SPEC §7 exit criterion (boot from Node, load a ROM,
step frames, read pixel buffer, dump a PNG matching the ROM boot
screen) is NOT executed here — it's the next agent's task under
`experiments/phase-0.5/`.

To rebuild from scratch, run:

```sh
cd vendor/mgba-wasm && ./build.sh --clean
```
