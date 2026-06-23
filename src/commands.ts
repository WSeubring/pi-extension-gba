import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AudioPlayer } from "./audio.js";
import type { GbaCapabilities } from "./capabilities.js";
import type { GbaConfig } from "./config.js";
import { popQueuedWarning } from "./config.js";
import { handleConfig, resetConfig } from "./config-menu.js";
import type { Emulator } from "./emulator.js";
import { RomLoadError } from "./emulator.js";
import type { Lifecycle, RenderController } from "./lifecycle.js";
import { MSG, requireAudio } from "./messages.js";
import type { Persistence } from "./persistence.js";
import { showRomPicker } from "./picker.js";
import { ensureGbaExtension } from "./rom.js";

export interface CommandDeps {
  emulator: Emulator;
  persistence: Persistence;
  lifecycle: Lifecycle;
  ensureRender: (ctx: ExtensionCommandContext) => RenderController;
  cfg: GbaConfig;
  caps: GbaCapabilities;
  notifyUnsupported: (ctx: ExtensionContext) => void;
  /** Audio player — undefined in silent mode. */
  audio: AudioPlayer | undefined;
  /**
   * Optional hook fired after a successful ROM load to mount game mode so
   * the user can play immediately. Without it the widget stays frozen on a
   * single frame because Phase 9 L5 disables ambient widget ticking — the
   * user would have to press alt+g after every /gba to see the game running.
   * Returns a Promise that resolves when the user exits game mode; commands
   * await it so the slash-command stays "active" for the lifetime of the
   * ctx.ui.custom UI (pi requires the command ctx to be live while the
   * custom component is mounted).
   */
  enterGameMode?: (ctx: ExtensionContext) => Promise<void>;
}

async function getRomsOrWarn(
  ctx: ExtensionCommandContext,
  persistence: Persistence,
  romDir: string,
): Promise<string[] | null> {
  const roms = await persistence.listRoms();
  if (roms.length === 0) {
    ctx.ui.notify(`No ROMs in ${romDir} — drop .gba files there`, "warning");
    return null;
  }
  return roms;
}

async function cmdResume(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  deps.ensureRender(ctx);
  const last = await deps.persistence.lastPlayed();
  if (last) {
    let restoredState: boolean;
    try {
      ({ restoredState } = await deps.persistence.loadRom(last));
    } catch (err) {
      if (err instanceof RomLoadError) {
        ctx.ui.notify(`GBA: '${last}' is not a valid GBA ROM — ${err.message}`, "error");
        return;
      }
      throw err;
    }
    deps.lifecycle.onRomLoad();
    ctx.ui.notify(`GBA: running ${last}${restoredState ? " (resumed)" : ""}`, "info");
    await deps.enterGameMode?.(ctx);
    return;
  }

  const roms = await getRomsOrWarn(ctx, deps.persistence, deps.cfg.romDir);
  if (!roms) return;
  await openPickerAndLoad(ctx, deps, roms);
}

async function cmdList(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  deps.ensureRender(ctx);
  const roms = await getRomsOrWarn(ctx, deps.persistence, deps.cfg.romDir);
  if (!roms) return;
  await openPickerAndLoad(ctx, deps, roms);
}

async function openPickerAndLoad(ctx: ExtensionCommandContext, deps: CommandDeps, roms: string[]): Promise<void> {
  const result = await showRomPicker(ctx, roms);
  if (result.cancelled || !result.basename) return;
  const basename = result.basename;
  let romPath: string;
  let restoredState: boolean;
  try {
    const loaded = await deps.persistence.loadRom(basename);
    romPath = loaded.romPath;
    restoredState = loaded.restoredState;
  } catch (err) {
    if (err instanceof RomLoadError) {
      ctx.ui.notify(`GBA: '${basename}' is not a valid GBA ROM — ${err.message}`, "error");
      return;
    }
    throw err;
  }
  deps.lifecycle.onRomLoad();
  ctx.ui.notify(`GBA: running ${romPath.split("/").pop() ?? basename}${restoredState ? " (resumed)" : ""}`, "info");
  await deps.enterGameMode?.(ctx);
}

async function cmdReset(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  deps.ensureRender(ctx);
  const basename = deps.persistence.currentRom();
  if (!basename) {
    ctx.ui.notify("No ROM loaded — run /gba first", "warning");
    return;
  }

  await deps.persistence.flushPending();

  try {
    await deps.persistence.clearState();
  } catch (err) {
    ctx.ui.notify(`GBA: reset failed — ${String((err as Error).message ?? err)}`, "error");
    return;
  }

  try {
    await deps.persistence.loadRom(basename);
  } catch (err) {
    if (err instanceof RomLoadError) {
      ctx.ui.notify(`GBA: reset failed — ${err.message}`, "error");
      return;
    }
    throw err;
  }

  deps.lifecycle.onRomLoad();
  ctx.ui.notify("GBA: reset", "info");
  await deps.enterGameMode?.(ctx);
}

async function cmdLoadByName(ctx: ExtensionCommandContext, deps: CommandDeps, token: string): Promise<void> {
  deps.ensureRender(ctx);
  const basename = ensureGbaExtension(token);

  const roms = await deps.persistence.listRoms();
  if (!roms.includes(basename)) {
    const available = roms.slice(0, 5).join(", ");
    const ellipsis = roms.length > 5 ? " …" : "";
    ctx.ui.notify(`No such ROM: '${basename}'. Available: ${available}${ellipsis}`, "error");
    return;
  }

  let romPath: string;
  let restoredState: boolean;
  try {
    const result = await deps.persistence.loadRom(basename);
    romPath = result.romPath;
    restoredState = result.restoredState;
  } catch (err) {
    if (err instanceof RomLoadError) {
      ctx.ui.notify(`GBA: '${basename}' is not a valid GBA ROM — ${err.message}`, "error");
      return;
    }
    throw err;
  }

  deps.lifecycle.onRomLoad();
  ctx.ui.notify(`GBA: running ${romPath.split("/").pop() ?? basename}${restoredState ? " (resumed)" : ""}`, "info");
  await deps.enterGameMode?.(ctx);
}

async function buildCompletions(
  argumentPrefix: string,
  persistence: Persistence,
  caps: GbaCapabilities,
  audio: AudioPlayer | undefined,
): Promise<{ value: string; label: string; description?: string }[] | null> {
  if (!caps.kittyGraphics) return null;
  const subs: { value: string; label: string; description?: string }[] = [
    { value: "list", label: "list", description: "Open ROM picker" },
    { value: "reset", label: "reset", description: "Soft reset current ROM" },
    { value: "config", label: "config", description: "Open config menu" },
    { value: "config reset", label: "config reset", description: "Reset config to defaults" },
  ];
  // Only advertise mute/unmute when audio is enabled.
  if (audio !== undefined) {
    subs.push({ value: "mute", label: "mute", description: "Mute audio" });
    subs.push({ value: "unmute", label: "unmute", description: "Unmute audio" });
  }
  const roms = await persistence.listRoms();
  const p = argumentPrefix.toLowerCase();
  const matches = [
    ...subs.filter((s) => s.value.startsWith(p)),
    ...roms.filter((r) => r.toLowerCase().startsWith(p)).map((r) => ({ value: r, label: r })),
  ];
  return matches.length ? matches : null;
}

export function registerAll(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("gba", {
    description: "Resume last-played GBA ROM (or open picker)",
    getArgumentCompletions: (argumentPrefix: string) =>
      buildCompletions(argumentPrefix, deps.persistence, deps.caps, deps.audio),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        if (!deps.caps.kittyGraphics) {
          deps.notifyUnsupported(ctx);
          return;
        }

        if (deps.lifecycle.isCrashed()) {
          ctx.ui.notify("GBA: recovering from crash — resetting", "warning");
          await cmdReset(ctx, deps);
          return;
        }

        // Dispatch on the first token only for known subcommands; ROM
        // basenames may contain spaces, so the load-by-name fallback gets
        // the full trimmed argument string.
        const trimmed = args.trim();
        const parts = trimmed.split(/\s+/);
        const token = parts[0] ?? "";
        const subToken = parts[1] ?? "";

        // Emit any queued warning from corrupt-file detection
        const queuedWarning = popQueuedWarning();
        if (queuedWarning) ctx.ui.notify(queuedWarning, "warning");

        if (token === "") {
          await cmdResume(ctx, deps);
        } else if (token === "list") {
          await cmdList(ctx, deps);
        } else if (token === "reset") {
          await cmdReset(ctx, deps);
        } else if (token === "mute") {
          const audio = requireAudio(ctx, deps.audio);
          if (!audio) return;
          audio.mute();
          ctx.ui.notify(MSG.audioMuted, "info");
        } else if (token === "unmute") {
          const audio = requireAudio(ctx, deps.audio);
          if (!audio) return;
          audio.unmute();
          ctx.ui.notify(MSG.audioUnmuted, "info");
        } else if (token === "config") {
          if (subToken === "reset") {
            await resetConfig(ctx, deps.cfg);
          } else {
            await handleConfig(ctx, deps.cfg);
          }
        } else if (!trimmed.startsWith("-")) {
          await cmdLoadByName(ctx, deps, trimmed);
        } else {
          ctx.ui.notify("Usage: /gba [list|reset|mute|unmute|config [reset]|<basename>]", "warning");
        }
      } catch (err) {
        console.warn("[pi-extension-gba] /gba handler threw:", err);
        ctx.ui.notify(`GBA: ${String((err as Error).message ?? err)}`, "error");
      }
    },
  });
}
