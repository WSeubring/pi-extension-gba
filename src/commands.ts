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
 * One editable setting in the /gba config menu. Each descriptor owns its menu
 * label, how it renders its current value, and how it prompts for + validates a
 * new one — so adding a setting is one table entry instead of six coordinated
 * edits (label, menu string, prefix-match branch, edit UI, clamp, save).
 */
interface Setting {
  readonly title: string;
  readonly key: keyof GbaConfig;
  /** Render the current value for the menu line and the save notification. */
  format(cfg: GbaConfig): string;
  /**
   * Prompt for a new value. Returns the config patch + its display string, or
   * undefined to leave the setting unchanged (cancelled, or invalid — in which
   * case the descriptor has already notified).
   */
  edit(
    ctx: ExtensionCommandContext,
    cfg: GbaConfig,
  ): Promise<{ patch: Partial<GbaConfig>; display: string } | undefined>;
  /** When set, editing emits a "requires restart" notice (renderer built once). */
  readonly restartNoun?: string;
}

function toggleSetting(key: keyof GbaConfig, title: string, offLabel = "off"): Setting {
  return {
    title,
    key,
    format: (cfg) => (cfg[key] ? "on" : offLabel),
    async edit(ctx) {
      const val = await ctx.ui.select(title, ["on", "off"]);
      if (val === undefined) return undefined;
      return { patch: { [key]: val === "on" } as Partial<GbaConfig>, display: val };
    },
  };
}

function numberSetting(
  key: keyof GbaConfig,
  title: string,
  prompt: string,
  range: { min: number; max: number; rejectBelow?: number },
  unit: string,
  invalidMsg: string,
  restartNoun?: string,
): Setting {
  return {
    title,
    key,
    restartNoun,
    format: (cfg) => `${cfg[key]} ${unit}`,
    async edit(ctx, cfg) {
      const raw = await ctx.ui.input(prompt, String(cfg[key]));
      if (raw === undefined) return undefined;
      // Number("") is 0 — reject empty/whitespace so a bare Enter doesn't save 0.
      const num = Number(raw);
      const floor = range.rejectBelow ?? Number.NEGATIVE_INFINITY;
      if (raw.trim() === "" || !Number.isFinite(num) || num < floor) {
        ctx.ui.notify(`GBA config: ${invalidMsg} — not saved`, "warning");
        return undefined;
      }
      const clamped = Math.max(range.min, Math.min(range.max, Math.round(num)));
      return { patch: { [key]: clamped } as Partial<GbaConfig>, display: String(clamped) };
    },
  };
}

function choiceSetting(
  key: keyof GbaConfig,
  title: string,
  choices: { label: string; value: number | string }[],
  format: (cfg: GbaConfig) => string,
  restartNoun?: string,
): Setting {
  return {
    title,
    key,
    restartNoun,
    format,
    async edit(ctx) {
      const val = await ctx.ui.select(
        title,
        choices.map((c) => c.label),
      );
      if (val === undefined) return undefined;
      const choice = choices.find((c) => c.label === val);
      if (!choice) return undefined;
      return { patch: { [key]: choice.value } as Partial<GbaConfig>, display: val };
    },
  };
}

const SETTINGS: Setting[] = [
  toggleSetting("autoFocusOnAgentStart", "Auto-focus on agent_start"),
  numberSetting(
    "autoFocusDebounceMs",
    "Auto-focus debounce",
    "Auto-focus debounce (ms, 0–5000)",
    { min: 0, max: 5000 },
    "ms",
    "invalid number",
  ),
  toggleSetting("autoRunOnAgentStart", "Auto-run on agent_start"),
  toggleSetting("autoHideOnAgentEnd", "Auto-hide on agent_end", "off (shrink)"),
  choiceSetting(
    "scale",
    "Scale",
    [
      { label: "1x", value: 1 },
      { label: "2x", value: 2 },
      { label: "3x", value: 3 },
    ],
    (cfg) => `${cfg.scale}x`,
    "scale",
  ),
  numberSetting(
    "frameRate",
    "Frame rate",
    "Frame rate (fps, 1–30)",
    { min: 1, max: 30, rejectBelow: 1 },
    "fps",
    "invalid frame rate",
    "frameRate",
  ),
  toggleSetting("audio", "Audio"),
];

const RESET_LABEL = "Reset all to defaults…";

/**
 * Interactive config menu via ctx.ui.select / ctx.ui.input, driven by the
 * SETTINGS table. Loops until the user picks "Close" or dismisses.
 */
export async function handleConfig(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  const lineFor = (s: Setting): string => `${s.title}: ${s.format(deps.cfg)}`;

  while (true) {
    const menuItems = [...SETTINGS.map(lineFor), RESET_LABEL, "Close"];
    const pick = await ctx.ui.select("GBA Config", menuItems);
    if (pick === undefined || pick === "Close") return;

    if (pick === RESET_LABEL) {
      const confirmed = await ctx.ui.confirm("Reset GBA config", "Reset all settings to defaults?");
      if (confirmed) await resetConfig(ctx, deps);
      continue;
    }

    // Match the exact menu line (no fragile startsWith on a shared prefix).
    const setting = SETTINGS.find((s) => lineFor(s) === pick);
    if (!setting) continue;

    const result = await setting.edit(ctx, deps.cfg);
    if (!result) continue; // cancelled or invalid (descriptor already notified)

    await applyAndSave(ctx, deps, setting.key, result.patch, result.display);
    if (setting.restartNoun) {
      ctx.ui.notify(`GBA config: ${setting.restartNoun} change requires restart to take effect`, "info");
    }
  }
}

/**
 * Apply a config patch to the live deps.cfg, clamp once via normalize, persist
 * only the changed key over the file layer, and notify. The runtime cfg carries
 * session-scoped env overrides (PI_GBA_AUTO_FOCUS, PI_GBA_AUDIO); persisting the
 * single key avoids baking those into gba.json.
 */
async function applyAndSave(
  ctx: ExtensionCommandContext,
  deps: CommandDeps,
  key: keyof GbaConfig,
  patch: Partial<GbaConfig>,
  display: string,
): Promise<void> {
  Object.assign(deps.cfg, normalize({ ...deps.cfg, ...patch }));
  try {
    await saveConfigFile(normalize({ ...(await loadConfigFile()), [key]: deps.cfg[key] }));
    ctx.ui.notify(`GBA config saved: ${key} = ${display}`, "info");
  } catch (err: unknown) {
    ctx.ui.notify(
      `GBA config: write failed — setting applied for this session only (${String((err as Error).message ?? err)})`,
      "error",
    );
  }
}

/** Reset config to defaults in place; shared by the menu and `/gba config reset`. */
async function resetConfig(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  const prevRomDir = deps.cfg.romDir;
  await resetConfigFile();
  const fresh = await resolveConfig();
  Object.assign(deps.cfg, fresh);
  ctx.ui.notify("GBA config reset to defaults", "info");
  if (fresh.romDir !== prevRomDir) {
    ctx.ui.notify("GBA config: romDir change requires restart to take effect", "info");
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
            await resetConfig(ctx, deps);
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
