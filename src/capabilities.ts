import { spawnSync } from "node:child_process";
import { getCapabilities, setCapabilities } from "@mariozechner/pi-tui";
import type { AudioBackend } from "./audio.js";

export interface GbaCapabilities {
  kittyGraphics: boolean;
  audioBackend: AudioBackend | undefined;
}

const AUDIO_ORDER: AudioBackend[] = ["pw-cat", "pacat", "ffplay", "aplay"];

// Per-tool probe args: ffplay (ffmpeg-style) only accepts `-version` and
// exits 1 on `--version`, so a uniform `--version` probe would never detect it.
const PROBE_ARGS: Record<AudioBackend, string[]> = {
  "pw-cat": ["--version"],
  pacat: ["--version"],
  ffplay: ["-version"],
  aplay: ["--version"],
};

/** Injectable for tests — matches the spawnSync subset the probe needs. */
export type ProbeSpawn = (
  cmd: string,
  args: string[],
  opts: { stdio: "ignore"; timeout: number },
) => { status: number | null };

export function probeAudioBackend(spawn: ProbeSpawn = spawnSync): AudioBackend | undefined {
  for (const tool of AUDIO_ORDER) {
    try {
      const r = spawn(tool, PROBE_ARGS[tool], {
        stdio: "ignore",
        timeout: 500,
      });
      if (r.status === 0) return tool;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export function detectCapabilities(): GbaCapabilities {
  return {
    kittyGraphics: getCapabilities().images === "kitty",
    audioBackend: probeAudioBackend(),
  };
}

export function __setCapabilitiesForTest(caps: { images: "kitty" | "iterm2" | null }): void {
  setCapabilities({ images: caps.images, trueColor: true, hyperlinks: true });
}
