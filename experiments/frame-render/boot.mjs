// ADR 0002 framebuffer smoke. Loads a ROM, steps 60 frames, reads the
// framebuffer and dumps boot.png. Asserts:
//   - framebuffer length === 240 * 160 * 4 === 153600.
//   - framebuffer contains at least one non-zero byte (not all-black).
//   - encoded PNG size > 1 KiB.
// Skips with exit 0 if no .gba file is present under roms/.

import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode as encodePng } from "fast-png";
import { createEmulator } from "../../src/emulator.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const romsDir = path.join(repoRoot, "roms");
const outPath = path.join(__dirname, "boot.png");

const EXPECTED_LEN = 240 * 160 * 4;

function findRom() {
  let entries;
  try {
    entries = readdirSync(romsDir);
  } catch {
    return undefined;
  }
  return entries
    .filter((f) => f.toLowerCase().endsWith(".gba"))
    .map((f) => path.join(romsDir, f))[0];
}

function fail(msg) {
  console.error(`[path-2-frame] FAIL: ${msg}`);
  process.exit(1);
}

const romPath = findRom();
if (!romPath) {
  console.log("skipped: no .gba in roms/");
  process.exit(0);
}

console.log(`[path-2-frame] loading ${path.basename(romPath)}`);
const emulator = await createEmulator();
try {
  await emulator.load(romPath);
  // Pokémon Emerald's boot logo + licence screen takes ~3-4s of simulated
  // time before the title screen appears. 60 frames is enough to prove the
  // core is running (non-zero frame emitted), but many ROMs only show a
  // uniform-color warm-up frame at t=60; step further here so the asserted
  // PNG contains visible game content.
  emulator.step(4000);
  const fb = emulator.getFramebuffer();

  if (fb.length !== EXPECTED_LEN) {
    fail(`framebuffer length ${fb.length}, expected ${EXPECTED_LEN}`);
  }

  let nonZero = 0;
  for (let i = 0; i < fb.length; i++) {
    if (fb[i] !== 0) nonZero++;
  }
  if (nonZero === 0) {
    fail("framebuffer is all-black after 60 frames");
  }
  console.log(`[path-2-frame] non-zero bytes: ${nonZero} / ${fb.length}`);

  const png = encodePng({ width: 240, height: 160, data: fb, depth: 8, channels: 4 });
  writeFileSync(outPath, png);

  const { size } = statSync(outPath);
  if (size < 1024) {
    fail(`boot.png size ${size} < 1 KiB`);
  }

  console.log(`[path-2-frame] PASS: ran, PNG ${size} bytes, ${nonZero}+ non-zero fb bytes`);
  process.exit(0);
} finally {
  try {
    emulator.destroy();
  } catch {
    /* ignore */
  }
}
