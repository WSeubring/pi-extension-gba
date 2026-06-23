/**
 * Phase 9c — Auto-focus lifecycle coupling.
 *
 * Subscribes to agent_start / agent_end pi events and drives
 * enter/exit of full-screen game mode (ctx.ui.custom).
 *
 * Design ref: docs/design/phase-9c-auto-focus-lifecycle.md
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RenderControllerWithSwap } from "./render.js";
import type { EmulatorLike } from "./render.js";
import type { ButtonSink } from "./types.js";
import type { Lifecycle } from "./lifecycle.js";
import type { AudioPlayer } from "./audio.js";
import { GbaGameComponent } from "./game-component.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutoFocusDeps {
  pi: ExtensionAPI;
  render: RenderControllerWithSwap | undefined;
  emulator: EmulatorLike & ButtonSink;
  lifecycle: Lifecycle;
  getCtx: () => ExtensionContext | undefined;
  cfg: {
    autoFocusOnAgentStart: boolean;
    autoFocusDebounceMs: number;
    scale: 1 | 2 | 3;
  };
  caps: {
    kittyGraphics: boolean;
  };
  notifyUnsupported: (ctx: ExtensionContext) => void;
  logger?: (msg: string) => void;
  /** Audio player — undefined in silent mode (L9 parity). */
  audio: AudioPlayer | undefined;
}

export interface AutoFocus {
  /** Subscribe to pi events, register alt+g shortcut. */
  attach(): void;
  /** Unsubscribe, release any live custom UI. */
  detach(): void;
  /** Called when alt+g is pressed in chat mode — enter game mode. */
  enterManual(ctx: ExtensionContext): Promise<void>;
  /** Called when alt+g is pressed in game mode — exit game mode. */
  exitManual(): void;
  /** Whether we are currently in game mode. */
  isInGameMode(): boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createAutoFocus(deps: AutoFocusDeps): AutoFocus {
  const { pi, emulator, lifecycle, cfg, caps, notifyUnsupported } = deps;
  const log = (msg: string) =>
    deps.logger ? deps.logger(msg) : console.error(msg);

  // Convenience accessor for the optional audio player.
  function getAudio(): AudioPlayer | undefined {
    return deps.audio;
  }

  /** Whether the custom UI is currently live. */
  let mode: "chat" | "game" = "chat";

  /**
   * Set by alt+g while in chat during an agent turn → stays in game across
   * agent_end (no auto-exit). Cleared when user presses alt+g again to exit.
   */
  let manualEnteredDuringChat = false;

  /**
   * Set when the user presses alt+g while in game mode mid-agent → block
   * the CURRENT and NEXT auto-entry. Cleared on the agent_end following the
   * exit (so the next agent_start can auto-enter again).
   */
  let manualExitedDuringGame = false;

  /** Pending debounce timer — cancel on agent_end to absorb fast replies. */
  let pendingEnterTimer: ReturnType<typeof setTimeout> | undefined;

  /** Live component ref — needed to call requestClose() from auto-exit. */
  let liveComponent: GbaGameComponent | undefined;

  /**
   * Set when exit() fires in the window between `mode = "game"` and the
   * component mount (audio.start await + factory): liveComponent is still
   * undefined then, so the close must be replayed right after the mount.
   */
  let closeRequested = false;

  /**
   * Generation counter for enter() sessions. The finally block runs after
   * an await (audio.stop can take 200 ms+); a NEW enter() started during
   * that await owns the backend, so a stale finally must not restore
   * "widget" out from under it.
   */
  let enterGen = 0;

  /** Whether attach() has been called. */
  let attached = false;

  // ---------------------------------------------------------------------------
  // Core enter / exit helpers
  // ---------------------------------------------------------------------------

  async function enter(
    ctx: ExtensionContext,
    opts?: { resume?: boolean },
  ): Promise<void> {
    const render = deps.render;
    if (!render) {
      log("[pi-extension-gba] auto-focus enter: no render controller (no ROM loaded)");
      return;
    }
    if (mode === "game") return;

    const myGen = ++enterGen;
    mode = "game";
    closeRequested = false;
    log("[pi-extension-gba] auto-focus → GameMode");

    // Start audio before entering game mode. Failures are logged but must
    // not block GameMode entry (L9/L10).
    try {
      await getAudio()?.start();
    } catch (err) {
      log(`[pi-extension-gba] audio.start() failed: ${String((err as Error)?.message ?? err)}`);
    }

    try {
      await ctx.ui.custom((tui, _theme, _keybindings, done) => {
        const component = new GbaGameComponent(
          tui,
          { emulator: emulator as unknown, sink: emulator, scale: cfg.scale },
          done,
        );
        liveComponent = component;

        // Wire component into the custom backend, THEN swap the backend so
        // the tick loop immediately routes frames to the new component.
        render.setCustomComponent(component);
        render.useBackend("custom");

        // Auto-entry must show a RUNNING game. With autoRunOnAgentStart=false
        // the lifecycle pauses the tick loop on agent_end and nothing restarts
        // it on the next auto-entry — game mode then mounts a frozen frame
        // with a silent (but spawned) audio subprocess. resume() is a no-op
        // when already Running, crashed, or manually paused (L3 still-frame).
        if (opts?.resume) {
          lifecycle.resume?.();
        }

        // exit() fired while we were still mounting (agent_end during the
        // audio.start await) — replay the close now that the component can
        // actually honour it, so game mode doesn't outlive the agent turn.
        if (closeRequested) {
          closeRequested = false;
          component.requestClose();
        }

        return component;
      });
    } catch (err) {
      // Surface UI failures here: both call sites fire-and-forget
      // (`void enter(...)`), so a propagated rejection would become an
      // unhandled rejection in the pi host.
      log(`[pi-extension-gba] game mode UI failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
      // custom() resolved — either done() was called or the UI was dismissed.
      liveComponent = undefined;
      mode = "chat";
      closeRequested = false;

      // Stop audio on GameMode exit. Failures are logged but must not block
      // cleanup (L9/L10).
      try {
        await getAudio()?.stop();
      } catch (err) {
        log(`[pi-extension-gba] audio.stop() failed: ${String((err as Error)?.message ?? err)}`);
      }

      // A new enter() may have started during the audio.stop await above —
      // it passed the mode guard (mode was already "chat") and now owns the
      // backend. Only the current generation may restore "widget".
      if (enterGen === myGen) {
        // Restore the widget render backend so lifecycle's tick loop works.
        const currentRender = deps.render;
        if (currentRender && currentRender.activeBackend() === "custom") {
          currentRender.useBackend("widget");
          // Phase 9 REVISE B3: flush a one-shot still frame so the transition
          // back to chat mode is visually continuous. L5 disables ambient
          // widget ticking, so this is the only frame shown until the next
          // lifecycle transition or user action.
          const withStill = currentRender as RenderControllerWithSwap & {
            showStillFrame?: () => void;
          };
          withStill.showStillFrame?.();
        }
        log("[pi-extension-gba] auto-focus → ChatMode");
      }
    }
  }

  function exit(): void {
    if (mode !== "game") return;
    if (liveComponent) {
      liveComponent.requestClose();
      // liveComponent and mode are cleared in the enter() finally block.
    } else {
      // enter() set mode="game" but has not mounted the component yet
      // (still awaiting audio.start / the factory). Record the close so the
      // mount replays it instead of leaving game mode up after agent_end.
      closeRequested = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Phase 9 REVISE B3: configure widget backend live-tick based on cfg.
   * Auto-focus enabled (default) → widget does not tick ambiently (L2/L5).
   * Auto-focus disabled (PI_GBA_AUTO_FOCUS=0 / opt-out) → widget reverts to
   * pre-Phase-9 live-tick behaviour.
   *
   * Called on attach() and re-called if cfg later changes (not supported today
   * but harmless). Safe to call before a render controller exists; the getter
   * may still return undefined, in which case we retry from attach().
   */
  function applyWidgetLiveTickPolicy(): void {
    const render = deps.render;
    if (!render) return;
    // Render may be a plain RenderController stub in tests; guard the method.
    const withSwap = render as RenderControllerWithSwap & {
      setWidgetLiveTick?: (enabled: boolean) => void;
    };
    withSwap.setWidgetLiveTick?.(!cfg.autoFocusOnAgentStart);
  }

  const autoFocus: AutoFocus = {
    attach() {
      if (attached) return;
      attached = true;

      applyWidgetLiveTickPolicy();

      // ---- agent_start handler ----
      pi.on("agent_start", async (_event, ctx) => {
        // Cache the ctx so exitManual can use it.
        // (Design says "cache most recent ctx" — we do it on every event.)

        // pi.on offers no unsubscribe — after detach() this handler stays
        // registered and must self-disarm (a detach→attach cycle would
        // otherwise also run doubled handlers).
        if (!attached) return;
        if (!cfg.autoFocusOnAgentStart) return;
        if (!deps.render) return;  // no ROM loaded yet
        if (!caps.kittyGraphics) return;
        // Re-apply on every agent_start so lazily-constructed renderers
        // pick up the "no ambient widget" policy before the first Running tick.
        applyWidgetLiveTickPolicy();
        if (manualExitedDuringGame) return;  // user exited mid-agent; suppress
        if (mode === "game") return;  // already in game mode

        // Phase 9 REVISE B3: defensive — clear any previously armed timer so
        // back-to-back agent_start events (theoretical race) never leave two
        // concurrent debounce timers live.
        if (pendingEnterTimer !== undefined) {
          clearTimeout(pendingEnterTimer);
        }
        pendingEnterTimer = setTimeout(() => {
          pendingEnterTimer = undefined;
          void enter(ctx, { resume: true });
        }, cfg.autoFocusDebounceMs);
      });

      // ---- agent_end handler ----
      pi.on("agent_end", async (_event, _ctx) => {
        if (!attached) return;
        if (pendingEnterTimer !== undefined) {
          // Fast reply — cancel before entering; arm for next turn.
          clearTimeout(pendingEnterTimer);
          pendingEnterTimer = undefined;
          manualExitedDuringGame = false;  // reset so next agent_start auto-enters
          return;
        }

        if (mode === "game" && !manualEnteredDuringChat) {
          exit();
        }

        // Clear manualExitedDuringGame after the turn completes so the
        // following agent_start can auto-enter again.
        manualExitedDuringGame = false;
      });

      // ---- alt+g shortcut ----
      pi.registerShortcut("alt+g", {
        description: "Toggle GBA game mode",
        handler: (ctx: ExtensionContext) => {
          if (!attached) return;
          if (!caps.kittyGraphics) {
            notifyUnsupported(ctx);
            return;
          }
          if (!deps.render) {
            ctx.ui.notify("GBA: load a ROM with /gba first, then press alt+g", "info");
            return;
          }
          // Phase 9 REVISE B2: L3 permits manual entry while Paused — the
          // component renders the last-captured still-frame until the user
          // manually resumes (alt+shift+g) or agent_start re-fires.
          if (mode === "game") {
            autoFocus.exitManual();
            return;
          }
          void autoFocus.enterManual(ctx);
        },
      });
    },

    detach() {
      if (!attached) return;
      // Cancel any pending timer.
      if (pendingEnterTimer !== undefined) {
        clearTimeout(pendingEnterTimer);
        pendingEnterTimer = undefined;
      }
      // If in game mode, close the component.
      if (mode === "game") {
        exit();
      }
      attached = false;
    },

    async enterManual(ctx: ExtensionContext): Promise<void> {
      if (mode === "game") return;
      manualEnteredDuringChat = true;
      try {
        // resume: a game paused by agent_end auto-pause must tick again when
        // the user deliberately opens game mode — otherwise (with
        // autoRunOnAgentStart=false) alt+g lands on a frozen frame that
        // ignores input. lifecycle.resume() still refuses when the user
        // explicitly paused via alt+shift+g (manualOverride) or after a crash,
        // which is the actual intent of the L3 still-frame rule.
        await enter(ctx, { resume: true });
      } finally {
        // enter() resolves when the component calls done() — that means the
        // user exited manually (alt+g/ctrl+c from inside game mode). Clear
        // the flag even on failure: a stuck true would exempt every future
        // auto-entered session from auto-exit.
        manualEnteredDuringChat = false;
      }
    },

    exitManual(): void {
      if (mode !== "game") return;
      // Mark that the user manually exited while the agent may still be running.
      // This suppresses the NEXT auto-entry (cleared on next agent_end).
      if (!lifecycle.isRunning()) {
        // Not mid-agent — no need to suppress future entries.
        manualExitedDuringGame = false;
      } else {
        manualExitedDuringGame = true;
      }
      // Clear manualEnteredDuringChat so agent_end can auto-exit next time.
      manualEnteredDuringChat = false;
      exit();
    },

    isInGameMode(): boolean {
      return mode === "game";
    },
  };

  return autoFocus;
}
