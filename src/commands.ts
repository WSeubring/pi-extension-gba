import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AudioPlayer } from "./audio.js";
import type { GbaCapabilities } from "./capabilities.js";
import type { GbaConfig } from "./config.js";
import {
  loadConfigFile,
  normalize,
  popQueuedWarning,
  resetConfigFile,
  resolveConfig,
  saveConfigFile,
} from "./config.js";
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

// ---- /gba config ------------------------------------------------------------

/**
 * Interactive config menu via ctx.ui.select / ctx.ui.input.
 * Loops until the user picks "Close" or dismisses.
 */
export async function handleConfig(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  // Work on a mutable copy so we can accumulate changes before save.
  // The live deps.cfg object is updated via Object.assign after each save.
  const cfg = deps.cfg;

  while (true) {
    const autoFocusLabel = cfg.autoFocusOnAgentStart ? "on" : "off";
    const autoRunLabel = cfg.autoRunOnAgentStart ? "on" : "off";
    const autoHideLabel = cfg.autoHideOnAgentEnd ? "on" : "off (shrink)";
    const audioLabel = cfg.audio ? "on" : "off";

    const menuItems = [
      `Auto-focus on agent_start: ${autoFocusLabel}`,
      `Auto-focus debounce: ${cfg.autoFocusDebounceMs} ms`,
      `Auto-run on agent_start: ${autoRunLabel}`,
      `Auto-hide on agent_end: ${autoHideLabel}`,
      `Scale: ${cfg.scale}x`,
      `Frame rate: ${cfg.frameRate} fps`,
      `Audio: ${audioLabel}`,
      "Reset all to defaults…",
      "Close",
    ];

    const pick = await ctx.ui.select("GBA Config", menuItems);
    if (pick === undefined || pick === "Close") return;

    if (pick.startsWith("Auto-focus on agent_start")) {
      const val = await ctx.ui.select("Auto-focus on agent_start", ["on", "off"]);
      if (val === undefined) continue;
      cfg.autoFocusOnAgentStart = val === "on";
      await _saveAndNotify(ctx, deps, cfg, "autoFocusOnAgentStart", val);
    } else if (pick.startsWith("Auto-focus debounce")) {
      const val = await ctx.ui.input("Auto-focus debounce (ms, 0–5000)", String(cfg.autoFocusDebounceMs));
      if (val === undefined) continue;
      // Number("") is 0 — reject empty/whitespace input explicitly so a bare
      // Enter doesn't silently save autoFocusDebounceMs=0.
      const num = Number(val);
      if (val.trim() === "" || !Number.isFinite(num)) {
        ctx.ui.notify("GBA config: invalid number — not saved", "warning");
        continue;
      }
      cfg.autoFocusDebounceMs = Math.max(0, Math.min(5000, Math.round(num)));
      await _saveAndNotify(ctx, deps, cfg, "autoFocusDebounceMs", String(cfg.autoFocusDebounceMs));
    } else if (pick.startsWith("Auto-run on agent_start")) {
      const val = await ctx.ui.select("Auto-run on agent_start", ["on", "off"]);
      if (val === undefined) continue;
      cfg.autoRunOnAgentStart = val === "on";
      await _saveAndNotify(ctx, deps, cfg, "autoRunOnAgentStart", val);
    } else if (pick.startsWith("Auto-hide on agent_end")) {
      const val = await ctx.ui.select("Auto-hide on agent_end", ["on", "off"]);
      if (val === undefined) continue;
      cfg.autoHideOnAgentEnd = val === "on";
      await _saveAndNotify(ctx, deps, cfg, "autoHideOnAgentEnd", val);
    } else if (pick.startsWith("Scale")) {
      const val = await ctx.ui.select("Scale", ["1x", "2x", "3x"]);
      if (val === undefined) continue;
      const scaleMap: Record<string, 1 | 2 | 3> = { "1x": 1, "2x": 2, "3x": 3 };
      const newScale = scaleMap[val] ?? 2;
      cfg.scale = newScale;
      await _saveAndNotify(ctx, deps, cfg, "scale", val);
      ctx.ui.notify("GBA config: scale change requires restart to take effect", "info");
    } else if (pick.startsWith("Frame rate")) {
      const val = await ctx.ui.input("Frame rate (fps, 1–30)", String(cfg.frameRate));
      if (val === undefined) continue;
      const num = Number(val);
      if (!Number.isFinite(num) || num < 1) {
        ctx.ui.notify("GBA config: invalid frame rate — not saved", "warning");
        continue;
      }
      cfg.frameRate = Math.max(1, Math.min(30, Math.round(num)));
      await _saveAndNotify(ctx, deps, cfg, "frameRate", String(cfg.frameRate));
      ctx.ui.notify("GBA config: frameRate change requires restart to take effect", "info");
    } else if (pick.startsWith("Audio")) {
      const val = await ctx.ui.select("Audio", ["on", "off"]);
      if (val === undefined) continue;
      cfg.audio = val === "on";
      await _saveAndNotify(ctx, deps, cfg, "audio", val);
    } else if (pick.startsWith("Reset all")) {
      const confirmed = await ctx.ui.confirm("Reset GBA config", "Reset all settings to defaults?");
      if (!confirmed) continue;
      const prevRomDir = cfg.romDir;
      await resetConfigFile();
      const fresh = await resolveConfig();
      Object.assign(cfg, fresh);
      Object.assign(deps.cfg, fresh);
      ctx.ui.notify("GBA config reset to defaults", "info");
      if (fresh.romDir !== prevRomDir) {
        ctx.ui.notify("GBA config: romDir change requires restart to take effect", "info");
      }
    }
  }
}

async function _saveAndNotify(
  ctx: ExtensionCommandContext,
  deps: CommandDeps,
  cfg: GbaConfig,
  key: keyof GbaConfig,
  value: string,
): Promise<void> {
  // Normalize before save (clamp values)
  const normalized = normalize(cfg);
  Object.assign(cfg, normalized);
  Object.assign(deps.cfg, normalized);
  try {
    // Persist only the changed key merged over the file layer. The runtime
    // cfg includes session-scoped env overrides (PI_GBA_AUTO_FOCUS,
    // PI_GBA_AUDIO); dumping it wholesale would bake those into gba.json.
    await saveConfigFile(normalize({ ...(await loadConfigFile()), [key]: normalized[key] }));
    ctx.ui.notify(`GBA config saved: ${key} = ${value}`, "info");
  } catch (err: unknown) {
    ctx.ui.notify(
      `GBA config: write failed — setting applied for this session only (${String((err as Error).message ?? err)})`,
      "error",
    );
  }
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
            const prevRomDir = deps.cfg.romDir;
            await resetConfigFile();
            const fresh = await resolveConfig();
            Object.assign(deps.cfg, fresh);
            ctx.ui.notify("GBA config reset to defaults", "info");
            if (fresh.romDir !== prevRomDir) {
              ctx.ui.notify("GBA config: romDir change requires restart to take effect", "info");
            }
          } else {
            await handleConfig(ctx, deps);
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
