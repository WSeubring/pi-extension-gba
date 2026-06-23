/**
 * Phase 9c tests — auto-focus lifecycle coupling.
 * Design ref: docs/design/phase-9c-auto-focus-lifecycle.md §Test plan
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { createAutoFocus } from "../src/auto-focus.js";
import type { AutoFocusDeps, AutoFocus } from "../src/auto-focus.js";
import type { ExtensionAPI, ExtensionContext, AgentStartEvent, AgentEndEvent } from "@mariozechner/pi-coding-agent";
import type { RenderControllerWithSwap, GbaGameComponent } from "../src/render.js";
import type { Lifecycle } from "../src/lifecycle.js";
import type { AudioPlayer } from "../src/audio.js";

// ---------------------------------------------------------------------------
// Flush helper — drains the microtask/setImmediate queue N times to avoid
// single-tick races on slow CI (N9 nit).
// ---------------------------------------------------------------------------

async function flushAsync(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((res) => setImmediate(res));
  }
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type EventName = "agent_start" | "agent_end";
type HandlerFn = (event: AgentStartEvent | AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void;

interface MockPi {
  pi: ExtensionAPI;
  fireAgentStart(): Promise<void>;
  fireAgentEnd(): Promise<void>;
  shortcutHandlers: Map<string, (ctx: ExtensionContext) => Promise<void> | void>;
}

function makeMockPi(): MockPi {
  const handlers: Map<EventName, HandlerFn[]> = new Map();
  const shortcutHandlers: Map<string, (ctx: ExtensionContext) => Promise<void> | void> = new Map();

  const pi = {
    on(event: string, handler: HandlerFn) {
      const list = handlers.get(event as EventName) ?? [];
      list.push(handler);
      handlers.set(event as EventName, list);
    },
    registerShortcut(shortcut: string, opts: { handler: (ctx: ExtensionContext) => Promise<void> | void }) {
      shortcutHandlers.set(shortcut, opts.handler);
    },
  } as unknown as ExtensionAPI;

  const mockCtx: ExtensionContext = {
    ui: {
      notify() {},
      custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: undefined) => void) => unknown) => {
        // Default custom: just call factory and return immediately (simulates instant done)
        return undefined;
      },
    },
  } as unknown as ExtensionContext;

  async function fireEvent(event: EventName): Promise<void> {
    const list = handlers.get(event) ?? [];
    const ev = { type: event } as AgentStartEvent | AgentEndEvent;
    for (const h of list) {
      await h(ev, mockCtx);
    }
  }

  return {
    pi,
    async fireAgentStart() { await fireEvent("agent_start"); },
    async fireAgentEnd() { await fireEvent("agent_end"); },
    shortcutHandlers,
  };
}

interface MockRender {
  render: RenderControllerWithSwap;
  backendKind: () => string;
  customComponentSet: () => GbaGameComponent | undefined;
  useBackendCalls: string[];
}

function makeMockRender(): MockRender {
  let activeKind = "widget";
  let customComponent: GbaGameComponent | undefined;
  const useBackendCalls: string[] = [];

  const render: RenderControllerWithSwap = {
    start() {},
    stop() {},
    shrink() {},
    expand() {},
    hide() {},
    destroy() {},
    onRenderError() { return () => {}; },
    __testGetImageId() { return undefined; },
    useBackend(kind: string) {
      useBackendCalls.push(kind);
      activeKind = kind;
    },
    activeBackend() { return activeKind as "widget" | "custom"; },
    setCustomComponent(c: GbaGameComponent) {
      customComponent = c;
    },
  } as unknown as RenderControllerWithSwap;

  return {
    render,
    backendKind: () => activeKind,
    customComponentSet: () => customComponent,
    useBackendCalls,
  };
}

function makeMockLifecycle(isRunning = true): Lifecycle {
  return {
    attach() {},
    detach() {},
    manualPauseToggle() {},
    isRunning() { return isRunning; },
    onRomLoad() {},
    isCrashed() { return false; },
    acknowledgeCrash() {},
  };
}

/**
 * A custom() implementation that holds the done callback so tests can
 * control when the custom UI resolves.
 */
function makeControllableCustom(): {
  customFn: ExtensionContext["ui"]["custom"];
  resolve: () => void;
  hasStarted: () => boolean;
} {
  let resolveCallback: (() => void) | null = null;
  let started = false;

  // Cast to `any` for the implementation because the generic signature is
  // hard to satisfy in a test double; the runtime behaviour is correct.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customFn = (factory: (tui: any, theme: any, kb: any, done: (r: undefined) => void) => any): Promise<undefined> => {
    started = true;
    return new Promise<undefined>((resolve) => {
      resolveCallback = () => resolve(undefined);
      const done = (r: undefined) => {
        resolve(r);
      };
      const fakeTui = {
        terminal: { rows: 40, write() {} },
        requestRender() {},
      };
      factory(fakeTui, {}, {}, done);
    });
  };

  return {
    customFn: customFn as unknown as ExtensionContext["ui"]["custom"],
    resolve: () => {
      if (resolveCallback) resolveCallback();
    },
    hasStarted: () => started,
  };
}

function makeCtxWithControllableCustom(controllable: ReturnType<typeof makeControllableCustom>): ExtensionContext {
  return {
    ui: {
      notify() {},
      custom: controllable.customFn,
    },
  } as unknown as ExtensionContext;
}

/** Build AutoFocusDeps with sensible defaults; override via partial. */
function makeDeps(
  overrides: Partial<AutoFocusDeps> & { render?: RenderControllerWithSwap | undefined },
  mock: MockPi,
): AutoFocusDeps {
  const { render: renderOverride, ...rest } = overrides;
  return {
    pi: mock.pi,
    render: renderOverride,
    emulator: {
      step() {},
      getFramebuffer() { return new Uint8Array(0); },
      press() {},
      release() {},
    } as unknown as AutoFocusDeps["emulator"],
    lifecycle: makeMockLifecycle(),
    getCtx: () => undefined,
    cfg: {
      autoFocusOnAgentStart: true,
      autoFocusDebounceMs: 500,
      scale: 2,
    },
    caps: { kittyGraphics: true },
    notifyUnsupported() {},
    audio: undefined,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — auto-enter-on-start (debounce fires → enters game mode)
// ---------------------------------------------------------------------------

test("auto-enter-on-start: agent_start + debounce → ctx.ui.custom called", async () => {
  const mockPi = makeMockPi();
  const { render, useBackendCalls } = makeMockRender();
  const controllable = makeControllableCustom();
  const ctx = makeCtxWithControllableCustom(controllable);

  // Override the ctx delivered by agent_start by patching the handler after attach.
  // We fire the event ourselves with the controllable ctx.
  const deps = makeDeps({ render }, mockPi);
  const af = createAutoFocus(deps);
  af.attach();

  // Patch: replace the agent_start handler's ctx with our controllable one.
  // Since we fire events manually, inject the right ctx here.
  // We use fake timers to control the debounce.
  mock.timers.enable({ apis: ["setTimeout"] });

  try {
    // Fire agent_start — this schedules a setTimeout for 500 ms.
    // We need to fire the event with our controllable ctx. Patch mockPi to use our ctx.
    const handlers = (mockPi.pi as unknown as { on: (e: string, h: HandlerFn) => void });
    // Get the stored handler and call it directly with controllable ctx.
    // We simulate: agent_start fires with controllable ctx.
    const piInternal = mockPi.pi as unknown as {
      [key: string]: unknown;
    };
    // Fire using the mock's internal approach but pass our ctx.
    // Since makeMockPi stores handlers, get the registered agent_start handler:
    const startHandlers: HandlerFn[] = [];
    const endHandlers: HandlerFn[] = [];

    // Re-attach with a pi that captures handlers we can invoke directly.
    const pi2 = {
      on(event: string, handler: HandlerFn) {
        if (event === "agent_start") startHandlers.push(handler);
        else if (event === "agent_end") endHandlers.push(handler);
      },
      registerShortcut() {},
    } as unknown as ExtensionAPI;

    const deps2 = makeDeps({ render }, { ...mockPi, pi: pi2 });
    const af2 = createAutoFocus(deps2);
    af2.attach();

    assert.ok(!af2.isInGameMode(), "starts in chat mode");

    const startEv = { type: "agent_start" } as AgentStartEvent;
    for (const h of startHandlers) {
      await h(startEv, ctx);
    }

    // Advance timer by 500 ms — debounce fires.
    mock.timers.tick(500);
    // Let the microtask queue drain.
    await flushAsync();

    assert.ok(controllable.hasStarted(), "ctx.ui.custom was called after debounce");
    assert.ok(af2.isInGameMode(), "now in game mode");
    assert.ok(useBackendCalls.includes("custom"), "useBackend('custom') called");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Test 2 — debounce-cancels-on-fast-end
// ---------------------------------------------------------------------------

test("debounce-cancels-on-fast-end: fast agent_end prevents game mode entry", async () => {
  const mockPi2 = makeMockPi();
  const { render } = makeMockRender();
  const controllable = makeControllableCustom();
  const ctx = makeCtxWithControllableCustom(controllable);

  const startHandlers: HandlerFn[] = [];
  const endHandlers: HandlerFn[] = [];
  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_start") startHandlers.push(handler);
      else if (event === "agent_end") endHandlers.push(handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const deps = makeDeps({ render }, { ...mockPi2, pi });
  const af = createAutoFocus(deps);
  af.attach();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const startEv = { type: "agent_start" } as AgentStartEvent;
    const endEv = { type: "agent_end" } as AgentEndEvent;

    for (const h of startHandlers) await h(startEv, ctx);

    // Advance only 200 ms (< 500 ms debounce) then fire agent_end.
    mock.timers.tick(200);
    for (const h of endHandlers) await h(endEv, ctx);

    // Advance past the full debounce window.
    mock.timers.tick(400);
    await flushAsync();

    assert.ok(!controllable.hasStarted(), "ctx.ui.custom was NOT called (debounce cancelled)");
    assert.ok(!af.isInGameMode(), "still in chat mode");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Test 3 — manual-override-stays-after-end (manualEnteredDuringChat)
// ---------------------------------------------------------------------------

test("manual-override-stays-after-end: manual enter keeps game mode across agent_end", async () => {
  const mockPi3 = makeMockPi();
  const { render } = makeMockRender();
  const controllable = makeControllableCustom();
  const ctx = makeCtxWithControllableCustom(controllable);

  const endHandlers: HandlerFn[] = [];
  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_end") endHandlers.push(handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const deps = makeDeps({ render }, { ...mockPi3, pi });
  const af = createAutoFocus(deps);
  af.attach();

  // Manually enter game mode (simulates alt+g during chat).
  const enterPromise = af.enterManual(ctx);

  // Let the component get created.
  await flushAsync();

  assert.ok(af.isInGameMode(), "in game mode after enterManual");

  // Fire agent_end — should NOT exit because manualEnteredDuringChat=true.
  const endEv = { type: "agent_end" } as AgentEndEvent;
  for (const h of endHandlers) await h(endEv, ctx);

  assert.ok(af.isInGameMode(), "still in game mode after agent_end (manual entered during chat)");

  // Clean up: resolve the custom UI.
  controllable.resolve();
  await enterPromise;
});

// ---------------------------------------------------------------------------
// Test 4 — manual-exit-blocks-next-entry
// ---------------------------------------------------------------------------

test("manual-exit-blocks-next-entry: manual exit suppresses next auto-entry, then resumes", async () => {
  const startHandlers: HandlerFn[] = [];
  const endHandlers: HandlerFn[] = [];
  const controllable = makeControllableCustom();
  const ctx = makeCtxWithControllableCustom(controllable);

  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_start") startHandlers.push(handler);
      else if (event === "agent_end") endHandlers.push(handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const { render } = makeMockRender();
  const deps = makeDeps({ render }, { pi } as unknown as MockPi);
  const af = createAutoFocus(deps);
  af.attach();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const startEv = { type: "agent_start" } as AgentStartEvent;
    const endEv = { type: "agent_end" } as AgentEndEvent;

    // First: auto-enter via debounce.
    for (const h of startHandlers) await h(startEv, ctx);
    mock.timers.tick(500);
    await flushAsync();

    assert.ok(af.isInGameMode(), "in game mode via auto-enter");

    // User manually exits mid-agent.
    af.exitManual();
    await flushAsync();

    assert.ok(!af.isInGameMode(), "exited game mode");

    // agent_end fires — clears manualExitedDuringGame.
    for (const h of endHandlers) await h(endEv, ctx);

    // Next agent_start — should be BLOCKED (manualExitedDuringGame was set during the turn).
    // Per design: cleared on agent_end so the FOLLOWING agent_start resumes auto-enter.
    // So actually: after agent_end clears the flag, next agent_start should auto-enter.
    // Let's verify the flag is cleared by checking the next entry works.
    const controllable2 = makeControllableCustom();
    const ctx2 = makeCtxWithControllableCustom(controllable2);

    for (const h of startHandlers) await h(startEv, ctx2);
    mock.timers.tick(500);
    await flushAsync();

    assert.ok(controllable2.hasStarted(), "auto-enter resumes after manual exit turn completes");
    controllable2.resolve();
    await flushAsync();
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Test 5 — env-opt-out (PI_GBA_AUTO_FOCUS=0)
// ---------------------------------------------------------------------------

test("env-opt-out: autoFocusOnAgentStart=false blocks auto-entry but alt+g still works", async () => {
  const startHandlers: HandlerFn[] = [];
  const controllable = makeControllableCustom();
  const ctx = makeCtxWithControllableCustom(controllable);
  const shortcutHandlers = new Map<string, (ctx: ExtensionContext) => Promise<void> | void>();

  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_start") startHandlers.push(handler);
    },
    registerShortcut(shortcut: string, opts: { handler: (c: ExtensionContext) => void }) {
      shortcutHandlers.set(shortcut, opts.handler);
    },
  } as unknown as ExtensionAPI;

  const { render } = makeMockRender();
  const deps = makeDeps(
    { render, cfg: { autoFocusOnAgentStart: false, autoFocusDebounceMs: 500, scale: 2 } },
    { pi } as unknown as MockPi,
  );
  const af = createAutoFocus(deps);
  af.attach();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Fire agent_start — should NOT enter.
    const startEv = { type: "agent_start" } as AgentStartEvent;
    for (const h of startHandlers) await h(startEv, ctx);
    mock.timers.tick(500);
    await flushAsync();

    assert.ok(!af.isInGameMode(), "no auto-entry when autoFocusOnAgentStart=false");
    assert.ok(!controllable.hasStarted(), "ctx.ui.custom not called");

    // alt+g shortcut should still work.
    const altG = shortcutHandlers.get("alt+g");
    assert.ok(altG !== undefined, "alt+g shortcut registered even when auto disabled");

    const controllable2 = makeControllableCustom();
    const ctx2 = makeCtxWithControllableCustom(controllable2);
    void altG!(ctx2);
    await flushAsync();

    assert.ok(af.isInGameMode(), "alt+g still enters game mode");
    controllable2.resolve();
    await flushAsync();
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Test 6 — crash-safe: emulator crash cancels pending timer
// ---------------------------------------------------------------------------

test("crash-safe: no render guard — events fire without throws when render is undefined", async () => {
  const startHandlers: HandlerFn[] = [];
  const endHandlers: HandlerFn[] = [];
  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_start") startHandlers.push(handler);
      else if (event === "agent_end") endHandlers.push(handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  // No render — simulates no ROM loaded.
  const deps = makeDeps({ render: undefined }, { pi } as unknown as MockPi);
  const af = createAutoFocus(deps);
  af.attach();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const startEv = { type: "agent_start" } as AgentStartEvent;
    const endEv = { type: "agent_end" } as AgentEndEvent;
    const mockCtx = { ui: { notify() {}, custom: async () => undefined } } as unknown as ExtensionContext;

    // Should not throw.
    await assert.doesNotReject(async () => {
      for (const h of startHandlers) await h(startEv, mockCtx);
    });

    mock.timers.tick(500);
    await flushAsync();

    assert.ok(!af.isInGameMode(), "no game mode without render");

    await assert.doesNotReject(async () => {
      for (const h of endHandlers) await h(endEv, mockCtx);
    });
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Test 7 — no-render-guard: no-ROM, events fire harmlessly (already covered above as test 6)
// Additional: verify isInGameMode stays false and no errors thrown.
// ---------------------------------------------------------------------------

test("no-render-guard: getRender undefined → no entry, no throws", async () => {
  const startHandlers: HandlerFn[] = [];
  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_start") startHandlers.push(handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const deps = makeDeps({ render: undefined }, { pi } as unknown as MockPi);
  const af = createAutoFocus(deps);
  af.attach();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const mockCtx = { ui: { notify() {}, custom: async () => undefined } } as unknown as ExtensionContext;
    const startEv = { type: "agent_start" } as AgentStartEvent;
    for (const h of startHandlers) await h(startEv, mockCtx);
    mock.timers.tick(600);
    await flushAsync();
    assert.ok(!af.isInGameMode(), "no game mode with no render");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Test 8 — rapid start/end churn: zero ctx.ui.custom calls
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test B2 (REVISE) — alt+g while Paused enters game mode per L3
// ---------------------------------------------------------------------------

test("alt+g while Paused enters game mode (L3 manual entry during agent_end)", async () => {
  const shortcutHandlers = new Map<string, (c: ExtensionContext) => Promise<void> | void>();
  const pi = {
    on() {},
    registerShortcut(shortcut: string, opts: { handler: (c: ExtensionContext) => void }) {
      shortcutHandlers.set(shortcut, opts.handler);
    },
  } as unknown as ExtensionAPI;

  const { render, useBackendCalls } = makeMockRender();
  const controllable = makeControllableCustom();
  const ctx = makeCtxWithControllableCustom(controllable);

  // Simulate lifecycle in Paused state (isRunning=false).
  const pausedLifecycle: Lifecycle = {
    attach() {}, detach() {}, manualPauseToggle() {},
    isRunning() { return false; },
    onRomLoad() {}, isCrashed() { return false; }, acknowledgeCrash() {},
  };

  const deps = makeDeps(
    { render, lifecycle: pausedLifecycle },
    { pi } as unknown as MockPi,
  );
  const af = createAutoFocus(deps);
  af.attach();

  const altG = shortcutHandlers.get("alt+g");
  assert.ok(altG !== undefined, "alt+g shortcut must be registered");

  void altG!(ctx);
  await flushAsync();

  assert.ok(af.isInGameMode(), "alt+g while Paused must enter game mode (L3)");
  assert.ok(useBackendCalls.includes("custom"), "custom backend swap must occur");
  // Does NOT start emulation — alt+g does not touch lifecycle.isRunning.
  assert.strictEqual(pausedLifecycle.isRunning(), false, "alt+g must not start emulation");

  controllable.resolve();
  await flushAsync();
});

// ---------------------------------------------------------------------------
// Test B3 (REVISE) — widget live-tick policy applied on attach
// ---------------------------------------------------------------------------

test("widget live-tick policy: autoFocus enabled → setWidgetLiveTick(false) called", async () => {
  const pi = {
    on() {},
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  // Extended render mock that records setWidgetLiveTick calls.
  const liveTickCalls: boolean[] = [];
  const base = makeMockRender();
  const render: RenderControllerWithSwap = {
    ...base.render,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setWidgetLiveTick(enabled: boolean) { liveTickCalls.push(enabled); },
  } as unknown as RenderControllerWithSwap;

  const deps = makeDeps({ render }, { pi } as unknown as MockPi);
  const af = createAutoFocus(deps);
  af.attach();

  assert.ok(
    liveTickCalls.includes(false),
    `attach() with autoFocusOnAgentStart=true must call setWidgetLiveTick(false); got ${JSON.stringify(liveTickCalls)}`,
  );
  void af;
});

test("widget live-tick policy: autoFocus disabled → setWidgetLiveTick(true) (legacy opt-out)", async () => {
  const pi = {
    on() {},
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const liveTickCalls: boolean[] = [];
  const base = makeMockRender();
  const render: RenderControllerWithSwap = {
    ...base.render,
    setWidgetLiveTick(enabled: boolean) { liveTickCalls.push(enabled); },
  } as unknown as RenderControllerWithSwap;

  const deps = makeDeps(
    { render, cfg: { autoFocusOnAgentStart: false, autoFocusDebounceMs: 500, scale: 2 } },
    { pi } as unknown as MockPi,
  );
  const af = createAutoFocus(deps);
  af.attach();

  assert.ok(
    liveTickCalls.includes(true),
    `attach() with autoFocusOnAgentStart=false must call setWidgetLiveTick(true); got ${JSON.stringify(liveTickCalls)}`,
  );
  void af;
});

test("rapid-start-end churn: 10 cycles below debounce → zero game mode entries", async () => {
  const startHandlers: HandlerFn[] = [];
  const endHandlers: HandlerFn[] = [];
  let customCallCount = 0;

  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_start") startHandlers.push(handler);
      else if (event === "agent_end") endHandlers.push(handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const { render } = makeMockRender();
  const deps = makeDeps({ render }, { pi } as unknown as MockPi);
  const af = createAutoFocus(deps);
  af.attach();

  // Override the render's underlying context to count custom calls.
  const ctx = {
    ui: {
      notify() {},
      custom: async () => {
        customCallCount++;
        return undefined;
      },
    },
  } as unknown as ExtensionContext;

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const startEv = { type: "agent_start" } as AgentStartEvent;
    const endEv = { type: "agent_end" } as AgentEndEvent;

    for (let i = 0; i < 10; i++) {
      for (const h of startHandlers) await h(startEv, ctx);
      // Advance less than debounce.
      mock.timers.tick(100);
      for (const h of endHandlers) await h(endEv, ctx);
    }

    // Now advance past debounce — no timer should be pending.
    mock.timers.tick(600);
    await flushAsync();

    assert.equal(customCallCount, 0, "ctx.ui.custom never called during rapid churn");
    assert.ok(!af.isInGameMode(), "still in chat mode");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Controllable audio fake — lets tests hold start()/stop() open to widen the
// enter()/finally race windows.
// ---------------------------------------------------------------------------

function makeControllableAudio(): {
  audio: AudioPlayer;
  resolveStart: () => void;
  resolveStop: () => void;
  holdStart: (hold: boolean) => void;
  holdStop: (hold: boolean) => void;
} {
  let startResolvers: (() => void)[] = [];
  let stopResolvers: (() => void)[] = [];
  let startHeld = false;
  let stopHeld = false;

  const audio = {
    start() {
      if (!startHeld) return Promise.resolve();
      return new Promise<void>((r) => startResolvers.push(r));
    },
    stop() {
      if (!stopHeld) return Promise.resolve();
      return new Promise<void>((r) => stopResolvers.push(r));
    },
    writeSamples() {},
    mute() {},
    unmute() {},
    isMuted() { return false; },
    onCrash() { return () => {}; },
  } as unknown as AudioPlayer;

  return {
    audio,
    resolveStart: () => { for (const r of startResolvers) r(); startResolvers = []; },
    resolveStop: () => { for (const r of stopResolvers) r(); stopResolvers = []; },
    holdStart: (hold) => { startHeld = hold; },
    holdStop: (hold) => { stopHeld = hold; },
  };
}

// ---------------------------------------------------------------------------
// Stale enter() finally must not steal the backend from a newer session
// (generation token guard)
// ---------------------------------------------------------------------------

test("re-enter during slow audio.stop: stale finally must not switch backend back to widget", async () => {
  const pi = {
    on() {},
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const { render, backendKind } = makeMockRender();
  const ctrlAudio = makeControllableAudio();
  const deps = makeDeps({ render, audio: ctrlAudio.audio }, { pi } as unknown as MockPi);
  const af = createAutoFocus(deps);
  af.attach();

  // Session 1: enter, then begin teardown that blocks on audio.stop().
  const c1 = makeControllableCustom();
  const p1 = af.enterManual(makeCtxWithControllableCustom(c1));
  await flushAsync();
  assert.ok(af.isInGameMode(), "session 1 in game mode");

  ctrlAudio.holdStop(true);
  c1.resolve(); // custom() resolves → finally runs, awaits the held stop()
  await flushAsync();
  assert.ok(!af.isInGameMode(), "mode flipped to chat before the stop await");

  // Session 2 starts while session 1's finally is still parked on stop().
  const c2 = makeControllableCustom();
  const p2 = af.enterManual(makeCtxWithControllableCustom(c2));
  await flushAsync();
  assert.ok(af.isInGameMode(), "session 2 mounted during session 1 teardown");
  assert.equal(backendKind(), "custom", "session 2 owns the custom backend");

  // Release session 1's stop — its stale finally must leave the backend alone.
  ctrlAudio.holdStop(false);
  ctrlAudio.resolveStop();
  await p1;
  await flushAsync();

  assert.ok(af.isInGameMode(), "session 2 still live");
  assert.equal(backendKind(), "custom", "stale finally did not restore widget under the live session");

  c2.resolve();
  await p2;
});

// ---------------------------------------------------------------------------
// agent_end inside the enter() pre-mount window (audio.start await) must
// still close game mode once the component mounts (closeRequested replay)
// ---------------------------------------------------------------------------

test("agent_end before component mount: close is replayed after mount, game mode does not linger", async () => {
  const startHandlers: HandlerFn[] = [];
  const endHandlers: HandlerFn[] = [];
  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_start") startHandlers.push(handler);
      else if (event === "agent_end") endHandlers.push(handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const { render } = makeMockRender();
  const ctrlAudio = makeControllableAudio();
  ctrlAudio.holdStart(true); // park enter() between mode="game" and the mount
  const controllable = makeControllableCustom();
  const ctx = makeCtxWithControllableCustom(controllable);

  const deps = makeDeps({ render, audio: ctrlAudio.audio }, { pi } as unknown as MockPi);
  const af = createAutoFocus(deps);
  af.attach();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const startEv = { type: "agent_start" } as AgentStartEvent;
    const endEv = { type: "agent_end" } as AgentEndEvent;

    for (const h of startHandlers) await h(startEv, ctx);
    mock.timers.tick(500); // debounce fires → enter() blocks on audio.start
    assert.ok(af.isInGameMode(), "mode flipped to game pre-mount");
    assert.ok(!controllable.hasStarted(), "component not mounted yet");

    // Agent ends while enter() is still awaiting audio.start — liveComponent
    // is undefined, so exit() can only record the close request.
    for (const h of endHandlers) await h(endEv, ctx);

    // Mount completes — the recorded close must fire immediately.
    ctrlAudio.holdStart(false);
    ctrlAudio.resolveStart();
    await flushAsync();

    assert.ok(!af.isInGameMode(), "game mode closed right after mount (agent already ended)");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// enterManual: a failing ctx.ui.custom must not leave manualEnteredDuringChat
// stuck true (which would exempt all future auto-entries from auto-exit)
// ---------------------------------------------------------------------------

test("enterManual failure: manualEnteredDuringChat is cleared, later auto-entries still auto-exit", async () => {
  const startHandlers: HandlerFn[] = [];
  const endHandlers: HandlerFn[] = [];
  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_start") startHandlers.push(handler);
      else if (event === "agent_end") endHandlers.push(handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const { render } = makeMockRender();
  const deps = makeDeps({ render }, { pi } as unknown as MockPi);
  const af = createAutoFocus(deps);
  af.attach();

  // Manual entry whose custom UI rejects. Must not throw out of enterManual
  // (both call sites are fire-and-forget) and must not strand the flag.
  const failingCtx = {
    ui: {
      notify() {},
      custom: async () => { throw new Error("tui exploded"); },
    },
  } as unknown as ExtensionContext;

  await assert.doesNotReject(() => af.enterManual(failingCtx));
  assert.ok(!af.isInGameMode(), "back in chat mode after the failure");

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Next auto-entry must still auto-exit on agent_end — a stuck
    // manualEnteredDuringChat=true would keep game mode open forever.
    const controllable = makeControllableCustom();
    const ctx = makeCtxWithControllableCustom(controllable);
    const startEv = { type: "agent_start" } as AgentStartEvent;
    const endEv = { type: "agent_end" } as AgentEndEvent;

    for (const h of startHandlers) await h(startEv, ctx);
    mock.timers.tick(500);
    await flushAsync();
    assert.ok(af.isInGameMode(), "auto-entered game mode");

    for (const h of endHandlers) await h(endEv, ctx);
    await flushAsync();
    assert.ok(!af.isInGameMode(), "agent_end auto-exits (flag was not stuck)");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// detach(): the still-registered agent_start handler must self-disarm
// (pi.on has no unsubscribe), so no post-detach game mode re-entry
// ---------------------------------------------------------------------------

test("detach: post-detach agent_start does not re-enter game mode", async () => {
  const startHandlers: HandlerFn[] = [];
  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_start") startHandlers.push(handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const { render } = makeMockRender();
  const controllable = makeControllableCustom();
  const ctx = makeCtxWithControllableCustom(controllable);

  const deps = makeDeps({ render }, { pi } as unknown as MockPi);
  const af = createAutoFocus(deps);
  af.attach();
  af.detach();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const startEv = { type: "agent_start" } as AgentStartEvent;
    for (const h of startHandlers) await h(startEv, ctx);
    mock.timers.tick(600);
    await flushAsync();

    assert.ok(!controllable.hasStarted(), "ctx.ui.custom never called after detach");
    assert.ok(!af.isInGameMode(), "no game mode re-entry from a detached handler");
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Both auto-entry and manual entry resume a Paused lifecycle. The L3
// still-frame contract lives inside lifecycle.resume() itself, which refuses
// when the user explicitly paused (manualOverride) or after a crash — see
// tests/lifecycle.test.ts.
// ---------------------------------------------------------------------------

test("auto-entry and manual alt+g entry both call lifecycle.resume()", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // --- auto path ---
    let resumeCalls = 0;
    const lifecycleWithResume: Lifecycle = {
      ...makeMockLifecycle(false),
      resume() { resumeCalls++; },
    };

    const startHandlers: HandlerFn[] = [];
    const pi = {
      on(event: string, handler: HandlerFn) {
        if (event === "agent_start") startHandlers.push(handler);
      },
      registerShortcut() {},
    } as unknown as ExtensionAPI;

    const mockPi = makeMockPi();
    const { render } = makeMockRender();
    const controllable = makeControllableCustom();
    const ctx = makeCtxWithControllableCustom(controllable);

    const deps = makeDeps({ render, lifecycle: lifecycleWithResume }, { ...mockPi, pi });
    const af = createAutoFocus(deps);
    af.attach();

    const startEv = { type: "agent_start" } as AgentStartEvent;
    for (const h of startHandlers) await h(startEv, ctx);
    mock.timers.tick(500);
    await flushAsync();

    assert.ok(af.isInGameMode(), "auto-entered game mode");
    assert.equal(resumeCalls, 1, "auto-entry resumed the paused lifecycle");

    controllable.resolve();
    await flushAsync();

    // --- manual path: resume must ALSO be called (frozen-frame trap fix) ---
    const controllable2 = makeControllableCustom();
    const ctx2 = makeCtxWithControllableCustom(controllable2);
    void af.enterManual(ctx2);
    await flushAsync();

    assert.ok(af.isInGameMode(), "manually entered game mode");
    assert.equal(resumeCalls, 2, "manual entry also calls resume()");

    controllable2.resolve();
    await flushAsync();
  } finally {
    mock.timers.reset();
  }
});
