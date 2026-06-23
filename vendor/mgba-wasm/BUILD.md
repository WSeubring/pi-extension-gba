# Building the vendored mgba-wasm

This document is the authoritative, reproducible build record for the
`vendor/mgba-wasm/dist/` artefacts consumed by `src/emulator.ts`.

---

## Pinned versions

| Input                  | Version / SHA                                                          | Source                                                                 |
|------------------------|------------------------------------------------------------------------|------------------------------------------------------------------------|
| Upstream repo          | `github.com/thenick775/mgba`                                           | https://github.com/thenick775/mgba                                     |
| Upstream branch        | `feature/wasm`                                                         | —                                                                      |
| Upstream commit SHA    | **`be30a34e913da1ba7f040d3db4e10f700ce49f76`**                         | verified 2026-04-18 via `gh api repos/thenick775/mgba/branches/feature/wasm` (tip at time of pinning; commit message `chore: bump version`, 2026-01-22) |
| Emscripten SDK         | **`4.0.4`**                                                            | matches `src/platform/wasm/docker/Dockerfile` at the pinned upstream SHA |
| Docker base image      | `emscripten/emsdk:4.0.4`                                               | —                                                                      |
| Vendor patch 1         | `patches/0001-add-node-environment.patch`                              | this repo                                                              |
| Vendor patch 2         | `patches/0002-export-getPixelBuffer.patch`                             | this repo                                                              |
| Vendor patch 3         | `patches/0003-loosen-canvas-type.patch`                                | this repo                                                              |
| Vendor patch 4         | `patches/0004-strip-sdl.patch`                                         | this repo                                                              |
| Vendor patch 5         | `patches/0005-mcore-audio.patch`                                       | this repo (ADR 0006)                                                   |

If any of these change, the `dist/` artefacts MUST be rebuilt.

The pinned upstream SHA has NOT changed for patch 0004 — it is additional
patching on top of the same base commit.

---

## What the patches do

**`0001-add-node-environment.patch`** — `src/platform/wasm/CMakeLists.txt`:

- Adds `node` to `-s ENVIRONMENT='web,worker,node'`. This makes
  Emscripten emit the Node load path for the `.wasm` asset (no
  `fetch()`, uses `fs.readFileSync`).
- Drops `-pthread` and `-s PTHREAD_POOL_SIZE=5`. Pthreads in Node
  require `worker_threads` stubs for the `new Worker(url, { type:
  'module' })` calls the Emscripten runtime emits; SPEC §2/§9 defer
  worker threads to v2 anyway, so a single-threaded Node build is
  strictly simpler. The emulator core runs on the main loop; rendering
  happens on the same thread. This is a Node-only build — a browser
  rebuild must restore `-pthread` + `PTHREAD_POOL_SIZE=5`.
- Sets `-s NODEJS_CATCH_EXIT=0` and `-s NODEJS_CATCH_REJECTION=0` so
  emulator crashes cannot kill the host pi process.
- Sets `-s ALLOW_MEMORY_GROWTH=1` (256 MiB initial, growable).
- Extends `EXPORTED_RUNTIME_METHODS` with `HEAPU8`, `HEAPU32`,
  `getValue`, `UTF8ToString` — needed by the TS wrapper to read the
  pixel pointer.

**`0002-export-getPixelBuffer.patch`** —
`src/platform/wasm/main.c` + `pre.js` + `mgba.d.ts`:

- Adds five `EMSCRIPTEN_KEEPALIVE` C accessors:
  `getPixelBuffer`, `getPixelBufferSize`, `getPixelBufferStride`,
  `getPixelBufferWidth`, `getPixelBufferHeight`. All read from
  `renderer->outputBuffer` and `renderer->core->currentVideoSize`.
- Adds `Module.getPixelBuffer()` (returns `Uint8Array` view into
  `HEAPU8`) and `Module.getPixelBufferDimensions()` in `pre.js`.
- Appends TS declarations for the two JS helpers to `mgba.d.ts`.

The core writes RGBA little-endian bytes (`SDL_PIXELFORMAT_ABGR8888`
→ byte 0 = R, byte 1 = G, byte 2 = B, byte 3 = A at 240×160×4 for GBA).
This format is a direct match for `fast-png` / `upng-js`.

**`0004-strip-sdl.patch`** —
`src/platform/wasm/main.c` + `src/platform/wasm/CMakeLists.txt`:

Rebuilds the Emscripten host without SDL2. ADR 0002
(internal ADR 0002) explains why:
even with `-pthread` dropped from top-level flags, SDL2's Emscripten
port re-adds pthread internally, emitting `memory.atomic.wait32`
instructions that block Node's main thread during `callMain`. Skipping
`callMain` avoids the hang but leaves SDL's renderer uninitialised, so
patch 0002's `getPixelBuffer()` reads from a null `outputBuffer`. The
only clean fix is to remove SDL from the build.

- Replaces `main.c` with an mcore-only host (~400 lines). Drives
  `mCoreFind` / `core->setVideoBuffer` / `core->runFrame` /
  `core->setKeys` / `mCoreSaveState` / `mCoreLoadState` directly. No
  `SDL_Init`, no renderer, no event pump, no WebGL.
- Allocates a single static 240*160*4-byte `videoBuffer`;
  `setVideoBuffer` is called once per `loadGame`.
- Adds an `EMSCRIPTEN_KEEPALIVE runFrame()` export — the synchronous
  frame-step the JS render loop calls each tick (see SPEC §3.3 post-ADR).
- Preserves the full V7 JS API surface
  (`loadGame`/`pauseGame`/`resumeGame`/`saveState`/`loadState`/
  `saveStateSlot`/`loadStateSlot`/`getSave`/`buttonPress`/
  `buttonUnpress`/`addCoreCallbacks`/`screenshot`/`filePaths`/...) so
  `pre.js` and downstream `src/emulator.ts` need no signature changes.
- Re-homes patch 0002's five `getPixelBuffer*` exports against the
  static buffer.
- Build flag changes (`CMakeLists.txt`):
  - `-s USE_SDL=2` -> `-s USE_SDL=0` (link + compile).
  - Adds `-s USE_PTHREADS=0` (explicit guard).
  - Removes `-s MIN_WEBGL_VERSION=2 -s MAX_WEBGL_VERSION=2`.
  - Drops `../sdl/sdl-audio.c`, `../sdl/sdl-events.c`,
    `../sdl/sdl-text.c` from the sources list.
  - Keeps `ALLOW_MEMORY_GROWTH=1`, `ENVIRONMENT=web,worker,node`,
    `EXPORT_ES6=1`, `MODULARIZE=1`, the extended
    `EXPORTED_RUNTIME_METHODS`, `NODEJS_CATCH_*` — all still needed.

Audio, rewind, fast-forward, event-toggling, and
`setIntegerCoreSetting` endpoints are no-op stubs in v1 (SPEC §1
non-goals). The DOM / WebGL shims in `src/wasm-shims.ts` stay in place
but become inert — they are never dereferenced at runtime post-0004 and
are retained as a compatibility guard for one release cycle per ADR 0002
§Consequences.

**`0003-loosen-canvas-type.patch`** — `src/platform/wasm/mgba.d.ts`:

Loosens the `mGBA` factory options so `canvas` is `canvas?:
HTMLCanvasElement | null` instead of a required `HTMLCanvasElement`.
Resolves the headless-boot escalation (internal phase-1 design doc): Node
consumers can now call `mGBA({})` or `mGBA({ canvas: null })` without
a `canvas: undefined as any` cast, while browser consumers retain the
ability to pass a real `<canvas>`. This is a TypeScript-surface-only
change; the Emscripten glue runtime was already made Node-safe by
patch 0001, so **`build.sh` does NOT need to be re-run** for this
patch alone. The already-built `dist/mgba.d.ts` is edited in place to
mirror the patch; when the wasm is next rebuilt the patch will
reapply this change on top of a fresh upstream checkout.

---

## Reproducible build (containerised, preferred)

From this directory (`vendor/mgba-wasm/`):

```sh
./build.sh
```

This will:

1. `docker build` the image described in `./Dockerfile` — clones the
   pinned upstream SHA, applies both patches, runs
   `emcmake cmake .. && make -j` inside `/src/build-wasm`.
2. `docker create` a throwaway container and `docker cp` the built
   artefacts into `./dist/`:
   - `dist/mgba.js`        (Emscripten glue, ES module)
   - `dist/mgba.wasm`      (compiled core)
   - `dist/mgba.d.ts`      (TypeScript declarations)
   - `dist/mgba.wasm.map`  (source map, best-effort)

Clean rebuild: `./build.sh --clean`.

---

## Manual build (for debugging only)

If you want to iterate on the patches without re-running Docker each
time:

```sh
git clone https://github.com/thenick775/mgba.git /tmp/mgba
cd /tmp/mgba
git checkout be30a34e913da1ba7f040d3db4e10f700ce49f76
patch -p1 < /path/to/vendor/mgba-wasm/patches/0001-add-node-environment.patch
patch -p1 < /path/to/vendor/mgba-wasm/patches/0002-export-getPixelBuffer.patch
patch -p1 < /path/to/vendor/mgba-wasm/patches/0003-loosen-canvas-type.patch
patch -p1 < /path/to/vendor/mgba-wasm/patches/0004-strip-sdl.patch
patch -p1 < /path/to/vendor/mgba-wasm/patches/0005-mcore-audio.patch

# Requires emsdk 4.0.4 activated in the current shell.
mkdir build-wasm && cd build-wasm
emcmake cmake .. -DBUILD_QT=OFF -DBUILD_SDL=OFF
make -j$(nproc)

# Output lands in ./wasm/{mgba.js,mgba.wasm,mgba.d.ts,mgba.wasm.map}
```

This is **not** the supported path — it's only useful when iterating on
the C export signatures. The shipped `dist/` MUST come from Docker.

---

## Verification checklist

After a successful build, verify the artefacts:

1. **File presence**: `ls dist/` shows `mgba.js`, `mgba.wasm`, `mgba.d.ts`.
2. **Node environment present**: `grep 'ENVIRONMENT_IS_NODE' dist/mgba.js`
   should show multiple branches actually being used (not just declared —
   in the shipped upstream build the constant is declared but unused on
   the hot path).
3. **No unconditional `fetch`**: `grep -n "fetch(" dist/mgba.js` should
   show each hit gated by `ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER`.
4. **Exports include pixel accessors**:
   `grep -o '_getPixelBuffer\|_getPixelBufferSize\|_getPixelBufferStride\|_getPixelBufferWidth\|_getPixelBufferHeight' dist/mgba.js | sort -u`
   should print all five symbols.
5. **Module.getPixelBuffer is wrapped**:
   `grep -n "Module.getPixelBuffer" dist/mgba.js` → two hits (one
   assignment, one call site).
6. **End-to-end smoke test** — the Phase 0.5 exit criterion in SPEC §7:
   a script in `experiments/phase-0.5/` loads a ROM, calls `FSInit`,
   `loadGame`, steps N frames, calls `Module.getPixelBuffer()`,
   round-trips through `fast-png`, and dumps a PNG that matches the
   ROM's boot screen. Not authored by this build phase; owner is the
   next agent after vendor build is green.

---

## Build verification status

**Green, 2026-04-18** (authoring session). Docker build completed
successfully on Linux x86_64. Output sizes:

- `dist/mgba.js` — 461,299 bytes
- `dist/mgba.wasm` — 1,880,949 bytes
- `dist/mgba.d.ts` — 16,115 bytes
- `dist/mgba.wasm.map` — 394,528 bytes

Post-build smoke checks (from the Verification checklist above):

1. File presence: OK.
2. `_getPixelBuffer{,Size,Stride,Width,Height}` all appear as wasm
   exports in `mgba.js`: OK.
3. `Module.getPixelBuffer` appears twice in `mgba.js` (assignment +
   call site): OK.
4. `ENVIRONMENT_IS_NODE` referenced 17 times in `mgba.js`: OK.
5. Only 2 `fetch(` references in `mgba.js` (vs. the shipped upstream's
   unconditional hot-path fetch): OK.

The end-to-end Phase 0.5 exit criterion (SPEC §7) — load a ROM, step
frames, read `getPixelBuffer()`, dump a PNG matching the ROM boot
screen — is NOT executed in this vendor-build phase. It belongs to
the next agent in `experiments/phase-0.5/`.

To re-verify from a clean slate, a human or CI should run:

```sh
cd vendor/mgba-wasm && ./build.sh --clean
```

Expected cost: ~90s warm (layers cached), ~3-5 min if emsdk image
needs re-pulling, ~15 min cold on a fresh machine.

---

## Known risks / surprises

1. **`mColor` vs `uint8_t*` cast in `main.c`**. `mEmscriptenRenderer.outputBuffer`
   is declared `mColor*`, which resolves to a 32-bit integer type in the
   core. The patch casts to `uint8_t*` for JS consumption; this is
   correct for `SDL_PIXELFORMAT_ABGR8888` on little-endian, but if
   upstream ever flips colour packing we'd see swizzled output. Low risk.
2. **Pthread removal ripples**. The SDL audio path uses threaded audio;
   disabling pthreads may disable audio. Acceptable — SPEC §1 non-goals
   #1 says "Audio. Muted."
3. **`BYTES_PER_PIXEL` macro**. Referenced in upstream `main.c` without
   visible `#define` in the file; it's pulled in from mGBA core headers
   (`mgba/core/core.h` chain). Value is 4. Patch relies on this.
4. **`currentVideoSize` may return zero before a ROM is loaded**. All
   accessors defend against this (`!renderer->core` early-return).
5. **Source-map file** is emitted by `-gsource-map` but the name / path
   may change with emsdk updates. `build.sh` treats it as optional.
6. **`EXPORT_ES6=1` means `mgba.js` is an ES module**. Node consumers
   must `import` it, not `require` it. SPEC §2 specifies TypeScript, so
   this is fine; a CommonJS-only consumer would need a separate build.

---

## License

Upstream mGBA is MPL-2.0. The vendor patches in `patches/` are MPL-2.0
by inheritance. The `Dockerfile` and `build.sh` in this directory are
MIT or MPL-2.0 at your option, consistent with pi-extension-gba.
