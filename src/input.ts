import type { KeyId } from "@mariozechner/pi-tui";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@mariozechner/pi-tui";
import type { GbaButton } from "./types.js";

const KEY_MAP: ReadonlyArray<readonly [KeyId, GbaButton]> = [
  ["up", "up"],
  ["down", "down"],
  ["left", "left"],
  ["right", "right"],
  ["z", "a"],
  ["x", "b"],
  ["a", "l"],
  ["s", "r"],
  ["enter", "start"],
  ["backspace", "select"],
];

// ---------------------------------------------------------------------------
// Shared key-classification helper
// ---------------------------------------------------------------------------

export type ButtonEvent =
  | { kind: "press"; button: GbaButton }
  | { kind: "release"; button: GbaButton }
  | { kind: "repeat"; button: GbaButton }
  | { kind: "passthrough"; data: string } // editor must forward to super
  | { kind: "drop" }; // e.g. printable when in game mode

/**
 * Pure helper: classifies a raw input byte string into a GBA ButtonEvent.
 * Used by GbaGameComponent. No state; safe to call from any context.
 */
export function classifyGbaKey(data: string): ButtonEvent {
  for (const [keyId, button] of KEY_MAP) {
    if (!matchesKey(data, keyId)) continue;

    if (isKeyRelease(data)) return { kind: "release", button };
    if (isKeyRepeat(data)) return { kind: "repeat", button };
    return { kind: "press", button };
  }

  // Drop printable keystrokes; pass control/escape chars through.
  const first = data.charCodeAt(0);
  const isPrintable = first >= 0x20 && first !== 0x7f;
  if (isPrintable) return { kind: "drop" };

  return { kind: "passthrough", data };
}
