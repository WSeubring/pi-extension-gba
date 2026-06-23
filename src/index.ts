import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AudioPlayer } from "./audio.js";
import { audioEnabled, createAudioPlayer } from "./audio.js";
import { createAutoFocus } from "./auto-focus.js";
import { detectCapabilities } from "./capabilities.js";
import { registerAll } from "./commands.js";
import { resolveConfig } from "./config.js";
import { createEmulator } from "./emulator.js";
import type { RenderController } from "./lifecycle.js";
import { createLifecycle } from "./lifecycle.js";
import { createUnsupportedNotifier, requireAudio, toggleMute } from "./messages.js";
import activateMinimal from "./minimal-activate.js";
import { createPersistence } from "./persistence.js";
import type { RenderController as PhaseRenderController, RenderControllerWithSwap } from "./render.js";
import { createRenderer } from "./render.js";

// ctx resolution: renderer construction requires an ExtensionCommandContext (for
// ctx.ui.setWidget), which is only available per-call. We defer renderer
// construction to the first /gba command invocation and store it. Lifecycle
// accepts a getRender getter so it stays inert (Idle) until onRomLoad() fires,
// which only happens after the renderer is built. See docs/design/phase-4-lifecycle.md §6.

export default async function activate(pi: ExtensionAPI): Promise<void> {
  // Minimal-mode escape hatch. Set PI_GBA_MINIMAL=1 to skip auto-focus,
  // lifecycle coupling, audio, and the /gba config menu — /gba mounts
  // ctx.ui.custom directly. See src/minimal-activate.ts for rationale.
  if (process.env.PI_GBA_MINIMAL === "1") {
    await activateMinimal(pi);
    return;
  }

  const caps = detectCapabilities();
  const cfg = await resolveConfig();
  const emulator = await createEmulator();
  const persistence = createPersistence(emulator, { romDir: cfg.romDir, autoSnapshotMs: 30_000 });

  let render: RenderControllerWithSwap | undefined;
  const notifyUnsupported = createUnsupportedNotifier();

  // Cache most-recent ctx for audio crash notifications (crash fires async).
  let lastCtx: ExtensionContext | undefined;

  // Create the player whenever a backend tool exists (cfgAudio: true skips
  // the config gate; PI_GBA_AUDIO=0 still forces it off). Idle until
  // start(), so creation is free. Whether audio is ACTIVE is decided live
  // via the `audio` getter below — this is what makes the /gba config audio
  // toggle take effect without a restart.
  const audioPlayer: AudioPlayer | undefined = createAudioPlayer({
    backend: caps.audioBackend,
    cfgAudio: true,
    logger: (msg) => console.error(msg),
    onCrash: (err) => {
      if (lastCtx) {
        lastCtx.ui.notify(`GBA: audio crashed — ${err.message}`, "error");
      } else {
        console.error(`[pi-extension-gba] audio crash (no ctx): ${err.message}`);
      }
    },
  });

  // Live audio gate: re-evaluated on every access so /gba config changes
  // apply immediately. Undefined = silent (disabled or no backend tool).
  const getAudio = (): AudioPlayer | undefined => (audioEnabled(cfg.audio) ? audioPlayer : undefined);

  const NOOP_RENDER: RenderController = {
    start() {},
    stop() {},
    shrink() {},
    expand() {},
    hide() {},
  };

  function ensureRender(ctx: ExtensionCommandContext): RenderController {
    lastCtx = ctx;
    if (!caps.kittyGraphics) return NOOP_RENDER;
    if (!render) {
      render = createRenderer(ctx, emulator, {
        scale: cfg.scale,
        frameRate: cfg.frameRate,
        // The render tick re-reads this via writeSamples-gating in the
        // player itself; pass the raw player so PCM drain keeps the ring
        // empty even while muted/disabled.
        audio: audioPlayer,
      });
      render.onRenderError((err) => {
        ctx.ui.notify(`GBA render error: ${err.message}`, "error");
      });
    }
    return render;
  }

  const lifecycle = createLifecycle(pi, emulator, (): RenderController => render ?? NOOP_RENDER, {
    // Live getters: /gba config mutates `cfg` in place (Object.assign in
    // commands.ts); plain boolean copies here would freeze the values at
    // activate time and silently ignore config changes until restart.
    get autoRunOnAgentStart() {
      return cfg.autoRunOnAgentStart;
    },
    get autoHideOnAgentEnd() {
      return cfg.autoHideOnAgentEnd;
    },
    onPause: () => persistence.snapshot(),
  });
  lifecycle.attach();

  const autoFocus = createAutoFocus({
    pi,
    get render() {
      return render;
    },
    emulator,
    lifecycle,
    getCtx: () => undefined, // ctx is captured per-event inside createAutoFocus
    cfg: {
      // Live getters — same rationale as the lifecycle options above.
      get autoFocusOnAgentStart() {
        return cfg.autoFocusOnAgentStart;
      },
      get autoFocusDebounceMs() {
        return cfg.autoFocusDebounceMs;
      },
      scale: cfg.scale, // restart-gated (renderer built once); /gba config says so
    },
    caps,
    notifyUnsupported,
    get audio() {
      return getAudio();
    },
  });
  autoFocus.attach();

  registerAll(pi, {
    emulator,
    persistence,
    lifecycle,
    ensureRender,
    cfg,
    caps,
    notifyUnsupported,
    get audio() {
      return getAudio();
    },
    // After /gba (+ variants) loads a ROM, mount game mode so the user can
    // play immediately. L5 disables ambient widget ticking, so without this
    // the user would have to press alt+g after every /gba to see the game.
    enterGameMode: (ctx: ExtensionContext) => autoFocus.enterManual(ctx),
  });

  // Register alt+m shortcut for mute toggle.
  // alt+m is safe: pi reserves ctrl+a..z; the alt+ namespace conflict check
  // (keybindings.d.ts) shows no existing binding for alt+m.
  pi.registerShortcut("alt+m", {
    description: "Toggle GBA audio mute",
    handler: (ctx: ExtensionContext) => {
      lastCtx = ctx;
      const audio = requireAudio(ctx, getAudio());
      if (!audio) return;
      toggleMute(ctx, audio);
    },
  });

  pi.on("session_shutdown", async () => {
    try {
      await persistence.snapshot();
    } catch (err) {
      console.warn(`[pi-extension-gba] session_shutdown snapshot failed: ${String((err as Error)?.message ?? err)}`);
    }
    autoFocus.detach();
    await persistence.flushPending();
    persistence.destroy();
    try {
      (render as PhaseRenderController | undefined)?.destroy();
    } catch (err) {
      console.warn(`[pi-extension-gba] render.destroy failed: ${String((err as Error)?.message ?? err)}`);
    }
    try {
      await audioPlayer?.stop();
    } catch (err) {
      console.warn(`[pi-extension-gba] audio.stop failed: ${String((err as Error)?.message ?? err)}`);
    }
    try {
      emulator.destroy();
    } catch (err) {
      console.warn(`[pi-extension-gba] emulator.destroy failed: ${String((err as Error)?.message ?? err)}`);
    }
  });
}
