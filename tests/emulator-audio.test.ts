/**
 * Phase 8a audio accessor tests.
 * Design ref: docs/design/phase-8a-vendor-audio.md §Test plan
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Emulator, EmulatorCrashError, EmulatorNotLoadedError } from "../src/emulator.js";
import type mGBA from "../vendor/mgba-wasm/dist/mgba.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fake scratchPtr — 8-byte aligned, well within any HEAP16 mock. */
const FAKE_SCRATCH_PTR = 1024;
const SCRATCH_FRAMES = 2048;

type MgbaModule = Awaited<ReturnType<typeof mGBA>>;

// ---------------------------------------------------------------------------
// Mock module factory
// ---------------------------------------------------------------------------

interface MockModuleOptions {
  /** Frames returned by _getAudioSamples (default 0). */
  framesWritten?: number;
  /** Fake HEAP16; default is zeroed 8 KiB. */
  heap16?: Int16Array;
  /** Omit _getAudioSamples to test the missing-export guard. */
  omitGetAudioSamples?: boolean;
  /** Capture malloc calls. */
  mallocCalls?: number[];
  /** Capture free calls. */
  freeCalls?: number[];
  /** Capture _getAudioSamples calls. */
  getAudioSamplesCalls?: Array<{ dest: number; max: number }>;
}

function buildMockModule(opts: MockModuleOptions = {}): MgbaModule {
  const mallocCalls = opts.mallocCalls ?? [];
  const freeCalls = opts.freeCalls ?? [];
  const getAudioSamplesCalls = opts.getAudioSamplesCalls ?? [];
  const heap16 = opts.heap16 ?? new Int16Array(8192);

  const mod: Record<string, unknown> = {
    _malloc(size: number) {
      mallocCalls.push(size);
      return FAKE_SCRATCH_PTR;
    },
    _free(ptr: number) {
      freeCalls.push(ptr);
    },
    HEAP16: heap16,
    pauseGame() {},
    addCoreCallbacks() {},
    filePaths() {
      return {
        root: "/data",
        cheatsPath: "/data/cheats",
        gamePath: "/data/games",
        savePath: "/data/saves",
        saveStatePath: "/data/states",
        screenshotsPath: "/data/screenshots",
        patchPath: "/data/patches",
        autosave: "/data/autosave",
      };
    },
    FS: {
      writeFile() {},
      readFile() {
        return new Uint8Array(0);
      },
    },
    loadGame() {
      return true;
    },
    getSave() {
      return null;
    },
  };

  if (!opts.omitGetAudioSamples) {
    mod._getAudioSamples = (dest: number, max: number) => {
      getAudioSamplesCalls.push({ dest, max });
      return opts.framesWritten ?? 0;
    };
  }

  return mod as unknown as MgbaModule;
}

/** Build a loaded Emulator using __testForceLoad (mirrors __testTriggerCrash pattern). */
function makeLoadedEmulator(opts: MockModuleOptions = {}): Emulator {
  const mod = buildMockModule(opts);
  const emulator = new Emulator(mod, FAKE_SCRATCH_PTR);
  emulator.__testForceLoad();
  return emulator;
}

// ---------------------------------------------------------------------------
// Test 5 — pre-load throws EmulatorNotLoadedError
// ---------------------------------------------------------------------------

test("getAudioSamples: pre-load throws EmulatorNotLoadedError", () => {
  const emulator = new Emulator(buildMockModule(), FAKE_SCRATCH_PTR);
  // Do NOT call __testForceLoad — #loaded stays false

  assert.throws(
    () => emulator.getAudioSamples(2048),
    (err: unknown) => {
      assert.ok(err instanceof EmulatorNotLoadedError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test 6 — post-destroy throws EmulatorNotLoadedError
// ---------------------------------------------------------------------------

test("getAudioSamples: post-destroy throws EmulatorNotLoadedError", () => {
  const emulator = makeLoadedEmulator({ framesWritten: 0 });
  emulator.destroy();

  assert.throws(
    () => emulator.getAudioSamples(2048),
    (err: unknown) => {
      assert.ok(err instanceof EmulatorNotLoadedError);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test 8 — zero maxFrames returns empty without calling _getAudioSamples
// ---------------------------------------------------------------------------

test("getAudioSamples: zero maxFrames returns empty Int16Array without calling _getAudioSamples", () => {
  const getAudioSamplesCalls: Array<{ dest: number; max: number }> = [];
  const emulator = makeLoadedEmulator({ getAudioSamplesCalls, framesWritten: 0 });

  const result = emulator.getAudioSamples(0);

  assert.ok(result instanceof Int16Array, "result is Int16Array");
  assert.equal(result.length, 0, "empty result for zero maxFrames");
  assert.equal(getAudioSamplesCalls.length, 0, "_getAudioSamples not called");
});

// ---------------------------------------------------------------------------
// Test 7 — clamp: large maxFrames passes SCRATCH_FRAMES to _getAudioSamples
// ---------------------------------------------------------------------------

test("getAudioSamples: clamp — maxFrames > 2048 passes 2048 to _getAudioSamples", () => {
  const getAudioSamplesCalls: Array<{ dest: number; max: number }> = [];
  const emulator = makeLoadedEmulator({ getAudioSamplesCalls, framesWritten: 0 });

  emulator.getAudioSamples(999_999);

  assert.equal(getAudioSamplesCalls.length, 1, "_getAudioSamples called once");
  assert.equal(getAudioSamplesCalls[0]?.max, SCRATCH_FRAMES, "max clamped to 2048");
});

// ---------------------------------------------------------------------------
// Test 2 — empty ring returns Int16Array(0)
// ---------------------------------------------------------------------------

test("getAudioSamples: empty ring returns Int16Array(0)", () => {
  const emulator = makeLoadedEmulator({ framesWritten: 0 });

  const result = emulator.getAudioSamples(2048);

  assert.ok(result instanceof Int16Array, "result is Int16Array");
  assert.equal(result.length, 0, "ring empty → length 0");
});

// ---------------------------------------------------------------------------
// Test 3/4 — non-zero ring returns correct interleaved slice from HEAP16
// ---------------------------------------------------------------------------

test("getAudioSamples: non-zero ring returns correct interleaved slice from HEAP16", () => {
  const heap16 = new Int16Array(8192);
  const offset = FAKE_SCRATCH_PTR / 2; // 512 — int16 element index of scratchPtr
  heap16[offset] = 100; // L0
  heap16[offset + 1] = 200; // R0
  heap16[offset + 2] = 300; // L1
  heap16[offset + 3] = 400; // R1

  const emulator = makeLoadedEmulator({ framesWritten: 2, heap16 });

  const result = emulator.getAudioSamples(2048);

  assert.ok(result instanceof Int16Array, "result is Int16Array");
  assert.equal(result.length, 4, "2 frames × 2 channels = 4 samples");
  // Interleave format: L, R, L, R, ...
  assert.equal(result[0], 100, "L0");
  assert.equal(result[1], 200, "R0");
  assert.equal(result[2], 300, "L1");
  assert.equal(result[3], 400, "R1");
  // Frame-aligned: length must be divisible by 2
  assert.equal(result.length % 2, 0, "length is frame-aligned (even)");
});

// ---------------------------------------------------------------------------
// Output is a copy — HEAP16 mutation after call does not affect result
// ---------------------------------------------------------------------------

test("getAudioSamples: output is a copy, not a view into HEAP16", () => {
  const heap16 = new Int16Array(8192);
  const offset = FAKE_SCRATCH_PTR / 2;
  heap16[offset] = 1000;
  heap16[offset + 1] = 2000;

  const emulator = makeLoadedEmulator({ framesWritten: 1, heap16 });
  const result = emulator.getAudioSamples(2048);

  // Mutate HEAP16 after the call
  heap16[offset] = 9999;
  heap16[offset + 1] = 9999;

  assert.equal(result[0], 1000, "copy unaffected by post-call HEAP16 mutation");
  assert.equal(result[1], 2000, "copy unaffected by post-call HEAP16 mutation");
});

// ---------------------------------------------------------------------------
// Missing export throws EmulatorCrashError
// ---------------------------------------------------------------------------

test("getAudioSamples: missing _getAudioSamples export throws EmulatorCrashError", () => {
  const emulator = makeLoadedEmulator({ omitGetAudioSamples: true });

  assert.throws(
    () => emulator.getAudioSamples(2048),
    (err: unknown) => {
      assert.ok(err instanceof EmulatorCrashError);
      assert.ok((err as EmulatorCrashError).message.includes("ADR 0006"), "error message references ADR 0006");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test 1 — scratch buffer allocated once, freed exactly once on destroy
// ---------------------------------------------------------------------------

test("getAudioSamples: scratch buffer allocated once at construct, freed once on destroy", () => {
  const mallocCalls: number[] = [];
  const freeCalls: number[] = [];
  const mod = buildMockModule({ mallocCalls, freeCalls, framesWritten: 0 });

  // Simulate what createEmulator does: _malloc before constructing Emulator
  const modWithMalloc = mod as unknown as { _malloc: (n: number) => number };
  const ptr = modWithMalloc._malloc(8192);
  const emulator = new Emulator(mod, ptr);
  emulator.__testForceLoad();

  // Multiple calls — no additional allocation or free
  emulator.getAudioSamples(2048);
  emulator.getAudioSamples(2048);
  emulator.getAudioSamples(2048);

  assert.equal(mallocCalls.length, 1, "_malloc called once (scratch alloc)");
  assert.equal(freeCalls.length, 0, "_free not called before destroy");

  emulator.destroy();

  assert.equal(freeCalls.length, 1, "_free called exactly once on destroy");
  assert.equal(freeCalls[0], FAKE_SCRATCH_PTR, "_free receives the correct scratch pointer");
});

// ---------------------------------------------------------------------------
// _getAudioSamples receives correct scratchPtr on each call
// ---------------------------------------------------------------------------

test("getAudioSamples: _getAudioSamples called with correct scratchPtr", () => {
  const getAudioSamplesCalls: Array<{ dest: number; max: number }> = [];
  const emulator = makeLoadedEmulator({ getAudioSamplesCalls, framesWritten: 0 });

  emulator.getAudioSamples(512);

  assert.equal(getAudioSamplesCalls.length, 1);
  assert.equal(getAudioSamplesCalls[0]?.dest, FAKE_SCRATCH_PTR, "dest is the persistent scratchPtr");
  assert.equal(getAudioSamplesCalls[0]?.max, 512, "max matches requested frames");
});

// ---------------------------------------------------------------------------
// Negative / float maxFrames are clamped to 0 and return empty array
// ---------------------------------------------------------------------------

test("getAudioSamples: negative maxFrames returns empty Int16Array", () => {
  const getAudioSamplesCalls: Array<{ dest: number; max: number }> = [];
  const emulator = makeLoadedEmulator({ getAudioSamplesCalls });

  const result = emulator.getAudioSamples(-100);

  assert.ok(result instanceof Int16Array);
  assert.equal(result.length, 0);
  assert.equal(getAudioSamplesCalls.length, 0, "_getAudioSamples not called");
});

test("getAudioSamples: fractional maxFrames is floored", () => {
  const getAudioSamplesCalls: Array<{ dest: number; max: number }> = [];
  const emulator = makeLoadedEmulator({ getAudioSamplesCalls, framesWritten: 0 });

  emulator.getAudioSamples(10.9);

  assert.equal(getAudioSamplesCalls.length, 1);
  assert.equal(getAudioSamplesCalls[0]?.max, 10, "fractional maxFrames is floored");
});

// ---------------------------------------------------------------------------
// .gba extension stripping is case-insensitive and shared — an uppercase
// `GAME.GBA` ROM must seed pending SRAM under the same stem the save-state
// path derives (regression: SRAM seeding used a case-SENSITIVE /\.gba$/).
// ---------------------------------------------------------------------------

test("load: uppercase .GBA ROM seeds SRAM and save-state under the same stem", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-gba-test-"));
  const romPath = join(dir, "GAME.GBA");
  writeFileSync(romPath, new Uint8Array([0x2e, 0x00, 0x00, 0xea]));

  try {
    const vfsWrites: string[] = [];
    const mod = buildMockModule() as unknown as Record<string, unknown>;
    mod.FS = {
      writeFile(path: string) {
        vfsWrites.push(path);
      },
      readFile() {
        return new Uint8Array(0);
      },
    };
    mod.loadState = () => true;

    const emulator = new Emulator(mod as unknown as MgbaModule, FAKE_SCRATCH_PTR);
    emulator.writeSram(new Uint8Array([1, 2, 3]));
    await emulator.load(romPath);

    assert.ok(
      vfsWrites.includes("/data/saves/GAME.sav"),
      `pending SRAM must be seeded as GAME.sav (case-insensitive strip), got: ${vfsWrites.join(", ")}`,
    );

    // The save-state path must derive the SAME stem.
    emulator.loadState(new Uint8Array([4, 5, 6]));
    assert.ok(
      vfsWrites.includes("/data/states/GAME.ss0"),
      `save-state must use the same stem, got: ${vfsWrites.join(", ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
