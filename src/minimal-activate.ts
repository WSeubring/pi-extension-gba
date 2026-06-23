/**
 * Minimal mode — PI_GBA_MINIMAL=1 activation path.
 *
 * Widget-only: /gba loads ROM and starts a widget above the editor. No
 * focus/custom-UI path, no input routing. Emulator ticks in the background
 * via WidgetRenderBackend; pi owns the rest of the screen.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { isKeyRelease, matchesKey } from "@mariozechner/pi-tui";
import type { GbaCapabilities } from "./capabilities.js";
import { detectCapabilities } from "./capabilities.js";
import { registerAll } from "./commands.js";
import type { GbaConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import type { Emulator } from "./emulator.js";
import { createEmulator } from "./emulator.js";
import { classifyGbaKey } from "./input.js";
import type { Lifecycle, RenderController } from "./lifecycle.js";
import { createUnsupportedNotifier } from "./messages.js";
import type { Persistence } from "./persistence.js";
import { createPersistence } from "./persistence.js";
import type { EmulatorLike, RenderControllerWithSwap } from "./render.js";
import { createRenderer } from "./render.js";
import type { ButtonSink, GbaButton } from "./types.js";

const NOOP_LIFECYCLE: Lifecycle = {
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
};

const NOOP_RENDER: RenderController = {
  start() {},
  stop() {},
  shrink() {},
  expand() {},
  hide() {},
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
  private readonly held = new Set<GbaButton>();
  private disposed = false;

  constructor(
    private readonly sink: ButtonSink,
    private readonly done: () => void,
  ) {}

  render(_width: number): string[] {
    return [""];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    // N1: matchesKey handles raw \x03 (ctrl+c) and \x1b (escape) correctly
    // (verified in node_modules/@mariozechner/pi-tui/dist/keys.js — the
    // ctrl+c branch: rawCtrl("c") === "\x03" → data === rawCtrl check;
    // the escape branch: data === "\x1b" check). Raw arms removed as redundant.
    //
    // Press only: this overlay opts into key releases (wantsKeyRelease) and
    // matchesKey also matches release encodings — without the guard the
    // alt+g release that follows the shortcut press closes the overlay
    // immediately (see game-component.ts handleInput for the full story).
    if (
      !isKeyRelease(data) &&
      (matchesKey(data, "alt+g") ||
        matchesKey(data, "escape") ||
        matchesKey(data, "ctrl+c") ||
        matchesKey(data, "q") ||
        matchesKey(data, "shift+q"))
    ) {
      this.done();
      return;
    }
    const event = classifyGbaKey(data);
    switch (event.kind) {
      case "press":
        if (!this.held.has(event.button)) {
          this.sink.press(event.button);
          this.held.add(event.button);
        }
        break;
      case "release":
        if (this.held.has(event.button)) {
          this.sink.release(event.button);
          this.held.delete(event.button);
        }
        break;
      case "repeat":
      case "passthrough":
      case "drop":
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const button of this.held) {
      try {
        this.sink.release(button);
      } catch {
        /* best-effort */
      }
    }
    this.held.clear();
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

  let destroyed = false;
  function destroyEmulator(): void {
    if (destroyed) return;
    destroyed = true;
    try {
      emulator.destroy();
    } catch {
      /* best-effort */
    }
  }

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

  pi.on("session_shutdown", async () => {
    // Best-effort save-state snapshot first (mirrors the full-mode shutdown
    // in index.ts) so a clean exit doesn't lose up to 30s of progress.
    try {
      await persistence.snapshot();
    } catch {
      /* best-effort */
    }
    destroyRender();
    try {
      await persistence.flushPending();
    } catch {
      /* best-effort */
    }
    try {
      persistence.destroy();
    } catch {
      /* best-effort */
    }
    destroyEmulator();
  });
}

export default async function activateMinimal(pi: ExtensionAPI): Promise<void> {
  const caps = detectCapabilities();
  const cfg = await resolveConfig();
  const emulator = await createEmulator();
  const persistence = createPersistence(emulator, { romDir: cfg.romDir, autoSnapshotMs: 30_000 });
  wireMinimal(pi, { emulator, persistence, cfg, caps });
}
