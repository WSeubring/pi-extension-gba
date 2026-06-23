/**
 * Tests for PI_GBA_MINIMAL=1 activation path (src/minimal-activate.ts).
 *
 * wireMinimal is the dependency-injected seam; it skips createEmulator +
 * resolveConfig + detectCapabilities so node --test can exercise the wiring
 * without loading the mGBA WASM module.
 *
 * InputOverlayComponent is exported for direct unit testing of input routing,
 * dispose behaviour, and exit keys.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { wireMinimal, InputOverlayComponent } from "../src/minimal-activate.js";
import { createMockPi } from "./harness/mock-pi.js";
import { createMockCtx } from "./harness/mock-ctx.js";
import type { GbaConfig } from "../src/config.js";
import type { Emulator } from "../src/emulator.js";
import type { Persistence } from "../src/persistence.js";
import type { RenderControllerWithSwap } from "../src/render.js";
import type { ButtonSink, GbaButton } from "../src/types.js";

// ---------------------------------------------------------------------------
// Minimal stubs — only what wireMinimal + registerAll touch.
// ---------------------------------------------------------------------------

function makeEmulator(): Emulator & { destroyed: number } {
  let destroyed = 0;
  const emu = {
    step(_n: number) {},
    getFramebuffer() { return new Uint8Array(240 * 160 * 4); },
    press(_b: string) {},
    release(_b: string) {},
    onCrash(_h: (err: Error) => void) {},
    destroy() { destroyed++; },
    loadRom(_b: Uint8Array) {},
    saveState(): Uint8Array { return new Uint8Array(0); },
    loadState(_b: Uint8Array) {},
    get destroyed() { return destroyed; },
  };
  return emu as unknown as Emulator & { destroyed: number };
}

function makePersistence(roms: string[], lastPlayed?: string): Persistence & {
  destroyCount: number;
  flushPendingCount: number;
  snapshotCount: number;
} {
  let current: string | undefined;
  let destroyCount = 0;
  let flushPendingCount = 0;
  let snapshotCount = 0;
  const p = {
    async loadRom(basename: string) {
      current = basename;
      return { romPath: `/roms/${basename}`, restoredState: false };
    },
    async snapshot() { snapshotCount++; },
    async flushPending() { flushPendingCount++; },
    async listRoms() { return roms; },
    async lastPlayed() { return lastPlayed; },
    currentRom() { return current; },
    async clearState() {},
    destroy() { destroyCount++; },
    get destroyCount() { return destroyCount; },
    get flushPendingCount() { return flushPendingCount; },
    get snapshotCount() { return snapshotCount; },
  };
  return p as unknown as Persistence & {
    destroyCount: number;
    flushPendingCount: number;
    snapshotCount: number;
  };
}

function makeConfig(): GbaConfig {
  return {
    version: 1,
    romDir: "/roms",
    scale: 2,
    frameRate: 30,
    autoRunOnAgentStart: true,
    autoHideOnAgentEnd: false,
    autoFocusOnAgentStart: true,
    autoFocusDebounceMs: 0,
    audio: false,
  } as GbaConfig;
}

function makeFakeRenderer(): { controller: RenderControllerWithSwap; calls: string[] } {
  const calls: string[] = [];
  const controller = {
    start() { calls.push("start"); },
    stop() { calls.push("stop"); },
    shrink() { calls.push("shrink"); },
    expand() { calls.push("expand"); },
    hide() { calls.push("hide"); },
    destroy() { calls.push("destroy"); },
    onRenderError() { return () => {}; },
    __testGetImageId() { return undefined; },
    useBackend(_k: "widget" | "custom") {},
    activeBackend(): "widget" | "custom" { return "custom"; },
    setCustomComponent(_c: unknown) { calls.push("setCustomComponent"); },
    showStillFrame() {},
    setWidgetLiveTick(_e: boolean) {},
  } as RenderControllerWithSwap;
  return { controller, calls };
}

/** A minimal ButtonSink that records press/release calls. */
function makeMockSink(): {
  sink: ButtonSink;
  pressed: GbaButton[];
  released: GbaButton[];
} {
  const pressed: GbaButton[] = [];
  const released: GbaButton[] = [];
  const sink: ButtonSink = {
    press(button) { pressed.push(button); },
    release(button) { released.push(button); },
  };
  return { sink, pressed, released };
}

// ---------------------------------------------------------------------------
// Scenario 1 — /gba <rom> → widget renderer created + started; session_shutdown
// destroys emulator exactly once (idempotent).
// ---------------------------------------------------------------------------

test("minimal mode: /gba <rom> starts widget renderer, shutdown cleans up", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCtx();
  const emulator = makeEmulator();
  const persistence = makePersistence(["pokemon.gba"]);
  const cfg = makeConfig();
  const rendererHandle = makeFakeRenderer();
  let createRendererCalls = 0;
  let lastBackend: string | undefined;

  wireMinimal(
    mockPi.pi,
    { emulator, persistence, cfg, caps: { kittyGraphics: true, audioBackend: undefined } },
    {
      createRenderer: ((_ctx: unknown, _emu: unknown, opts: { initialBackend?: string }) => {
        createRendererCalls++;
        lastBackend = opts?.initialBackend;
        return rendererHandle.controller;
      }) as unknown as typeof import("../src/render.js").createRenderer,
    },
  );

  assert.ok(mockPi.commands.find((c) => c.name === "gba"), "/gba command registered");
  assert.ok(mockPi.events.some((e) => e.event === "session_shutdown"), "session_shutdown registered");

  await mockPi.invokeCommand("gba", "pokemon", mockCtx.ctx);

  assert.equal(createRendererCalls, 1, "renderer created exactly once per entry");
  assert.equal(lastBackend, "widget", "widget backend selected");
  assert.ok(rendererHandle.calls.includes("start"), "renderer started");

  await mockPi.emit("session_shutdown", { type: "session_shutdown" }, mockCtx.ctx);
  assert.ok(rendererHandle.calls.includes("destroy"), "renderer destroyed on shutdown");
  assert.equal(emulator.destroyed, 1, "emulator.destroy called exactly once");
  assert.equal(persistence.destroyCount, 1, "persistence.destroy called on shutdown");
  assert.ok(persistence.snapshotCount >= 1, "persistence.snapshot called on shutdown (save-state not lost)");

  await mockPi.emit("session_shutdown", { type: "session_shutdown" }, mockCtx.ctx);
  assert.equal(emulator.destroyed, 1, "emulator.destroy still exactly once after second shutdown");
});

// session_shutdown snapshot is best-effort — a rejecting snapshot must not
// prevent flushPending / destroy from running.
test("minimal mode: shutdown survives snapshot failure, still flushes + destroys", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCtx();
  const emulator = makeEmulator();
  const persistence = makePersistence(["pokemon.gba"]);
  (persistence as { snapshot: () => Promise<void> }).snapshot = async () => {
    throw new Error("snapshot exploded");
  };
  const cfg = makeConfig();

  wireMinimal(
    mockPi.pi,
    { emulator, persistence, cfg, caps: { kittyGraphics: true, audioBackend: undefined } },
    {},
  );

  await mockPi.emit("session_shutdown", { type: "session_shutdown" }, mockCtx.ctx);

  assert.equal(persistence.flushPendingCount, 1, "flushPending still runs after snapshot failure");
  assert.equal(persistence.destroyCount, 1, "persistence.destroy still runs after snapshot failure");
  assert.equal(emulator.destroyed, 1, "emulator.destroy still runs after snapshot failure");
});

// ---------------------------------------------------------------------------
// Scenario 2 — re-invoking /gba tears down prior renderer before creating the
// next; minimal mode registers alt+g but NOT alt+m.
// ---------------------------------------------------------------------------

test("minimal mode: re-invoking /gba disposes prior renderer", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCtx();
  const emulator = makeEmulator();
  const persistence = makePersistence(["pokemon.gba"], "pokemon.gba");
  const cfg = makeConfig();

  const handles: Array<ReturnType<typeof makeFakeRenderer>> = [];

  wireMinimal(
    mockPi.pi,
    { emulator, persistence, cfg, caps: { kittyGraphics: true, audioBackend: undefined } },
    {
      createRenderer: ((_ctx: unknown, _emu: unknown, _opts: unknown) => {
        const h = makeFakeRenderer();
        handles.push(h);
        return h.controller;
      }) as unknown as typeof import("../src/render.js").createRenderer,
    },
  );

  await mockPi.invokeCommand("gba", "mute", mockCtx.ctx);
  assert.ok(
    mockCtx.notifyCalls.some((n) => n.message.includes("audio not enabled")),
    "audio disabled in minimal mode",
  );

  await mockPi.invokeCommand("gba", "", mockCtx.ctx);
  await mockPi.invokeCommand("gba", "", mockCtx.ctx);

  assert.equal(handles.length, 2, "two renderers created across two /gba invocations");
  assert.ok(handles[0]!.calls.includes("destroy"), "first renderer destroyed before second starts");
  assert.ok(handles[1]!.calls.includes("start"), "second renderer started");

  const altM = mockPi.shortcuts.find((s) => s.keyId === "alt+m");
  assert.equal(altM, undefined, "alt+m shortcut NOT registered in minimal mode");

  // B1: alt+g IS registered (pivot to widget-only + overlay per ADR 0007).
  const altG = mockPi.shortcuts.find((s) => s.keyId === "alt+g");
  assert.ok(altG, "alt+g shortcut registered for input overlay");
  assert.equal(typeof altG.handler, "function", "alt+g handler is a function");
  assert.ok(
    altG.description?.includes("GBA"),
    "alt+g description mentions GBA",
  );
});

// ---------------------------------------------------------------------------
// Overlay handler tests — drive InputOverlayComponent directly.
// ---------------------------------------------------------------------------

// Overlay no-ops when activeRender is undefined (no ROM loaded).
test("overlay handler: no-ops when no ROM loaded, notifies user", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCtx();
  const emulator = makeEmulator();
  const persistence = makePersistence([]);
  const cfg = makeConfig();

  wireMinimal(
    mockPi.pi,
    { emulator, persistence, cfg, caps: { kittyGraphics: true, audioBackend: undefined } },
    {},
  );

  // Do NOT invoke /gba — activeRender stays undefined.
  await mockPi.pressShortcut("alt+g", mockCtx.ctx);

  // ctx.ui.notify must have been called.
  assert.ok(
    mockCtx.notifyCalls.some((n) => n.message.includes("no ROM loaded")),
    "notify called with 'no ROM loaded' message",
  );
  // ctx.ui.custom must NOT have been called.
  assert.equal(mockCtx.customCalls.length, 0, "ctx.ui.custom not called when no ROM loaded");
});

// Overlay handler with activeRender present invokes ctx.ui.custom with overlay:true.
test("overlay handler: invokes ctx.ui.custom with overlay:true when ROM loaded", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCtx();
  const emulator = makeEmulator();
  const persistence = makePersistence(["pokemon.gba"]);
  const cfg = makeConfig();
  const rendererHandle = makeFakeRenderer();

  wireMinimal(
    mockPi.pi,
    { emulator, persistence, cfg, caps: { kittyGraphics: true, audioBackend: undefined } },
    {
      createRenderer: ((_ctx: unknown, _emu: unknown, _opts: unknown) =>
        rendererHandle.controller
      ) as unknown as typeof import("../src/render.js").createRenderer,
    },
  );

  // Load a ROM so activeRender is set.
  await mockPi.invokeCommand("gba", "pokemon", mockCtx.ctx);

  // Press alt+g — do NOT await (it won't resolve until done() is called).
  void mockPi.pressShortcut("alt+g", mockCtx.ctx);

  // Give the microtask queue a tick so factory runs synchronously.
  await Promise.resolve();

  assert.equal(mockCtx.customCalls.length, 1, "ctx.ui.custom called once");
  const call = mockCtx.customCalls[0]!;
  assert.ok(call.options, "custom called with options");
  const opts = call.options as { overlay?: boolean; overlayOptions?: unknown };
  assert.equal(opts.overlay, true, "overlay: true passed");
  assert.ok(opts.overlayOptions, "overlayOptions passed");
});

// ---------------------------------------------------------------------------
// InputOverlayComponent direct unit tests
// ---------------------------------------------------------------------------

// Press "z" → sink.press("a") called once.
test("InputOverlayComponent: handleInput('z') → sink.press('a')", () => {
  const { sink, pressed } = makeMockSink();
  let doneCalled = 0;
  const comp = new InputOverlayComponent(sink, () => { doneCalled++; });

  comp.handleInput("z");

  assert.deepEqual(pressed, ["a"], "sink.press('a') called for 'z'");
  assert.equal(doneCalled, 0, "done not called");
  comp.dispose();
});

// Kitty CSI-u release of z (key code 122, event type 3) → sink.release("a").
test("InputOverlayComponent: Kitty CSI-u release of z → sink.release('a')", () => {
  const { sink, pressed, released } = makeMockSink();
  const comp = new InputOverlayComponent(sink, () => {});

  // Press z first so it's tracked as held.
  comp.handleInput("z");
  assert.deepEqual(pressed, ["a"]);

  // Synthesise Kitty CSI-u key-release for 'z' (codepoint 122, modifier 1, event type 3).
  comp.handleInput("\x1b[122;1:3u");

  assert.deepEqual(released, ["a"], "sink.release('a') called on Kitty release event");
  comp.dispose();
});

// dispose() releases all held buttons.
test("InputOverlayComponent: dispose() releases all held buttons", () => {
  const { sink, released } = makeMockSink();
  const comp = new InputOverlayComponent(sink, () => {});

  comp.handleInput("z"); // presses "a"
  comp.handleInput("x"); // presses "b"
  comp.dispose();

  assert.ok(released.includes("a"), "dispose releases held 'a'");
  assert.ok(released.includes("b"), "dispose releases held 'b'");
});

// Exit key: ctrl+c (\x03) calls done exactly once.
test("InputOverlayComponent: ctrl+c (raw \\x03) calls done", () => {
  const { sink } = makeMockSink();
  let doneCalled = 0;
  const comp = new InputOverlayComponent(sink, () => { doneCalled++; });

  comp.handleInput("\x03");

  assert.equal(doneCalled, 1, "done called once for ctrl+c");
  comp.dispose();
});

// Exit key: escape (\x1b) calls done exactly once.
test("InputOverlayComponent: escape (raw \\x1b) calls done", () => {
  const { sink } = makeMockSink();
  let doneCalled = 0;
  const comp = new InputOverlayComponent(sink, () => { doneCalled++; });

  comp.handleInput("\x1b");

  assert.equal(doneCalled, 1, "done called once for escape");
  comp.dispose();
});

// Exit key: "q" calls done exactly once.
test("InputOverlayComponent: 'q' calls done", () => {
  const { sink } = makeMockSink();
  let doneCalled = 0;
  const comp = new InputOverlayComponent(sink, () => { doneCalled++; });

  comp.handleInput("q");

  assert.equal(doneCalled, 1, "done called once for 'q'");
  comp.dispose();
});

// Exit key: alt+g calls done exactly once.
// Legacy alt+g = ESC followed by 'g' = "\x1bg".
test("InputOverlayComponent: alt+g (\\x1bg) calls done", () => {
  const { sink } = makeMockSink();
  let doneCalled = 0;
  const comp = new InputOverlayComponent(sink, () => { doneCalled++; });

  comp.handleInput("\x1bg");

  assert.equal(doneCalled, 1, "done called once for alt+g");
  comp.dispose();
});

// Press is idempotent: pressing "z" twice without release calls sink.press only once.
test("InputOverlayComponent: press is idempotent — second press without release is swallowed", () => {
  const { sink, pressed } = makeMockSink();
  const comp = new InputOverlayComponent(sink, () => {});

  comp.handleInput("z");
  comp.handleInput("z"); // repeat — should be ignored since "a" is already held

  assert.deepEqual(pressed, ["a"], "sink.press called only once for double z");
  comp.dispose();
});

// overlayActive guard: second alt+g while overlay is open must NOT invoke ctx.ui.custom again.
test("overlayActive guard: second alt+g does not open a second overlay", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCtx();
  const emulator = makeEmulator();
  const persistence = makePersistence(["pokemon.gba"]);
  const cfg = makeConfig();
  const rendererHandle = makeFakeRenderer();

  wireMinimal(
    mockPi.pi,
    { emulator, persistence, cfg, caps: { kittyGraphics: true, audioBackend: undefined } },
    {
      createRenderer: ((_ctx: unknown, _emu: unknown, _opts: unknown) =>
        rendererHandle.controller
      ) as unknown as typeof import("../src/render.js").createRenderer,
    },
  );

  await mockPi.invokeCommand("gba", "pokemon", mockCtx.ctx);

  // Fire alt+g twice without resolving the first.
  void mockPi.pressShortcut("alt+g", mockCtx.ctx);
  void mockPi.pressShortcut("alt+g", mockCtx.ctx);

  // Give microtasks a chance to run.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    mockCtx.customCalls.length,
    1,
    "ctx.ui.custom called only once despite two alt+g presses",
  );

  // Resolve the first overlay by sending an exit key to the component.
  // The component's handleInput("q") calls done() which resolves ctx.ui.custom
  // and triggers the finally block that resets overlayActive.
  const firstCall = mockCtx.customCalls[0]!;
  const comp = firstCall.component as { handleInput(data: string): void } | undefined;
  comp?.handleInput("q");

  // After overlay is closed (overlayActive resets), a third press should work.
  // Use setTimeout(0) to let the Promise chain in wireMinimal's finally settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  void mockPi.pressShortcut("alt+g", mockCtx.ctx);
  await Promise.resolve();

  assert.equal(
    mockCtx.customCalls.length,
    2,
    "after first overlay resolves, alt+g opens a new overlay",
  );
});

// B3: ctx.ui.custom throwing should call ctx.ui.notify with error message.
test("overlay handler: ctx.ui.custom rejection notifies user with error", async () => {
  const mockPi = createMockPi();
  const emulator = makeEmulator();
  const persistence = makePersistence(["pokemon.gba"]);
  const cfg = makeConfig();
  const rendererHandle = makeFakeRenderer();

  // Build a mock ctx where custom() rejects.
  const notifyCalls: Array<{ message: string; type?: string }> = [];

  // Create an ExtensionCommandContext-like mock with a throwing custom.
  const throwingCtx = {
    ui: {
      notify(message: string, type?: string) { notifyCalls.push({ message, type }); },
      async custom(): Promise<never> { throw new Error("overlay exploded"); },
      setWidget() {},
    },
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: {},
    modelRegistry: {},
    model: undefined,
    isIdle() { return true; },
    signal: undefined,
    abort() {},
    hasPendingMessages() { return false; },
    shutdown() {},
    getContextUsage() { return undefined; },
    compact() {},
    getSystemPrompt() { return ""; },
    async waitForIdle() {},
    async newSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async navigateTree() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async reload() {},
  } as unknown as import("@mariozechner/pi-coding-agent").ExtensionCommandContext;

  wireMinimal(
    mockPi.pi,
    { emulator, persistence, cfg, caps: { kittyGraphics: true, audioBackend: undefined } },
    {
      createRenderer: ((_ctx: unknown, _emu: unknown, _opts: unknown) =>
        rendererHandle.controller
      ) as unknown as typeof import("../src/render.js").createRenderer,
    },
  );

  // Load ROM using normal ctx so activeRender is set.
  const mockCtx = createMockCtx();
  await mockPi.invokeCommand("gba", "pokemon", mockCtx.ctx);

  // Now press alt+g with the throwing ctx.
  await mockPi.pressShortcut("alt+g", throwingCtx);

  assert.ok(
    notifyCalls.some(
      (n) => n.message.includes("overlay failed") && n.type === "error",
    ),
    "error notify emitted when ctx.ui.custom rejects",
  );
});
