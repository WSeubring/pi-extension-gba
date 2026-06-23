import type { KeyId } from "@mariozechner/pi-tui";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@mariozechner/pi-tui";
import { HeldButtons } from "./held-buttons.js";
import type { ButtonSink, GbaButton } from "./types.js";

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

/**
 * The keys that exit game mode / the input overlay. Raw ESC (\x1b) and raw
 * ctrl+c (\x03) always exit. The rest match on PRESS only: matchesKey also
 * matches the key-RELEASE encoding, and the components opt into release
 * delivery — without the press guard, entering via the alt+g shortcut would
 * self-close when that key's own release arrives (observed in Ghostty).
 */
export function isGbaExitKey(data: string): boolean {
  if (data === "\x03" || data === "\x1b") return true;
  if (isKeyRelease(data)) return false;
  return (
    matchesKey(data, "alt+g") ||
    matchesKey(data, "ctrl+c") ||
    matchesKey(data, "escape") ||
    matchesKey(data, "q") ||
    matchesKey(data, "shift+q")
  );
}

/**
 * A GBA input session over a terminal: the single home for the exit-hatch keys
 * and the classify→held-buttons routing that both the full-screen game
 * component and the minimal-mode overlay need. The component owns rendering and
 * decides what "exit" does; this owns input.
 */
export class GbaInputSession {
  private readonly buttons: HeldButtons;

  /** `decayMs > 0` auto-releases stuck buttons (terminals miss key-up); pass 0
   * for callers that receive reliable releases (the minimal overlay). */
  constructor(sink: ButtonSink, decayMs = 0) {
    this.buttons = new HeldButtons(sink, decayMs);
  }

  /**
   * Route one raw input byte string. Returns "exit" if it is an exit hatch
   * (the caller should tear the session down), else "consumed".
   */
  handleKey(data: string): "exit" | "consumed" {
    if (isGbaExitKey(data)) return "exit";
    const event = classifyGbaKey(data);
    switch (event.kind) {
      case "press":
        this.buttons.press(event.button);
        break;
      case "release":
        this.buttons.release(event.button);
        break;
      case "repeat":
        this.buttons.repeat(event.button);
        break;
      case "passthrough":
      case "drop":
        break;
    }
    return "consumed";
  }

  /** Release every held button and clear timers (call on dispose). */
  releaseAll(): void {
    this.buttons.releaseAll();
  }
}
