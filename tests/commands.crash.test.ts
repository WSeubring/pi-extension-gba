import { test } from "node:test";
import assert from "node:assert/strict";

import { registerAll } from "../src/commands.js";
import type { CommandDeps } from "../src/commands.js";
import type { Persistence } from "../src/persistence.js";
import type { Lifecycle, RenderController } from "../src/lifecycle.js";
import type { GbaCapabilities } from "../src/capabilities.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---- mock factories ----

type NotifyCall = { message: string; type: string | undefined };

function makeFakeCtx(): {
  ctx: ExtensionCommandContext;
  notifyCalls: NotifyCall[];
  wasCustomCalled: () => boolean;
} {
  const notifyCalls: NotifyCall[] = [];
  let customCalled = false;

  const ctx = {
    ui: {
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type });
      },
      custom<T>(
        _factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
        _options?: unknown,
      ): Promise<T> {
        customCalled = true;
        return new Promise<T>(() => {});
      },
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, notifyCalls, wasCustomCalled: () => customCalled };
}

function makeFakePersistence(overrides?: Partial<Persistence>): Persistence & {
  loadRomCalls: string[];
  clearStateCalls: number;
} {
  const loadRomCalls: string[] = [];
  let clearStateCalls = 0;
  let currentBasename: string | undefined;

  return {
    loadRomCalls,
    get clearStateCalls() { return clearStateCalls; },
    async loadRom(basename: string) {
      loadRomCalls.push(basename);
      currentBasename = basename;
      return { romPath: `/roms/${basename}`, restoredState: false };
    },
    async snapshot() {},
    async flushPending() {},
    async listRoms() { return []; },
    async lastPlayed() { return undefined; },
    currentRom() { return currentBasename; },
    async clearState() { clearStateCalls++; },
    destroy() {},
    ...overrides,
  } as unknown as Persistence & { loadRomCalls: string[]; clearStateCalls: number };
}

function makeFakeLifecycle(isCrashedResult: boolean): Lifecycle & { onRomLoadCalls: number } {
  let onRomLoadCalls = 0;
  return {
    get onRomLoadCalls() { return onRomLoadCalls; },
    attach() {},
    detach() {},
    manualPauseToggle() {},
    isRunning() { return false; },
    onRomLoad() { onRomLoadCalls++; },
    isCrashed() { return isCrashedResult; },
    acknowledgeCrash() {},
  } as unknown as Lifecycle & { onRomLoadCalls: number };
}

function makeFakeRender(): RenderController {
  return {
    start() {},
    stop() {},
    shrink() {},
    expand() {},
    hide() {},
  };
}

function makeFakePi(): {
  pi: ExtensionAPI;
  invokeCommand: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
} {
  let registeredHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | null = null;

  const pi = {
    registerCommand(
      _name: string,
      opts: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>; getArgumentCompletions?: unknown },
    ) {
      registeredHandler = opts.handler;
    },
    on() {},
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  return {
    pi,
    async invokeCommand(args: string, ctx: ExtensionCommandContext) {
      if (!registeredHandler) throw new Error("No command registered");
      await registeredHandler(args, ctx);
    },
  };
}

function makeDeps(
  caps: GbaCapabilities,
  isCrashed: boolean,
  persistenceOverrides?: Partial<Persistence>,
): {
  deps: CommandDeps;
  persistence: Persistence & { loadRomCalls: string[]; clearStateCalls: number };
  lifecycle: Lifecycle & { onRomLoadCalls: number };
  notifyUnsupportedCalls: number;
} {
  const fakeRender = makeFakeRender();
  const persistence = makeFakePersistence(persistenceOverrides);
  const lifecycle = makeFakeLifecycle(isCrashed);
  let notifyUnsupportedCalls = 0;

  const deps: CommandDeps = {
    emulator: {} as never,
    persistence,
    lifecycle,
    ensureRender: () => fakeRender,
    cfg: {
      version: 1 as const,
      romDir: "/roms",
      scale: 2,
      frameRate: 30,
      autoRunOnAgentStart: true,
      autoHideOnAgentEnd: false,
      autoFocusOnAgentStart: true,
      autoFocusDebounceMs: 500,
      audio: false,
    },
    caps,
    notifyUnsupported(_ctx: ExtensionContext) { notifyUnsupportedCalls++; },
    audio: undefined,
  };

  return { deps, persistence, lifecycle, get notifyUnsupportedCalls() { return notifyUnsupportedCalls; } };
}

// ---- tests ----

test("/gba list when isCrashed → clearState called + picker NOT mounted", async () => {
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence } = makeDeps(
    { kittyGraphics: true, audioBackend: undefined },
    true,
    { currentRom() { return "game.gba"; } },
  );
  const { ctx, wasCustomCalled, notifyCalls } = makeFakeCtx();

  registerAll(pi, deps);
  await invokeCommand("list", ctx);

  assert.ok(
    notifyCalls.some((n) => n.type === "warning" && n.message.includes("recovering from crash")),
    "should warn about crash recovery",
  );
  assert.ok(
    (persistence as unknown as { clearStateCalls: number }).clearStateCalls >= 1,
    "clearState should be called during reset",
  );
  assert.equal(wasCustomCalled(), false, "picker must NOT be mounted when crashed");
});

test("/gba when !caps.kittyGraphics → one notify, no loadRom", async () => {
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence } = makeDeps({ kittyGraphics: false, audioBackend: undefined }, false);
  const { ctx, notifyCalls } = makeFakeCtx();

  registerAll(pi, deps);
  await invokeCommand("", ctx);

  assert.equal(notifyCalls.length, 0, "no direct ctx.ui.notify (notifyUnsupported handles it separately)");
  assert.deepEqual(persistence.loadRomCalls, [], "loadRom must NOT be called on unsupported terminal");
});

test("/gba notifyUnsupported called on every invocation when !caps.kittyGraphics (one-shot gate is in index.ts)", async () => {
  const { pi, invokeCommand } = makeFakePi();
  let notifyUnsupportedCount = 0;
  const fakeRender = makeFakeRender();
  const persistence = makeFakePersistence();
  const lifecycle = makeFakeLifecycle(false);

  const deps: CommandDeps = {
    emulator: {} as never,
    persistence,
    lifecycle,
    ensureRender: () => fakeRender,
    cfg: { version: 1 as const, romDir: "/roms", scale: 2, frameRate: 30, autoRunOnAgentStart: true, autoHideOnAgentEnd: false, autoFocusOnAgentStart: true, autoFocusDebounceMs: 500, audio: false },
    caps: { kittyGraphics: false, audioBackend: undefined },
    notifyUnsupported(_ctx: ExtensionContext) { notifyUnsupportedCount++; },
    audio: undefined,
  };

  registerAll(pi, deps);

  const { ctx } = makeFakeCtx();
  await invokeCommand("", ctx);
  assert.equal(notifyUnsupportedCount, 1, "notifyUnsupported called once on first /gba");

  await invokeCommand("", ctx);
  assert.equal(notifyUnsupportedCount, 2, "notifyUnsupported called again on second /gba (closed-over gate is in index.ts, not commands.ts)");
});

test("/gba reset path when crashed: clearState + loadRom called", async () => {
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence, lifecycle } = makeDeps(
    { kittyGraphics: true, audioBackend: undefined },
    true,
    { currentRom() { return "game.gba"; } },
  );
  const { ctx } = makeFakeCtx();

  registerAll(pi, deps);
  await invokeCommand("list", ctx);

  assert.ok(
    (persistence as unknown as { clearStateCalls: number }).clearStateCalls >= 1,
    "clearState called during crash recovery reset",
  );
  assert.ok(
    persistence.loadRomCalls.includes("game.gba"),
    "loadRom called with current ROM during crash recovery",
  );
  assert.equal(lifecycle.onRomLoadCalls, 1, "onRomLoad called once");
});

test("buildCompletions returns null when !caps.kittyGraphics", async () => {
  let registeredGetCompletions: ((prefix: string) => Promise<unknown> | unknown) | null = null;
  const pi = {
    registerCommand(_name: string, opts: { getArgumentCompletions?: (prefix: string) => unknown }) {
      registeredGetCompletions = opts.getArgumentCompletions ?? null;
    },
    on() {},
    registerShortcut() {},
  } as unknown as ExtensionAPI;

  const fakeRender = makeFakeRender();
  const persistence = makeFakePersistence({ async listRoms() { return ["a.gba"]; } });
  const lifecycle = makeFakeLifecycle(false);
  const deps: CommandDeps = {
    emulator: {} as never,
    persistence,
    lifecycle,
    ensureRender: () => fakeRender,
    cfg: { version: 1 as const, romDir: "/roms", scale: 2, frameRate: 30, autoRunOnAgentStart: true, autoHideOnAgentEnd: false, autoFocusOnAgentStart: true, autoFocusDebounceMs: 500, audio: false },
    caps: { kittyGraphics: false, audioBackend: undefined },
    notifyUnsupported() {},
    audio: undefined,
  };

  registerAll(pi, deps);

  const result = await registeredGetCompletions!("");
  assert.equal(result, null, "completions should be null when kittyGraphics is false");
});
