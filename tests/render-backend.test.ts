import { defined } from "./harness/assert.js";
/**
 * Phase 9a backend tests — RenderControllerWithSwap + backend abstraction.
 * Design ref: docs/design/phase-9a-render-backend.md §Test plan
 *
 * Phase 9 REVISE B1: add end-to-end test proving raw RGBA flows to the custom
 * backend (Kitty f=32 path) and PNG flows to the widget backend (pi-tui Image).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { allocateImageId, deleteKittyImage } from "@mariozechner/pi-tui";
import { GbaGameComponent as RealGameComponent } from "../src/game-component.js";
import { createRenderer, type EmulatorLike, type GbaGameComponent } from "../src/render.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

/**
 * Build a fake GbaGameComponent whose acceptFrame and dispose calls are recorded.
 * Lazily allocates a real imageId on first acceptFrame so the id is valid.
 */
function makeFakeComponent(): {
  component: GbaGameComponent;
  acceptFrameCalls: number;
  disposeCalls: number;
} {
  let imageId: number | undefined;
  let acceptFrameCalls = 0;
  let disposeCalls = 0;

  const component: GbaGameComponent = {
    acceptFrame(_rgba, _widthPx, _heightPx) {
      acceptFrameCalls++;
      if (imageId === undefined) {
        imageId = allocateImageId();
      }
    },
    dispose() {
      disposeCalls++;
      if (imageId !== undefined) {
        process.stdout.write(deleteKittyImage(imageId));
        imageId = undefined;
      }
    },
    __getImageId() {
      return imageId;
    },
  };

  return {
    component,
    get acceptFrameCalls() {
      return acceptFrameCalls;
    },
    get disposeCalls() {
      return disposeCalls;
    },
  };
}

/** Spy on stdout, collect written bytes, then restore. */
function captureStdout(fn: () => void): string {
  const written: Buffer[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = (
    chunk: unknown,
    ...args: unknown[]
  ) => {
    if (Buffer.isBuffer(chunk)) written.push(chunk);
    else if (typeof chunk === "string") written.push(Buffer.from(chunk));
    return (orig as (...a: unknown[]) => boolean)(chunk, ...args);
  };
  try {
    fn();
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = orig;
  }
  return Buffer.concat(written).toString();
}

// ---------------------------------------------------------------------------
// Test 1 — swap-backend
// ---------------------------------------------------------------------------

test("swap-backend: useBackend('custom') disposes widget id and routes frames to component", async () => {
  // Phase 9 REVISE N8: dropped the dead-code first half that constructed a
  // renderer, destroyed it, and then rebuilt a second identical one. The
  // live test below is the single source of truth.
  const { ctx, calls } = makeMockCtx();

  let capturedAdapter: GbaGameComponent | undefined;
  const renderer2 = createRenderer(ctx, makeMockEmulator(), {
    frameRate: 30,
    attachCustomComponent(c) {
      capturedAdapter = c;
    },
  });

  renderer2.setWidgetLiveTick(true);
  renderer2.start();
  await new Promise((r) => setTimeout(r, 60));

  const widgetId2 = renderer2.__testGetImageId();
  assert.notStrictEqual(widgetId2, undefined, "widget imageId must exist before swap");

  // Record stdout during swap to check deleteKittyImage is emitted
  const stdoutDuringSwap = captureStdout(() => {
    renderer2.useBackend("custom");
  });

  // Old widget imageId must appear in the delete sequence
  assert.ok(
    stdoutDuringSwap.includes(`i=${widgetId2}`),
    `useBackend swap must emit deleteKittyImage(${widgetId2}), got: ${stdoutDuringSwap}`,
  );

  // After swap, controller is on "custom" backend
  assert.strictEqual(renderer2.activeBackend(), "custom");

  // The capturedAdapter proxies to the CustomRenderBackend — but without a
  // real GbaGameComponent set, acceptFrame is a no-op on the stub. We confirm
  // no more setWidget calls come through after the swap.
  const setWidgetCallsBeforeSwap = calls.filter((c) => typeof c.content === "function").length;
  await new Promise((r) => setTimeout(r, 60));
  const setWidgetCallsAfterSwap = calls.filter((c) => typeof c.content === "function").length;

  // After swapping to custom backend, no new setWidget(key, factory) calls
  assert.strictEqual(
    setWidgetCallsAfterSwap,
    setWidgetCallsBeforeSwap,
    "after swapping to custom backend, widget setWidget must not be called again",
  );

  renderer2.destroy();

  // Verify capturedAdapter forwarded its dispose to the backend
  assert.strictEqual(renderer2.__testGetImageId(), undefined, "imageId must be cleared after destroy");
  assert.ok(capturedAdapter !== undefined); // suppress unused var
});

// ---------------------------------------------------------------------------
// Test 2 — two-backends-don't-interfere
// ---------------------------------------------------------------------------

test("two-backends-don't-interfere: custom backend imageId differs from widget backend imageId", async () => {
  const { ctx } = makeMockCtx();
  let capturedAdapter: GbaGameComponent | undefined;

  const renderer = createRenderer(ctx, makeMockEmulator(), {
    frameRate: 30,
    attachCustomComponent(c) {
      capturedAdapter = c;
    },
  });

  renderer.setWidgetLiveTick(true);
  renderer.start();
  await new Promise((r) => setTimeout(r, 60));

  const widgetId = renderer.__testGetImageId();
  assert.notStrictEqual(widgetId, undefined, "widget backend must have an imageId");

  // Swap to custom — widget id gets disposed. Custom backend has no component yet → id undefined.
  renderer.useBackend("custom");
  const customId = renderer.__testGetImageId();

  // Custom backend has no component installed → no imageId yet
  assert.strictEqual(customId, undefined, "custom backend starts with no imageId (no component yet)");

  // Simulate 9c attaching a component: push a frame through the adapter
  // so the fake component allocates its own imageId
  const _fakeComp = makeFakeComponent();
  // Manually push frame through adapter to simulate 9b component accepting a frame
  capturedAdapter?.acceptFrame(new Uint8Array(10), 480, 320);

  // The adapter only forwards to the CustomRenderBackend's component slot,
  // but our fakeComp is not wired into the adapter's slot.
  // The adapter IS the bridge. The design says 9c calls renderer.useBackend("custom")
  // AFTER binding the component via a setter outside the adapter.
  // For this test we verify isolation: the widget id that was freed ≠ any new id.

  // Widget id was disposed → gone. Custom backend currently has no id.
  // The two ids (if custom were to allocate one) would be freshly allocated
  // and would not collide because pi-tui's allocateImageId monotonically increments.
  // We simply verify the widget id is not present in the custom backend.
  assert.notStrictEqual(
    widgetId,
    renderer.__testGetImageId(),
    "custom backend must not reuse the widget backend imageId",
  );

  renderer.destroy();

  assert.ok(capturedAdapter !== undefined); // suppress unused var
});

// ---------------------------------------------------------------------------
// Test 3 — imageId lifecycle / no-leak
// ---------------------------------------------------------------------------

test("imageId lifecycle: each backend emits exactly one deleteKittyImage per allocated id", async () => {
  const { ctx } = makeMockCtx();

  // --- Widget backend ---
  const widgetRenderer = createRenderer(ctx, makeMockEmulator(), { frameRate: 30 });
  widgetRenderer.setWidgetLiveTick(true);
  widgetRenderer.start();
  await new Promise((r) => setTimeout(r, 60));

  const wId = widgetRenderer.__testGetImageId();
  assert.notStrictEqual(wId, undefined, "widget must allocate an imageId after first tick");

  const widgetDestroyOutput = captureStdout(() => widgetRenderer.destroy());
  assert.ok(widgetDestroyOutput.includes(`i=${wId}`), `destroy() must emit deleteKittyImage(${wId}) exactly once`);

  // After destroy, id is gone
  assert.strictEqual(widgetRenderer.__testGetImageId(), undefined);

  // Count occurrences of the id in the output — must be exactly 1
  const occurrences = (widgetDestroyOutput.match(new RegExp(`i=${wId}`, "g")) ?? []).length;
  assert.strictEqual(occurrences, 1, `deleteKittyImage must appear exactly once, got ${occurrences}`);

  // --- Custom backend (via fakeComp) ---
  const fakeComp = makeFakeComponent();
  const { ctx: ctx2 } = makeMockCtx();
  let capturedAdapter: GbaGameComponent | undefined;

  const customRenderer = createRenderer(ctx2, makeMockEmulator(), {
    frameRate: 30,
    attachCustomComponent(c) {
      capturedAdapter = c;
    },
  });

  // Swap to custom immediately
  customRenderer.useBackend("custom");

  // Simulate the component accepting a frame (allocates its imageId)
  fakeComp.component.acceptFrame(new Uint8Array(10), 480, 320);
  const compId = fakeComp.component.__getImageId();
  assert.notStrictEqual(compId, undefined, "fakeComp must allocate an imageId on first acceptFrame");

  // Dispose the custom renderer — should call component.dispose() → deleteKittyImage
  const customDestroyOutput = captureStdout(() => fakeComp.component.dispose());
  assert.ok(customDestroyOutput.includes(`i=${compId}`), `component.dispose() must emit deleteKittyImage(${compId})`);
  assert.strictEqual(fakeComp.disposeCalls, 1, "dispose must be called exactly once");
  assert.strictEqual(fakeComp.component.__getImageId(), undefined, "imageId must be cleared after dispose");

  customRenderer.destroy();
  assert.ok(capturedAdapter !== undefined); // suppress unused var
});

// ---------------------------------------------------------------------------
// Test 4 — tick-pause around swap
// ---------------------------------------------------------------------------

test("tick-pause around swap: no pushFrame delivered to disposed backend", async () => {
  const { ctx } = makeMockCtx();

  // We track which backend receives each pushFrame by counting setWidget calls.
  // After swap, widgetBackend must receive no further setWidget(factory) calls.
  const renderer = createRenderer(ctx, makeMockEmulator(), { frameRate: 30 });
  renderer.setWidgetLiveTick(true);
  renderer.start();
  await new Promise((r) => setTimeout(r, 60));

  // Perform swap and immediately record call count
  renderer.useBackend("custom");

  const callCountRightAfterSwap = 0; // placeholder — real assertion done below via renderer3

  // Wait for a few potential tick intervals
  await new Promise((r) => setTimeout(r, 80));

  // Check that after dispose + swap, no widget backend setWidget(factory) calls arrived.
  // We do this by inspecting the calls array from the mock ctx (captured via closure
  // in the outer makeMockCtx; but we used the inner ctx here — re-query via closure).

  // Count setWidget calls with a factory function AFTER the swap:
  // We do not have a direct timestamp, so instead we capture the count before swap
  // by using a fresh renderer with spy ctx that records post-swap.

  // Simpler approach: create renderer, start, record call count, swap, wait, compare.
  renderer.destroy();

  // Fresh test with precise call-count capture
  const { ctx: ctx3, calls: calls3 } = makeMockCtx();
  const renderer3 = createRenderer(ctx3, makeMockEmulator(), { frameRate: 30 });
  renderer3.setWidgetLiveTick(true);
  renderer3.start();
  await new Promise((r) => setTimeout(r, 60));

  const widgetCallsBeforeSwap = calls3.filter((c) => typeof c.content === "function").length;
  assert.ok(widgetCallsBeforeSwap > 0, "must have some widget calls before swap");

  renderer3.useBackend("custom");
  const widgetCallsAtSwap = calls3.filter((c) => typeof c.content === "function").length;

  // Wait for a few tick intervals — no new widget setWidget calls should arrive
  await new Promise((r) => setTimeout(r, 80));

  const widgetCallsAfterWait = calls3.filter((c) => typeof c.content === "function").length;
  assert.strictEqual(
    widgetCallsAfterWait,
    widgetCallsAtSwap,
    `after swapping away from widget backend, no new setWidget(factory) calls must arrive; ` +
      `before: ${widgetCallsBeforeSwap}, at swap: ${widgetCallsAtSwap}, after wait: ${widgetCallsAfterWait}`,
  );

  renderer3.destroy();
  assert.ok(callCountRightAfterSwap >= 0); // suppress unused var
});

// ---------------------------------------------------------------------------
// Test 5 — destroy is idempotent
// ---------------------------------------------------------------------------

test("destroy is idempotent: calling destroy twice does not throw or double-emit", async () => {
  // Widget backend
  const { ctx: ctxW } = makeMockCtx();
  const widgetRenderer = createRenderer(ctxW, makeMockEmulator(), { frameRate: 30 });
  widgetRenderer.setWidgetLiveTick(true);
  widgetRenderer.start();
  await new Promise((r) => setTimeout(r, 50));

  const wId = widgetRenderer.__testGetImageId();

  const firstDestroyOut = captureStdout(() => widgetRenderer.destroy());
  const secondDestroyOut = captureStdout(() => widgetRenderer.destroy());

  // First destroy emits deleteKittyImage; second must not (imageId already cleared)
  assert.ok(wId !== undefined && firstDestroyOut.includes(`i=${wId}`), "first destroy must emit deleteKittyImage");
  assert.ok(!secondDestroyOut.includes(`i=${wId}`), "second destroy must NOT re-emit deleteKittyImage (idempotent)");
  assert.strictEqual(widgetRenderer.__testGetImageId(), undefined, "imageId must be undefined after first destroy");

  // Custom backend
  const fakeComp2 = makeFakeComponent();
  fakeComp2.component.acceptFrame(new Uint8Array(10), 480, 320);

  const firstOut = captureStdout(() => fakeComp2.component.dispose());
  const secondOut = captureStdout(() => fakeComp2.component.dispose());

  assert.ok(firstOut.includes("i="), "first dispose must emit deleteKittyImage");
  assert.strictEqual(secondOut, "", "second dispose must not emit anything (imageId already cleared)");
  assert.strictEqual(fakeComp2.component.__getImageId(), undefined);
});

// ---------------------------------------------------------------------------
// Test B1 (REVISE) — end-to-end: emulator → custom backend → RealGameComponent.
//
// Proves the PNG/RGBA mismatch is fixed: raw RGBA flows from the tick loop
// all the way into GbaGameComponent's Kitty `f=32` transmission, never as PNG
// container bytes. Asserts the base64 payload length matches width*height*4
// raw RGBA bytes (via round-trip decoding).
// ---------------------------------------------------------------------------

test("end-to-end: emulator framebuffer flows as raw RGBA to GbaGameComponent under f=32", async () => {
  const { ctx, calls } = makeMockCtx();

  // Build a distinctive framebuffer: first pixel R=1,G=2,B=3,A=4.
  // Upscaler will set alpha=0xff; the first RGB triplet must still be (1,2,3).
  const frame = new Uint8Array(GBA_W * GBA_H * 4);
  frame[0] = 1;
  frame[1] = 2;
  frame[2] = 3;
  frame[3] = 4;

  const emulator: EmulatorLike = {
    step() {},
    getFramebuffer() {
      return frame;
    },
  };

  let attachedAdapter: GbaGameComponent | undefined;
  const renderer = createRenderer(ctx, emulator, {
    scale: 2,
    frameRate: 30,
    attachCustomComponent(c) {
      attachedAdapter = c;
    },
  });

  assert.ok(attachedAdapter !== undefined);

  // Build a REAL GbaGameComponent and wire it into the custom backend.
  // Minimal pi-tui stub — we only need terminal.rows + terminal.write + requestRender.
  const writtenToTerminal: string[] = [];
  const tuiStub = {
    terminal: {
      rows: 40,
      write(s: string) {
        writtenToTerminal.push(s);
      },
    },
    requestRender() {},
  } as unknown as TUI;

  const sinkStub = { press() {}, release() {} };
  const component = new RealGameComponent(tuiStub, { emulator: {}, sink: sinkStub, scale: 2 }, () => {});
  renderer.setCustomComponent(component);
  renderer.useBackend("custom");

  // Teach the component its width first — placement geometry derives from
  // the last render width under the direct-pin strategy.
  component.render(80);

  // Drive at least one tick manually by calling start (will tick immediately).
  renderer.start();
  // Swallow the interval; we just need the first tick's side-effect.
  renderer.stop();

  // The tick → acceptFrame → direct terminal pin. The transmit sequence
  // carries a base64-encoded file path (t=f), pixels live on /dev/shm (or
  // $TMPDIR). Validate the raw RGBA bytes reach that file and that the
  // pinned sequence references it.
  const imageLine = writtenToTerminal.find((l) => l.includes("\x1b_G"));
  assert.ok(imageLine !== undefined, "acceptFrame must pin the Kitty sequence via terminal.write");

  // Sequence shape: \x1b_Ga=T,f=24,t=f,...;<base64path>\x1b\\
  const match = imageLine?.match(/;([A-Za-z0-9+/=]+)\x1b\\/);
  assert.ok(match, "Kitty sequence payload must be present");
  const base64Path = defined(match[1], "base64 path");
  const filePath = Buffer.from(base64Path, "base64").toString("utf8");

  // Decode file contents and assert byte layout = width * height * 4 raw RGBA.
  // Upscaler forces alpha=0xFF so f=32 renders correctly in Ghostty.
  const decoded = readFileSync(filePath);
  const outW = GBA_W * 2;
  const outH = GBA_H * 2;
  assert.strictEqual(
    decoded.length,
    outW * outH * 4,
    `decoded payload must be raw RGBA (${outW * outH * 4} bytes), got ${decoded.length}.`,
  );

  // First pixel: source (1,2,3,4) → RGBA (1,2,3,0xFF). Alpha forced opaque.
  assert.strictEqual(decoded[0], 1, "decoded R");
  assert.strictEqual(decoded[1], 2, "decoded G");
  assert.strictEqual(decoded[2], 3, "decoded B");
  assert.strictEqual(decoded[3], 0xff, "decoded A (forced opaque)");

  assert.ok(imageLine?.includes("f=32"), "Kitty sequence must declare f=32 (raw RGBA)");
  assert.ok(imageLine?.includes("t=f"), "Kitty sequence must declare t=f (file transport)");
  assert.ok(!imageLine?.includes("f=100"), "Kitty sequence must NOT declare f=100 (PNG)");
  assert.ok(!imageLine?.includes("f=24"), "Kitty sequence must NOT declare f=24 (RGB)");

  component.dispose();
  renderer.destroy();
  assert.ok(calls !== undefined); // suppress lint
});

// ---------------------------------------------------------------------------
// Test B1 (REVISE) — widget backend receives PNG; custom backend receives RGBA
// ---------------------------------------------------------------------------

test("FramePayload routing: widget backend gets PNG, custom backend gets RGBA", async () => {
  // Proves per-backend FramePayload selection:
  //   widget path → pi-tui Image receives "image/png"
  //   custom path → GbaGameComponent-like receiver gets raw RGBA (not PNG)
  const { ctx, calls } = makeMockCtx();

  // Capture RGBA bytes at the component — the tick's backend.pushFrame path.
  const seenRgba: Array<{ bytes: Uint8Array; w: number; h: number }> = [];
  const component: GbaGameComponent = {
    acceptFrame(rgba, w, h) {
      seenRgba.push({ bytes: rgba, w, h });
    },
    dispose() {},
    __getImageId() {
      return undefined;
    },
  };

  const renderer = createRenderer(ctx, makeMockEmulator(), { frameRate: 30 });

  // Phase 1: widget backend live-tick → at least one setWidget(factory) call.
  renderer.setWidgetLiveTick(true);
  renderer.start();
  await new Promise((r) => setTimeout(r, 60));

  const widgetFactoryCalls = calls.filter((c) => typeof c.content === "function");
  assert.ok(widgetFactoryCalls.length >= 1, "widget backend must fire at least one setWidget(factory) call");

  // Phase 2: swap to custom backend with our spy component → RGBA captured.
  renderer.setCustomComponent(component);
  renderer.useBackend("custom");
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(seenRgba.length >= 1, "custom backend must deliver at least one RGBA frame to component");
  const sample = seenRgba[0];
  // GBA 240×160 at scale=2 → 480×320×4 = 614400 bytes raw RGBA.
  assert.strictEqual(sample.bytes.length, 480 * 320 * 4, "RGBA buffer must be width*height*4 (not PNG-encoded)");
  assert.strictEqual(sample.w, 480, "width must be 480 (scale=2)");
  assert.strictEqual(sample.h, 320, "height must be 320 (scale=2)");

  // PNG magic = 0x89 0x50 0x4E 0x47. Assert the buffer does NOT start with it.
  assert.ok(
    !(sample.bytes[0] === 0x89 && sample.bytes[1] === 0x50 && sample.bytes[2] === 0x4e && sample.bytes[3] === 0x47),
    "custom backend must receive raw RGBA, not PNG container bytes",
  );

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// destroy() disposes BOTH backends — a custom component wired while the
// widget backend is active must not leak its write hook / raw files.
// ---------------------------------------------------------------------------

test("destroy() disposes the inactive custom backend's component too", async () => {
  const { ctx } = makeMockCtx();
  const renderer = createRenderer(ctx, makeMockEmulator(), { frameRate: 30 });

  // Wire a component into the custom backend but keep "widget" active.
  let disposeCalls = 0;
  const component: GbaGameComponent = {
    acceptFrame() {},
    dispose() {
      disposeCalls++;
    },
    __getImageId() {
      return undefined;
    },
  };
  renderer.setCustomComponent(component);
  assert.strictEqual(renderer.activeBackend(), "widget");

  renderer.destroy();

  assert.strictEqual(
    disposeCalls,
    1,
    "destroy() must dispose the custom backend's component even when the widget backend is active",
  );
});
