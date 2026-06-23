export type GbaButton =
  | "up"
  | "down"
  | "left"
  | "right"
  | "a"
  | "b"
  | "l"
  | "r"
  | "start"
  | "select";

export interface ButtonSink {
  press(button: GbaButton): void;
  release(button: GbaButton): void;
}
