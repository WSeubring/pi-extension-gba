/**
 * Phase 9c — Auto-focus lifecycle coupling.
 *
 * Subscribes to agent_start / agent_end pi events and drives
 * enter/exit of full-screen game mode (ctx.ui.custom).
 *
 * Design ref: docs/design/phase-9c-auto-focus-lifecycle.md
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AudioPlayer } from "./audio.js";
import { GbaGameComponent } from "./game-component.js";
import type { Lifecycle } from "./lifecycle.js";
import type { EmulatorLike, RenderControllerWithSwap } from "./render.js";
import type { ButtonSink } from "./types.js";

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
  /** Register the alt+g shortcut and apply the widget tick policy. */
  attach(): void;
  /** Unsubscribe, release any live custom UI, and await its unmount. */
  detach(): Promise<void>;
  /**
   * Agent turn started — arm the debounce timer to enter game mode. Invoked
   * by the session coordinator after lifecycle.onAgentStart(), so the tick
   * loop is already resumed before game mode mounts.
   */
  onAgentStart(ctx: ExtensionContext): void;
  /** Agent turn ended — cancel a pending entry or auto-exit game mode. */
  onAgentEnd(): void;
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
  const log = (msg: string) => (deps.logger ? deps.logger(msg) : console.error(msg));

  // Convenience accessor for the optional audio player.
  function getAudio(): AudioPlayer | undefined {
    return deps.audio;
  }

  /**
   * Game-mode state machine. The illegal combinations the old flag soup could
   * represent (a live component while in chat, a close request with no session)
   * are now unrepresentable.
   *
   *   chat     → not in game mode.
   *   entering → enter() has flipped on but the component isn't mounted yet
   *              (awaiting audio.start + the ctx.ui.custom factory). exit()
   *              during this window can only record `closeRequested`, replayed
   *              at mount.
   *   game     → component mounted and live; exit() calls requestClose().
   *
   * `gen` is a per-session id: enter()'s teardown runs after an await
   * (audio.stop can take 200 ms+), and a NEWER enter() may have started and now
   * own the backend — only the latest session may restore the widget backend.
   * `manualEntered` (alt+g during chat) suppresses agent_end auto-exit for this
   * session; it lives in the state because it's a property of the session.
   */
  type FocusState =
    | { tag: "chat" }
    | { tag: "entering"; gen: number; manualEntered: boolean; closeRequested: boolean }
    | { tag: "game"; gen: number; manualEntered: boolean; component: GbaGameComponent };

  let state: FocusState = { tag: "chat" };

  /**
   * Set when the user presses alt+g while in game mode mid-agent → block the
   * CURRENT and NEXT auto-entry. Spans turns (outlives a single session), so it
   * lives outside FocusState. Cleared on the agent_end following the exit.
   */
  let manualExitedDuringGame = false;

  /** Pending debounce timer — cancel on agent_end to absorb fast replies. */
  let pendingEnterTimer: ReturnType<typeof setTimeout> | undefined;

  /** Monotonic session id source (see FocusState.gen). */
  let genCounter = 0;

  /**
   * The in-flight enter() promise (resolves when its finally — audio.stop +
   * widget restore — completes). detach() awaits it so shutdown can't destroy
   * the renderer mid-unmount (the requestClose → done → finally chain runs on a
   * later tick). Cleared only by the session that set it.
   */
  let entering: Promise<void> | undefined;
  const trackEnter = (p: Promise<void>): Promise<void> => {
    entering = p;
    void p.finally(() => {
      if (entering === p) entering = undefined;
    });
    return p;
  };

  const inGameMode = (): boolean => state.tag === "entering" || state.tag === "game";

  /** Whether attach() has been called. */
  let attached = false;

  // ---------------------------------------------------------------------------
  // Core enter / exit helpers
  // ---------------------------------------------------------------------------

  async function enter(ctx: ExtensionContext, opts?: { resume?: boolean; manual?: boolean }): Promise<void> {
    const render = deps.render;
    if (!render) {
      log("[pi-extension-gba] auto-focus enter: no render controller (no ROM loaded)");
      return;
    }
    if (state.tag !== "chat") return;

    const gen = ++genCounter;
    state = { tag: "entering", gen, manualEntered: opts?.manual ?? false, closeRequested: false };
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
        const component = new GbaGameComponent(tui, { sink: emulator, scale: cfg.scale }, done);

        // Only mount if THIS session is still the one entering. exit() may
        // have set closeRequested while we awaited audio.start.
        if (state.tag === "entering" && state.gen === gen) {
          const replayClose = state.closeRequested;
          state = { tag: "game", gen, manualEntered: state.manualEntered, component };

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
          if (replayClose) {
            component.requestClose();
          }
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
      // Flip to chat BEFORE the audio.stop await so a new enter() during that
      // await passes the `state.tag === "chat"` guard and can own the backend.
      state = { tag: "chat" };

      // Stop audio on GameMode exit. Failures are logged but must not block
      // cleanup (L9/L10).
      try {
        await getAudio()?.stop();
      } catch (err) {
        log(`[pi-extension-gba] audio.stop() failed: ${String((err as Error)?.message ?? err)}`);
      }

      // A new enter() may have started during the audio.stop await above and
      // now owns the backend. Only the latest session may restore "widget".
      if (genCounter === gen) {
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
    if (state.tag === "game") {
      state.component.requestClose();
      // The component → done() → enter()'s finally returns us to chat.
    } else if (state.tag === "entering") {
      // Component not mounted yet (still awaiting audio.start / the factory).
      // Record the close so the mount replays it instead of leaving game mode
      // up after agent_end.
      state.closeRequested = true;
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
          if (inGameMode()) {
            autoFocus.exitManual();
            return;
          }
          void autoFocus.enterManual(ctx);
        },
      });
    },

    async detach(): Promise<void> {
      if (!attached) return;
      // Cancel any pending timer.
      if (pendingEnterTimer !== undefined) {
        clearTimeout(pendingEnterTimer);
        pendingEnterTimer = undefined;
      }
      // If in game mode, close the component.
      if (inGameMode()) {
        exit();
      }
      attached = false;
      // Wait for any in-flight enter() to finish unmounting (its finally runs
      // audio.stop + restores the widget backend on a later tick). Without this
      // a shutdown could destroy the renderer mid-unmount — a write-after-free.
      await entering;
    },

    onAgentStart(ctx: ExtensionContext): void {
      if (!cfg.autoFocusOnAgentStart) return;
      if (!deps.render) return; // no ROM loaded yet
      if (!caps.kittyGraphics) return;
      // Re-apply on every agent_start so lazily-constructed renderers
      // pick up the "no ambient widget" policy before the first Running tick.
      applyWidgetLiveTickPolicy();
      if (manualExitedDuringGame) return; // user exited mid-agent; suppress
      if (state.tag !== "chat") return; // already entering / in game mode

      // Defensive — clear any previously armed timer so back-to-back
      // agent_start events (theoretical race) never leave two concurrent
      // debounce timers live.
      if (pendingEnterTimer !== undefined) {
        clearTimeout(pendingEnterTimer);
      }
      pendingEnterTimer = setTimeout(() => {
        pendingEnterTimer = undefined;
        void trackEnter(enter(ctx, { resume: true }));
      }, cfg.autoFocusDebounceMs);
    },

    onAgentEnd(): void {
      if (pendingEnterTimer !== undefined) {
        // Fast reply — cancel before entering; arm for next turn.
        clearTimeout(pendingEnterTimer);
        pendingEnterTimer = undefined;
        manualExitedDuringGame = false; // reset so next agent_start auto-enters
        return;
      }

      // Auto-exit unless this session was manually entered (alt+g during chat),
      // which stays in game across agent_end.
      if ((state.tag === "entering" || state.tag === "game") && !state.manualEntered) {
        exit();
      }

      // Clear manualExitedDuringGame after the turn completes so the
      // following agent_start can auto-enter again.
      manualExitedDuringGame = false;
    },

    async enterManual(ctx: ExtensionContext): Promise<void> {
      if (state.tag !== "chat") return;
      // resume: a game paused by agent_end auto-pause must tick again when the
      // user deliberately opens game mode — otherwise (with
      // autoRunOnAgentStart=false) alt+g lands on a frozen frame that ignores
      // input. lifecycle.resume() still refuses when the user explicitly paused
      // via alt+shift+g (manualOverride) or after a crash, which is the actual
      // intent of the L3 still-frame rule. The `manual` flag records on the
      // session that agent_end must not auto-exit it; it clears with the state
      // when the session ends, so no manual reset is needed.
      await trackEnter(enter(ctx, { resume: true, manual: true }));
    },

    exitManual(): void {
      if (!inGameMode()) return;
      // Mark that the user manually exited while the agent may still be running,
      // to suppress the NEXT auto-entry (cleared on next agent_end). Not
      // mid-agent → nothing to suppress.
      manualExitedDuringGame = lifecycle.isRunning();
      exit();
    },

    isInGameMode(): boolean {
      return inGameMode();
    },
  };

  return autoFocus;
}
