import { test } from "node:test";
import assert from "node:assert/strict";

import { detectCapabilities, probeAudioBackend, __setCapabilitiesForTest } from "../src/capabilities.js";
import type { ProbeSpawn } from "../src/capabilities.js";

test("detectCapabilities: kittyGraphics true when images=kitty", () => {
  __setCapabilitiesForTest({ images: "kitty" });
  assert.equal(detectCapabilities().kittyGraphics, true);
});

test("detectCapabilities: kittyGraphics false when images=iterm2", () => {
  __setCapabilitiesForTest({ images: "iterm2" });
  assert.equal(detectCapabilities().kittyGraphics, false);
});

test("detectCapabilities: kittyGraphics false when images=null", () => {
  __setCapabilitiesForTest({ images: null });
  assert.equal(detectCapabilities().kittyGraphics, false);
});

// ---- audio backend probe ------------------------------------------------------

/** Fake spawn that behaves like the real tools: ffplay rejects --version. */
function makeFakeSpawn(installed: string[]): { spawn: ProbeSpawn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn: ProbeSpawn = (cmd, args) => {
    calls.push({ cmd, args });
    if (!installed.includes(cmd)) throw new Error("ENOENT");
    // ffplay (ffmpeg-style) only accepts -version; --version exits 1.
    if (cmd === "ffplay") return { status: args[0] === "-version" ? 0 : 1 };
    return { status: args[0] === "--version" ? 0 : 1 };
  };
  return { spawn, calls };
}

test("probeAudioBackend: detects ffplay via -version when only ffplay is installed", () => {
  const { spawn, calls } = makeFakeSpawn(["ffplay"]);
  assert.equal(probeAudioBackend(spawn), "ffplay");
  const ffplayCall = calls.find((c) => c.cmd === "ffplay");
  assert.deepEqual(ffplayCall?.args, ["-version"], "ffplay must be probed with -version");
});

test("probeAudioBackend: probes pw-cat/pacat/aplay with --version", () => {
  for (const tool of ["pw-cat", "pacat", "aplay"]) {
    const { spawn, calls } = makeFakeSpawn([tool]);
    assert.equal(probeAudioBackend(spawn), tool);
    const call = calls.find((c) => c.cmd === tool);
    assert.deepEqual(call?.args, ["--version"], `${tool} must be probed with --version`);
  }
});

test("probeAudioBackend: prefers pw-cat over ffplay when both installed", () => {
  const { spawn } = makeFakeSpawn(["pw-cat", "ffplay"]);
  assert.equal(probeAudioBackend(spawn), "pw-cat");
});

test("probeAudioBackend: undefined when no tool is installed", () => {
  const { spawn } = makeFakeSpawn([]);
  assert.equal(probeAudioBackend(spawn), undefined);
});
