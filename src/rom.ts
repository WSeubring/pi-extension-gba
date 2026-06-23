/** The Game Boy Advance ROM file extension. */
const GBA_EXTENSION = ".gba";

/** True when `name` ends with the `.gba` extension, case-insensitively. */
export function hasGbaExtension(name: string): boolean {
  return name.toLowerCase().endsWith(GBA_EXTENSION);
}

/** Append `.gba` to `token` unless it already carries the extension. */
export function ensureGbaExtension(token: string): string {
  return hasGbaExtension(token) ? token : `${token}${GBA_EXTENSION}`;
}

/**
 * The "ROM stem": a ROM basename with its `.gba` extension stripped
 * (case-insensitively). This is the identity that keys every save artifact —
 * `.sav`, `.state`, `.ss<slot>` — so the emulator's in-VFS paths and the
 * on-disk persistence paths MUST derive it the same way. A non-lowercase
 * extension (`GAME.GBA`) must yield the same stem (`GAME`) on both sides;
 * deriving it case-sensitively in one place and case-insensitively in the
 * other silently breaks the save/restore round-trip.
 */
export function romStem(basename: string): string {
  return basename.replace(/\.gba$/i, "");
}
