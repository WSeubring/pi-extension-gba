#!/usr/bin/env node
// Phase 10b — PTY harness parser
// Reads /tmp/pi-harness.log and asserts the GBA extension behaved correctly.
// Exit 0 = PASS, Exit 1 = FAIL.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const LOG_PATH = "/tmp/pi-harness.log";
// Post-port (pi-nes pattern) minimum: one Kitty transmit per render cycle.
// The old inline t=d path produced ~100 chunks per render (1 a=T + ~99 a=c),
// so the historical threshold of 30 was satisfied by just 1-2 renders. With
// pi-nes-style t=f (file transport, 1 a=T per render), 10 transmits means 10
// real render cycles landed frames, which is a stronger signal of visibility.
const KITTY_MIN_FRAMES = 10;
// Require APC marker monotonicity with a minimum count so the "render called
// once" regression that motivated this port cannot reappear undetected.
const APC_MIN_MARKERS = 5;

// ---------------------------------------------------------------------------
// Prerequisite guards
// ---------------------------------------------------------------------------

// Check that `expect` is available. If the log is missing, that is the most
// likely cause, and we should tell the user how to fix it.
let expectInstalled = true;
try {
  execSync("which expect", { stdio: "ignore" });
} catch {
  expectInstalled = false;
}

if (!existsSync(LOG_PATH)) {
  const hint = expectInstalled
    ? "Run `npm run harness` to generate the log first."
    : "install expect (`pacman -S expect` / `apt install expect`) then run `npm run harness`.";
  process.stderr.write(
    `FAIL: log file not found at ${LOG_PATH}.\n  Hint: ${hint}\n`
  );
  process.exit(1);
}

// Also sanity-check that pi is on $PATH (informational only — if we got here
// the log exists so pi probably ran, but the check costs nothing).
let piOnPath = true;
try {
  execSync("which pi", { stdio: "ignore" });
} catch {
  piOnPath = false;
}

// ---------------------------------------------------------------------------
// Read log
// ---------------------------------------------------------------------------

const raw = readFileSync(LOG_PATH); // Buffer — keep binary-safe

// ---------------------------------------------------------------------------
// Kitty transmit sequences: ESC _ G … ESC \
// Pattern: \x1b_G followed by params/payload up to the ST (ESC \)
// ---------------------------------------------------------------------------
const kittyTransmitRe = /\x1b_G([^\x1b]*)\x1b\\/g;
let kittyCount = 0;
const kittyIds = new Set();
const kittyPayloadSizes = [];

for (const m of raw.toString("binary").matchAll(kittyTransmitRe)) {
  kittyCount++;
  const params = m[1];
  const idMatch = params.match(/(?:^|[,;])i=(\d+)/);
  if (idMatch) kittyIds.add(idMatch[1]);
  // Payload is the last comma-separated chunk (after the last semicolon).
  const payloadMatch = params.match(/;([A-Za-z0-9+/=]*)$/);
  kittyPayloadSizes.push(payloadMatch ? payloadMatch[1].length : 0);
}

// ---------------------------------------------------------------------------
// APC markers: ESC _ pi:gba:<n> BEL
// ---------------------------------------------------------------------------
const apcRe = /\x1b_pi:gba:(\d+)\x07/g;
const apcValues = [];
for (const m of raw.toString("binary").matchAll(apcRe)) {
  apcValues.push(parseInt(m[1], 10));
}

let apcMonotonic = true;
for (let i = 1; i < apcValues.length; i++) {
  if (apcValues[i] <= apcValues[i - 1]) {
    apcMonotonic = false;
    break;
  }
}

// ---------------------------------------------------------------------------
// Cursor-move-up sequences: ESC [ <n> A
// ---------------------------------------------------------------------------
const cursorUpRe = /\x1b\[(\d+)A/g;
let cursorUpCount = 0;
for (const _m of raw.toString("binary").matchAll(cursorUpRe)) {
  cursorUpCount++;
}

// ---------------------------------------------------------------------------
// deleteKittyImage emissions: ESC _ G a=d … ESC \
// ---------------------------------------------------------------------------
const deleteKittyRe = /\x1b_Ga=d[^\x1b]*\x1b\\/g;
const deleteKittyMatches = [...raw.toString("binary").matchAll(deleteKittyRe)];
const deleteKittyCount = deleteKittyMatches.length;

// ---------------------------------------------------------------------------
// Error grep
// ---------------------------------------------------------------------------
const rawText = raw.toString("utf8");
const errorPatterns = [
  "Error:",
  "Failed to load extension",
  "mod._malloc",
];
const errorHits = errorPatterns.filter((p) => rawText.includes(p));

// ---------------------------------------------------------------------------
// PASS checklist
// ---------------------------------------------------------------------------
const checks = [
  {
    name: `Kitty transmits >= ${KITTY_MIN_FRAMES}`,
    pass: kittyCount >= KITTY_MIN_FRAMES,
    detail: `got ${kittyCount}`,
  },
  {
    name: `APC markers >= ${APC_MIN_MARKERS} and monotonic`,
    pass: apcValues.length >= APC_MIN_MARKERS && apcMonotonic,
    detail:
      apcValues.length === 0
        ? "no APC markers (extension may not emit them)"
        : `${apcValues.length} markers, first=${apcValues[0]}, last=${apcValues[apcValues.length - 1]}${apcMonotonic ? "" : " (NOT monotonic)"}`,
  },
  {
    name: "deleteKittyImage on exit >= 1",
    pass: deleteKittyCount >= 1,
    detail: `got ${deleteKittyCount}`,
  },
  {
    name: "No error markers in log",
    pass: errorHits.length === 0,
    detail:
      errorHits.length === 0 ? "clean" : `found: ${errorHits.join(", ")}`,
  },
];

if (!piOnPath) {
  checks.push({
    name: "pi on $PATH",
    pass: false,
    detail: "pi not found — install @mariozechner/pi-coding-agent globally",
  });
}

const allPass = checks.every((c) => c.pass);

// ---------------------------------------------------------------------------
// Report (≤ 1 KB)
// ---------------------------------------------------------------------------
const lines = [
  `--- pi-harness parse report ---`,
  `Kitty transmits : ${kittyCount}  (distinct image IDs: ${kittyIds.size})`,
  `Cursor-move-up  : ${cursorUpCount}`,
  `deleteKittyImage: ${deleteKittyCount}`,
  `APC markers     : ${apcValues.length}${apcValues.length > 0 ? `  first=${apcValues[0]} last=${apcValues[apcValues.length - 1]}` : ""}`,
  ``,
  ...checks.map((c) => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`),
  ``,
  allPass ? "RESULT: PASS" : "RESULT: FAIL",
];

process.stdout.write(lines.join("\n") + "\n");
process.exit(allPass ? 0 : 1);
