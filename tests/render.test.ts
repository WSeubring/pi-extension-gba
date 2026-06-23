import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRenderer,
  RenderInitError,
  RenderTickError,
  type EmulatorLike,
} from "../src/render.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const GBA_W = 240;
const GBA_H = 160;
const FRAME_BYTES = GBA_W * GBA_H * 4;

function makeMockEmulator(): EmulatorLike {
  const buf = new Uint8Array(FRAME_BYTES).fill(128);
  return { step: () => {}, getFramebuffer: () => buf.slice() };
}

interface SetWidgetCall {
  key: string;
  content: unknown;
  options?: unknown;
}

function makeMockCtx(): { ctx: ExtensionContext; calls: SetWidgetCall[] } {
  const calls: SetWidgetCall[] = [];
  const ctx = {
    ui: {
      setWidget(key: string, content: unknown, options?: unknown) {
        calls.push({ key, content, options });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, calls };
}

test("createRenderer throws RenderInitError for invalid scale", () => {
  const { ctx } = makeMockCtx();
  assert.throws(
    () =>
      createRenderer(ctx, makeMockEmulator(), { scale: 4 as unknown as 1 }),
    RenderInitError,
  );
});

test("createRenderer throws RenderInitError for frameRate=0", () => {
  const { ctx } = makeMockCtx();
  assert.throws(
    () => createRenderer(ctx, makeMockEmulator(), { frameRate: 0 }),
    RenderInitError,
  );
});

test("createRenderer throws RenderInitError for frameRate=31", () => {
  const { ctx } = makeMockCtx();
  assert.throws(
    () => createRenderer(ctx, makeMockEmulator(), { frameRate: 31 }),
    RenderInitError,
  );
});

test("tick error is surfaced through onRenderError, not thrown", async () => {
  const { ctx } = makeMockCtx();
  const badEmulator: EmulatorLike = {
    step: () => {},
    getFramebuffer() {
      throw new Error("framebuffer exploded");
    },
  };
  const renderer = createRenderer(ctx, badEmulator, { frameRate: 30 });
  const errors: unknown[] = [];
  renderer.onRenderError((err) => errors.push(err));

  renderer.start();
  await new Promise((r) => setTimeout(r, 80));
  renderer.destroy();

  assert.ok(errors.length > 0, "expected at least one error via onRenderError");
  assert.ok(
    errors[0] instanceof RenderTickError,
    "error must be a RenderTickError",
  );
});

test("stop() preserves imageId (does not delete Kitty image)", async () => {
  const { ctx } = makeMockCtx();
  const renderer = createRenderer(ctx, makeMockEmulator(), { frameRate: 30 });
  // Phase 9 REVISE B3: opt into legacy live-tick so the widget backend
  // allocates an imageId during the first tick (pre-Phase-9 parity).
  renderer.setWidgetLiveTick(true);
  renderer.start();
  await new Promise((r) => setTimeout(r, 50));
  const idBeforeStop = renderer.__testGetImageId();
  renderer.stop();
  const idAfterStop = renderer.__testGetImageId();
  assert.notStrictEqual(idBeforeStop, undefined, "imageId must be set after start");
  assert.strictEqual(idBeforeStop, idAfterStop, "stop() must not clear imageId");
  renderer.destroy();
});

test("destroy() writes deleteKittyImage to stdout and clears imageId", async () => {
  const { ctx, calls } = makeMockCtx();
  const renderer = createRenderer(ctx, makeMockEmulator(), { frameRate: 30 });
  renderer.setWidgetLiveTick(true);
  renderer.start();
  await new Promise((r) => setTimeout(r, 50));
  const idBeforeDestroy = renderer.__testGetImageId();
  assert.notStrictEqual(idBeforeDestroy, undefined);

  const written: Buffer[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: typeof process.stdout.write }).write =
    (chunk: unknown, ...args: unknown[]) => {
      if (Buffer.isBuffer(chunk)) written.push(chunk);
      else if (typeof chunk === "string") written.push(Buffer.from(chunk));
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
    };

  try {
    renderer.destroy();
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write =
      origWrite;
  }

  assert.strictEqual(
    renderer.__testGetImageId(),
    undefined,
    "imageId must be undefined after destroy()",
  );

  const unmounts = calls.filter((c) => c.key === "gba" && c.content === undefined);
  assert.strictEqual(unmounts.length, 1, "destroy() must unmount the widget exactly once");

  const kittyOutput = Buffer.concat(written).toString();
  assert.ok(
    kittyOutput.includes(`i=${idBeforeDestroy}`),
    `stdout must contain deleteKittyImage with id=${idBeforeDestroy}, got: ${kittyOutput}`,
  );
});

test("#tick calls emulator.step(2) per ADR 0003", async () => {
  // ADR 0003: the render tick is the frame pump — each tick must call
  // emulator.step(2) before sampling the framebuffer. At 30 Hz, ≥3 ticks
  // in 150 ms means ≥3 step calls each receiving exactly 2 as their argument.
  const { ctx } = makeMockCtx();
  const stepCalls: number[] = [];
  const buf = new Uint8Array(GBA_W * GBA_H * 4).fill(128);
  const spyEmulator: EmulatorLike = {
    step(n: number) { stepCalls.push(n); },
    getFramebuffer() { return buf.slice(); },
  };

  const renderer = createRenderer(ctx, spyEmulator, { frameRate: 30 });
  renderer.start();
  await new Promise((r) => setTimeout(r, 150));
  renderer.stop();
  renderer.destroy();

  assert.ok(stepCalls.length >= 3, `expected ≥3 step calls, got ${stepCalls.length}`);
  assert.ok(
    stepCalls.every((n) => n === 2),
    `every step call must receive 2, got: ${JSON.stringify(stepCalls)}`,
  );
});

test("shrink() after stop() synchronously flushes a re-laid-out still frame without stepping", async () => {
  const { ctx, calls } = makeMockCtx();
  const stepCalls: number[] = [];
  const buf = new Uint8Array(FRAME_BYTES).fill(128);
  const spyEmulator: EmulatorLike = {
    step(n: number) { stepCalls.push(n); },
    getFramebuffer() { return buf.slice(); },
  };
  const renderer = createRenderer(ctx, spyEmulator, {
    frameRate: 30,
    expandedMaxCells: 60,
    shrunkMaxCells: 30,
  });
  // Phase 9 REVISE B3: shrink/expand use flushFrameToCurrentBackend → writeFrame
  // directly, so they flush regardless of live-tick.  No setWidgetLiveTick(true)
  // is needed here — the test exercises the gated-flush path specifically.
  renderer.start();
  await new Promise((r) => setTimeout(r, 50));
  renderer.stop();

  const callCountAfterStop = calls.length;
  const stepCountAfterStop = stepCalls.length;
  renderer.shrink();

  // shrink() while paused must fire a new synchronous setWidget call so the
  // widget re-mounts with the updated maxWidthCells (Phase 4 thumbnail resize path).
  assert.ok(
    calls.length > callCountAfterStop,
    `shrink() after stop() must synchronously invoke setWidget ` +
      `(calls before shrink: ${callCountAfterStop}, after: ${calls.length})`,
  );

  // The flush must NOT step the emulator: shrink() runs outside the tick loop
  // (agent_end on a paused game, crash handler inside a core callback) — it
  // re-lays out the CURRENT framebuffer like showStillFrame.
  assert.strictEqual(
    stepCalls.length,
    stepCountAfterStop,
    "shrink() must not call emulator.step (still-frame flush only)",
  );

  // The most-recent call must carry a factory function (not undefined/null).
  const lastCall = calls[calls.length - 1];
  assert.strictEqual(typeof lastCall.content, "function",
    "setWidget content after shrink() must be a widget factory");

  renderer.destroy();
});
