import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CommandDeps } from "../src/commands.js";
import { registerAll } from "../src/commands.js";
import type { Lifecycle, RenderController } from "../src/lifecycle.js";
import type { Persistence } from "../src/persistence.js";

// ---- mock factories ----

type NotifyCall = { message: string; type: string | undefined };

interface FakeCtx {
  ctx: ExtensionCommandContext;
  notifyCalls: NotifyCall[];
  driveCustomDone: (result: unknown) => void;
  wasCustomCalled: () => boolean;
}

function makeFakeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
    getFgAnsi: (_color: string) => "",
    getBgAnsi: (_color: string) => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (text: string) => text,
    getBashModeBorderColor: () => (text: string) => text,
  };
}

function makeFakeCtx(): FakeCtx {
  const notifyCalls: NotifyCall[] = [];
  let customDoneCallback: ((result: unknown) => void) | null = null;
  let customCalled = false;

  const ctx = {
    ui: {
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type });
      },
      custom<T>(
        factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: T) => void) => unknown,
        _options?: unknown,
      ): Promise<T> {
        customCalled = true;
        return new Promise<T>((resolve) => {
          const done = (result: T) => resolve(result);
          customDoneCallback = done as (result: unknown) => void;
          factory(null, makeFakeTheme(), null, done);
        });
      },
    },
  } as unknown as ExtensionCommandContext;

  return {
    ctx,
    notifyCalls,
    driveCustomDone(result: unknown) {
      if (customDoneCallback) customDoneCallback(result);
    },
    wasCustomCalled() {
      return customCalled;
    },
  };
}

function makeFakePersistence(overrides?: Partial<Persistence>): Persistence & {
  loadRomCalls: string[];
} {
  const loadRomCalls: string[] = [];
  let currentBasename: string | undefined;

  const p: Persistence & { loadRomCalls: string[] } = {
    loadRomCalls,
    async loadRom(basename: string) {
      loadRomCalls.push(basename);
      currentBasename = basename;
      return { romPath: `/roms/${basename}`, restoredState: false };
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
      return currentBasename;
    },
    async clearState() {},
    destroy() {},
    ...overrides,
  };

  return p;
}

function makeFakeLifecycle(): Lifecycle & { onRomLoadCalls: number } {
  let onRomLoadCalls = 0;
  const lifecycle = {
    get onRomLoadCalls() {
      return onRomLoadCalls;
    },
    attach() {},
    detach() {},
    manualPauseToggle() {},
    isRunning() {
      return false;
    },
    onRomLoad() {
      onRomLoadCalls++;
    },
    isCrashed() {
      return false;
    },
    acknowledgeCrash() {},
  };
  return lifecycle as Lifecycle & { onRomLoadCalls: number };
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
  invokeGetCompletions: (prefix: string) => Promise<unknown>;
} {
  let registeredHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | null = null;
  let registeredGetCompletions: ((prefix: string) => Promise<unknown> | unknown) | null = null;

  const pi = {
    registerCommand(
      _name: string,
      opts: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => Promise<unknown> | unknown;
      },
    ) {
      registeredHandler = opts.handler;
      registeredGetCompletions = opts.getArgumentCompletions ?? null;
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
    async invokeGetCompletions(prefix: string) {
      if (!registeredGetCompletions) return null;
      return registeredGetCompletions(prefix);
    },
  };
}

function makeDeps(persistenceOverrides?: Partial<Persistence>): {
  deps: CommandDeps;
  persistence: Persistence & { loadRomCalls: string[] };
  lifecycle: Lifecycle & { onRomLoadCalls: number };
} {
  const fakeRender = makeFakeRender();
  const persistence = makeFakePersistence(persistenceOverrides);
  const lifecycle = makeFakeLifecycle();

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
    caps: { kittyGraphics: true, audioBackend: undefined },
    notifyUnsupported(_ctx: ExtensionContext) {},
    audio: undefined,
  };

  return { deps, persistence, lifecycle };
}

// ---- tests ----

test("/gba list — empty dir → warning, no picker", async () => {
  const { pi, invokeCommand } = makeFakePi();
  const { deps } = makeDeps({
    async listRoms() {
      return [];
    },
  });
  const { ctx, notifyCalls, wasCustomCalled } = makeFakeCtx();

  registerAll(pi, deps);
  await invokeCommand("list", ctx);

  assert.ok(
    notifyCalls.some((n) => n.message.includes("No ROMs in") && n.type === "warning"),
    "should warn about empty ROM dir",
  );
  assert.equal(wasCustomCalled(), false, "picker must not be opened");
});

test("/gba list — 3 ROMs → picker shown; select a.gba → loadRom + onRomLoad", async () => {
  const roms = ["a.gba", "b.gba", "c.gba"];
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence, lifecycle } = makeDeps({
    async listRoms() {
      return roms;
    },
  });
  const { ctx, wasCustomCalled, notifyCalls, driveCustomDone } = makeFakeCtx();

  registerAll(pi, deps);

  const cmdPromise = invokeCommand("list", ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(wasCustomCalled(), true, "picker must be opened");

  driveCustomDone({ cancelled: false, basename: "a.gba" });
  await cmdPromise;

  assert.deepEqual(persistence.loadRomCalls, ["a.gba"], "loadRom called with a.gba");
  assert.equal(lifecycle.onRomLoadCalls, 1, "onRomLoad called once");
  assert.ok(
    notifyCalls.some((n) => n.type === "info" && n.message.includes("running")),
    "info notify sent",
  );
});

test("/gba list — cancellation → loadRom NOT called", async () => {
  const roms = ["a.gba", "b.gba"];
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence } = makeDeps({
    async listRoms() {
      return roms;
    },
  });
  const { ctx, driveCustomDone } = makeFakeCtx();

  registerAll(pi, deps);

  const cmdPromise = invokeCommand("list", ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));

  driveCustomDone({ cancelled: true });
  await cmdPromise;

  assert.deepEqual(persistence.loadRomCalls, [], "loadRom must NOT be called on cancel");
});

test("/gba reset — loaded ROM → clearState + loadRom(same) + onRomLoad", async () => {
  let clearStateCallCount = 0;
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence, lifecycle } = makeDeps({
    currentRom() {
      return "game.gba";
    },
    async clearState() {
      clearStateCallCount++;
    },
  });
  const { ctx, notifyCalls } = makeFakeCtx();

  registerAll(pi, deps);
  await invokeCommand("reset", ctx);

  assert.equal(clearStateCallCount, 1, "clearState called once");
  assert.deepEqual(persistence.loadRomCalls, ["game.gba"], "loadRom called with same basename");
  assert.equal(lifecycle.onRomLoadCalls, 1, "onRomLoad called");
  assert.ok(
    notifyCalls.some((n) => n.type === "info" && n.message === "GBA: reset"),
    "reset info notify sent",
  );
});

test("/gba reset — no ROM loaded → warning, no clearState", async () => {
  let clearStateCalled = false;
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence } = makeDeps({
    currentRom() {
      return undefined;
    },
    async clearState() {
      clearStateCalled = true;
    },
  });
  const { ctx, notifyCalls } = makeFakeCtx();

  registerAll(pi, deps);
  await invokeCommand("reset", ctx);

  assert.ok(
    notifyCalls.some((n) => n.type === "warning" && n.message === "No ROM loaded — run /gba first"),
    "warning about no ROM loaded",
  );
  assert.equal(clearStateCalled, false, "clearState must NOT be called");
  assert.deepEqual(persistence.loadRomCalls, [], "loadRom must NOT be called");
});

test("/gba unknown.gba — not in list → error notify listing available", async () => {
  const roms = ["a.gba", "b.gba", "c.gba"];
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence } = makeDeps({
    async listRoms() {
      return roms;
    },
  });
  const { ctx, notifyCalls } = makeFakeCtx();

  registerAll(pi, deps);
  await invokeCommand("unknown.gba", ctx);

  assert.deepEqual(persistence.loadRomCalls, [], "loadRom must NOT be called for unknown ROM");
  const errorNotify = notifyCalls.find((n) => n.type === "error");
  assert.ok(errorNotify, "error notify sent");
  assert.ok(
    errorNotify?.message.includes("No such ROM"),
    `error message should contain "No such ROM", got: ${errorNotify?.message}`,
  );
  assert.ok(errorNotify?.message.includes("a.gba"), "error message should list available ROMs");
});

test("/gba a.gba — valid ROM → loadRom + onRomLoad", async () => {
  const roms = ["a.gba", "b.gba"];
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence, lifecycle } = makeDeps({
    async listRoms() {
      return roms;
    },
  });
  const { ctx, notifyCalls } = makeFakeCtx();

  registerAll(pi, deps);
  await invokeCommand("a.gba", ctx);

  assert.deepEqual(persistence.loadRomCalls, ["a.gba"], "loadRom called with a.gba");
  assert.equal(lifecycle.onRomLoadCalls, 1, "onRomLoad called");
  assert.ok(
    notifyCalls.some((n) => n.type === "info" && n.message.includes("running")),
    "info notify sent",
  );
});

test("/gba <name with spaces> — full args used for ROM load, not first token", async () => {
  const roms = ["Pokemon - Emerald Version (USA).gba", "a.gba"];
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence, lifecycle } = makeDeps({
    async listRoms() {
      return roms;
    },
  });
  const { ctx, notifyCalls } = makeFakeCtx();

  registerAll(pi, deps);
  await invokeCommand("Pokemon - Emerald Version (USA).gba", ctx);

  assert.deepEqual(
    persistence.loadRomCalls,
    ["Pokemon - Emerald Version (USA).gba"],
    "loadRom called with the full basename including spaces",
  );
  assert.equal(lifecycle.onRomLoadCalls, 1, "onRomLoad called");
  assert.ok(!notifyCalls.some((n) => n.type === "error"), "no error notify for a ROM name containing spaces");
});

test("/gba <name with spaces, no extension> — .gba appended to full args", async () => {
  const roms = ["Pokemon - Emerald Version (USA).gba"];
  const { pi, invokeCommand } = makeFakePi();
  const { deps, persistence } = makeDeps({
    async listRoms() {
      return roms;
    },
  });
  const { ctx } = makeFakeCtx();

  registerAll(pi, deps);
  await invokeCommand("Pokemon - Emerald Version (USA)", ctx);

  assert.deepEqual(
    persistence.loadRomCalls,
    ["Pokemon - Emerald Version (USA).gba"],
    ".gba appended to the full space-containing name",
  );
});

test('getArgumentCompletions("") → [list, reset, ...roms]; ("re") → [reset]', async () => {
  const roms = ["pokemon-emerald.gba", "pokemon-ruby.gba"];
  const { pi, invokeGetCompletions } = makeFakePi();
  const { deps } = makeDeps({
    async listRoms() {
      return roms;
    },
  });

  registerAll(pi, deps);

  const all = (await invokeGetCompletions("")) as { value: string }[];
  assert.ok(Array.isArray(all), "completions should be an array");
  const values = all.map((i: { value: string }) => i.value);
  assert.ok(values.indexOf("list") < values.indexOf("reset"), "list before reset");
  assert.ok(values.indexOf("reset") < values.indexOf("pokemon-emerald.gba"), "subs before ROMs");
  assert.ok(values.includes("pokemon-emerald.gba"), "ROM included in completions");

  const re = (await invokeGetCompletions("re")) as { value: string }[];
  assert.ok(Array.isArray(re), "completions for 're' should be an array");
  const reValues = re.map((i: { value: string }) => i.value);
  assert.deepEqual(reValues, ["reset"], 'only "reset" matches "re"');
});
