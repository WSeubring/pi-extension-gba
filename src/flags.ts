/**
 * Single inventory of the `PI_GBA_*` runtime environment flags. Accessors read
 * `process.env` live (not cached) so a value toggled at runtime — or set by a
 * test — takes effect immediately. Centralising them means the precedence rules
 * (notably the audio override) live in one place and the full set of flags is
 * discoverable here rather than scattered across modules.
 */

const isOne = (v: string | undefined): boolean => v === "1";

/** `PI_GBA_MINIMAL=1` — widget-only minimal activation path. */
export const minimalMode = (): boolean => isOne(process.env.PI_GBA_MINIMAL);

/** `PI_GBA_DEBUG_CORE` set — restore mGBA core stdout traces. */
export const debugCore = (): boolean => process.env.PI_GBA_DEBUG_CORE !== undefined;

/** `PI_GBA_RENDER_TRACE=1` — log placement pins + input bytes to stderr. */
export const renderTrace = (): boolean => isOne(process.env.PI_GBA_RENDER_TRACE);

/** `PI_GBA_AUDIO_TRACE=1` — log per-tick audio drain stats to stderr. */
export const audioTrace = (): boolean => isOne(process.env.PI_GBA_AUDIO_TRACE);

/**
 * `PI_GBA_AUDIO` override: `true` forces audio on, `false` forces it off
 * (README contract), `undefined` defers to the config value. The single source
 * of this precedence — both the live audio gate and config resolution use it.
 */
export const audioOverride = (): boolean | undefined => {
  const v = process.env.PI_GBA_AUDIO;
  if (v === "0") return false;
  if (v === "1") return true;
  return undefined;
};

/** `PI_GBA_AUTO_FOCUS` override: `false` when set to `0`, else `undefined`. */
export const autoFocusOverride = (): boolean | undefined => {
  const v = process.env.PI_GBA_AUTO_FOCUS;
  return v === undefined ? undefined : v !== "0";
};

/** `PI_GBA_FRAME_DUMP` — directory to dump PNG frames into (undefined = off). */
export const frameDumpDir = (): string | undefined => {
  const dir = process.env.PI_GBA_FRAME_DUMP;
  return dir && dir.length > 0 ? dir : undefined;
};

/** `PI_GBA_FRAME_DUMP_EVERY` — dump cadence in frames; defaults to 30. */
export const frameDumpEvery = (): number => {
  const n = Number.parseInt(process.env.PI_GBA_FRAME_DUMP_EVERY ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
};
