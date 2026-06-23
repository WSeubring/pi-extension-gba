/**
 * Env-gated PNG frame dump hook for the custom render backend.
 *
 * Scenarios:
 *   1. PI_GBA_FRAME_DUMP unset  → no files written.
 *   2. PI_GBA_FRAME_DUMP set, every=2, 10 frames → 5 PNGs (decodable, dims match).
 *   3. Invalid (read-only) dump dir → hook silently disables; no crash.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { decode as decodePng } from "fast-png";
import { createRenderer, type EmulatorLike, type GbaGameComponent } from "../src/render.js";

const GBA_W = 240;
const GBA_H = 160;
const FRAME_BYTES = GBA_W * GBA_H * 4;

function makeMockEmulator(): EmulatorLike {
  const buf = new Uint8Array(FRAME_BYTES);
  // Non-uniform pattern so a decoded PNG has distinguishable pixels.
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = (i >> 2) & 0xff;
    buf[i + 1] = 0x80;
    buf[i + 2] = 0x40;
    buf[i + 3] = 0xff;
  }
  return { step: () => {}, getFramebuffer: () => buf.slice() };
}

function makeMockCtx(): ExtensionContext {
  return {
    ui: { setWidget(_k: string, _c: unknown, _o?: unknown) {} },
  } as unknown as ExtensionContext;
}

/** Temp dir helper: creates and returns an absolute path. */
function makeTempDir(): string {
  const p = join(tmpdir(), `gba-frame-dump-${randomUUID()}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function tryRm(path: string): void {
  try {
    chmodSync(path, 0o700);
  } catch {}
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
}

/**
 * Drive N frames through the custom backend synchronously by routing them via
 * the attachCustomComponent adapter — same path tick() uses.
 * scale=1 keeps dims at 240x160.
 */
async function driveFrames(frames: number, extraEnv: Record<string, string | undefined>): Promise<void> {
  // Apply env overrides around createRenderer (env is read at construction).
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  let adapter: GbaGameComponent | undefined;
  const renderer = createRenderer(makeMockCtx(), makeMockEmulator(), {
    scale: 1,
    frameRate: 30,
    initialBackend: "custom",
    attachCustomComponent(c) {
      adapter = c;
    },
  });

  try {
    // Push frames directly into the custom adapter — exercises CustomRenderBackend.pushFrame.
    assert.ok(adapter, "attachCustomComponent must fire");
    const rgba = new Uint8Array(GBA_W * GBA_H * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = i & 0xff;
      rgba[i + 1] = 0x22;
      rgba[i + 2] = 0x44;
      rgba[i + 3] = 0xff;
    }
    for (let i = 0; i < frames; i++) {
      adapter.acceptFrame(rgba, GBA_W, GBA_H);
    }
    // Give fire-and-forget writes a moment to flush.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    renderer.destroy();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — env unset → no files
// ---------------------------------------------------------------------------

test("frame-dump: env unset writes no files", async () => {
  const dir = makeTempDir();
  try {
    await driveFrames(10, {
      PI_GBA_FRAME_DUMP: undefined,
      PI_GBA_FRAME_DUMP_EVERY: undefined,
    });
    const entries = readdirSync(dir);
    assert.deepStrictEqual(entries, [], "no files should be written when env is unset");
  } finally {
    tryRm(dir);
  }
});

// ---------------------------------------------------------------------------
// Scenario 2 — env set, every=2, 10 frames → 5 PNGs (decodable, dims match)
// ---------------------------------------------------------------------------

test("frame-dump: env set writes every Nth frame as decodable PNG", async () => {
  const dir = makeTempDir();
  try {
    await driveFrames(10, {
      PI_GBA_FRAME_DUMP: dir,
      PI_GBA_FRAME_DUMP_EVERY: "2",
    });
    const files = readdirSync(dir).sort();
    // seq 0, 2, 4, 6, 8 → 5 files
    assert.strictEqual(files.length, 5, `expected 5 files, got ${files.length}: ${files.join(",")}`);
    const expected = ["gba-0000.png", "gba-0002.png", "gba-0004.png", "gba-0006.png", "gba-0008.png"];
    assert.deepStrictEqual(files, expected);

    for (const name of files) {
      const buf = readFileSync(join(dir, name));
      assert.ok(buf.length > 0, `${name} must be non-empty`);
      const decoded = decodePng(buf);
      assert.strictEqual(decoded.width, GBA_W, `${name} width`);
      assert.strictEqual(decoded.height, GBA_H, `${name} height`);
      assert.strictEqual(decoded.channels, 4, `${name} channels`);
    }
  } finally {
    tryRm(dir);
  }
});

// ---------------------------------------------------------------------------
// Scenario 3 — invalid/unwritable dir → hook disables silently, no crash.
// ---------------------------------------------------------------------------

test("frame-dump: invalid dir silently disables hook without crashing", async () => {
  // Use a path under a read-only parent so mkdir -p can't create it.
  const parent = makeTempDir();
  try {
    chmodSync(parent, 0o500); // r-x: cannot create children
    const unwritable = join(parent, "nested", "child");
    // Should not throw even though mkdir will fail.
    await driveFrames(5, {
      PI_GBA_FRAME_DUMP: unwritable,
      PI_GBA_FRAME_DUMP_EVERY: "1",
    });
    // If the unwritable path somehow materialised, fail loudly.
    try {
      const st = statSync(unwritable);
      assert.fail(`unwritable path unexpectedly exists: ${JSON.stringify(st)}`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // ENOENT (nothing created) or EACCES (no perms) are both acceptable.
      if (err.code !== "ENOENT" && err.code !== "EACCES") throw e;
    }
  } finally {
    try {
      chmodSync(parent, 0o700);
    } catch {}
    tryRm(parent);
  }
});
