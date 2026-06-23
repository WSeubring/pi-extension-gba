// Phase 1 smoke: load a ROM, drive 60 frames via emulator.step(), dump boot.png,
// probe save-state VFS path. Post-ADR 0003 the render tick is the frame pump;
// standalone scripts must call emulator.step(n) directly — no passive wait.
// Run: node --import ../../node_modules/tsx/dist/esm/index.mjs smoke.mjs [path-to-rom.gba]
// Exits 0 on PASS or when no ROM is available (SKIP); exits 1 on failure.

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode as encodePng } from "fast-png";
import { createEmulator, GBA_WIDTH, GBA_HEIGHT } from "../../src/emulator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveRomPath() {
  const argv = process.argv[2];
  if (argv) return resolve(argv);
  const romsDir = resolve(__dirname, "..", "..", "roms");
  let entries;
  try {
    entries = readdirSync(romsDir).filter((n) => n.toLowerCase().endsWith(".gba"));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  return join(romsDir, entries[0]);
}

async function main() {
  const romPath = resolveRomPath();
  if (!romPath) {
    console.log("[smoke] SKIP: no .gba ROM found (pass path as argv[2] or drop a ROM in roms/)");
    process.exit(0);
  }

  console.log(`[smoke] loading ROM: ${romPath}`);

  const emulator = await createEmulator();
  await emulator.load(romPath);

  // Post-ADR 0003: drive emulation explicitly; there is no background loop.
  emulator.step(60);
  console.log(`[smoke] frameCounter=${emulator.frameCounter}`);

  const framebuffer = emulator.getFramebuffer();
  console.log(
    `[smoke] framebuffer length=${framebuffer.length} (expected ${GBA_WIDTH * GBA_HEIGHT * 4})`,
  );

  const png = encodePng({
    width: GBA_WIDTH,
    height: GBA_HEIGHT,
    data: framebuffer,
    channels: 4,
    depth: 8,
  });
  const outPath = join(__dirname, "boot.png");
  writeFileSync(outPath, png);
  console.log(`[smoke] wrote ${outPath}`);

  // E2: empirically resolve save-state VFS path.
  console.log("[smoke] probing save-state VFS path via saveState()...");
  const stateBytes = emulator.saveState();
  console.log(`[smoke] saveState() returned ${stateBytes.length} bytes`);
  const saveStatePath = emulator.module.filePaths().saveStatePath;
  const entries = emulator.module.FS.readdir(saveStatePath);
  console.log(
    `[smoke] FS.readdir(${saveStatePath}) = ${JSON.stringify(entries)}`,
  );
  console.log(`[smoke] Module.gameName=${emulator.module.gameName}`);

  emulator.destroy();
  console.log("[smoke] PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exit(1);
});
