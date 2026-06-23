/**
 * Phase 9b — Custom-UI game component.
 *
 * GbaGameComponent implements pi-tui's Component interface and is hosted
 * via ctx.ui.custom(...) during game mode (mounted by 9c). It owns:
 *   - Kitty image transmission (hand-rolled Kitty t=f raw-file sequence)
 *   - Input routing to the emulator (via classifyGbaKey shared helper)
 *   - Clean teardown (release buttons, delete Kitty image, unlink raw file)
 *
 * Rendering strategy (direct-pin, 2026-06-09 — replaces the pi-nes
 * line-embedded approach):
 *
 *   • Write the upscaled RGBA frame to a file on /dev/shm (or fall back to
 *     /tmp) every `acceptFrame`. Kitty reads the file via the `t=f` (file
 *     transport) parameter, so we never base64-encode the pixels. The bytes
 *     on the wire per frame stay constant (< 200 B) regardless of scale.
 *   • render() emits ONLY static blank lines + a static footer — the image
 *     never appears in pi-tui's line diff. Embedding the transmit sequence
 *     in a rendered line coupled the image to document flow: agent
 *     streaming grew the chat container every chunk, pi-tui repainted the
 *     shifted lines, and the placement re-transmitted at a moving position
 *     (visible stutter/jumping).
 *   • acceptFrame() pins the placement itself: save cursor → absolute move
 *     to the image's top-left cell → `a=T` transmit → restore cursor →
 *     delete the previously visible image id, all in ONE synchronous
 *     terminal write. 30 fps re-pinning snaps the image back within ≤33 ms
 *     even if a scroll drags it between frames.
 *   • DOUBLE-BUFFERED: frames alternate between two image ids, each with
 *     its own raw file. Re-transmitting over a single id makes Ghostty
 *     blank the cells before the new frame decodes (hard 30 Hz flicker);
 *     place-new-then-delete-old keeps pixels on screen across the swap.
 *   • On dispose: delete both Kitty image ids and unlink both raw files.
 */

import { closeSync, existsSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { allocateImageId, calculateImageRows, deleteKittyImage, getCellDimensions } from "@mariozechner/pi-tui";
import { renderTrace } from "./flags.js";
import { GbaInputSession } from "./input.js";
import type { ButtonSink } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GameComponentDeps {
  /** ButtonSink — receives press/release events. Frames arrive via acceptFrame. */
  sink: ButtonSink;
  /** Display scale from cfg (1×, 2×, 3×). */
  scale: 1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const PRESS_DECAY_MS = 100;

/**
 * Rows reserved below the image for chrome that shares the screen with the
 * component: our own footer line (1) plus pi's status bar rows (2), so the
 * image never overlaps pi's bottom chrome.
 */
const FOOTER_ROWS = 3;

/** Height ratio: cap image rows to 90 % of available terminal height. */
const HEIGHT_RATIO = 0.9;

/** PI_GBA_RENDER_TRACE=1 → stderr-log placement pins + input bytes. */
const RENDER_TRACE = renderTrace();

// ---------------------------------------------------------------------------
// Raw-file path resolution
// ---------------------------------------------------------------------------

function resolveRawDir(): string {
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

function rawFilePath(dir: string, imageId: number): string {
  return join(dir, `pi-gba-${imageId}.raw`);
}

// ---------------------------------------------------------------------------
// Kitty t=f (file transport) sequence — adapted from pi-nes prior art.
// ---------------------------------------------------------------------------

interface KittySeqOptions {
  widthPx: number;
  heightPx: number;
  columns: number;
  rows: number;
  imageId: number;
}

function encodeKittyRawFile(base64Path: string, opts: KittySeqOptions): string {
  // f=32 RGBA — upscaler forces alpha=0xFF (render.ts makeUpscaler), probe
  // confirms Ghostty renders RGBA correctly when alpha is opaque.
  //
  // No `S=` (data size): Ghostty 1.3.1 rejects any t=f transmit carrying S
  // with "EINVAL: invalid data" and renders nothing (verified by param-
  // isolation probe 2026-06-09 — identical sequence without S gets ;OK and
  // paints). S is optional in the kitty spec; omitting it reads the whole
  // file, which is exactly one frame.
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

// ---------------------------------------------------------------------------
// Layout computation
// ---------------------------------------------------------------------------

interface KittyLayout {
  cols: number;
  rows: number;
  availableRows: number;
}

/** One half of the double-buffer: a Kitty image id backed by a raw RGBA file. */
interface DoubleBufferSlot {
  imageId: number;
  path: string;
  path64: string;
  fd: number | null;
}

function computeLayout(widthCols: number, terminalRows: number, widthPx: number, heightPx: number): KittyLayout {
  const availableRows = Math.max(1, terminalRows - FOOTER_ROWS);
  const maxRows = Math.max(1, Math.floor(availableRows * HEIGHT_RATIO));

  // Use pi-tui's calculateImageRows which reads the runtime cell dimensions
  // reported by the terminal (TIOCGWINSZ pixel extents). Falls back to the
  // 0.5 approximation if the helper returns zero (e.g. in headless test envs).
  const cellDims = getCellDimensions();
  let aspectRatioRows = calculateImageRows({ widthPx, heightPx }, widthCols, cellDims);
  if (!aspectRatioRows) {
    aspectRatioRows = Math.ceil((heightPx / widthPx) * widthCols * 0.5);
  }
  // Kitty's c=/r= scale the image to fill the cell rect WITHOUT preserving
  // aspect ratio. When the height cap binds (wide/short terminals), shrink
  // the columns proportionally so the frame is not stretched horizontally.
  let cols = widthCols;
  if (aspectRatioRows > maxRows) {
    cols = Math.max(1, Math.floor((widthCols * maxRows) / aspectRatioRows));
  }
  const rows = Math.min(aspectRatioRows, maxRows);

  return { cols, rows: Math.max(1, rows), availableRows };
}

// ---------------------------------------------------------------------------
// GbaGameComponent
// ---------------------------------------------------------------------------

export class GbaGameComponent implements Component {
  readonly wantsKeyRelease = true;

  private readonly sink: ButtonSink;
  private readonly tui: TUI;
  private readonly done: (r: undefined) => void;

  // Latest frame kept by reference (CustomRenderBackend copies before passing).
  private latestRgba: Uint8Array | undefined;
  private latestWidthPx = 0;
  private latestHeightPx = 0;

  // Cached layout (recomputed when geometry changes).
  private cachedCols = 0;
  private cachedRows = 0;

  /**
   * Double-buffer slots. Re-transmitting `a=T` over a single image id makes
   * Ghostty tear the old placement down before the new file is decoded —
   * a blank gap every frame, i.e. hard 30 Hz flicker. Instead frames
   * alternate between two image ids (each with its own raw file): place the
   * incoming id, THEN delete the previous one in the same write. The old
   * pixels stay on screen until the new ones are up — verified flicker-free
   * idiom in Ghostty 1.3.1 (probe 2026-06-09: alternate-id a=T + delete-old
   * → clean swap; the Kitty animation protocol a=f/a=a is NOT supported).
   */
  private readonly slots: readonly [DoubleBufferSlot, DoubleBufferSlot];
  /** Slot the NEXT frame will be written to (flips every frame). */
  private slotIdx: 0 | 1 = 0;
  /** Image id currently on screen (delete target for the next swap). */
  private visibleImageId: number | undefined;

  private readonly input: GbaInputSession;
  private disposed = false;

  /** Trace counter (PI_GBA_RENDER_TRACE) — first few placements logged. */
  private rawVersion = 0;

  /** Width pi-tui last rendered us at — placement geometry derives from it. */
  private lastRenderWidth = 0;

  /** Original terminal.write — restored on dispose (see installWriteHook). */
  private origWrite: ((data: string) => void) | undefined;

  /** Re-entrancy guard: our own pin writes must not re-trigger the hook. */
  private inEmit = false;

  constructor(tui: TUI, _deps: GameComponentDeps, done: (r: undefined) => void) {
    this.tui = tui;
    this.sink = _deps.sink;
    this.done = done;
    // Terminals don't reliably send key-up; the decay timer auto-releases a
    // stuck button after PRESS_DECAY_MS (see HeldButtons inside GbaInputSession).
    this.input = new GbaInputSession(this.sink, PRESS_DECAY_MS);
    const dir = resolveRawDir();
    const makeSlot = (): DoubleBufferSlot => {
      const imageId = allocateImageId();
      const path = rawFilePath(dir, imageId);
      return {
        imageId,
        path,
        path64: Buffer.from(path).toString("base64"),
        fd: null,
      };
    };
    this.slots = [makeSlot(), makeSlot()];
  }

  // ---------------------------------------------------------------------------
  // Component interface
  // ---------------------------------------------------------------------------

  /**
   * STATIC lines only — the image is NOT part of pi-tui's line diff.
   *
   * Earlier revisions embedded the Kitty transmit sequence in a rendered
   * line (pi-nes idiom). That couples the image to document flow: while the
   * agent streams text, every chunk grows the chat container, pi-tui
   * repaints the shifted lines, and the placement gets re-transmitted at a
   * moving position — visible stutter/jumping of the whole game. Returning
   * unchanging blank lines + a static footer means the differ sees nothing
   * to repaint here; the image is pinned to absolute screen coordinates by
   * acceptFrame() via a direct terminal write instead.
   */
  render(width: number): string[] {
    if (this.disposed || width <= 0) {
      return [""];
    }
    this.lastRenderWidth = width;

    const layout = computeLayout(width, this.tui.terminal.rows, this.latestWidthPx || 480, this.latestHeightPx || 320);

    const lines: string[] = [];
    for (let i = 0; i < layout.availableRows; i += 1) {
      lines.push("");
    }
    const footer = " GBA | alt+g / q / ctrl+c = exit";
    const truncated = footer.length > width ? footer.slice(0, width) : footer;
    lines.push(`\x1b[2m${truncated}\x1b[0m`);
    return lines;
  }

  /**
   * Write the frame into the inactive slot's file, then emit one atomic
   * terminal chunk: save cursor → absolute move to the image's top-left
   * cell → `a=T` for the incoming image id → restore cursor → delete the
   * previously visible id. Double-buffering removes the per-frame blank gap
   * (see `slots`); absolute pinning keeps the image out of pi-tui's diff so
   * agent streaming cannot move it; re-pinning at frame rate snaps the
   * placement back within ≤33 ms if a scroll ever drags it.
   */
  private emitPlacement(): void {
    if (this.latestRgba === undefined) return;
    const width = this.lastRenderWidth;
    if (width <= 0) return;

    const layout = computeLayout(width, this.tui.terminal.rows, this.latestWidthPx, this.latestHeightPx);

    if (layout.cols !== this.cachedCols || layout.rows !== this.cachedRows) {
      this.cachedCols = layout.cols;
      this.cachedRows = layout.rows;
      // Layout changed — let pi repaint the (static) line scaffolding once.
      this.tui.requestRender();
    }

    const slot = this.slots[this.slotIdx];
    this.slotIdx = this.slotIdx === 0 ? 1 : 0;
    try {
      if (slot.fd === null) {
        slot.fd = openSync(slot.path, "w+");
      }
      const rgba = this.latestRgba;
      writeSync(slot.fd, rgba, 0, rgba.length, 0);
    } catch {
      return; // can't produce a frame file — keep the previous image up
    }

    const seq = encodeKittyRawFile(slot.path64, {
      widthPx: this.latestWidthPx,
      heightPx: this.latestHeightPx,
      columns: layout.cols,
      rows: layout.rows,
      imageId: slot.imageId,
    });

    // Anchor the image so its bottom sits just above our footer + pi's
    // status rows, regardless of how tall the terminal is.
    const totalRows = this.tui.terminal.rows;
    const placeRow = Math.max(1, totalRows - FOOTER_ROWS - layout.rows + 1);

    // Place new, then delete old — strictly in that order, one write.
    const deleteOld =
      this.visibleImageId !== undefined && this.visibleImageId !== slot.imageId
        ? `\x1b_Ga=d,d=I,q=2,i=${this.visibleImageId}\x1b\\`
        : "";
    this.inEmit = true;
    try {
      const write = this.origWrite ?? this.tui.terminal.write.bind(this.tui.terminal);
      write(`\x1b7\x1b[${placeRow};1H${seq}\x1b8${deleteOld}`);
    } finally {
      this.inEmit = false;
    }
    this.visibleImageId = slot.imageId;

    if (RENDER_TRACE && this.rawVersion <= 3) {
      this.rawVersion += 1;
      process.stderr.write(
        `[pi-gba-trace] pin v=${this.rawVersion} width=${width} terminalRows=${totalRows} ` +
          `layout=${layout.cols}x${layout.rows} placeRow=${placeRow} ` +
          `imagePx=${this.latestWidthPx}x${this.latestHeightPx} imageId=${slot.imageId}\n`,
      );
    }
  }

  handleInput(data: string): void {
    // Post-dispose input must be a no-op: the emulator may already be
    // destroyed (sink.press throws EmulatorNotLoadedError) and a decay timer
    // armed here would throw inside setTimeout — an uncaught exception.
    if (this.disposed) return;
    if (RENDER_TRACE) {
      process.stderr.write(`[pi-gba-trace] handleInput ${JSON.stringify(data)}\n`);
    }
    if (this.input.handleKey(data) === "exit") {
      this.done(undefined);
    }
  }

  invalidate(): void {
    // Reset cached layout so the next placement recomputes from scratch.
    this.cachedCols = 0;
    this.cachedRows = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Unwrap terminal.write BEFORE emitting cleanup sequences.
    this.removeWriteHook();

    // Release all held buttons.
    this.input.releaseAll();

    // Delete both buffered Kitty images from the terminal, close fds,
    // unlink the raw files.
    for (const slot of this.slots) {
      this.tui.terminal.write(deleteKittyImage(slot.imageId));
      if (slot.fd !== null) {
        try {
          closeSync(slot.fd);
        } catch {
          // best-effort
        }
        slot.fd = null;
      }
      try {
        if (existsSync(slot.path)) unlinkSync(slot.path);
      } catch {
        // best-effort
      }
    }
    this.visibleImageId = undefined;
  }

  // ---------------------------------------------------------------------------
  // requestClose — called by auto-focus exit path (9c addendum)
  // ---------------------------------------------------------------------------

  requestClose(): void {
    if (this.disposed) return;
    this.done(undefined);
  }

  // ---------------------------------------------------------------------------
  // acceptFrame — called by CustomRenderBackend tick
  // ---------------------------------------------------------------------------

  acceptFrame(rgba: Uint8Array, widthPx: number, heightPx: number): void {
    if (this.disposed) return;
    const firstFrame = this.latestRgba === undefined;
    this.latestRgba = rgba;
    this.latestWidthPx = widthPx;
    this.latestHeightPx = heightPx;

    if (firstFrame) {
      // Mount the static line scaffolding once; subsequent frames only
      // re-pin the placement and never touch pi-tui's diff.
      this.tui.requestRender();
      // From the first frame on, every pi-tui flush is chased by a re-pin
      // so scrolls can never leave the image displaced for a visible frame.
      this.installWriteHook();
    }
    // File write + transmit + delete-old all happen inside emitPlacement
    // (the file belongs to the slot being placed).
    this.emitPlacement();
  }

  /**
   * Wrap tui.terminal.write so that EVERY flush pi-tui makes is immediately
   * followed by a fresh placement swap in the same synchronous burst.
   *
   * Why: during agent streaming the chat document grows each chunk; pi-tui
   * scrolls the terminal to make room, and the scroll physically drags Kitty
   * placements up with the cells. Re-pinning only at the 30 fps tick leaves
   * the image displaced for up to 33 ms — visible bouncing/flicker exactly
   * while the agent types. Chasing each foreign write with a re-pin puts the
   * correction in the same pty flush, so the compositor never shows the
   * intermediate state. (Put-only re-placement via a=p is not usable:
   * Ghostty 1.3.1 duplicates instead of replacing same-id placements —
   * probed 2026-06-09. The full double-buffer swap is cheap: ~200 B escape +
   * one shm file write.)
   */
  private installWriteHook(): void {
    if (this.origWrite) return;
    const term = this.tui.terminal as unknown as { write: (data: string) => void };
    const orig = term.write.bind(term);
    this.origWrite = orig;
    term.write = (data: string) => {
      orig(data);
      if (!this.inEmit && !this.disposed && this.latestRgba !== undefined) {
        this.emitPlacement();
      }
    };
  }

  /** Restore the unwrapped terminal.write (dispose path). */
  private removeWriteHook(): void {
    if (!this.origWrite) return;
    (this.tui.terminal as unknown as { write: (data: string) => void }).write = this.origWrite;
    this.origWrite = undefined;
  }

  // ---------------------------------------------------------------------------
  // @internal — test access
  // ---------------------------------------------------------------------------

  __getImageId(): number | undefined {
    if (this.disposed) return undefined;
    return this.visibleImageId ?? this.slots[0]?.imageId;
  }
}
