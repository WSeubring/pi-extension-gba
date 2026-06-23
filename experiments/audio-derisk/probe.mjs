// Phase 8 de-risk probe (ADR 0006 §De-risk).
//
// Loads Pokémon Emerald, steps ~60 frames, calls the new
// `getAudioSamples(destPtr, maxFrames)` KEEPALIVE, and asserts we see a
// non-trivial PCM signal. Exits 0 = GREEN, 1 = RED.
//
// Heap-allocation shortcut: the SDL-free WASM host exports
// `_getPixelBuffer()` which returns a pointer to a static
// 240*160*4 = 153 600-byte `videoBuffer`. 2048 stereo int16 frames
// = 8 192 bytes, which fits with room to spare. We reuse this buffer
// as scratch for the audio read; after we copy out to a JS-side
// Int16Array the next `runFrame` will overwrite the video scratch,
// which is fine because we do not read pixels in this probe.
//
// Run: node --import ../../node_modules/tsx/dist/esm/index.mjs probe.mjs

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmulator } from "../../src/emulator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveRomPath() {
  const argv = process.argv[2];
  if (argv) return resolve(argv);
  const romsDir = resolve(__dirname, "..", "..", "roms");
  const entries = readdirSync(romsDir).filter((n) =>
    /emerald.*\.gba$/i.test(n),
  );
  if (entries.length > 0) return join(romsDir, entries[0]);
  const anyGba = readdirSync(romsDir).filter((n) =>
    n.toLowerCase().endsWith(".gba"),
  );
  if (anyGba.length > 0) return join(romsDir, anyGba[0]);
  return null;
}

async function main() {
  const romPath = resolveRomPath();
  if (!romPath) {
    console.error("[probe] RED: no .gba ROM available");
    process.exit(1);
  }
  console.log(`[probe] ROM: ${romPath}`);

  const emulator = await createEmulator();
  await emulator.load(romPath);

  const module = emulator.module;

  // Sanity: KEEPALIVE export must be wired.
  const getAudioSamples = module._getAudioSamples;
  const getPixelBuffer = module._getPixelBuffer;
  if (typeof getAudioSamples !== "function") {
    console.error(
      "[probe] RED: module._getAudioSamples is not a function — patch 0005 not in built wasm",
    );
    process.exit(1);
  }
  if (typeof getPixelBuffer !== "function") {
    console.error("[probe] RED: module._getPixelBuffer not wired");
    process.exit(1);
  }

  // Drive the emulator. Patch 0005 calls core->setAudioBufferSize(core, 2048)
  // during loadGame; the ring buffer fills from inside runFrame. Step well
  // past 60 frames so the ring definitely has 2048+ frames queued
  // (32 768 Hz / 60 fps ≈ 546 frames/vid-frame, so ~4 video frames is
  // enough; we step 60 to match the ADR smoke spec and give slack).
  // Pokémon Emerald shows a silent BIOS/GBA logo intro for ~90 video
  // frames before the GAME FREAK jingle. The 32 768 Hz ring holds only
  // ~0.5 s so we must drain while stepping to avoid the producer
  // stalling on a full ring (mCoreSyncProduceAudio has NULL-sync so it
  // just drops on full). Step in chunks, reading between each.
  const MAX_FRAMES = 2048;
  let destPtrEarly = module._getPixelBuffer() >>> 0;
  let cumulativeNonZero = 0;
  let cumulativeSumSq = 0;
  let cumulativeSamples = 0;
  let cumulativePeak = 0;
  let firstNonzeroChunk = -1;
  const HEAP16pre = module.HEAP16;
  for (let i = 0; i < 40; i++) {
    emulator.step(15); // 15 video frames ≈ 250 ms = 8192 audio frames
    const got = module._getAudioSamples(destPtrEarly, MAX_FRAMES) >>> 0;
    if (i < 5 || i % 5 === 0) {
      console.log(`[probe] chunk ${i} videoFrames=${emulator.frameCounter} got=${got}`);
    }
    if (got === 0) continue;
    const start = destPtrEarly >> 1;
    let chunkNonzero = 0;
    let chunkPeak = 0;
    for (let j = 0; j < got * 2; j++) {
      const s = HEAP16pre[start + j];
      if (s !== 0) chunkNonzero++;
      const a = Math.abs(s);
      if (a > chunkPeak) chunkPeak = a;
      cumulativeSumSq += s * s;
    }
    cumulativeNonZero += chunkNonzero;
    cumulativeSamples += got * 2;
    if (chunkPeak > cumulativePeak) cumulativePeak = chunkPeak;
    if (chunkNonzero > 0 && firstNonzeroChunk < 0) firstNonzeroChunk = i;
  }
  console.log(
    `[probe] stepped ${emulator.frameCounter} video frames, drained ${cumulativeSamples} samples across chunks, first_nonzero_chunk=${firstNonzeroChunk}`,
  );

  // Also grab one final chunk to report first 8 samples.
  const destPtr = destPtrEarly;
  const HEAP16 = module.HEAP16;
  emulator.step(15);
  const framesWritten = module._getAudioSamples(destPtr, MAX_FRAMES) >>> 0;
  console.log(`[probe] final chunk: ${framesWritten} frames`);
  const i16Start = destPtr >> 1;
  const totalSamples = framesWritten * 2;
  const pcm = new Int16Array(totalSamples);
  if (framesWritten > 0) {
    pcm.set(HEAP16.subarray(i16Start, i16Start + totalSamples));
  }

  // Aggregate metrics across all chunks drained above.
  const nonZero = cumulativeNonZero;
  const rms =
    cumulativeSamples > 0
      ? Math.sqrt(cumulativeSumSq / cumulativeSamples)
      : 0;
  const peak = cumulativePeak;
  const first8 = Array.from(pcm.subarray(0, 8));

  console.log(
    `[probe] aggregate frames=${cumulativeSamples / 2} samples=${cumulativeSamples}`,
  );
  console.log(`[probe] non_zero_samples=${nonZero}/${cumulativeSamples}`);
  console.log(`[probe] peak=${peak} rms=${rms.toFixed(2)}`);
  console.log(`[probe] first_8_samples_final_chunk=${JSON.stringify(first8)}`);

  emulator.destroy();

  // GREEN gate per ADR 0006 §De-risk: ≥1 non-zero sample AND RMS > 500.
  if (nonZero === 0) {
    console.error("[probe] RED: all samples zero");
    process.exit(1);
  }
  if (rms < 500) {
    console.error(`[probe] RED: RMS ${rms.toFixed(2)} < 500 gate`);
    process.exit(1);
  }

  console.log("[probe] GREEN");
  process.exit(0);
}

main().catch((err) => {
  console.error("[probe] RED: uncaught", err);
  process.exit(1);
});
