# E2 — Save-state VFS path (empirical)

**Status: not resolved — smoke script not yet run (no `.gba` ROM on disk).**

The Phase 1 smoke script (`smoke.mjs`) is wired to probe the save-state
landing path via `Module.FS.readdir(Module.filePaths().saveStatePath)`
immediately after the first `saveState(0)` call succeeds, and logs both
the directory listing and `Module.gameName`. However, no ROM is
currently present in `roms/` and the task forbids fabricating one, so
the probe has not yet produced empirical output.

The implementation in `src/emulator.ts` bakes in the design-§5 best
guess — `#stateVfsPath()` returns `${filePaths().saveStatePath}/${basename(romPath)}.ss${slot}` where `basename(romPath)` is the host-side
basename of the loaded ROM (not `Module.gameName`, which per the design
doc may be the full VFS path and therefore not safe to use directly).

**Next step:** drop any `.gba` into `roms/` (or pass a path as `argv[2]`)
and re-run `node --import tsx experiments/phase-1/smoke.mjs`. Record the
`FS.readdir(...)` output and `Module.gameName` value here, and — if the
actual landing path differs from `<saveStatePath>/<basename>.ss0` —
update `#stateVfsPath()` in `src/emulator.ts` accordingly before the
Tech Lead signs off Phase 1.

Proposed `#stateVfsPath()` helper should: resolve the save-state VFS
path purely from state known to the `Emulator` instance (host basename
stashed in `load()`), falling back to inspecting `Module.gameName` only
if the empirical readdir shows otherwise.
