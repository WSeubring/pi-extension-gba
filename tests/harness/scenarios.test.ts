/**
 * Phase 10a — Harness scenario tests.
 *
 * 6 end-to-end scenarios driving the extension through createMockPi +
 * createMockCtx without a live terminal or pi binary.
 *
 * Design ref: docs/design/phase-10-feedback-loop.md §10a
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { createMockPi } from "./mock-pi.js";
import { createMockCtx } from "./mock-ctx.js";
import { GbaGameComponent } from "../../src/game-component.js";
import { createAutoFocus } from "../../src/auto-focus.js";
import type { AutoFocusDeps } from "../../src/auto-focus.js";
import { registerAll } from "../../src/commands.js";
import type { CommandDeps } from "../../src/commands.js";
import { loadConfigFile, popQueuedWarning, getConfigPath, normalize } from "../../src/config.js";
import type { AudioPlayer } from "../../src/audio.js";
import type { Emulator } from "../../src/emulator.js";
import type { Persistence } from "../../src/persistence.js";
import type { Lifecycle, RenderController } from "../../src/lifecycle.js";
import type { RenderControllerWithSwap } from "../../src/render.js";
import type { ButtonSink } from "../../src/types.js";
import type { TUI, Component } from "@mariozechner/pi-tui";
import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Emulator stub — minimal surface consumed by auto-focus + lifecycle + render.
// ---------------------------------------------------------------------------

function makeMockEmulator() {
  let crashHandler: ((err: Error) => void) | undefined;
  const pressedButtons: string[] = [];
  const releasedButtons: string[] = [];

  return {
    // EmulatorLike
    step(_frames: number) {},
    getFramebuffer(): Uint8Array {
      return new Uint8Array(240 * 160 * 4);
    },
    // ButtonSink
    press(button: string) { pressedButtons.push(button); },
    release(button: string) { releasedButtons.push(button); },
    // Emulator extras
    onCrash(handler: (err: Error) => void) { crashHandler = handler; },
    destroy() {},
    loadRom(_bytes: Uint8Array) {},
    saveState(): Uint8Array { return new Uint8Array(0); },
    loadState(_bytes: Uint8Array) {},
    // Test helpers
    _simulateCrash(msg = "crash") { crashHandler?.(new Error(msg)); },
    pressedButtons,
    releasedButtons,
  };
}

// ---------------------------------------------------------------------------
// Render controller stub
// ---------------------------------------------------------------------------

function makeMockRender() {
  let backend: "widget" | "custom" = "widget";
  let liveComponent: { acceptFrame(r: Uint8Array, w: number, h: number): void; dispose(): void } | undefined;
  const calls: string[] = [];

  return {
    start() { calls.push("start"); },
    stop() { calls.push("stop"); },
    shrink() { calls.push("shrink"); },
    expand() { calls.push("expand"); },
    hide() { calls.push("hide"); },
    destroy() { calls.push("destroy"); },
    onRenderError() { return () => {}; },
    __testGetImageId() { return undefined; },
    useBackend(kind: "widget" | "custom") { backend = kind; calls.push(`useBackend:${kind}`); },
    activeBackend() { return backend; },
    setCustomComponent(component: typeof liveComponent) { liveComponent = component; },
    showStillFrame() { calls.push("showStillFrame"); },
    setWidgetLiveTick(_enabled: boolean) {},
    _getLiveComponent() { return liveComponent; },
    _calls() { return calls; },
  };
}

// ---------------------------------------------------------------------------
// Persistence stub
// ---------------------------------------------------------------------------

function makeMockPersistence(lastPlayedRom: string | undefined, roms: string[]) {
  let currentRomBasename: string | undefined;

  return {
    async loadRom(basename: string) {
      currentRomBasename = basename;
      return { romPath: `/roms/${basename}`, restoredState: false };
    },
    async snapshot() {},
    async flushPending() {},
    async listRoms() { return roms; },
    async lastPlayed() { return lastPlayedRom; },
    currentRom() { return currentRomBasename; },
    async clearState() {},
    destroy() {},
  };
}

// ---------------------------------------------------------------------------
// Lifecycle stub
// ---------------------------------------------------------------------------

function makeMockLifecycle(opts: { isRunning?: boolean } = {}) {
  let running = opts.isRunning ?? false;
  const calls: string[] = [];

  return {
    attach() { calls.push("attach"); },
    detach() { calls.push("detach"); },
    manualPauseToggle() { calls.push("manualPauseToggle"); },
    isRunning() { return running; },
    onRomLoad() { running = true; calls.push("onRomLoad"); },
    isCrashed() { return false; },
    acknowledgeCrash() {},
    _calls() { return calls; },
    _setRunning(v: boolean) { running = v; },
  };
}

// ---------------------------------------------------------------------------
// Audio stub
// ---------------------------------------------------------------------------

function makeMockAudio() {
  const calls: string[] = [];
  let muted = false;

  return {
    async start() { calls.push("start"); },
    async stop() { calls.push("stop"); },
    writeSamples(_pcm: Int16Array) {},
    mute() { muted = true; calls.push("mute"); },
    unmute() { muted = false; calls.push("unmute"); },
    isMuted() { return muted; },
    onCrash(_handler: (err: Error) => void) { return () => {}; },
    _calls() { return calls; },
  };
}

// ---------------------------------------------------------------------------
// Flush helper for async debounce / microtask queues
// ---------------------------------------------------------------------------

/** Drains the setImmediate queue n times. */
async function flushImmediate(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((res) => setImmediate(res));
  }
}

/**
 * Waits at least `ms` milliseconds plus drains the immediate queue.
 * Use this whenever code under test schedules setTimeout (e.g. debounce).
 */
async function flushAsync(ms = 10): Promise<void> {
  await new Promise<void>((res) => setTimeout(res, ms));
  await flushImmediate(5);
}

// ---------------------------------------------------------------------------
// Helper: build a fake TUI for component tests
// ---------------------------------------------------------------------------

function makeFakeTui(rows = 40, cols = 80): TUI {
  return {
    requestRender() {},
    terminal: { rows, cols, write(_s: string) {} },
  } as unknown as TUI;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Cold start → /gba (no last-played) → picker → pick ROM →
//              auto-enter game mode → acceptFrame → render → ctrl+c → done
// ---------------------------------------------------------------------------

test("scenario 1: cold-start /gba → picker → game mode → ctrl+c exits", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCtx();
  const emulator = makeMockEmulator();
  const lifecycle = makeMockLifecycle();
  const audio = makeMockAudio();
  const render = makeMockRender();

  const ROM = "pokemon.gba";
  const persistence = makeMockPersistence(undefined, [ROM]);

  // We'll intercept calls to ctx.ui.custom in order:
  // call 0 = showRomPicker (SelectList) → immediately fire done with our ROM
  // call 1 = game mode entry → capture the component for interaction
  let customCallIndex = 0;
  let capturedComponent:
    | (Component & {
        acceptFrame(rgba: Uint8Array, w: number, h: number): void;
        handleInput(data: string): void;
        render(width: number): string[];
      })
    | undefined;
  let gameModeResolved = false;

  (mockCtx.ctx.ui as unknown as { custom: unknown }).custom = <T>(
    factory: (tui: TUI, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
    _options?: unknown,
  ): Promise<T> => {
    const callIdx = customCallIndex++;

    if (callIdx === 0) {
      // Picker call — call the factory and immediately fire done with selected ROM.
      return new Promise<T>((resolve) => {
        const done = (result: T) => resolve(result);
        const list = factory(makeFakeTui(), { fg: (_n: string, t: string) => t }, {}, done) as {
          onSelect?: (item: { value: string; label: string }) => void;
        };
        list?.onSelect?.({ value: ROM, label: ROM });
      });
    }

    // call 1 = game mode
    return new Promise<T>((resolve) => {
      const done = (result: T) => {
        gameModeResolved = true;
        resolve(result);
      };
      const comp = factory(makeFakeTui(), {}, {}, done) as typeof capturedComponent;
      capturedComponent = comp;
    });
  };

  const autoFocus = createAutoFocus({
    pi: mockPi.pi,
    get render() { return render as unknown as RenderControllerWithSwap; },
    emulator: emulator as unknown as AutoFocusDeps["emulator"],
    lifecycle: lifecycle as unknown as Lifecycle,
    getCtx: () => undefined,
    cfg: { autoFocusOnAgentStart: true, autoFocusDebounceMs: 0, scale: 2 },
    caps: { kittyGraphics: true },
    notifyUnsupported: () => {},
    audio: audio as unknown as AudioPlayer,
  });
  autoFocus.attach();

  registerAll(mockPi.pi, {
    emulator: emulator as unknown as Emulator,
    persistence: persistence as unknown as Persistence,
    lifecycle: lifecycle as unknown as Lifecycle,
    ensureRender: () => render as unknown as RenderController,
    cfg: {
      version: 1,
      romDir: "/roms",
      scale: 2,
      frameRate: 30,
      autoRunOnAgentStart: true,
      autoHideOnAgentEnd: false,
      autoFocusOnAgentStart: true,
      autoFocusDebounceMs: 0,
      audio: false,
    },
    caps: { kittyGraphics: true },
    notifyUnsupported: () => {},
    audio: audio as unknown as AudioPlayer,
    enterGameMode: (ctx: ExtensionContext) => autoFocus.enterManual(ctx),
  } as unknown as CommandDeps);

  assert.ok(mockPi.commands.some((c) => c.name === "gba"), "/gba command registered");

  // Invoke /gba with no args — no last-played → open picker.
  const commandPromise = mockPi.invokeCommand("gba", "", mockCtx.ctx);

  // Picker is synchronously resolved in our custom mock; the game mode enters
  // next. Give the microtask queue time to work.
  await flushAsync(20);

  // The command awaits enterGameMode. We need to let the game mode resolve.
  // capturedComponent should exist by now.
  assert.ok(capturedComponent !== undefined, "game component was created");

  // Simulate a frame tick.
  const rgba = new Uint8Array(480 * 320 * 4).fill(128);
  capturedComponent!.acceptFrame(rgba, 480, 320);

  // Render should now return > 1 row (empty spacers + image line).
  const rendered = capturedComponent!.render(80);
  assert.ok(rendered.length > 1, `render returned ${rendered.length} rows (expected > 1)`);

  // Exit via ctrl+c.
  assert.equal(gameModeResolved, false, "not yet resolved before ctrl+c");
  capturedComponent!.handleInput("\x03");
  assert.equal(gameModeResolved, true, "done() called after ctrl+c");

  await commandPromise;

  // Audio should have been stopped on exit.
  assert.ok(audio._calls().includes("stop"), "audio.stop called on exit");
});

// ---------------------------------------------------------------------------
// Scenario 2 — ROM loaded → agent_start → game mode mounts → agent_end → auto-exit
// ---------------------------------------------------------------------------

test("scenario 2: agent_start → game mode → agent_end → auto-exit", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCtx();
  const emulator = makeMockEmulator();
  const render = makeMockRender();
  const lifecycle = makeMockLifecycle({ isRunning: false });
  const audio = makeMockAudio();

  let gameDoneCount = 0;
  let capturedGameComponent: { requestClose?(): void } | undefined;

  (mockCtx.ctx.ui as unknown as { custom: unknown }).custom = <T>(
    factory: (tui: TUI, theme: unknown, kb: unknown, done: (r: T) => void) => unknown,
  ): Promise<T> => {
    return new Promise<T>((resolve) => {
      const done = (r: T) => {
        gameDoneCount++;
        resolve(r);
      };
      const comp = factory(makeFakeTui(), {}, {}, done) as { requestClose?(): void };
      capturedGameComponent = comp;
    });
  };

  const autoFocus = createAutoFocus({
    pi: mockPi.pi,
    get render() { return render as unknown as RenderControllerWithSwap; },
    emulator: emulator as unknown as AutoFocusDeps["emulator"],
    lifecycle: lifecycle as unknown as Lifecycle,
    getCtx: () => undefined,
    cfg: { autoFocusOnAgentStart: true, autoFocusDebounceMs: 0, scale: 2 },
    caps: { kittyGraphics: true },
    notifyUnsupported: () => {},
    audio: audio as unknown as AudioPlayer,
  });
  autoFocus.attach();

  // Emit agent_start — game mode entry debounces with 0ms.
  await mockPi.emit("agent_start", { type: "agent_start" }, mockCtx.ctx);
  await flushAsync(10);

  assert.equal(autoFocus.isInGameMode(), true, "game mode active after agent_start");
  assert.ok(capturedGameComponent !== undefined, "game component created");

  // Emit agent_end — auto-exit should call requestClose → done.
  await mockPi.emit("agent_end", { type: "agent_end", messages: [] }, mockCtx.ctx);
  await flushAsync(5);

  assert.equal(gameDoneCount, 1, "done() called exactly once on auto-exit");
});

// ---------------------------------------------------------------------------
// Scenario 3 — alt+g manual entry while mode === "Paused"
// ---------------------------------------------------------------------------

test("scenario 3: alt+g manual entry when ROM loaded but Paused → game mode mounts", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCtx();
  const emulator = makeMockEmulator();
  const render = makeMockRender();
  const lifecycle = makeMockLifecycle({ isRunning: false });

  let customMounted = false;
  let capturedDone: (() => void) | undefined;

  (mockCtx.ctx.ui as unknown as { custom: unknown }).custom = <T>(
    factory: (tui: TUI, theme: unknown, kb: unknown, done: (r: T) => void) => unknown,
  ): Promise<T> => {
    customMounted = true;
    return new Promise<T>((resolve) => {
      const done = (r: T) => resolve(r);
      capturedDone = () => done(undefined as T);
      factory(makeFakeTui(), {}, {}, done);
    });
  };

  const autoFocus = createAutoFocus({
    pi: mockPi.pi,
    get render() { return render as unknown as RenderControllerWithSwap; },
    emulator: emulator as unknown as AutoFocusDeps["emulator"],
    lifecycle: lifecycle as unknown as Lifecycle,
    getCtx: () => undefined,
    cfg: { autoFocusOnAgentStart: true, autoFocusDebounceMs: 0, scale: 2 },
    caps: { kittyGraphics: true },
    notifyUnsupported: () => {},
    audio: undefined,
  });
  autoFocus.attach();

  // alt+g shortcut should be registered.
  assert.ok(
    mockPi.shortcuts.some((s) => s.keyId === "alt+g"),
    "alt+g shortcut registered",
  );

  // Press alt+g — render is available, mode is chat → should enter game mode.
  const enterPromise = mockPi.pressShortcut("alt+g", mockCtx.ctx);
  await flushAsync(5);

  assert.equal(customMounted, true, "ui.custom was called (game mode mounted)");
  assert.equal(autoFocus.isInGameMode(), true, "in game mode");

  // Clean up.
  capturedDone?.();
  await enterPromise;
  await flushAsync(3);
});

// ---------------------------------------------------------------------------
// Scenario 4 — alt+g exit via component.handleInput — all key variants
// ---------------------------------------------------------------------------

const EXIT_KEYS: Array<{ label: string; bytes: string }> = [
  { label: "matchesKey canonical alt+g", bytes: "\x1b[103;3u" },
  { label: "legacy ESC sequence \\x1bg", bytes: "\x1bg" },
  { label: "Kitty CSI-u \\x1b[103;3u", bytes: "\x1b[103;3u" },
  // 10c probe: Ghostty with Kitty keyboard flag 2 (report event types)
  // appends the event byte after a colon: press=1, repeat=2, release=3.
  { label: "Kitty CSI-u event-press \\x1b[103;3:1u", bytes: "\x1b[103;3:1u" },
  { label: "Kitty CSI-u event-repeat \\x1b[103;3:2u", bytes: "\x1b[103;3:2u" },
  // NOTE: the event-RELEASE encoding (\x1b[103;3:3u) deliberately does NOT
  // exit — when game mode is entered via the alt+g shortcut, the press is
  // consumed by the editor and the release lands in this component; exiting
  // on release made alt+g entry self-close instantly (observed in Ghostty).
  // Covered by the non-exit test below.
  // 10c probe: last-resort human fallback keys (10c).
  { label: "q (last-resort quit)", bytes: "q" },
  { label: "Q (shift+q last-resort)", bytes: "Q" },
  // 10c probe: raw ctrl+c byte regardless of Kitty state.
  { label: "ctrl+c (raw 0x03)", bytes: "\x03" },
  { label: "ctrl+c Kitty CSI-u \\x1b[99;5u", bytes: "\x1b[99;5u" },
  { label: "ctrl+c Kitty event-press \\x1b[99;5:1u", bytes: "\x1b[99;5:1u" },
  { label: "escape (raw)", bytes: "\x1b" },
  { label: "escape Kitty CSI-u \\x1b[27u", bytes: "\x1b[27u" },
];

for (const { label, bytes } of EXIT_KEYS) {
  test(`scenario 4 (${label}): handleInput → done called exactly once`, () => {
    let doneCount = 0;

    const fakeEmulator = {
      press(_b: string) {},
      release(_b: string) {},
    };

    const component = new GbaGameComponent(
      makeFakeTui(),
      {
        emulator: {},
        sink: fakeEmulator as unknown as ButtonSink,
        scale: 2,
      },
      () => { doneCount++; },
    );

    component.handleInput(bytes);
    assert.equal(doneCount, 1, `done called once after ${label}`);
  });
}

test("scenario 4 (release guard): alt+g key-RELEASE does NOT exit game mode", () => {
  let doneCount = 0;
  const component = new GbaGameComponent(
    makeFakeTui(),
    {
      emulator: {},
      sink: { press() {}, release() {} } as unknown as ButtonSink,
      scale: 2,
    },
    () => { doneCount++; },
  );

  component.handleInput("\x1b[103;3:3u"); // alt+g release (Kitty event type 3)
  assert.equal(doneCount, 0, "release must not close the component");
  component.handleInput("\x1b[103;3:1u"); // explicit press still exits
  assert.equal(doneCount, 1, "press still closes the component");
});

// ---------------------------------------------------------------------------
// Scenario 5 — PI_GBA_AUTO_FOCUS=0 → agent_start does NOT auto-enter
// ---------------------------------------------------------------------------

test("scenario 5: PI_GBA_AUTO_FOCUS=0 → agent_start skips auto-enter; alt+g still works", async () => {
  const savedEnv = process.env["PI_GBA_AUTO_FOCUS"];
  process.env["PI_GBA_AUTO_FOCUS"] = "0";

  try {
    const mockPi = createMockPi();
    const mockCtx = createMockCtx();
    const emulator = makeMockEmulator();
    const render = makeMockRender();
    const lifecycle = makeMockLifecycle({ isRunning: false });

    let autoCustomCalled = false;

    // First override: auto-enter check
    (mockCtx.ctx.ui as unknown as { custom: unknown }).custom = (): Promise<undefined> => {
      autoCustomCalled = true;
      return Promise.resolve(undefined);
    };

    const autoFocus = createAutoFocus({
      pi: mockPi.pi,
      get render() { return render as unknown as RenderControllerWithSwap; },
      emulator: emulator as unknown as AutoFocusDeps["emulator"],
      lifecycle: lifecycle as unknown as Lifecycle,
      getCtx: () => undefined,
      cfg: {
        autoFocusOnAgentStart: false, // PI_GBA_AUTO_FOCUS=0
        autoFocusDebounceMs: 0,
        scale: 2,
      },
      caps: { kittyGraphics: true },
      notifyUnsupported: () => {},
      audio: undefined,
    });
    autoFocus.attach();

    // agent_start should NOT trigger game mode.
    await mockPi.emit("agent_start", { type: "agent_start" }, mockCtx.ctx);
    await flushAsync(10);

    assert.equal(autoCustomCalled, false, "ui.custom NOT called when PI_GBA_AUTO_FOCUS=0");
    assert.equal(autoFocus.isInGameMode(), false, "not in game mode");

    // alt+g should still work manually.
    let manualMounted = false;
    let capturedDone: (() => void) | undefined;
    (mockCtx.ctx.ui as unknown as { custom: unknown }).custom = <T>(
      factory: (tui: TUI, theme: unknown, kb: unknown, done: (r: T) => void) => unknown,
    ): Promise<T> => {
      manualMounted = true;
      return new Promise<T>((resolve) => {
        const done = (r: T) => resolve(r);
        capturedDone = () => done(undefined as T);
        factory(makeFakeTui(), {}, {}, done);
      });
    };

    const altGPromise = mockPi.pressShortcut("alt+g", mockCtx.ctx);
    await flushAsync(5);
    assert.equal(manualMounted, true, "alt+g still works manually when PI_GBA_AUTO_FOCUS=0");

    capturedDone?.();
    await altGPromise;
  } finally {
    if (savedEnv === undefined) {
      delete process.env["PI_GBA_AUTO_FOCUS"];
    } else {
      process.env["PI_GBA_AUTO_FOCUS"] = savedEnv;
    }
  }
});

// ---------------------------------------------------------------------------
// Scenario 6 — Corrupt config on boot → .bak written, warning queued, defaults resolved
// ---------------------------------------------------------------------------

test("scenario 6: corrupt config file → .bak written + warning queued + defaults used", async () => {
  const configPath = getConfigPath();
  const bakPath = configPath + ".bak";

  // Backup any existing config.
  let existingConfig: string | undefined;
  try {
    existingConfig = await fsPromises.readFile(configPath, "utf8");
  } catch {
    existingConfig = undefined;
  }

  // Write corrupt JSON.
  const corruptContent = "{ not valid json!!! }}}";
  try {
    await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
  } catch { /* may already exist */ }
  await fsPromises.writeFile(configPath, corruptContent, "utf8");

  // Remove any stale .bak.
  try { await fsPromises.unlink(bakPath); } catch { /* ignore */ }

  // Clear any previously queued warning.
  popQueuedWarning();

  try {
    // Load config — detect corrupt JSON, backup, queue warning.
    const result = await loadConfigFile();

    assert.deepEqual(result, {}, "loadConfigFile returns {} on corrupt input");

    // Warning should be queued.
    const warning = popQueuedWarning();
    assert.ok(typeof warning === "string" && warning.length > 0, "warning queued");
    assert.ok(warning!.includes("gba.json.bak"), "warning mentions backup file");

    // .bak file should contain the corrupt content.
    const bakContent = await fsPromises.readFile(bakPath, "utf8");
    assert.equal(bakContent, corruptContent, ".bak contains original corrupt content");

    // normalize({}) returns defaults.
    const defaults = normalize({});
    assert.equal(defaults.scale, 2, "scale defaults to 2");
    assert.equal(defaults.frameRate, 30, "frameRate defaults to 30");
    assert.equal(typeof defaults.romDir, "string", "romDir is a string");
  } finally {
    // Restore.
    try { await fsPromises.unlink(bakPath); } catch { /* ignore */ }
    try { await fsPromises.unlink(configPath); } catch { /* ignore */ }
    if (existingConfig !== undefined) {
      await fsPromises.writeFile(configPath, existingConfig, "utf8");
    }
  }
});

// ---------------------------------------------------------------------------
// Scenario 7 (Bug 2 probe) — component render returns multi-row output
//                             only after acceptFrame. Pre-frame it returns
//                             a single empty row so pi allocates a 1-row slot,
//                             which is what the user actually saw in Ghostty.
// ---------------------------------------------------------------------------

test("scenario 7 (direct-pin): render is static scaffolding; no Kitty bytes in diff", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCtx();
  const emulator = makeMockEmulator();
  const render = makeMockRender();
  const lifecycle = makeMockLifecycle({ isRunning: false });
  const audio = makeMockAudio();

  let capturedComponent:
    | (Component & {
        acceptFrame(rgba: Uint8Array, w: number, h: number): void;
        render(width: number): string[];
      })
    | undefined;
  let capturedDone: (() => void) | undefined;

  (mockCtx.ctx.ui as unknown as { custom: unknown }).custom = <T>(
    factory: (tui: TUI, theme: unknown, kb: unknown, done: (r: T) => void) => unknown,
  ): Promise<T> => {
    return new Promise<T>((resolve) => {
      const done = (r: T) => resolve(r);
      capturedDone = () => done(undefined as T);
      capturedComponent = factory(makeFakeTui(), {}, {}, done) as typeof capturedComponent;
    });
  };

  const autoFocus = createAutoFocus({
    pi: mockPi.pi,
    get render() { return render as unknown as RenderControllerWithSwap; },
    emulator: emulator as unknown as AutoFocusDeps["emulator"],
    lifecycle: lifecycle as unknown as Lifecycle,
    getCtx: () => undefined,
    cfg: { autoFocusOnAgentStart: true, autoFocusDebounceMs: 0, scale: 2 },
    caps: { kittyGraphics: true },
    notifyUnsupported: () => {},
    audio: audio as unknown as AudioPlayer,
  });
  autoFocus.attach();

  await mockPi.emit("agent_start", { type: "agent_start" }, mockCtx.ctx);
  await flushAsync(10);
  assert.ok(capturedComponent !== undefined, "component created");

  // ---- Direct-pin contract: render() reserves full-height STATIC
  //      scaffolding immediately (so pi allocates the space before the
  //      first frame), and never embeds Kitty bytes — the placement is
  //      written straight to the terminal by acceptFrame instead.
  const beforeFrame = capturedComponent!.render(80);
  assert.ok(beforeFrame.length > 1, `pre-frame render returned ${beforeFrame.length} rows (expected full scaffolding)`);
  assert.ok(beforeFrame.every((l) => !l.includes("\x1b_G")), "pre-frame render carries no Kitty bytes");

  const rgba = new Uint8Array(480 * 320 * 4).fill(128);
  capturedComponent!.acceptFrame(rgba, 480, 320);
  const afterFrame = capturedComponent!.render(80);
  assert.deepEqual(afterFrame, beforeFrame, "render output is static across frames (diff never repaints it)");
  assert.ok(afterFrame.every((l) => !l.includes("\x1b_G")), "post-frame render still carries no Kitty bytes");

  capturedDone?.();
});

// ---------------------------------------------------------------------------
// Scenario 8 (Bug 1 extra probe) — matchesKey accepts all modern Ghostty
//                                    Kitty keyboard variants. Ensures the
//                                    regex-based parser does not reject the
//                                    event-typed forms (\x1b[103;3:1u etc.).
// ---------------------------------------------------------------------------

test("scenario 8 (bug 1): matchesKey recognizes all Kitty enhancement levels", async () => {
  const { matchesKey } = await import("@mariozechner/pi-tui");
  const altG = [
    "\x1bg",
    "\x1b[103;3u",
    "\x1b[103;3:1u",
    "\x1b[103;3:2u",
    "\x1b[103;3:3u",
  ];
  for (const b of altG) {
    assert.ok(matchesKey(b, "alt+g"), `matchesKey should accept ${JSON.stringify(b)} as alt+g`);
  }
  const ctrlC = [
    "\x03",
    "\x1b[99;5u",
    "\x1b[99;5:1u",
  ];
  for (const b of ctrlC) {
    assert.ok(matchesKey(b, "ctrl+c"), `matchesKey should accept ${JSON.stringify(b)} as ctrl+c`);
  }
  const esc = [
    "\x1b",
    "\x1b[27u",
    "\x1b[27;1u",
  ];
  for (const b of esc) {
    assert.ok(matchesKey(b, "escape"), `matchesKey should accept ${JSON.stringify(b)} as escape`);
  }
});

// ---------------------------------------------------------------------------
// Scenario 9 (Bug 3 probe) — audio tick cadence instrumentation.
//                             With PI_GBA_AUDIO_TRACE=1 the render tick logs
//                             per-tick stats; verifies the flag is honoured
//                             without breaking the silent path.
// ---------------------------------------------------------------------------

test("scenario 9 (bug 3): PI_GBA_AUDIO_TRACE=1 emits per-tick stats to stderr", async () => {
  const savedFlag = process.env["PI_GBA_AUDIO_TRACE"];
  process.env["PI_GBA_AUDIO_TRACE"] = "1";

  const savedStderr = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    captured.push(s);
    return true;
  };

  try {
    const { createRenderer } = await import("../../src/render.js");

    // Minimal ctx stub for createRenderer.
    const ctx = {
      ui: {
        setWidget: () => {},
      },
    } as unknown as ExtensionContext;

    // Fake emulator with getAudioSamples so audio branch executes.
    const pcm = new Int16Array(512);
    const fakeEmulator = {
      step: (_n: number) => {},
      getFramebuffer: () => new Uint8Array(240 * 160 * 4),
      getAudioSamples: (_max: number) => pcm,
    };

    const fakeAudio: AudioPlayer = {
      async start() {},
      async stop() {},
      writeSamples(_p: Int16Array) {},
      mute() {},
      unmute() {},
      isMuted() { return false; },
      onCrash() { return () => {}; },
    };

    const ctrl = createRenderer(ctx, fakeEmulator, {
      scale: 1, frameRate: 30, initialBackend: "custom", audio: fakeAudio,
    });

    // Wire a dummy component so pushFrame does not no-op.
    ctrl.setCustomComponent({
      acceptFrame: () => {},
      dispose: () => {},
      __getImageId: () => undefined,
    });

    ctrl.start();
    await flushAsync(100); // let several ticks fire
    ctrl.stop();
    ctrl.destroy();

    const joined = captured.join("");
    assert.ok(
      joined.includes("[pi-extension-gba] audio-trace"),
      `expected audio-trace line in stderr, got: ${joined.slice(0, 200)}`,
    );
  } finally {
    (process.stderr as unknown as { write: typeof savedStderr }).write = savedStderr;
    if (savedFlag === undefined) delete process.env["PI_GBA_AUDIO_TRACE"];
    else process.env["PI_GBA_AUDIO_TRACE"] = savedFlag;
  }
});
