/**
 * Phase 9b tests — GbaGameComponent + classifyGbaKey.
 * Design ref: docs/design/phase-9b-custom-game-component.md §Test plan
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { GbaGameComponent } from "../src/game-component.js";
import { classifyGbaKey } from "../src/input.js";
import type { ButtonSink, GbaButton } from "../src/types.js";
import type { TUI } from "@mariozechner/pi-tui";
import { setCellDimensions } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const GBA_W = 240;
const GBA_H = 160;
const SCALE = 2;
const OUT_W = GBA_W * SCALE; // 480
const OUT_H = GBA_H * SCALE; // 320

interface SinkCall {
  kind: "press" | "release";
  button: GbaButton;
}

function makeMockSink(): { sink: ButtonSink; calls: SinkCall[] } {
  const calls: SinkCall[] = [];
  const sink: ButtonSink = {
    press(button) { calls.push({ kind: "press", button }); },
    release(button) { calls.push({ kind: "release", button }); },
  };
  return { sink, calls };
}

/** Minimal TUI mock exposing terminal.rows and terminal.write. */
function makeMockTui(rows = 40): { tui: TUI; written: string[] } {
  const written: string[] = [];
  const tui = {
    terminal: {
      rows,
      write(data: string) { written.push(data); },
    },
    requestRender() {},
  } as unknown as TUI;
  return { tui, written };
}

function makeGreenRgba(widthPx: number, heightPx: number): Uint8Array {
  const buf = new Uint8Array(widthPx * heightPx * 4);
  for (let i = 0; i < widthPx * heightPx; i++) {
    buf[i * 4 + 0] = 0;
    buf[i * 4 + 1] = 255;
    buf[i * 4 + 2] = 0;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function makeComponent(
  sink: ButtonSink,
  tui: TUI,
  done: (r: undefined) => void = () => {},
): GbaGameComponent {
  return new GbaGameComponent(tui, { emulator: {}, sink, scale: SCALE as 2 }, done);
}

// ---------------------------------------------------------------------------
// Test 1 — correct Kitty bytes + cursor-relative prefix
// ---------------------------------------------------------------------------

test("direct-pin: acceptFrame writes Kitty placement to terminal at absolute coords", () => {
  const { sink } = makeMockSink();
  const { tui, written } = makeMockTui(40);
  const comp = makeComponent(sink, tui);
  const id = comp.__getImageId();
  assert.ok(id !== undefined, "imageId must be allocated at construction");

  // render() first so the component learns its width (placement geometry).
  comp.render(80);

  const rgba = makeGreenRgba(OUT_W, OUT_H);
  comp.acceptFrame(rgba, OUT_W, OUT_H);

  const pin = written.find((w) => w.includes("\x1b_G"));
  assert.ok(pin !== undefined, "acceptFrame must write the Kitty transmit directly to the terminal");
  assert.ok(pin!.startsWith("\x1b7"), "pin must save the cursor first (DECSC)");
  assert.ok(pin!.endsWith("\x1b8"), "pin must restore the cursor last (DECRC)");
  assert.match(pin!, /\x1b7\x1b\[\d+;1H/, "pin must move to an absolute row before transmitting");
  assert.ok(pin!.includes(`i=${id}`), `pin must contain i=${id}`);
  assert.ok(pin!.includes("a=T"), "pin must include a=T");
  assert.ok(pin!.includes("t=f"), "pin must declare t=f (file transport)");
  assert.ok(pin!.includes("p=1"), "pin must reuse placement id 1 for atomic replace");
  assert.ok(!pin!.includes("S="), "pin must not carry S= (Ghostty rejects it)");

  comp.dispose();
});

// ---------------------------------------------------------------------------
// Test 2 — render() output is static: no Kitty bytes, stable across frames
// ---------------------------------------------------------------------------

test("render(): static lines only — no Kitty bytes, identical across frames", () => {
  const { sink } = makeMockSink();
  const { tui } = makeMockTui(40);
  const comp = makeComponent(sink, tui);

  comp.render(80);
  const rgba = makeGreenRgba(OUT_W, OUT_H);
  comp.acceptFrame(rgba, OUT_W, OUT_H);

  const first = comp.render(80);
  assert.ok(first.every((l) => !l.includes("\x1b_G")),
    "render must never embed the Kitty transmit (image is pinned directly)");
  assert.ok(first[first.length - 1]!.includes("GBA |"), "last line is the static footer");
  for (let i = 0; i < first.length - 1; i++) {
    assert.strictEqual(first[i], "", `line ${i} must be empty`);
  }

  comp.acceptFrame(rgba, OUT_W, OUT_H);
  const second = comp.render(80);
  assert.deepStrictEqual(second, first,
    "render output must be byte-identical across frames so pi-tui's diff never repaints it");

  comp.dispose();
});

// ---------------------------------------------------------------------------
// Test 3 — key-release: Kitty CSI-u release of "z" releases the "a" button
// ---------------------------------------------------------------------------

test("key-release: Kitty CSI-u release of z fires sink.release('a')", () => {
  const { sink, calls } = makeMockSink();
  const { tui } = makeMockTui();
  const comp = makeComponent(sink, tui);

  // Press z first (so button is held).
  comp.handleInput("z");
  assert.deepEqual(calls, [{ kind: "press", button: "a" }]);
  calls.length = 0;

  // Synthesise a Kitty CSI-u key-release event for 'z' (key code 122, modifier 0).
  // Kitty release format: \x1b[<keycode>;<modifiers>u with modifiers including release.
  // Release events have event type 3 encoded as \x1b[122;1:3u
  comp.handleInput("\x1b[122;1:3u"); // 'z' key release (Kitty extended)
  const releaseCall = calls.find((c) => c.kind === "release" && c.button === "a");
  assert.ok(releaseCall !== undefined, "sink.release('a') must be called on key release");

  comp.dispose();
});

// ---------------------------------------------------------------------------
// Test 4 — 100 ms decay without release event
// ---------------------------------------------------------------------------

test("100 ms decay: press z, advance timers 100ms, assert sink.release('a')", async () => {
  const { sink, calls } = makeMockSink();
  const { tui } = makeMockTui();
  const comp = makeComponent(sink, tui);

  comp.handleInput("z");
  assert.deepEqual(calls, [{ kind: "press", button: "a" }]);

  // Wait > 100 ms for the decay timer to fire naturally.
  await new Promise((r) => setTimeout(r, 120));

  const releaseCall = calls.find((c) => c.kind === "release" && c.button === "a");
  assert.ok(releaseCall !== undefined, "decay timer must fire sink.release('a') after 100ms");

  comp.dispose();
});

// ---------------------------------------------------------------------------
// Test 5 — dispose cleanup
// ---------------------------------------------------------------------------

test("dispose cleanup: held buttons released, deleteKittyImage emitted, raw file unlinked", () => {
  const { sink, calls } = makeMockSink();
  const { tui, written } = makeMockTui();
  const comp = makeComponent(sink, tui);
  const id = comp.__getImageId()!;

  // Hold 3 buttons by pressing them.
  comp.handleInput("z"); // → press "a"
  comp.handleInput("x"); // → press "b"
  comp.handleInput("z"); // already held — no double press
  comp.handleInput("\u001b[A"); // up arrow → press "up"

  const pressCount = calls.filter((c) => c.kind === "press").length;
  assert.ok(pressCount >= 2, "at least 2 buttons must be pressed");

  comp.dispose();

  // All held buttons must be released.
  const releaseButtons = calls.filter((c) => c.kind === "release").map((c) => c.button);
  assert.ok(releaseButtons.includes("a"), "must release 'a'");
  assert.ok(releaseButtons.includes("b"), "must release 'b'");

  // deleteKittyImage must have been written exactly once.
  const deleteSeqs = written.filter((s) => s.includes(`i=${id}`));
  assert.strictEqual(deleteSeqs.length, 1, `deleteKittyImage(${id}) must appear exactly once`);

  // imageId must be cleared after dispose.
  assert.strictEqual(comp.__getImageId(), undefined, "imageId must be undefined after dispose");
});

// ---------------------------------------------------------------------------
// Test 6 — exit on alt+g (all three variants)
// ---------------------------------------------------------------------------

test("exit on alt+g legacy: done(undefined) is called", () => {
  const { sink } = makeMockSink();
  const { tui } = makeMockTui();
  let doneCalled = 0;
  let doneArg: unknown = "sentinel";
  const comp = makeComponent(sink, tui, (r) => { doneCalled++; doneArg = r; });

  comp.handleInput("\u001bg"); // alt+g legacy
  assert.strictEqual(doneCalled, 1, "done must be called once");
  assert.strictEqual(doneArg, undefined, "done must be called with undefined");

  comp.dispose();
});

test("exit on alt+g Kitty CSI-u: done(undefined) is called", () => {
  const { sink } = makeMockSink();
  const { tui } = makeMockTui();
  let doneCalled = 0;
  const comp = makeComponent(sink, tui, (r) => { doneCalled++; void r; });

  comp.handleInput("\x1b[103;3u"); // alt+g Kitty protocol
  assert.strictEqual(doneCalled, 1, "done must be called on Kitty alt+g");

  comp.dispose();
});

test("exit on ctrl+c: done(undefined) is called", () => {
  const { sink } = makeMockSink();
  const { tui } = makeMockTui();
  let doneCalled = 0;
  const comp = makeComponent(sink, tui, (r) => { doneCalled++; void r; });

  comp.handleInput("\x03"); // ctrl+c
  assert.strictEqual(doneCalled, 1, "done must be called on ctrl+c");

  comp.dispose();
});

// ---------------------------------------------------------------------------
// Test 7 — no double-alloc: distinct imageIds
// ---------------------------------------------------------------------------

test("no double-alloc: two components get distinct imageIds", () => {
  const { sink: s1 } = makeMockSink();
  const { sink: s2 } = makeMockSink();
  const { tui: t1 } = makeMockTui();
  const { tui: t2 } = makeMockTui();

  const comp1 = makeComponent(s1, t1);
  const comp2 = makeComponent(s2, t2);

  const id1 = comp1.__getImageId();
  const id2 = comp2.__getImageId();

  assert.ok(id1 !== undefined, "comp1 must have an imageId");
  assert.ok(id2 !== undefined, "comp2 must have an imageId");
  assert.notStrictEqual(id1, id2, "two components must have distinct imageIds");

  comp1.dispose();
  comp2.dispose();
});

// ---------------------------------------------------------------------------
// Test 8 — printable keys: mapped fires press; unmapped is dropped
// ---------------------------------------------------------------------------

test("printable keys: 'a' (→ L button) fires press; 'p' (no mapping) is dropped", () => {
  const { sink, calls } = makeMockSink();
  const { tui } = makeMockTui();
  const comp = makeComponent(sink, tui);

  // 'a' maps to GBA "l" button in KEY_MAP.
  comp.handleInput("a");
  assert.deepEqual(calls, [{ kind: "press", button: "l" }]);

  calls.length = 0;

  // 'p' has no GBA mapping — must be dropped.
  comp.handleInput("p");
  assert.deepEqual(calls, [], "unmapped printable 'p' must be dropped");

  comp.dispose();
});

// ---------------------------------------------------------------------------
// Test 9 — classifyGbaKey unit tests
// ---------------------------------------------------------------------------

test("classifyGbaKey: maps known keys correctly", () => {
  assert.deepEqual(classifyGbaKey("z"), { kind: "press", button: "a" });
  assert.deepEqual(classifyGbaKey("x"), { kind: "press", button: "b" });
  assert.deepEqual(classifyGbaKey("a"), { kind: "press", button: "l" });
  assert.deepEqual(classifyGbaKey("s"), { kind: "press", button: "r" });
});

test("classifyGbaKey: printable unmapped key → drop", () => {
  assert.deepEqual(classifyGbaKey("p"), { kind: "drop" });
  assert.deepEqual(classifyGbaKey("q"), { kind: "drop" });
});

test("classifyGbaKey: ctrl+c → passthrough", () => {
  const result = classifyGbaKey("\x03");
  assert.strictEqual(result.kind, "passthrough");
});

test("classifyGbaKey: escape sequence → passthrough", () => {
  const result = classifyGbaKey("\x1b[15~");
  assert.strictEqual(result.kind, "passthrough");
});

// ---------------------------------------------------------------------------
// Test N5 — computeLayout uses runtime cell dims from getCellDimensions
// ---------------------------------------------------------------------------

test("computeLayout uses getCellDimensions: square cells give more rows than 2:1 assumption", () => {
  // Inject square cells (10×10 px) — pi-tui's calculateImageRows will compute
  // rows = ceil(heightPx / heightPxPerRow) = ceil(320 / 10) = 32 for a
  // 320-px-tall image at 10px-per-row. The 0.5 fallback would compute
  // ceil((320/480)*80*0.5) ≈ 27 — fewer rows, confirming the helper is used.
  setCellDimensions({ widthPx: 10, heightPx: 10 });

  try {
    const { sink } = makeMockSink();
    const { tui, written } = makeMockTui(50); // 50 rows → maxRows = floor(47 * 0.9)
    const comp = makeComponent(sink, tui);

    comp.render(80); // teach the component its width
    const rgba = makeGreenRgba(OUT_W, OUT_H);
    comp.acceptFrame(rgba, OUT_W, OUT_H);

    // width=80 cols; image 480×320 px; cell 10×10 px.
    // calculateImageRows = ceil(320 / 10) = 32 image rows.
    // 0.5-fallback = ceil((320/480)*80*0.5) = ceil(26.67) = 27 rows.
    // The pinned transmit carries the row count in its r= param.
    const pin = written.find((w) => w.includes("\x1b_G"));
    assert.ok(pin !== undefined, "pin must be written");
    const rMatch = pin!.match(/,r=(\d+),/);
    assert.ok(rMatch, "pin must carry r= rows param");
    const imageRows = Number(rMatch![1]);

    // With real cell dims (square), expected ~32 image rows; fallback ~27.
    // Assert we're above the fallback to confirm the helper path is active.
    assert.ok(
      imageRows >= 30,
      `with square cells (10×10) expected ≥30 image rows, got ${imageRows} — getCellDimensions may not be wired`,
    );
    comp.dispose();
  } finally {
    // Reset to zero so other tests use the fallback.
    setCellDimensions({ widthPx: 0, heightPx: 0 });
  }
});

// ---------------------------------------------------------------------------
// computeLayout — height cap must shrink cols proportionally (aspect ratio)
// ---------------------------------------------------------------------------

test("computeLayout: when the height cap binds, cols shrink proportionally (no horizontal stretch)", () => {
  // Kitty's c=/r= scale the image to fill the cell rect WITHOUT preserving
  // aspect ratio. On a wide/short terminal the row cap binds; if cols stay at
  // full width the frame is stretched horizontally.
  setCellDimensions({ widthPx: 10, heightPx: 10 });

  try {
    const { sink } = makeMockSink();
    // 10 terminal rows → availableRows = 7, maxRows = floor(7 * 0.9) = 6.
    const { tui, written } = makeMockTui(10);
    const comp = makeComponent(sink, tui);

    comp.render(120); // wide: 120 cols
    comp.acceptFrame(makeGreenRgba(OUT_W, OUT_H), OUT_W, OUT_H);

    // calculateImageRows: 120 cols × 10 px = 1200 px target width for a
    // 480×320 image → scale 2.5 → 800 px tall → 80 rows. Cap binds (80 > 6):
    // rows = 6, cols = floor(120 * 6 / 80) = 9.
    const pin = written.find((w) => w.includes("\x1b_G"));
    assert.ok(pin !== undefined, "pin must be written");
    const cols = Number(pin!.match(/,c=(\d+),/)![1]);
    const rows = Number(pin!.match(/,r=(\d+),/)![1]);
    assert.strictEqual(rows, 6, "rows must be capped to maxRows");
    assert.strictEqual(cols, 9, "cols must shrink proportionally with the row cap");

    comp.dispose();
  } finally {
    // Reset to zero so other tests use the fallback.
    setCellDimensions({ widthPx: 0, heightPx: 0 });
  }
});

// ---------------------------------------------------------------------------
// handleInput after dispose — must be a no-op (no sink calls, no timers)
// ---------------------------------------------------------------------------

test("handleInput after dispose is a no-op: no sink calls, no exit, no throw", () => {
  const { tui } = makeMockTui();
  let doneCalled = 0;
  // Sink that throws like a destroyed emulator (EmulatorNotLoadedError path).
  const throwingSink: ButtonSink = {
    press() { throw new Error("Emulator has no ROM loaded"); },
    release() { throw new Error("Emulator has no ROM loaded"); },
  };
  const comp = makeComponent(throwingSink, tui, () => { doneCalled++; });

  comp.dispose();

  // Post-dispose: button press must not reach the sink (would throw) and must
  // not arm a decay timer (would throw inside setTimeout → uncaught).
  assert.doesNotThrow(() => comp.handleInput("z"));
  // Post-dispose: exit hatches must not fire done().
  assert.doesNotThrow(() => comp.handleInput("\x03"));
  assert.strictEqual(doneCalled, 0, "exit hatch must not fire after dispose");
});

// ---------------------------------------------------------------------------
// dispose with throwing sink — slot cleanup must still run
// ---------------------------------------------------------------------------

test("dispose with throwing sink.release still deletes Kitty images and unlinks raw files", () => {
  const { tui, written } = makeMockTui(40);
  // press succeeds (button becomes held); release throws like a destroyed
  // emulator — dispose must survive it and still clean up the slots.
  const throwingSink: ButtonSink = {
    press() {},
    release() { throw new Error("Emulator has no ROM loaded"); },
  };
  const comp = makeComponent(throwingSink, tui);
  const id = comp.__getImageId()!;

  comp.render(80);
  comp.acceptFrame(makeGreenRgba(OUT_W, OUT_H), OUT_W, OUT_H);
  comp.handleInput("z"); // hold "a" so dispose attempts sink.release

  // The pinned transmit carries the raw file path (base64, t=f transport).
  const pin = written.find((w) => w.includes("\x1b_Ga=T"));
  assert.ok(pin !== undefined, "frame must be pinned before dispose");
  const rawPath = Buffer.from(pin!.match(/;([A-Za-z0-9+/=]+)\x1b\\/)![1]!, "base64").toString("utf8");
  assert.ok(existsSync(rawPath), "raw frame file must exist before dispose");

  assert.doesNotThrow(() => comp.dispose());

  // Slot cleanup must have run despite the throwing release.
  const deleteSeqs = written.filter((s) => s.includes(`i=${id}`) && s.includes("a=d"));
  assert.ok(deleteSeqs.length >= 1, `deleteKittyImage(${id}) must be emitted`);
  assert.ok(!existsSync(rawPath), "raw frame file must be unlinked despite throwing sink");
  assert.strictEqual(comp.__getImageId(), undefined, "imageId must be cleared after dispose");
});

// ---------------------------------------------------------------------------
// Write-hook: foreign terminal writes are chased by a re-pin; dispose unhooks
// ---------------------------------------------------------------------------

test("write-hook: pi-tui flush triggers immediate re-pin; dispose restores write", () => {
  const { sink } = makeMockSink();
  const { tui, written } = makeMockTui(40);
  const comp = makeComponent(sink, tui);

  comp.render(80);
  comp.acceptFrame(makeGreenRgba(OUT_W, OUT_H), OUT_W, OUT_H);
  const pinsAfterFrame = written.filter((w) => w.includes("\x1b_Ga=T")).length;
  assert.ok(pinsAfterFrame >= 1, "first frame pinned");

  // Simulate a pi-tui flush (e.g. streaming repaint) through the wrapped write.
  (tui.terminal as unknown as { write: (d: string) => void }).write("chat repaint bytes");
  const pinsAfterForeign = written.filter((w) => w.includes("\x1b_Ga=T")).length;
  assert.equal(pinsAfterForeign, pinsAfterFrame + 1, "foreign write chased by exactly one re-pin");
  assert.ok(written.includes("chat repaint bytes"), "foreign bytes still pass through");

  // Re-pin alternates the double-buffer slot: the chase pin must use the
  // OTHER image id than the previous pin.
  const pins = written.filter((w) => w.includes("\x1b_Ga=T"));
  const idOf = (s: string) => s.match(/,i=(\d+),/)?.[1];
  assert.notEqual(idOf(pins[pins.length - 1]!), idOf(pins[pins.length - 2]!),
    "chase pin swaps to the other buffer id");

  comp.dispose();
  const before = written.length;
  (tui.terminal as unknown as { write: (d: string) => void }).write("after dispose");
  const newWrites = written.slice(before);
  assert.deepEqual(newWrites, ["after dispose"], "write restored — no chase pin after dispose");
});
