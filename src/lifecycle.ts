import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Emulator } from "./emulator.js";
import type { GbaButton } from "./types.js";

const GBA_BUTTONS: GbaButton[] = [
  "up", "down", "left", "right", "a", "b", "l", "r", "start", "select",
];

// Minimal interface lifecycle consumes from Phase 2's RenderController.
// Phase 2's RenderController is a superset; this interface is the contract.
export interface RenderController {
  start(): void;
  stop(): void;
  shrink(): void;
  expand(): void;
  hide(): void;
  /** Phase 9 REVISE B3: optional still-frame flush on Running→Paused. */
  showStillFrame?(): void;
}

export interface LifecycleOptions {
  autoRunOnAgentStart: boolean;
  autoHideOnAgentEnd: boolean;
  logger?: (msg: string) => void;
  onPause?: () => Promise<void>;
}

export interface Lifecycle {
  attach(): void;
  detach(): void;
  manualPauseToggle(): void;
  isRunning(): boolean;
  onRomLoad(): void;
  isCrashed(): boolean;
  acknowledgeCrash(): void;
  /**
   * Resume from Paused for auto-entered game mode. Unlike onRomLoad() it
   * preserves the crash flag and respects a manual pause (alt+shift+g):
   * if the user explicitly paused, auto-focus entry shows the still-frame
   * per Phase 9 L3 instead of silently unpausing. Optional so minimal-mode
   * and test stubs need not implement it.
   */
  resume?(): void;
}

type State = "Idle" | "Running" | "Paused";

// getRender is a getter rather than a direct reference so that index.ts can
// construct the renderer lazily (on the first /gba command invocation, where
// an ExtensionContext is available) and hand it to lifecycle after the fact.
// Lifecycle stays inert in Idle state until onRomLoad() is called, so it
// will never invoke render methods before getRender() returns a controller.
export function createLifecycle(
  pi: ExtensionAPI,
  emulator: Emulator,
  getRender: () => RenderController | undefined,
  opts: LifecycleOptions,
): Lifecycle {
  let state: State = "Idle";
  let manualOverride = false;
  let attached = false;
  let crashed = false;

  // Silent by default — pi's TUI in Ghostty captures BOTH stdout and stderr
  // from loaded extensions and prepends them as in-band rows, so lifecycle
  // diagnostics visibly leak above the status bar (observed 2026-04-19).
  // Callers who want the trace pass opts.logger explicitly.
  const log = (msg: string) => opts.logger?.(msg);

  function goRunning(): void {
    const render = getRender();
    if (!render) return;
    render.start();
    render.expand();
    state = "Running";
    log("[pi-extension-gba] state → Running");
  }

  async function goPaused(): Promise<void> {
    const render = getRender();
    if (!render) {
      state = "Paused";
      return;
    }
    render.stop();
    if (opts.autoHideOnAgentEnd) {
      render.hide();
    } else {
      render.shrink();
      // Phase 9 REVISE B3: flush a one-shot still frame so the widget surface
      // shows the paused scene without needing a live tick loop. No-op if
      // the controller does not expose showStillFrame (e.g. minimal stubs
      // used in tests).
      render.showStillFrame?.();
    }
    // Transition BEFORE awaiting onPause (disk I/O): while the await is
    // pending, state must already read "Paused" so a duplicate agent_end or
    // manualPauseToggle cannot re-enter goPaused, and a goRunning() during
    // the await is not clobbered by a late state write afterwards.
    state = "Paused";
    log("[pi-extension-gba] state → Paused");
    if (opts.onPause) {
      try {
        await opts.onPause();
      } catch (err) {
        log("[pi-extension-gba] onPause: " + String(err));
      }
    }
  }

  emulator.onCrash((err) => {
    opts.logger?.(
      `[pi-extension-gba] GBA crashed — try /gba reset: ${err.message}`,
    );
    crashed = true;
    state = "Paused";
    manualOverride = true;
    const render = getRender();
    if (render) {
      render.stop();
      if (opts.autoHideOnAgentEnd) {
        render.hide();
      } else {
        render.shrink();
      }
    }
  });

  const lifecycle: Lifecycle = {
    attach() {
      if (attached) return;
      attached = true;

      pi.on("agent_start", async (_event, ctx) => {
        try {
          // pi.on offers no unsubscribe — after detach() this handler stays
          // registered, so it must self-disarm (and a detach→attach cycle
          // would otherwise run doubled handlers).
          if (!attached) return;
          if (state !== "Paused") return;
          if (!opts.autoRunOnAgentStart) return;
          if (manualOverride) return;
          goRunning();
        } catch (err) {
          ctx.ui.notify(
            `GBA lifecycle error: ${String((err as Error).message ?? err)}`,
            "error",
          );
          log(`[pi-extension-gba] agent_start handler threw: ${String(err)}`);
        }
      });

      pi.on("agent_end", async (_event, ctx) => {
        try {
          if (!attached) return;
          if (state !== "Running") return;
          if (manualOverride) return;
          await goPaused();
        } catch (err) {
          ctx.ui.notify(
            `GBA lifecycle error: ${String((err as Error).message ?? err)}`,
            "error",
          );
          log(`[pi-extension-gba] agent_end handler threw: ${String(err)}`);
        }
      });

      pi.registerShortcut("alt+shift+g", {
        description: "Toggle GBA pause/resume manually",
        handler: (ctx: ExtensionContext) => {
          try {
            if (!attached) return;
            lifecycle.manualPauseToggle();
          } catch (err) {
            ctx.ui.notify(
              `GBA lifecycle error: ${String((err as Error).message ?? err)}`,
              "error",
            );
            log(
              `[pi-extension-gba] alt+shift+g handler threw: ${String(err)}`,
            );
          }
        },
      });
    },

    detach() {
      if (state === "Idle" && !attached) return;

      if (emulator) {
        for (const button of GBA_BUTTONS) {
          try {
            emulator.release(button);
          } catch {
            // best-effort: continue releasing remaining buttons
          }
        }
      }

      const render = getRender();
      if (render) {
        render.stop();
      }
      state = "Idle";
      attached = false;
      manualOverride = false;
      log("[pi-extension-gba] state → Idle (detached)");
    },

    manualPauseToggle() {
      if (crashed) return;
      manualOverride = true;
      if (state === "Running") {
        void goPaused();
        log("[pi-extension-gba] manual pause");
      } else if (state === "Paused") {
        goRunning();
        log("[pi-extension-gba] manual resume");
      }
    },

    isRunning() {
      return state === "Running";
    },

    resume() {
      if (crashed || manualOverride) return;
      if (state !== "Paused") return;
      goRunning();
    },

    onRomLoad() {
      manualOverride = false;
      crashed = false;
      goRunning();
    },

    isCrashed() {
      return crashed;
    },

    acknowledgeCrash() {
      crashed = false;
    },
  };

  return lifecycle;
}
