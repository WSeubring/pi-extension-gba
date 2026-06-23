/**
 * H3 smoke test — verifies that mgba-wasm tolerates loadGame after a crash.
 *
 * Usage: node experiments/phase-7/smoke.mjs
 *
 * Exit codes:
 *   0 — H3 PASS or skipped (no ROM available)
 *   1 — H3 FAIL — escalate for hardReset
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const romsDir = path.join(repoRoot, "roms");

async function findRom() {
  let entries;
  try {
    entries = await readdir(romsDir);
  } catch {
    return null;
  }
  const rom = entries.find((e) => e.endsWith(".gba"));
  return rom ? path.join(romsDir, rom) : null;
}

async function main() {
  const romPath = await findRom();
  if (!romPath) {
    console.log("skipped: no .gba in roms/");
    process.exit(0);
  }

  console.log(`H3 smoke: using ROM ${path.basename(romPath)}`);

  // Dynamic import so this script can coexist without requiring a build step.
  const { createEmulator } = await import("../../dist/emulator.js").catch(() => {
    console.error("H3 smoke: dist/emulator.js not found — run npm run build first");
    process.exit(0);
  });

  let emulator;
  try {
    emulator = await createEmulator({ romDir: romsDir });
  } catch (err) {
    console.error("H3 FAIL — createEmulator threw:", err);
    process.exit(1);
  }

  let crashed = false;
  emulator.onCrash((err) => {
    console.log("crash received:", err.message);
    crashed = true;
  });

  try {
    await emulator.load(romPath);
    console.log("ROM loaded — triggering synthetic crash via __testTriggerCrash");
  } catch (err) {
    console.error("H3 FAIL — initial load threw:", err);
    process.exit(1);
  }

  emulator.__testTriggerCrash(new Error("synthetic H3 crash"));

  if (!crashed) {
    console.error("H3 FAIL — crash listener was never invoked");
    process.exit(1);
  }

  console.log("isCrashed listener fired — now attempting loadGame after crash (H3 assumption)");

  const loadTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("loadGame timed out after 10 s")), 10_000),
  );

  try {
    await Promise.race([emulator.load(romPath), loadTimeout]);
    console.log("H3 PASS — loadGame after crash succeeded without hanging");
    process.exit(0);
  } catch (err) {
    console.error("H3 FAIL — escalate for hardReset:", err);
    process.exit(1);
  }
}

main();
