/**
 * Minimal mode — PI_GBA_MINIMAL=1 activation path.
 *
 * Widget-only: /gba loads ROM and starts a widget above the editor. No
 * focus/custom-UI path, no input routing. Emulator ticks in the background
 * via WidgetRenderBackend; pi owns the rest of the screen.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { GbaCapabilities } from "./capabilities.js";
import { detectCapabilities } from "./capabilities.js";
import { registerAll } from "./commands.js";
import type { GbaConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import type { Emulator } from "./emulator.js";
import { createEmulator } from "./emulator.js";
import { GbaInputSession } from "./input.js";
import type { Lifecycle } from "./lifecycle.js";
import { NOOP_RENDER } from "./lifecycle.js";
import { createUnsupportedNotifier } from "./messages.js";
import type { Persistence } from "./persistence.js";
import { createPersistence } from "./persistence.js";
import type { EmulatorLike, RenderControllerWithSwap } from "./render.js";
import { createRenderer } from "./render.js";
import { teardownCore } from "./teardown.js";
import type { ButtonSink } from "./types.js";

const NOOP_LIFECYCLE: Lifecycle = {
  attach() {},
  detach() {},
  onAgentStart() {},
  async onAgentEnd() {},
  manualPauseToggle() {},
  isRunning() {
    return false;
  },
  onRomLoad() {},
  isCrashed() {
    return false;
  },
  acknowledgeCrash() {},
};

/**
 * Invisible overlay that captures keyboard while the widget keeps rendering.
 * render() returns a single empty line so pi-tui allocates no visible area;
 * handleInput forwards GBA keys to the emulator sink and closes on the
 * canonical exit hatches.
 *
 * Exported for unit tests that drive handleInput / dispose directly.
 */
export class InputOverlayComponent implements Component {
  readonly wantsKeyRelease = true;
  private readonly input: GbaInputSession;
  private disposed = false;

  constructor(
    sink: ButtonSink,
    private readonly done: () => void,
  ) {
    // No decay timer: this overlay gets reliable key-release events.
    this.input = new GbaInputSession(sink, 0);
  }

  render(_width: number): string[] {
    return [""];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.input.handleKey(data) === "exit") {
      this.done();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.releaseAll();
  }
}

/** Injectable seams for testing. Production path uses real module defaults. */
export interface MinimalSeams {
  createRenderer?: typeof createRenderer;
}

/**
 * Wire /gba + session_shutdown onto pi using already-built emulator, config,
 * persistence, caps. Exported for unit tests that cannot load the mGBA WASM
 * module inside node --test.
 */
export function wireMinimal(
  pi: ExtensionAPI,
  deps: {
    emulator: Emulator;
    persistence: Persistence;
    cfg: GbaConfig;
    caps: GbaCapabilities;
  },
  seams: MinimalSeams = {},
): void {
  const { emulator, persistence, cfg, caps } = deps;
  const makeRenderer = seams.createRenderer ?? createRenderer;

  const notifyUnsupported = createUnsupportedNotifier();

  let activeRender: RenderControllerWithSwap | undefined;

  function destroyRender(): void {
    if (activeRender === undefined) return;
    try {
      activeRender.destroy();
    } catch {
      /* best-effort */
    }
    activeRender = undefined;
  }

  let overlayActive = false;
  async function toggleOverlay(ctx: ExtensionContext): Promise<void> {
    if (overlayActive) return;
    if (activeRender === undefined) {
      ctx.ui.notify("GBA: no ROM loaded — run /gba <rom> first", "info");
      return;
    }
    overlayActive = true;
    try {
      // N2: emulator implements ButtonSink directly (Emulator implements ButtonSink
      // per src/emulator.ts:61) — no cast needed.
      await ctx.ui.custom(
        (_tui: TUI, _theme, _keybindings, done) => new InputOverlayComponent(emulator, () => done(undefined)),
        { overlay: true, overlayOptions: { width: 1, anchor: "center" } },
      );
    } catch (err) {
      // B3: if ctx.ui.custom throws or rejects (e.g. factory error, pi overlay
      // rejection) notify the user so alt+g doesn't silently fail.
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`GBA: input overlay failed: ${msg}`, "error");
    } finally {
      overlayActive = false;
    }
  }

  // Widget-only entry: start a tick loop that writes PNG frames into a pi
  // widget. If /gba is re-invoked with a new ROM, the caller has already
  // swapped the emulator's ROM; we dispose the prior widget + tick and spin
  // up a fresh one so the Kitty image id cycles cleanly.
  async function enterGameMode(ctx: ExtensionContext): Promise<void> {
    if (!caps.kittyGraphics) {
      notifyUnsupported(ctx);
      return;
    }
    destroyRender();
    activeRender = makeRenderer(ctx, emulator as unknown as EmulatorLike, {
      scale: cfg.scale,
      frameRate: cfg.frameRate,
      initialBackend: "widget",
    });
    activeRender.setWidgetLiveTick(true);
    activeRender.start();
  }

  registerAll(pi, {
    emulator,
    persistence,
    lifecycle: NOOP_LIFECYCLE,
    ensureRender: (_ctx: ExtensionCommandContext) => NOOP_RENDER,
    cfg,
    caps,
    notifyUnsupported,
    audio: undefined,
    enterGameMode,
  });

  // N3: Updated description to list all exit keys.
  pi.registerShortcut("alt+g", {
    description: "Toggle GBA input overlay (alt+g / esc / q to exit)",
    handler: (ctx) => toggleOverlay(ctx),
  });

  let toreDown = false;
  pi.on("session_shutdown", async () => {
    // Guard re-entry: pi may fire session_shutdown more than once, and the
    // shared teardown is not itself idempotent.
    if (toreDown) return;
    toreDown = true;
    await teardownCore({ persistence, emulator, render: activeRender });
  });
}

export default async function activateMinimal(pi: ExtensionAPI): Promise<void> {
  const caps = detectCapabilities();
  const cfg = await resolveConfig();
  const emulator = await createEmulator();
  const persistence = createPersistence(emulator, { romDir: cfg.romDir, autoSnapshotMs: 30_000 });
  wireMinimal(pi, { emulator, persistence, cfg, caps });
}
