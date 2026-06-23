export type GbaButton = "up" | "down" | "left" | "right" | "a" | "b" | "l" | "r" | "start" | "select";

/** Canonical list of every GBA button — the single source consumers iterate. */
export const GBA_BUTTONS: readonly GbaButton[] = ["up", "down", "left", "right", "a", "b", "l", "r", "start", "select"];

export interface ButtonSink {
  press(button: GbaButton): void;
  release(button: GbaButton): void;
}
