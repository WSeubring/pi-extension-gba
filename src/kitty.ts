import { existsSync } from "node:fs";
import { join } from "node:path";
import { calculateImageRows, getCellDimensions } from "@mariozechner/pi-tui";

/**
 * Pure Kitty graphics-protocol helpers for the GBA game component: raw-file
 * path resolution, the `t=f` (file transport) transmit sequence, and image
 * layout. Stateless and free of component coupling, so they're unit-testable on
 * their own.
 */

/**
 * Rows reserved below the image for chrome that shares the screen: our footer
 * line (1) plus pi's status bar rows (2), so the image never overlaps pi's
 * bottom chrome.
 */
export const FOOTER_ROWS = 3;

/** Cap image rows to 90 % of available terminal height. */
const HEIGHT_RATIO = 0.9;

/** First existing dir among $TMPDIR, /dev/shm, /tmp — where raw frame files go. */
export function resolveRawDir(): string {
  const candidates = [process.env.TMPDIR, "/dev/shm", "/tmp"].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // keep trying
    }
  }
  return "/tmp";
}

export function rawFilePath(dir: string, imageId: number): string {
  return join(dir, `pi-gba-${imageId}.raw`);
}

export interface KittySeqOptions {
  widthPx: number;
  heightPx: number;
  columns: number;
  rows: number;
  imageId: number;
}

export function encodeKittyRawFile(base64Path: string, opts: KittySeqOptions): string {
  // f=32 RGBA — upscaler forces alpha=0xFF (see upscale.ts); Ghostty renders
  // RGBA correctly when alpha is opaque.
  //
  // No `S=` (data size): Ghostty 1.3.1 rejects any t=f transmit carrying S with
  // "EINVAL: invalid data" and renders nothing (param-isolation probe
  // 2026-06-09 — identical sequence without S gets ;OK and paints). S is
  // optional in the kitty spec; omitting it reads the whole file = one frame.
  const params = [
    "a=T",
    "f=32",
    "t=f",
    "p=1",
    "q=2",
    `s=${opts.widthPx}`,
    `v=${opts.heightPx}`,
    `c=${opts.columns}`,
    `r=${opts.rows}`,
    `i=${opts.imageId}`,
    "z=0",
  ];
  return `\x1b_G${params.join(",")};${base64Path}\x1b\\`;
}

export interface KittyLayout {
  cols: number;
  rows: number;
  availableRows: number;
}

export function computeLayout(widthCols: number, terminalRows: number, widthPx: number, heightPx: number): KittyLayout {
  const availableRows = Math.max(1, terminalRows - FOOTER_ROWS);
  const maxRows = Math.max(1, Math.floor(availableRows * HEIGHT_RATIO));

  // pi-tui's calculateImageRows reads the runtime cell dimensions reported by
  // the terminal (TIOCGWINSZ pixel extents). Falls back to the 0.5
  // approximation if the helper returns zero (e.g. headless test envs).
  const cellDims = getCellDimensions();
  let aspectRatioRows = calculateImageRows({ widthPx, heightPx }, widthCols, cellDims);
  if (!aspectRatioRows) {
    aspectRatioRows = Math.ceil((heightPx / widthPx) * widthCols * 0.5);
  }
  // Kitty's c=/r= scale the image to fill the cell rect WITHOUT preserving
  // aspect ratio. When the height cap binds (wide/short terminals), shrink the
  // columns proportionally so the frame is not stretched horizontally.
  let cols = widthCols;
  if (aspectRatioRows > maxRows) {
    cols = Math.max(1, Math.floor((widthCols * maxRows) / aspectRatioRows));
  }
  const rows = Math.min(aspectRatioRows, maxRows);

  return { cols, rows: Math.max(1, rows), availableRows };
}
