# experiments

Standalone spike scripts used to de-risk the extension before building it for
real. Each folder probes one uncertainty — can the WASM core boot, does frame
rendering work, what's the real audio sample rate — in isolation, so failures
are cheap and obvious.

These are **not** part of the shipped extension. Nothing here is imported by
`src/`. They're kept in the repo as a record of how each subsystem was proven
out, and as smoke tests you can re-run if a dependency changes.

## Running

Most scripts are plain Node ESM (`.mjs`) and assume a `.gba` ROM is reachable —
either via the `ROM` env var or dropped under `roms/`. **No ROMs are bundled.**
Every script skips gracefully (exit 0) when no ROM is present, so a clean
checkout won't error.

```sh
# example: measure the core's audio sample rate
ROM=/path/to/your.gba node experiments/audio-rate/measure.mjs
```

## Layout

| Folder                 | Probes                                                          |
|------------------------|----------------------------------------------------------------|
| `emulator-boot/`       | The `createEmulator` wrapper constructs and tears down.         |
| `frame-render/`        | Step 60 frames, read framebuffer, dump `boot.png`.             |
| `renderer-smoke/`      | `createRenderer` against a mock animated-gradient emulator.     |
| `audio-rate/`          | Real audio sample rate emitted by the core.                    |
| `audio-derisk/`        | `getAudioSamples` KEEPALIVE produces a non-trivial PCM signal.  |
| `savestate-recovery/`  | Snapshot → corrupt `.state` → reload → verify recovery.         |
| `crash-reload-smoke/`  | Core tolerates `loadGame` after a crash (no leak/hang).         |
| `e2e-smoke/`           | End-to-end boot + frame pump + save-state path, plus findings.  |
| `core-node-probe/`     | Raw `@thenick775/mgba-wasm` API surface in vanilla Node.        |
| `png-encode-bench/`    | `fast-png` vs `upng-js` per-frame encode budget.                |
| `pi-harness/`          | Drives the extension inside a real pi session (expect script).  |
| `probe-kitty.sh`       | Kitty graphics protocol capability probe.                       |
