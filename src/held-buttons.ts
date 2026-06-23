import type { ButtonSink, GbaButton } from "./types.js";

/**
 * Tracks which GBA buttons are currently held and forwards press/release to a
 * sink, deduping redundant events (a second press of an already-held button is
 * ignored; releasing an unheld button is a no-op).
 *
 * When constructed with `decayMs > 0` it also auto-releases a held button after
 * that many milliseconds of silence: terminals don't reliably send key-up, so
 * without this a button could stick down forever. Every press/repeat re-arms
 * the timer; an explicit release cancels it. Pass `decayMs = 0` (the default)
 * for callers that receive reliable release events and want no timers.
 */
export class HeldButtons {
  private readonly held = new Set<GbaButton>();
  private readonly timers = new Map<GbaButton, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly sink: ButtonSink,
    private readonly decayMs = 0,
  ) {}

  /** Press a button (dedupes) and re-arm its decay timer if decay is enabled. */
  press(button: GbaButton): void {
    if (!this.held.has(button)) {
      this.sink.press(button);
      this.held.add(button);
    }
    this.arm(button);
  }

  /** Key-repeat for an already-held button: keep it alive by re-arming decay. */
  repeat(button: GbaButton): void {
    this.arm(button);
  }

  /** Release a button (dedupes) and cancel any pending decay timer. */
  release(button: GbaButton): void {
    this.clearTimer(button);
    if (this.held.has(button)) {
      this.sink.release(button);
      this.held.delete(button);
    }
  }

  /**
   * Release every held button and clear all timers. Sink errors are swallowed
   * per-button so a throwing sink (e.g. the emulator was already destroyed)
   * can't strand the rest of a component's teardown.
   */
  releaseAll(): void {
    for (const button of [...this.held]) {
      this.clearTimer(button);
      try {
        this.sink.release(button);
      } catch {
        // best-effort: continue releasing the remaining buttons
      }
      this.held.delete(button);
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private arm(button: GbaButton): void {
    if (this.decayMs <= 0) return;
    this.clearTimer(button);
    this.timers.set(
      button,
      setTimeout(() => {
        this.timers.delete(button);
        if (this.held.has(button)) {
          this.sink.release(button);
          this.held.delete(button);
        }
      }, this.decayMs),
    );
  }

  private clearTimer(button: GbaButton): void {
    const timer = this.timers.get(button);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(button);
    }
  }
}
