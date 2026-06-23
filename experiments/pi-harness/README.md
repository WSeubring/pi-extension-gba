# Phase 10b — PTY Harness

End-to-end smoke test: spawns the real `pi` binary in a PTY, drives the
`/gba` slash-command, waits for the GBA emulator to render frames, then
exercises the `alt+g` exit path and cleanly shuts pi down. Every byte
emitted by pi is logged to `/tmp/pi-harness.log` and parsed by `parse.mjs`.

## Prerequisites

| Requirement | How to satisfy |
|---|---|
| `expect` on `$PATH` | `pacman -S expect` (Arch) / `apt install expect` (Debian/Ubuntu) |
| `pi` on `$PATH` | `npm install -g @mariozechner/pi-coding-agent` |
| GBA ROM | Place `.gba` file in `~/.config/pi/roms/gba/` |
| pi knows the extension | Extension path in `~/.pi/agent/settings.json` → `packages` array |

## Running

```sh
npm run harness
```

This runs `drive.exp` (the Expect script) then `parse.mjs` (the parser).
Both must succeed for the overall command to exit 0.

## What the harness checks

`parse.mjs` asserts:

1. **Kitty transmits >= 30** — the GBA renderer must emit at least 30 Kitty
   image protocol sequences during the 2-second render window. Fewer means the
   extension's `acceptFrame` loop is not firing.
2. **APC sequence monotonically increasing** — `\x1b_pi:gba:<n>\x07` markers
   must have strictly increasing frame counters. A reset or repeat indicates a
   state-machine bug.
3. **deleteKittyImage >= 1 on exit** — when `alt+g` unloads the game, the
   extension must delete its Kitty image slot so the terminal doesn't leak
   image data.
4. **No error markers** — the log must not contain `"Error:"`,
   `"Failed to load extension"`, or `"mod._malloc"`.

## Interpreting output

```
--- pi-harness parse report ---
Kitty transmits : 42  (distinct image IDs: 1)
Cursor-move-up  : 18
deleteKittyImage: 1
APC markers     : 38  first=1 last=38

  [PASS] Kitty transmits >= 30 — got 42
  [PASS] APC sequence monotonically increasing — 38 markers, first=1 last=38
  [PASS] deleteKittyImage on exit >= 1 — got 1
  [PASS] No error markers in log — clean

RESULT: PASS
```

A `FAIL` line is printed for each failed assertion with a brief explanation.

## If `expect` is not installed

`drive.exp` will not run, so `/tmp/pi-harness.log` will be absent. `parse.mjs`
detects this and exits 1 with an actionable message:

```
FAIL: log file not found at /tmp/pi-harness.log.
  Hint: install expect (`pacman -S expect` / `apt install expect`) then run `npm run harness`.
```

## Raw log

`/tmp/pi-harness.log` is overwritten on each run (`-noappend`). You can
inspect it directly — it contains the raw PTY output including ANSI escape
sequences and Kitty/APC payloads.
