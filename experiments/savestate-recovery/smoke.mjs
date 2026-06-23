// Phase 5 smoke: load ROM, snapshot, corrupt .state, reload, verify recovery.
// Invoke with:
//   node --import ../../node_modules/tsx/dist/esm/index.mjs smoke.mjs
// If ../../roms/ contains no .gba, skip gracefully with exit 0.

import { readdirSync, statSync, truncateSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createEmulator } from "../../src/emulator.ts";
import { createPersistence } from "../../src/persistence.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRom() {
  const romsDir = resolve(__dirname, "..", "..", "roms");
  let entries;
  try {
    entries = readdirSync(romsDir);
  } catch {
    return undefined;
  }
  const gba = entries.find((n) => n.toLowerCase().endsWith(".gba"));
  if (!gba) return undefined;
  return { romsDir, basename: gba, romPath: join(romsDir, gba) };
}

async function waitFrames(emulator, target, timeoutMs = 5000) {
  const start = Date.now();
  while (emulator.frameCounter < target) {
    if (Date.now() - start > timeoutMs) {
      console.warn(
        `[smoke] frameCounter only reached ${emulator.frameCounter}/${target} after ${timeoutMs}ms`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function main() {
  const rom = findRom();
  if (!rom) {
    console.log("skipped: no .gba in roms/");
    process.exit(0);
  }
  const { romsDir, basename, romPath } = rom;
  console.log(`[smoke] using ROM: ${romPath}`);

  const emulator = await createEmulator();
  const persistence = createPersistence(emulator, { romDir: romsDir });

  console.log("[smoke] first loadRom");
  const first = await persistence.loadRom(basename);
  console.log(`[smoke] restoredState (first) = ${first.restoredState}`);

  await waitFrames(emulator, 60);
  console.log(`[smoke] frameCounter=${emulator.frameCounter}`);

  console.log("[smoke] snapshot()");
  await persistence.snapshot();

  const statePath = join(romsDir, basename.replace(/\.gba$/, ".state"));
  const sizeBefore = statSync(statePath).size;
  console.log(`[smoke] .state size after snapshot: ${sizeBefore}`);
  if (sizeBefore === 0) {
    throw new Error("snapshot produced empty .state");
  }

  console.log("[smoke] corrupt .state (truncate to 4 bytes)");
  truncateSync(statePath, 4);

  console.log("[smoke] second loadRom");
  const second = await persistence.loadRom(basename);
  console.log(`[smoke] restoredState (after corrupt) = ${second.restoredState}`);
  if (second.restoredState !== false) {
    throw new Error(
      `expected restoredState=false after truncated .state, got ${second.restoredState}`,
    );
  }

  let stillCorrupt = false;
  try {
    readFileSync(statePath);
    stillCorrupt = true;
  } catch {
    stillCorrupt = false;
  }
  if (stillCorrupt) {
    console.log("[smoke] NOTE: corrupt .state still on disk (loadState may not have thrown on truncated input)");
  } else {
    console.log("[smoke] corrupt .state deleted as expected");
  }

  await waitFrames(emulator, emulator.frameCounter + 30);
  console.log("[smoke] snapshot() regenerates valid .state");
  await persistence.snapshot();
  const sizeAfter = statSync(statePath).size;
  console.log(`[smoke] .state size after regeneration: ${sizeAfter}`);
  if (sizeAfter === 0) {
    throw new Error("regenerated .state is empty");
  }

  await persistence.flushPending();
  persistence.destroy();
  emulator.destroy();
  console.log("[smoke] OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exit(1);
});
