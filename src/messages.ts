import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AudioPlayer } from "./audio.js";

/** Single source of truth for user-facing notification strings. */
export const MSG = {
  kittyUnsupported: "GBA: this terminal does not support Kitty graphics — extension disabled",
  audioNotEnabled: "GBA: audio not enabled — set PI_GBA_AUDIO=1 or enable via /gba config",
  audioMuted: "GBA: audio muted",
  audioUnmuted: "GBA: audio unmuted",
} as const;

/**
 * Builds a "Kitty graphics unsupported" notifier that warns at most once per
 * activation. Both the full and minimal activation paths share this so the
 * wording and the warn-once behaviour can't drift apart.
 */
export function createUnsupportedNotifier(): (ctx: ExtensionContext) => void {
  let notified = false;
  return (ctx: ExtensionContext) => {
    if (notified) return;
    notified = true;
    ctx.ui.notify(MSG.kittyUnsupported, "warning");
  };
}

/**
 * Returns the player when audio is active, otherwise notifies the user that
 * audio is off and returns undefined. Callers gate on the return value.
 */
export function requireAudio(ctx: ExtensionContext, audio: AudioPlayer | undefined): AudioPlayer | undefined {
  if (!audio) {
    ctx.ui.notify(MSG.audioNotEnabled, "warning");
    return undefined;
  }
  return audio;
}

/** Flips mute on the player and notifies the user of the resulting state. */
export function toggleMute(ctx: ExtensionContext, audio: AudioPlayer): void {
  if (audio.isMuted()) {
    audio.unmute();
    ctx.ui.notify(MSG.audioUnmuted, "info");
  } else {
    audio.mute();
    ctx.ui.notify(MSG.audioMuted, "info");
  }
}
