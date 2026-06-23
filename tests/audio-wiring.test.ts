import { defined } from "./harness/assert.js";
/**
 * Phase 8c — Audio wiring tests.
 * Covers: render tick pulls samples, mute/unmute commands, alt+m shortcut,
 * audio=undefined silent path.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AudioPlayer } from "../src/audio.js";
import { type AutoFocusDeps, createAutoFocus } from "../src/auto-focus.js";
import { type CommandDeps, registerAll } from "../src/commands.js";
import type { GbaConfig } from "../src/config.js";
import type { Lifecycle } from "../src/lifecycle.js";
import type { Persistence } from "../src/persistence.js";
import type { RenderControllerWithSwap } from "../src/render.js";
import { createRenderer, type EmulatorLike } from "../src/render.js";

// ---------------------------------------------------------------------------
// Mock audio player
// ---------------------------------------------------------------------------

interface MockAudio extends AudioPlayer {
  startCalls: number;
  stopCalls: number;
  muteCalls: number;
  unmuteCalls: number;
  writtenChunks: Int16Array[];
  _muted: boolean;
  _crashed: boolean;
}

function makeMockAudio(opts?: { startReject?: boolean }): MockAudio {
  const listeners: Array<(err: Error) => void> = [];
  let muted = false;

  const player: MockAudio = {
    startCalls: 0,
    stopCalls: 0,
    muteCalls: 0,
    unmuteCalls: 0,
    writtenChunks: [],
    _muted: false,
    _crashed: false,

    async start() {
      player.startCalls++;
      if (opts?.startReject) throw new Error("start failed (test)");
    },

    writeSamples(pcm: Int16Array) {
      player.writtenChunks.push(pcm);
    },

    mute() {
      muted = true;
      player._muted = true;
      player.muteCalls++;
    },

    unmute() {
      muted = false;
      player._muted = false;
      player.unmuteCalls++;
    },

    isMuted() {
      return muted;
    },

    async stop() {
      player.stopCalls++;
    },

    onCrash(cb) {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
  };

  return player;
}

// ---------------------------------------------------------------------------
// Mock emulator with optional getAudioSamples
// ---------------------------------------------------------------------------

function makeAudioEmulator(samples: Int16Array): EmulatorLike & { getAudioSamples(n: number): Int16Array } {
  const buf = new Uint8Array(240 * 160 * 4).fill(128);
  return {
    step() {},
    getFramebuffer() {
      return buf.slice();
    },
    getAudioSamples(_max: number) {
      return samples;
    },
  };
}

function makeNoAudioEmulator(): EmulatorLike {
  const buf = new Uint8Array(240 * 160 * 4).fill(128);
  return {
    step() {},
    getFramebuffer() {
      return buf.slice();
    },
    // deliberately no getAudioSamples
  };
}

// ---------------------------------------------------------------------------
// Mock ctx
// ---------------------------------------------------------------------------

function makeMockCtx(): { ctx: ExtensionContext; notifyCalls: Array<{ message: string; type?: string }> } {
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const ctx = {
    ui: {
      setWidget() {},
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notifyCalls };
}

// ---------------------------------------------------------------------------
// Test 1: tick pulls samples when audio provided (non-empty chunk → writeSamples called)
// ---------------------------------------------------------------------------

test("render tick: getAudioSamples called + writeSamples forwarded for non-empty chunk", async () => {
  const samples = new Int16Array([1, 2, 3, 4]);
  const emulator = makeAudioEmulator(samples);
  const audio = makeMockAudio();
  const { ctx } = makeMockCtx();

  const renderer = createRenderer(
    ctx as unknown as import("@mariozechner/pi-coding-agent").ExtensionContext,
    emulator,
    {
      frameRate: 30,
      audio,
    },
  );
  renderer.setWidgetLiveTick(true);
  renderer.start();
  await new Promise((r) => setTimeout(r, 80));
  renderer.destroy();

  assert.ok(audio.writtenChunks.length > 0, "writeSamples must be called when samples non-empty");
  assert.strictEqual(audio.writtenChunks[0], samples, "writeSamples receives the returned Int16Array");
});

// ---------------------------------------------------------------------------
// Test 2: tick skips writeSamples for empty chunk
// ---------------------------------------------------------------------------

test("render tick: empty chunk → writeSamples NOT called", async () => {
  const samples = new Int16Array(0); // empty
  const emulator = makeAudioEmulator(samples);
  const audio = makeMockAudio();
  const { ctx } = makeMockCtx();

  const renderer = createRenderer(
    ctx as unknown as import("@mariozechner/pi-coding-agent").ExtensionContext,
    emulator,
    {
      frameRate: 30,
      audio,
    },
  );
  renderer.setWidgetLiveTick(true);
  renderer.start();
  await new Promise((r) => setTimeout(r, 80));
  renderer.destroy();

  assert.strictEqual(audio.writtenChunks.length, 0, "writeSamples must NOT be called for empty chunk");
});

// ---------------------------------------------------------------------------
// Test 3: audio=undefined silent path — tick runs, no throw, no getAudioSamples
// ---------------------------------------------------------------------------

test("render tick: audio=undefined silent path — no throw, tick proceeds normally", async () => {
  const getAudioSamplesCalls: number[] = [];
  const emulatorWithSpy: EmulatorLike & { getAudioSamples(n: number): Int16Array } = {
    ...makeAudioEmulator(new Int16Array([1, 2])),
    getAudioSamples(n: number) {
      getAudioSamplesCalls.push(n);
      return new Int16Array([1, 2]);
    },
  };

  const { ctx } = makeMockCtx();
  const renderer = createRenderer(
    ctx as unknown as import("@mariozechner/pi-coding-agent").ExtensionContext,
    emulatorWithSpy,
    {
      frameRate: 30,
      // audio intentionally omitted → silent mode
    },
  );
  renderer.setWidgetLiveTick(true);

  const errors: unknown[] = [];
  renderer.onRenderError((e) => errors.push(e));

  renderer.start();
  await new Promise((r) => setTimeout(r, 80));
  renderer.destroy();

  assert.strictEqual(errors.length, 0, "no render errors in silent mode");
  assert.strictEqual(getAudioSamplesCalls.length, 0, "getAudioSamples NOT called when audio=undefined");
});

// ---------------------------------------------------------------------------
// Test 4: emulator without getAudioSamples — tick still works (no throw)
// ---------------------------------------------------------------------------

test("render tick: emulator lacks getAudioSamples + audio provided → no throw", async () => {
  const emulator = makeNoAudioEmulator(); // no getAudioSamples method
  const audio = makeMockAudio();
  const { ctx } = makeMockCtx();

  const renderer = createRenderer(
    ctx as unknown as import("@mariozechner/pi-coding-agent").ExtensionContext,
    emulator,
    {
      frameRate: 30,
      audio,
    },
  );
  renderer.setWidgetLiveTick(true);

  const errors: unknown[] = [];
  renderer.onRenderError((e) => errors.push(e));

  renderer.start();
  await new Promise((r) => setTimeout(r, 80));
  renderer.destroy();

  assert.strictEqual(errors.length, 0, "no render errors when getAudioSamples is absent");
  assert.strictEqual(audio.writtenChunks.length, 0, "writeSamples not called when method absent");
});

// ---------------------------------------------------------------------------
// Test 5: /gba mute → audio.mute() + notify "muted"
// ---------------------------------------------------------------------------

function makeFakePi(): {
  pi: ExtensionAPI;
  invokeCommand: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
} {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | null = null;
  const pi = {
    registerCommand(_name: string, opts: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      handler = opts.handler;
    },
    on() {},
    registerShortcut() {},
  } as unknown as ExtensionAPI;
  return {
    pi,
    async invokeCommand(args, ctx) {
      if (!handler) throw new Error("no command registered");
      await handler(args, ctx);
    },
  };
}

function makeFakeDeps(audio: AudioPlayer | undefined): CommandDeps {
  return {
    emulator: {} as never,
    persistence: {
      async loadRom(b) {
        return { romPath: b, restoredState: false };
      },
      async snapshot() {},
      async flushPending() {},
      async listRoms() {
        return [];
      },
      async lastPlayed() {
        return undefined;
      },
      currentRom() {
        return undefined;
      },
      async clearState() {},
      destroy() {},
    } as Persistence,
    lifecycle: {
      attach() {},
      detach() {},
      manualPauseToggle() {},
      isRunning() {
        return false;
      },
      onRomLoad() {},
      isCrashed() {
        return false;
      },
      acknowledgeCrash() {},
    } as Lifecycle,
    ensureRender: () => ({ start() {}, stop() {}, shrink() {}, expand() {}, hide() {} }),
    cfg: {
      version: 1,
      romDir: "/roms",
      scale: 2,
      frameRate: 30,
      autoRunOnAgentStart: true,
      autoHideOnAgentEnd: false,
      autoFocusOnAgentStart: true,
      autoFocusDebounceMs: 500,
      audio: false,
    } as GbaConfig,
    caps: { kittyGraphics: true, audioBackend: undefined },
    notifyUnsupported() {},
    audio,
  };
}

test("/gba mute → audio.mute() called + notifies 'muted'", async () => {
  const { pi, invokeCommand } = makeFakePi();
  const audio = makeMockAudio();
  registerAll(pi, makeFakeDeps(audio));

  const { ctx, notifyCalls } = makeMockCtx();
  await invokeCommand("mute", ctx as unknown as ExtensionCommandContext);

  assert.strictEqual(audio.muteCalls, 1, "mute() must be called once");
  assert.ok(
    notifyCalls.some((n) => n.message.includes("muted") && n.type === "info"),
    `expected info notify containing 'muted', got: ${JSON.stringify(notifyCalls)}`,
  );
});

// ---------------------------------------------------------------------------
// Test 6: /gba unmute → audio.unmute() + notify "unmuted"
// ---------------------------------------------------------------------------

test("/gba unmute → audio.unmute() called + notifies 'unmuted'", async () => {
  const { pi, invokeCommand } = makeFakePi();
  const audio = makeMockAudio();
  registerAll(pi, makeFakeDeps(audio));

  const { ctx, notifyCalls } = makeMockCtx();
  await invokeCommand("unmute", ctx as unknown as ExtensionCommandContext);

  assert.strictEqual(audio.unmuteCalls, 1, "unmute() must be called once");
  assert.ok(
    notifyCalls.some((n) => n.message.includes("unmuted") && n.type === "info"),
    `expected info notify containing 'unmuted', got: ${JSON.stringify(notifyCalls)}`,
  );
});

// ---------------------------------------------------------------------------
// Test 7: /gba mute with audio=undefined → notify "not enabled"
// ---------------------------------------------------------------------------

test("/gba mute with audio=undefined → notify 'audio not enabled'", async () => {
  const { pi, invokeCommand } = makeFakePi();
  registerAll(pi, makeFakeDeps(undefined));

  const { ctx, notifyCalls } = makeMockCtx();
  await invokeCommand("mute", ctx as unknown as ExtensionCommandContext);

  assert.ok(
    notifyCalls.some((n) => n.message.toLowerCase().includes("not enabled") && n.type === "warning"),
    `expected warning about audio not enabled, got: ${JSON.stringify(notifyCalls)}`,
  );
});

// ---------------------------------------------------------------------------
// Test 8: completions include mute/unmute when audio enabled, omit when disabled
// ---------------------------------------------------------------------------

test("completions include mute/unmute when audio provided, omit when undefined", async () => {
  function makePiWithCompletions(): {
    pi: ExtensionAPI;
    getCompletions: (prefix: string) => Promise<unknown>;
  } {
    let getter: ((prefix: string) => unknown) | null = null;
    const pi = {
      registerCommand(_name: string, opts: { getArgumentCompletions?: (prefix: string) => unknown }) {
        getter = opts.getArgumentCompletions ?? null;
      },
      on() {},
      registerShortcut() {},
    } as unknown as ExtensionAPI;
    return {
      pi,
      async getCompletions(prefix) {
        if (!getter) return null;
        return getter(prefix);
      },
    };
  }

  // With audio
  const { pi: pi1, getCompletions: gc1 } = makePiWithCompletions();
  registerAll(pi1, makeFakeDeps(makeMockAudio()));
  const withAudio = (await gc1("")) as { value: string }[];
  assert.ok(Array.isArray(withAudio), "completions should be an array");
  assert.ok(
    withAudio.some((c) => c.value === "mute"),
    "mute in completions when audio provided",
  );
  assert.ok(
    withAudio.some((c) => c.value === "unmute"),
    "unmute in completions when audio provided",
  );

  // Without audio
  const { pi: pi2, getCompletions: gc2 } = makePiWithCompletions();
  registerAll(pi2, makeFakeDeps(undefined));
  const withoutAudio = (await gc2("")) as { value: string }[];
  assert.ok(Array.isArray(withoutAudio), "completions should be array when audio absent");
  assert.ok(!withoutAudio.some((c) => c.value === "mute"), "mute NOT in completions when audio absent");
  assert.ok(!withoutAudio.some((c) => c.value === "unmute"), "unmute NOT in completions when audio absent");
});

// ---------------------------------------------------------------------------
// Test 9: alt+m toggle — starts unmuted, first fire → mute, second → unmute
// ---------------------------------------------------------------------------

test("alt+m toggle: unmuted→mute→unmute cycle", () => {
  const audio = makeMockAudio();
  const shortcutHandlers = new Map<string, (ctx: ExtensionContext) => void>();
  const notifyCalls: Array<{ message: string; type?: string }> = [];

  const ctx = {
    ui: {
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type });
      },
      setWidget() {},
    },
  } as unknown as ExtensionContext;

  // Register shortcut directly (simulating what index.ts does)
  function registerMuteShortcut(a: AudioPlayer | undefined): void {
    shortcutHandlers.set("alt+m", (c: ExtensionContext) => {
      if (!a) {
        c.ui.notify("GBA: audio not enabled — set PI_GBA_AUDIO=1 or enable via /gba config", "warning");
        return;
      }
      if (a.isMuted()) {
        a.unmute();
        c.ui.notify("GBA: audio unmuted", "info");
      } else {
        a.mute();
        c.ui.notify("GBA: audio muted", "info");
      }
    });
  }

  registerMuteShortcut(audio);
  const handler = defined(shortcutHandlers.get("alt+m"), "alt+m handler");
  assert.ok(handler !== undefined, "alt+m handler registered");

  // starts unmuted
  assert.strictEqual(audio.isMuted(), false, "starts unmuted");

  // first press → mute
  handler(ctx);
  assert.strictEqual(audio.isMuted(), true, "after first press: muted");
  assert.ok(
    notifyCalls.some((n) => n.message.includes("muted") && !n.message.includes("unmuted") && n.type === "info"),
    `expected 'muted' info notify, got: ${JSON.stringify(notifyCalls)}`,
  );
  notifyCalls.length = 0;

  // second press → unmute
  handler(ctx);
  assert.strictEqual(audio.isMuted(), false, "after second press: unmuted");
  assert.ok(
    notifyCalls.some((n) => n.message.includes("unmuted") && n.type === "info"),
    `expected 'unmuted' info notify, got: ${JSON.stringify(notifyCalls)}`,
  );
});

// ---------------------------------------------------------------------------
// Test 10: alt+m with audio=undefined → notify not enabled
// ---------------------------------------------------------------------------

test("alt+m with audio=undefined → notify 'audio not enabled'", () => {
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type });
      },
      setWidget() {},
    },
  } as unknown as ExtensionContext;

  // Simulate the shortcut handler from index.ts with audio=undefined
  function handleAltM(audio: AudioPlayer | undefined, c: ExtensionContext): void {
    if (!audio) {
      c.ui.notify("GBA: audio not enabled — set PI_GBA_AUDIO=1 or enable via /gba config", "warning");
      return;
    }
    if (audio.isMuted()) {
      audio.unmute();
      c.ui.notify("GBA: audio unmuted", "info");
    } else {
      audio.mute();
      c.ui.notify("GBA: audio muted", "info");
    }
  }

  handleAltM(undefined, ctx);
  assert.ok(
    notifyCalls.some((n) => n.message.toLowerCase().includes("not enabled") && n.type === "warning"),
    `expected warning about not enabled, got: ${JSON.stringify(notifyCalls)}`,
  );
});

// ---------------------------------------------------------------------------
// Test 11: auto-focus enter calls audio.start(), exit calls audio.stop()
// ---------------------------------------------------------------------------

type HandlerFn = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

test("auto-focus: enter calls audio.start(), exit calls audio.stop() in finally", async () => {
  const audio = makeMockAudio();
  const startHandlers: HandlerFn[] = [];

  let customResolveFn: (() => void) | null = null;
  let customStarted = false;

  const mockCtx: ExtensionContext = {
    ui: {
      notify() {},
      custom: async (
        factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: undefined) => void) => unknown,
      ): Promise<undefined> => {
        customStarted = true;
        return new Promise<undefined>((resolve) => {
          customResolveFn = () => resolve(undefined);
          const done = (r: undefined) => resolve(r);
          const fakeTui = { terminal: { rows: 40, write() {} }, requestRender() {} };
          factory(fakeTui, {}, {}, done);
        });
      },
    },
  } as unknown as ExtensionContext;

  const pi = {
    on(event: string, handler: HandlerFn) {
      if (event === "agent_start") startHandlers.push(handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const render: RenderControllerWithSwap = {
    start() {},
    stop() {},
    shrink() {},
    expand() {},
    hide() {},
    destroy() {},
    onRenderError() {
      return () => {};
    },
    __testGetImageId() {
      return undefined;
    },
    useBackend() {},
    activeBackend() {
      return "widget" as const;
    },
    setCustomComponent() {},
    showStillFrame() {},
    setWidgetLiveTick() {},
  } as unknown as RenderControllerWithSwap;

  const deps: AutoFocusDeps = {
    pi,
    get render() {
      return render;
    },
    emulator: {
      step() {},
      getFramebuffer() {
        return new Uint8Array(0);
      },
      press() {},
      release() {},
    } as unknown as AutoFocusDeps["emulator"],
    lifecycle: {
      attach() {},
      detach() {},
      manualPauseToggle() {},
      isRunning() {
        return false;
      },
      onRomLoad() {},
      isCrashed() {
        return false;
      },
      acknowledgeCrash() {},
    } as Lifecycle,
    getCtx: () => undefined,
    cfg: { autoFocusOnAgentStart: true, autoFocusDebounceMs: 0, scale: 2 },
    caps: { kittyGraphics: true },
    notifyUnsupported() {},
    audio,
    logger: () => {},
  };

  const af = createAutoFocus(deps);
  af.attach();

  // Enter game mode manually
  const enterPromise = af.enterManual(mockCtx);
  await new Promise<void>((r) => setImmediate(r));

  assert.ok(customStarted, "custom UI started");
  assert.strictEqual(audio.startCalls, 1, "audio.start() called on game mode enter");

  // Exit game mode
  defined<() => void>(customResolveFn, "customResolveFn")();
  await enterPromise;

  assert.strictEqual(audio.stopCalls, 1, "audio.stop() called on game mode exit");
});

// ---------------------------------------------------------------------------
// Test 12: audio.start() failure logs but game mode still enters
// ---------------------------------------------------------------------------

test("auto-focus: audio.start() rejection logs but does not block game mode entry", async () => {
  const audio = makeMockAudio({ startReject: true });
  const logMessages: string[] = [];

  let customStarted = false;
  let customResolveFn: (() => void) | null = null;

  const mockCtx: ExtensionContext = {
    ui: {
      notify() {},
      custom: async (
        factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: undefined) => void) => unknown,
      ): Promise<undefined> => {
        customStarted = true;
        return new Promise<undefined>((resolve) => {
          customResolveFn = () => resolve(undefined);
          const done = (r: undefined) => resolve(r);
          const fakeTui = { terminal: { rows: 40, write() {} }, requestRender() {} };
          factory(fakeTui, {}, {}, done);
        });
      },
    },
  } as unknown as ExtensionContext;

  const render: RenderControllerWithSwap = {
    start() {},
    stop() {},
    shrink() {},
    expand() {},
    hide() {},
    destroy() {},
    onRenderError() {
      return () => {};
    },
    __testGetImageId() {
      return undefined;
    },
    useBackend() {},
    activeBackend() {
      return "widget" as const;
    },
    setCustomComponent() {},
    showStillFrame() {},
    setWidgetLiveTick() {},
  } as unknown as RenderControllerWithSwap;

  const pi = {
    on() {},
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const deps: AutoFocusDeps = {
    pi,
    get render() {
      return render;
    },
    emulator: {
      step() {},
      getFramebuffer() {
        return new Uint8Array(0);
      },
      press() {},
      release() {},
    } as unknown as AutoFocusDeps["emulator"],
    lifecycle: {
      attach() {},
      detach() {},
      manualPauseToggle() {},
      isRunning() {
        return false;
      },
      onRomLoad() {},
      isCrashed() {
        return false;
      },
      acknowledgeCrash() {},
    } as Lifecycle,
    getCtx: () => undefined,
    cfg: { autoFocusOnAgentStart: false, autoFocusDebounceMs: 0, scale: 2 },
    caps: { kittyGraphics: true },
    notifyUnsupported() {},
    audio,
    logger: (msg) => logMessages.push(msg),
  };

  const af = createAutoFocus(deps);
  af.attach();

  // Enter game mode manually
  const enterPromise = af.enterManual(mockCtx);
  await new Promise<void>((r) => setImmediate(r));

  // Custom UI should still mount despite audio.start() rejection
  assert.ok(customStarted, "ctx.ui.custom called even when audio.start() rejects");
  assert.ok(
    logMessages.some((m) => m.includes("audio.start() failed")),
    `expected log about start failure, got: ${JSON.stringify(logMessages)}`,
  );

  // Clean up
  defined<() => void>(customResolveFn, "customResolveFn")();
  await enterPromise;
});
