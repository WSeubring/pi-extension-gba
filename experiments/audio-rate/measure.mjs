// Measure actual audio production rate of the vendored mGBA build.
// Steps N video frames, drains the ring fully after each, reports
// frames-of-audio per video frame and the implied sample rate.
import { createEmulator } from "../../dist/emulator.js";

const ROM = process.env.ROM ?? `${process.env.HOME}/.config/pi/roms/gba/game.gba`;

const emu = await createEmulator();
await emu.load(ROM);

// Warm up past BIOS into title screen.
emu.step(120);
// Drain whatever accumulated during warmup.
let drained = 0;
for (;;) {
  const got = emu.getAudioSamples(2048);
  if (got.length === 0) break;
  drained += got.length / 2;
}
console.log(`warmup backlog drained: ${drained} frames`);

const VIDEO_FRAMES = 600; // 10 s of emulated time
let totalAudioFrames = 0;
let perStepMax = 0;
for (let i = 0; i < VIDEO_FRAMES; i++) {
  emu.step(1);
  let thisStep = 0;
  for (;;) {
    const got = emu.getAudioSamples(2048);
    if (got.length === 0) break;
    thisStep += got.length / 2;
  }
  totalAudioFrames += thisStep;
  if (thisStep > perStepMax) perStepMax = thisStep;
}

const perVideoFrame = totalAudioFrames / VIDEO_FRAMES;
// GBA video: 59.7275 fps
const impliedRate = perVideoFrame * 59.7275;
console.log(`audio frames per video frame: ${perVideoFrame.toFixed(1)} (max ${perStepMax})`);
console.log(`implied output sample rate: ${impliedRate.toFixed(0)} Hz`);

// Also simulate the production tick: step(2) then ONE capped read of 2048.
let lost = 0, read = 0;
for (let i = 0; i < 300; i++) {
  emu.step(2);
  const got = emu.getAudioSamples(2048);
  read += got.length / 2;
}
// Whatever is left in the ring after the loop is backlog the production
// path never drains (steady-state loss if production > 2048/tick).
let leftover = 0;
for (;;) {
  const got = emu.getAudioSamples(2048);
  if (got.length === 0) break;
  leftover += got.length / 2;
}
console.log(`tick-sim: read ${read} frames over 300 ticks (${(read / 300).toFixed(1)}/tick), ring leftover ${leftover}`);
emu.destroy();
process.exit(0);
