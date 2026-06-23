import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CommandDeps } from "../src/commands.js";
import { registerAll } from "../src/commands.js";
import type { GbaConfig } from "../src/config.js";
import { loadConfigFile, popQueuedWarning, saveConfigFile } from "../src/config.js";
import { handleConfig } from "../src/config-menu.js";
import type { Lifecycle, RenderController } from "../src/lifecycle.js";
import type { Persistence } from "../src/persistence.js";
import { defined } from "./harness/assert.js";

// ---- temp HOME helpers -------------------------------------------------------

async function withTempHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pi-gba-cmd-cfg-"));
  const nestedDir = path.join(dir, ".config", "pi");
  await fsPromises.mkdir(nestedDir, { recursive: true });

  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return await fn(dir);
  } finally {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    await fsPromises.rm(dir, { recursive: true, force: true });
    popQueuedWarning();
  }
}

// ---- mock factories ---------------------------------------------------------

type NotifyCall = { message: string; type: string | undefined };

interface SelectEntry {
  title: string;
  options: string[];
  result: string | undefined;
}

interface InputEntry {
  title: string;
  placeholder: string | undefined;
  result: string | undefined;
}

interface ConfirmEntry {
  title: string;
  message: string;
  result: boolean;
}

interface FakeUiCtx {
  ctx: ExtensionCommandContext;
  notifyCalls: NotifyCall[];
  selectCalls: SelectEntry[];
  inputCalls: InputEntry[];
  confirmCalls: ConfirmEntry[];
}

function makeFakeCtx(
  selectResults: (string | undefined)[],
  inputResults: (string | undefined)[] = [],
  confirmResults: boolean[] = [],
): FakeUiCtx {
  const notifyCalls: NotifyCall[] = [];
  const selectCalls: SelectEntry[] = [];
  const inputCalls: InputEntry[] = [];
  const confirmCalls: ConfirmEntry[] = [];

  let selectIdx = 0;
  let inputIdx = 0;
  let confirmIdx = 0;

  const ctx = {
    ui: {
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type: type ?? undefined });
      },
      async select(title: string, options: string[]): Promise<string | undefined> {
        const result = selectResults[selectIdx++];
        selectCalls.push({ title, options, result });
        return result;
      },
      async input(title: string, placeholder?: string): Promise<string | undefined> {
        const result = inputResults[inputIdx++];
        inputCalls.push({ title, placeholder, result });
        return result;
      },
      async confirm(title: string, message: string): Promise<boolean> {
        const result = confirmResults[confirmIdx++] ?? false;
        confirmCalls.push({ title, message, result });
        return result;
      },
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, notifyCalls, selectCalls, inputCalls, confirmCalls };
}

function makeFakePersistence(): Persistence {
  return {
    async loadRom(basename: string) {
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
      return undefined;
    },
    async clearState() {},
    destroy() {},
  };
}

function makeFakeLifecycle(): Lifecycle {
  return {
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
  } as unknown as Lifecycle;
}

function makeFakeRender(): RenderController {
  return { start() {}, stop() {}, shrink() {}, expand() {}, hide() {} };
}

function makeBaseCfg(overrides?: Partial<GbaConfig>): GbaConfig {
  return {
    version: 1,
    romDir: "/roms",
    scale: 2,
    frameRate: 30,
    autoRunOnAgentStart: true,
    autoHideOnAgentEnd: false,
    autoFocusOnAgentStart: true,
    autoFocusDebounceMs: 500,
    audio: false,
    ...overrides,
  };
}

function makeDeps(cfg?: GbaConfig): CommandDeps {
  return {
    emulator: {} as never,
    persistence: makeFakePersistence(),
    lifecycle: makeFakeLifecycle(),
    ensureRender: () => makeFakeRender(),
    cfg: cfg ?? makeBaseCfg(),
    caps: { kittyGraphics: true, audioBackend: undefined },
    notifyUnsupported(_ctx: ExtensionContext) {},
    audio: undefined,
  };
}

// ---- tests ------------------------------------------------------------------

// Test 8: menu flow — drive Scale → "3x" → on-disk JSON contains scale:3
test("menu flow: pick Scale → 3x → saves scale:3 to disk", async () => {
  await withTempHome(async () => {
    const deps = makeDeps();
    // selectResults sequence:
    //   1st call = main menu pick "Scale: 2x"
    //   2nd call = scale sub-menu → "3x"
    //   3rd call = main menu → "Close" to exit
    const { ctx, notifyCalls } = makeFakeCtx(["Scale: 2x", "3x", "Close"]);

    await handleConfig(ctx, deps.cfg);

    // Check in-memory cfg updated
    assert.equal(deps.cfg.scale, 3, "in-memory cfg.scale should be 3");

    // Check on-disk JSON
    const loaded = await loadConfigFile();
    assert.equal(loaded.scale, 3, "on-disk scale should be 3");

    // Check notify
    const saveNotify = notifyCalls.find((n) => n.message.includes("scale = 3x"));
    assert.ok(saveNotify, "save notification should mention scale = 3x");
    assert.equal(saveNotify?.type, "info");
  });
});

// Test 9: menu cancel path — select returns undefined → no write
test("menu cancel: select returns undefined → no write, no notify", async () => {
  await withTempHome(async () => {
    const deps = makeDeps();
    // First select returns undefined (user dismissed)
    const { ctx, notifyCalls } = makeFakeCtx([undefined]);

    await handleConfig(ctx, deps.cfg);

    // No save should have happened
    const loaded = await loadConfigFile();
    assert.deepEqual(loaded, {}, "nothing should be written to disk on cancel");
    const saveNotify = notifyCalls.filter((n) => n.message.includes("GBA config saved"));
    assert.equal(saveNotify.length, 0, "no save notification should be sent");
  });
});

// Test: boolean toggle — autoFocusOnAgentStart on → off
test("menu flow: toggle autoFocusOnAgentStart off → saved", async () => {
  await withTempHome(async () => {
    const deps = makeDeps();
    const { ctx } = makeFakeCtx(["Auto-focus on agent_start: on", "off", "Close"]);

    await handleConfig(ctx, deps.cfg);

    assert.equal(deps.cfg.autoFocusOnAgentStart, false, "autoFocusOnAgentStart should be false");
    const loaded = await loadConfigFile();
    assert.equal(loaded.autoFocusOnAgentStart, false, "on-disk should be false");
  });
});

// Test: number input — autoFocusDebounceMs
test("menu flow: change debounce to 1200 → saved", async () => {
  await withTempHome(async () => {
    const deps = makeDeps();
    const { ctx } = makeFakeCtx(["Auto-focus debounce: 500 ms", "Close"], ["1200"]);

    await handleConfig(ctx, deps.cfg);

    assert.equal(deps.cfg.autoFocusDebounceMs, 1200, "autoFocusDebounceMs should be 1200");
    const loaded = await loadConfigFile();
    assert.equal(loaded.autoFocusDebounceMs, 1200, "on-disk should be 1200");
  });
});

// Test: invalid number input → warning, no save
test("menu flow: invalid debounce input → warning, loop continues, then Close", async () => {
  await withTempHome(async () => {
    const deps = makeDeps();
    const { ctx, notifyCalls } = makeFakeCtx(["Auto-focus debounce: 500 ms", "Close"], ["not-a-number"]);

    await handleConfig(ctx, deps.cfg);

    const warnNotify = notifyCalls.find((n) => n.type === "warning" && n.message.includes("invalid"));
    assert.ok(warnNotify, "warning should be emitted for invalid input");

    const loaded = await loadConfigFile();
    assert.deepEqual(loaded, {}, "nothing should be written for invalid input");
  });
});

// Test: empty debounce input → warning, no save (Number("") is 0, must not save 0)
test("menu flow: empty debounce input → warning, no save", async () => {
  await withTempHome(async () => {
    const deps = makeDeps();
    const { ctx, notifyCalls } = makeFakeCtx(
      ["Auto-focus debounce: 500 ms", "Auto-focus debounce: 500 ms", "Close"],
      ["", "   "],
    );

    await handleConfig(ctx, deps.cfg);

    const warnings = notifyCalls.filter((n) => n.type === "warning" && n.message.includes("invalid"));
    assert.equal(warnings.length, 2, "warning emitted for both empty and whitespace input");
    assert.equal(deps.cfg.autoFocusDebounceMs, 500, "cfg.autoFocusDebounceMs unchanged");

    const loaded = await loadConfigFile();
    assert.deepEqual(loaded, {}, "nothing should be written for empty input");
  });
});

// Test: env overrides must not be baked into gba.json when saving an unrelated key
test("env override (PI_GBA_AUDIO=1) not persisted when saving an unrelated key", async () => {
  const { resolveConfig } = await import("../src/config.js");

  await withTempHome(async () => {
    const origEnv = process.env.PI_GBA_AUDIO;
    process.env.PI_GBA_AUDIO = "1";
    try {
      // Runtime cfg carries the session-scoped env override (audio: true).
      const cfg = await resolveConfig();
      assert.equal(cfg.audio, true, "precondition: env override active in runtime cfg");
      const deps = makeDeps(cfg);

      // Save an unrelated key (debounce) via the config menu.
      const { ctx } = makeFakeCtx(["Auto-focus debounce: 500 ms", "Close"], ["1200"]);
      await handleConfig(ctx, deps.cfg);

      assert.equal(deps.cfg.audio, true, "runtime cfg keeps the env override");
      const loaded = await loadConfigFile();
      assert.equal(loaded.autoFocusDebounceMs, 1200, "changed key persisted");
      assert.notEqual(loaded.audio, true, "env-only audio override must NOT be baked into gba.json");
    } finally {
      if (origEnv === undefined) {
        delete process.env.PI_GBA_AUDIO;
      } else {
        process.env.PI_GBA_AUDIO = origEnv;
      }
    }
  });
});

// Test 10: /gba config reset subcommand dispatches resetConfigFile and re-reads cfg
test("/gba config reset: clears config file and resets deps.cfg to defaults", async () => {
  await withTempHome(async () => {
    // Write a non-default config first
    await saveConfigFile({
      version: 1,
      romDir: "/roms",
      scale: 3,
      frameRate: 15,
      autoRunOnAgentStart: false,
      autoHideOnAgentEnd: true,
      autoFocusOnAgentStart: false,
      autoFocusDebounceMs: 2000,
      audio: true,
    });

    const deps = makeDeps();
    // Override deps.cfg to reflect the saved state
    deps.cfg.scale = 3;
    deps.cfg.frameRate = 15;

    // Build a fake pi and ctx that supports notify + confirm for the dispatch test
    let registeredHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | null = null;
    const pi = {
      registerCommand(
        _name: string,
        opts: {
          handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
          getArgumentCompletions?: unknown;
        },
      ) {
        registeredHandler = opts.handler;
      },
      on() {},
      registerShortcut() {},
    } as unknown as ExtensionAPI;

    const notifyCalls: NotifyCall[] = [];
    const ctx = {
      ui: {
        notify(message: string, type?: string) {
          notifyCalls.push({ message, type: type ?? undefined });
        },
        async select() {
          return "Close";
        },
        async input() {
          return undefined;
        },
        async confirm() {
          return false;
        },
      },
    } as unknown as ExtensionCommandContext;

    registerAll(pi, deps);
    await defined<(args: string, ctx: ExtensionCommandContext) => Promise<void>>(
      registeredHandler,
      "registeredHandler",
    )("config reset", ctx);

    // Config file should be gone
    const loaded = await loadConfigFile();
    assert.deepEqual(loaded, {}, "config file should be absent after reset");

    // deps.cfg should be reset to defaults
    assert.equal(deps.cfg.scale, 2, "deps.cfg.scale should be reset to default 2");
    assert.equal(deps.cfg.frameRate, 30, "deps.cfg.frameRate should be reset to default 30");

    // Notify should be sent
    const resetNotify = notifyCalls.find((n) => n.message.includes("reset to defaults"));
    assert.ok(resetNotify, "reset notification should be sent");

    // romDir changed back to default but persistence resolved it at
    // activation — the user must be told a restart is needed.
    const romDirNotify = notifyCalls.find((n) => n.message.includes("romDir change requires restart"));
    assert.ok(romDirNotify, "romDir restart-gated notification should be sent when romDir changes");
  });
});

// Test: resolveConfig precedence — env > file > default
test("resolveConfig precedence: PI_GBA_AUTO_FOCUS=1 overrides file autoFocusOnAgentStart:false", async () => {
  // Dynamic import to get fresh module state
  const { resolveConfig } = await import("../src/config.js");

  await withTempHome(async () => {
    // Write file with autoFocusOnAgentStart: false
    await saveConfigFile({
      version: 1,
      romDir: "/roms",
      scale: 2,
      frameRate: 30,
      autoRunOnAgentStart: true,
      autoHideOnAgentEnd: false,
      autoFocusOnAgentStart: false,
      autoFocusDebounceMs: 500,
      audio: false,
    });

    const origEnv = process.env.PI_GBA_AUTO_FOCUS;
    process.env.PI_GBA_AUTO_FOCUS = "1";
    try {
      const cfg = await resolveConfig();
      assert.equal(cfg.autoFocusOnAgentStart, true, "env PI_GBA_AUTO_FOCUS=1 should override file value false");
    } finally {
      if (origEnv === undefined) {
        delete process.env.PI_GBA_AUTO_FOCUS;
      } else {
        process.env.PI_GBA_AUTO_FOCUS = origEnv;
      }
    }
  });
});

// Test: resolveConfig precedence — file > default
test("resolveConfig precedence: file scale:1 overrides default scale:2", async () => {
  const { resolveConfig } = await import("../src/config.js");

  await withTempHome(async () => {
    await saveConfigFile({
      version: 1,
      romDir: "/roms",
      scale: 1,
      frameRate: 30,
      autoRunOnAgentStart: true,
      autoHideOnAgentEnd: false,
      autoFocusOnAgentStart: true,
      autoFocusDebounceMs: 500,
      audio: false,
    });

    // Ensure no env var overriding
    const origEnv = process.env.PI_GBA_AUTO_FOCUS;
    delete process.env.PI_GBA_AUTO_FOCUS;
    try {
      const cfg = await resolveConfig();
      assert.equal(cfg.scale, 1, "file scale:1 should override default scale:2");
    } finally {
      if (origEnv !== undefined) process.env.PI_GBA_AUTO_FOCUS = origEnv;
    }
  });
});
