import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GbaConfig } from "./config.js";
import { loadConfigFile, normalize, resetConfigFile, resolveConfig, saveConfigFile } from "./config.js";

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
 * SETTINGS table. Mutates `cfg` in place. Loops until the user picks "Close"
 * or dismisses.
 */
export async function handleConfig(ctx: ExtensionCommandContext, cfg: GbaConfig): Promise<void> {
  const lineFor = (s: Setting): string => `${s.title}: ${s.format(cfg)}`;

  while (true) {
    const menuItems = [...SETTINGS.map(lineFor), RESET_LABEL, "Close"];
    const pick = await ctx.ui.select("GBA Config", menuItems);
    if (pick === undefined || pick === "Close") return;

    if (pick === RESET_LABEL) {
      const confirmed = await ctx.ui.confirm("Reset GBA config", "Reset all settings to defaults?");
      if (confirmed) await resetConfig(ctx, cfg);
      continue;
    }

    // Match the exact menu line (no fragile startsWith on a shared prefix).
    const setting = SETTINGS.find((s) => lineFor(s) === pick);
    if (!setting) continue;

    const result = await setting.edit(ctx, cfg);
    if (!result) continue; // cancelled or invalid (descriptor already notified)

    await applyAndSave(ctx, cfg, setting.key, result.patch, result.display);
    if (setting.restartNoun) {
      ctx.ui.notify(`GBA config: ${setting.restartNoun} change requires restart to take effect`, "info");
    }
  }
}

/**
 * Apply a config patch to the live cfg, clamp once via normalize, persist only
 * the changed key over the file layer, and notify. The runtime cfg carries
 * session-scoped env overrides (PI_GBA_AUTO_FOCUS, PI_GBA_AUDIO); persisting the
 * single key avoids baking those into gba.json.
 */
async function applyAndSave(
  ctx: ExtensionCommandContext,
  cfg: GbaConfig,
  key: keyof GbaConfig,
  patch: Partial<GbaConfig>,
  display: string,
): Promise<void> {
  Object.assign(cfg, normalize({ ...cfg, ...patch }));
  try {
    await saveConfigFile(normalize({ ...(await loadConfigFile()), [key]: cfg[key] }));
    ctx.ui.notify(`GBA config saved: ${key} = ${display}`, "info");
  } catch (err: unknown) {
    ctx.ui.notify(
      `GBA config: write failed — setting applied for this session only (${String((err as Error).message ?? err)})`,
      "error",
    );
  }
}

/** Reset config to defaults in place; shared by the menu and `/gba config reset`. */
export async function resetConfig(ctx: ExtensionCommandContext, cfg: GbaConfig): Promise<void> {
  const prevRomDir = cfg.romDir;
  await resetConfigFile();
  const fresh = await resolveConfig();
  Object.assign(cfg, fresh);
  ctx.ui.notify("GBA config reset to defaults", "info");
  if (fresh.romDir !== prevRomDir) {
    ctx.ui.notify("GBA config: romDir change requires restart to take effect", "info");
  }
}
