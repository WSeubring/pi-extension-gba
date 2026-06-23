import { homedir } from "node:os";
import path from "node:path";
import fsPromises from "node:fs/promises";

// Env vars:
//   PI_GBA_AUTO_FOCUS=0  — disable auto-focus (L7). Default: enabled.
//   PI_GBA_AUDIO=0|1     — override audio setting (phase-8).
//   PI_GBA_DEBUG_CORE    — existing debug flag (not parsed here).

export interface GbaConfig {
  version: 1;
  romDir: string;
  scale: 1 | 2 | 3;
  frameRate: number;                 // 1..30
  autoRunOnAgentStart: boolean;
  autoHideOnAgentEnd: boolean;
  /** Enter full-screen game mode on agent_start (after debounce). L1/L7. */
  autoFocusOnAgentStart: boolean;
  /** Milliseconds to wait before entering game mode on agent_start. L4. 0..5000 */
  autoFocusDebounceMs: number;
  /** Audio enabled. Phase-8 flag, persisted; overridden by PI_GBA_AUDIO. */
  audio: boolean;
}

// ---- Defaults ---------------------------------------------------------------

const DEFAULT_ROM_DIR = path.join(homedir(), ".config", "pi", "roms", "gba");

const DEFAULTS: GbaConfig = {
  version: 1,
  romDir: DEFAULT_ROM_DIR,
  scale: 2,
  frameRate: 30,
  autoRunOnAgentStart: true,
  autoHideOnAgentEnd: false,
  autoFocusOnAgentStart: true,
  autoFocusDebounceMs: 500,
  audio: false,
};

// ---- Helpers ----------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function expandTilde(p: string): string {
  // Only `~` exactly or a `~/` prefix refer to $HOME; `~user/...` names
  // another user's home and must be left untouched.
  if (p === "~") return homedir();
  if (p.startsWith("~/")) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

// ---- Path -------------------------------------------------------------------

/** Returns the path to the GBA config file: ~/.config/pi/gba.json */
export function getConfigPath(): string {
  return path.join(homedir(), ".config", "pi", "gba.json");
}

// ---- Normalize --------------------------------------------------------------

/**
 * Merges a partial config on top of defaults, clamping values into valid ranges.
 * Out-of-range values are clamped silently (caller may notify user if desired).
 */
export function normalize(input: Partial<GbaConfig>): GbaConfig {
  const rawScale = input.scale;
  const scale: 1 | 2 | 3 =
    rawScale === 1 || rawScale === 2 || rawScale === 3 ? rawScale : 2;

  const frameRate = clamp(
    typeof input.frameRate === "number" ? input.frameRate : DEFAULTS.frameRate,
    1,
    30,
  );

  const autoFocusDebounceMs = clamp(
    typeof input.autoFocusDebounceMs === "number"
      ? input.autoFocusDebounceMs
      : DEFAULTS.autoFocusDebounceMs,
    0,
    5000,
  );

  const rawRomDir =
    typeof input.romDir === "string" ? input.romDir : DEFAULTS.romDir;
  const romDir = expandTilde(rawRomDir);

  return {
    version: 1,
    romDir,
    scale,
    frameRate,
    autoRunOnAgentStart:
      typeof input.autoRunOnAgentStart === "boolean"
        ? input.autoRunOnAgentStart
        : DEFAULTS.autoRunOnAgentStart,
    autoHideOnAgentEnd:
      typeof input.autoHideOnAgentEnd === "boolean"
        ? input.autoHideOnAgentEnd
        : DEFAULTS.autoHideOnAgentEnd,
    autoFocusOnAgentStart:
      typeof input.autoFocusOnAgentStart === "boolean"
        ? input.autoFocusOnAgentStart
        : DEFAULTS.autoFocusOnAgentStart,
    autoFocusDebounceMs,
    audio:
      typeof input.audio === "boolean" ? input.audio : DEFAULTS.audio,
  };
}

// ---- File I/O ---------------------------------------------------------------

/**
 * Queued warning message from corrupt-file detection.
 * Set during loadConfigFile and emitted by the first ctx that becomes available.
 */
let _queuedWarning: string | undefined;

export function popQueuedWarning(): string | undefined {
  const w = _queuedWarning;
  _queuedWarning = undefined;
  return w;
}

/**
 * Reads and parses the GBA config file.
 * Returns a partial config on success, or {} on file-not-found.
 * On corrupt/unknown-version: backs up to .bak, queues a warning, returns {}.
 */
export async function loadConfigFile(): Promise<Partial<GbaConfig>> {
  const configPath = getConfigPath();
  let raw: string;
  try {
    raw = await fsPromises.readFile(configPath, "utf8");
  } catch (err: unknown) {
    // File not found → silent fallback
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await _backupAndWarn(configPath, raw, "JSON parse error");
    return {};
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>)["version"] !== 1
  ) {
    await _backupAndWarn(configPath, raw, "unknown version");
    return {};
  }

  return parsed as Partial<GbaConfig>;
}

async function _backupAndWarn(
  configPath: string,
  raw: string,
  reason: string,
): Promise<void> {
  const bakPath = configPath + ".bak";
  try {
    await fsPromises.writeFile(bakPath, raw, "utf8");
  } catch {
    // Best-effort backup — ignore write failures
  }
  _queuedWarning = `GBA config corrupt (${reason}) — backed up to gba.json.bak, using defaults`;
}

/**
 * Writes the GBA config file, normalizing values before writing.
 * On write failure, throws (caller should notify the user).
 */
export async function saveConfigFile(cfg: GbaConfig): Promise<void> {
  const normalized = normalize(cfg);
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(
    configPath,
    JSON.stringify(normalized, null, 2),
    "utf8",
  );
}

/**
 * Deletes the GBA config file (ignores ENOENT).
 */
export async function resetConfigFile(): Promise<void> {
  const configPath = getConfigPath();
  try {
    await fsPromises.unlink(configPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ---- resolveConfig ----------------------------------------------------------

/**
 * Resolves the effective GBA config using three layers (lowest to highest):
 *   1. Hardcoded defaults
 *   2. JSON file (~/.config/pi/gba.json) if present and valid
 *   3. Environment variables
 *
 * This function is async because reading the config file is async.
 */
export async function resolveConfig(): Promise<GbaConfig> {
  const fileCfg = await loadConfigFile();

  // Merge: defaults ← file
  const merged: Partial<GbaConfig> = { ...DEFAULTS, ...fileCfg };
  const base = normalize(merged);

  // Layer 3: env vars override
  const envAutoFocus = process.env["PI_GBA_AUTO_FOCUS"];
  if (envAutoFocus !== undefined) {
    base.autoFocusOnAgentStart = envAutoFocus !== "0";
  }

  const envAudio = process.env["PI_GBA_AUDIO"];
  if (envAudio !== undefined) {
    base.audio = envAudio !== "0";
  }

  return base;
}
