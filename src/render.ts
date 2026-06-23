import { performance } from "node:perf_hooks";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { encode as encodePng } from "fast-png";
import { Image, allocateImageId, deleteKittyImage } from "@mariozechner/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { WidgetPlacement } from "@mariozechner/pi-coding-agent";
import type { AudioPlayer } from "./audio.js";

const GBA_W = 240;
const GBA_H = 160;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RenderBackendKind = "widget" | "custom";

/**
 * Phase 9 REVISE B1: tagged frame payload. Widget backend needs PNG (pi-tui's
 * Image requires it); custom backend needs raw RGBA (Kitty f=32). Producing
 * the representation a backend wants avoids the PNG-over-f=32 mismatch that
 * would render garbled pixels in game mode.
 */
export type FramePayload =
  | { kind: "rgba"; bytes: Uint8Array; width: number; height: number }
  | { kind: "png"; bytes: Uint8Array; width: number; height: number };

/**
 * Minimal interface that 9b's GbaGameComponent must satisfy.
 * The full Component implementation lives in 9b; this stub keeps 9a
 * self-contained and lets CustomRenderBackend typecheck.
 */
export interface GbaGameComponent {
  acceptFrame(rgba: Uint8Array, widthPx: number, heightPx: number): void;
  dispose(): void;
  /** @internal test access */
  __getImageId(): number | undefined;
}

export interface RenderBackend {
  /** Write one frame. Called by the tick loop. */
  pushFrame(payload: FramePayload): void;
  /** Start presenting (mount widget / show custom UI). Idempotent. */
  mount(): void;
  /** Stop presenting but keep pixel buffers / imageId (frozen still). */
  unmount(): void;
  /** Apply new layout hint (shrink/expand/hidden). */
  setLayout(layout: "expanded" | "shrunk" | "hidden"): void;
  /** Free terminal-side resources (Kitty image id, file handles). */
  dispose(): void;
  /** @internal test access. */
  __getImageId(): number | undefined;
}

export interface RenderOptions {
  scale?: 1 | 2 | 3;
  frameRate?: number;
  placement?: "aboveEditor" | "belowEditor";
  widgetKey?: string;
  expandedMaxCells?: number;
  shrunkMaxCells?: number;
  /** Default backend. "widget" matches pre-Phase-9 behaviour. */
  initialBackend?: RenderBackendKind;
  /** Inject the custom-UI component for the "custom" backend (set by 9c). */
  attachCustomComponent?: (component: GbaGameComponent) => void;
  /**
   * Audio player. When provided, tick() drains PCM from the emulator and
   * forwards it to the player. When undefined, audio is skipped (silent mode).
   */
  audio?: AudioPlayer;
}

export interface RenderController {
  start(): void;
  stop(): void;
  shrink(): void;
  expand(): void;
  hide(): void;
  destroy(): void;
  onRenderError(cb: (err: RenderTickError | RenderInitError) => void): () => void;
  /** @internal */
  __testGetImageId(): number | undefined;
}

export interface RenderControllerWithSwap extends RenderController {
  /** Swap active backend. Old backend fully disposed before new one mounts. */
  useBackend(kind: RenderBackendKind): void;
  /** Current kind. */
  activeBackend(): RenderBackendKind;
  /**
   * Wire the live GbaGameComponent into the custom render backend.
   * Must be called before useBackend("custom") so frames reach the component.
   * Called by 9c auto-focus on each custom UI mount.
   */
  setCustomComponent(component: GbaGameComponent): void;
  /**
   * Phase 9 REVISE B3: one-shot still frame for the widget backend, intended
   * to be called on Running→Paused transition. Captures a single frame from
   * the emulator and flushes it to the widget surface. No subsequent ticks.
   *
   * Safe to call from any backend state; no-ops if widget backend cannot
   * produce a frame (missing ctx, emulator crashed).
   */
  showStillFrame(): void;
  /**
   * Phase 9 REVISE B3: opt-out toggle. When true, widget backend ticks live
   * during every frame (pre-Phase-9 behaviour, used when PI_GBA_AUTO_FOCUS=0).
   * When false (default), widget backend only emits on explicit showStillFrame
   * flushes so there is no ambient widget above the editor (L2/L5).
   */
  setWidgetLiveTick(enabled: boolean): void;
}

export interface EmulatorLike {
  step(frames: number): void;
  getFramebuffer(): Uint8Array;
  /** Optional — present when the vendor build includes audio ring buffer access. */
  getAudioSamples?(maxFrames: number): Int16Array;
}

export class RenderInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderInitError";
  }
}

export class RenderTickError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "RenderTickError";
  }
}

// ---------------------------------------------------------------------------
// WidgetRenderBackend — wraps the original setWidget path.
//
// Phase 9 REVISE B3: WidgetRenderBackend no longer participates in the Running
// tick surface when auto-focus is active. During Running the custom backend is
// the only ticking surface. The widget backend is reserved for a one-shot
// still-frame flush on pause (see RenderController.showStillFrame) and the
// legacy opt-out path (PI_GBA_AUTO_FOCUS=0) where it behaves as pre-Phase-9.
// ---------------------------------------------------------------------------

class WidgetRenderBackend implements RenderBackend {
  private imageId: number | undefined;
  private currentMaxWidthCells: number;
  private hidden = false;

  /**
   * Phase 9 REVISE B3: gate live-tick pushFrame. Default false — widget
   * backend only shows one-shot still frames (see writeFrame). The controller
   * flips this to true on the legacy opt-out path (autoFocusOnAgentStart=false)
   * so pre-Phase-9 widget-above-editor behaviour is retained for users who
   * set PI_GBA_AUTO_FOCUS=0.
   */
  private liveTick = false;

  constructor(
    private ctx: ExtensionContext,
    private widgetKey: string,
    private placement: WidgetPlacement,
    private expandedMaxCells: number,
    private shrunkMaxCells: number,
  ) {
    this.currentMaxWidthCells = expandedMaxCells;
  }

  setLiveTick(enabled: boolean): void {
    this.liveTick = enabled;
  }

  pushFrame(payload: FramePayload): void {
    // Phase 9 REVISE B3: per L2/L5, no ambient widget during Running. The
    // widget backend only emits on explicit still-frame flushes unless the
    // controller has opted into live-tick (legacy opt-out path).
    if (!this.liveTick) return;
    this.writeFrame(payload);
  }

  /**
   * Write a single frame to the widget surface regardless of liveTick gating.
   * Used by RenderController.showStillFrame for the Running→Paused transition
   * still-frame and by the legacy live-tick path.
   */
  writeFrame(payload: FramePayload): void {
    if (this.hidden) return;
    // Widget backend requires PNG (pi-tui's Image accepts "image/png").
    if (payload.kind !== "png") return;
    if (this.imageId === undefined) {
      this.imageId = allocateImageId();
    }
    const base64 = Buffer.from(payload.bytes).toString("base64");
    const id = this.imageId;
    const maxW = this.currentMaxWidthCells;
    const widthPx = payload.width;
    const heightPx = payload.height;
    this.ctx.ui.setWidget(
      this.widgetKey,
      (_tui, _theme) =>
        new Image(
          base64,
          "image/png",
          { fallbackColor: (s: string) => s },
          { imageId: id, maxWidthCells: maxW },
          { widthPx, heightPx },
        ),
      { placement: this.placement },
    );
  }

  /** Make widget visible — no-op because visibility is implicit via pushFrame. */
  mount(): void {
    this.hidden = false;
  }

  /**
   * Stop the live tick loop presentation but keep the last frame frozen.
   * Widget remains visible — no-op for widget backend.
   */
  unmount(): void {
    // widget stays visible as a frozen still; hidden flag unchanged
  }

  setLayout(layout: "expanded" | "shrunk" | "hidden"): void {
    if (layout === "expanded") {
      this.hidden = false;
      this.currentMaxWidthCells = this.expandedMaxCells;
    } else if (layout === "shrunk") {
      this.hidden = false;
      this.currentMaxWidthCells = this.shrunkMaxCells;
    } else {
      // "hidden" — hide the widget
      this.hidden = true;
      this.ctx.ui.setWidget(this.widgetKey, undefined);
    }
  }

  dispose(): void {
    if (this.imageId !== undefined) {
      process.stdout.write(deleteKittyImage(this.imageId));
      this.imageId = undefined;
    }
    this.ctx.ui.setWidget(this.widgetKey, undefined);
    this.hidden = false;
  }

  __getImageId(): number | undefined {
    return this.imageId;
  }
}

// ---------------------------------------------------------------------------
// CustomRenderBackend — thin adapter to GbaGameComponent (9b)
// ---------------------------------------------------------------------------

class CustomRenderBackend implements RenderBackend {
  private component: GbaGameComponent | undefined;

  // PNG frame dump hook (env-gated). Zero cost when dumpDir is undefined.
  // Enable via PI_GBA_FRAME_DUMP=/path/to/dir. Tune cadence via
  // PI_GBA_FRAME_DUMP_EVERY=<n> (default 30 ≈ 1s of wall time at 30fps).
  private readonly dumpDir: string | undefined;
  private readonly dumpEvery: number;
  private dumpSeq = 0;

  constructor() {
    const dir = process.env["PI_GBA_FRAME_DUMP"];
    let dumpDir: string | undefined;
    if (dir && dir.length > 0) {
      try {
        mkdirSync(dir, { recursive: true });
        dumpDir = dir;
      } catch (e) {
        if (process.env["PI_GBA_AUDIO_TRACE"] === "1") {
          process.stderr.write(
            `[pi-extension-gba] frame-dump disabled: mkdir ${dir} failed: ${(e as Error).message}\n`,
          );
        }
      }
    }
    this.dumpDir = dumpDir;
    const everyRaw = Number.parseInt(process.env["PI_GBA_FRAME_DUMP_EVERY"] ?? "", 10);
    this.dumpEvery = Number.isFinite(everyRaw) && everyRaw > 0 ? everyRaw : 30;
  }

  setComponent(component: GbaGameComponent): void {
    this.component = component;
  }

  pushFrame(payload: FramePayload): void {
    // Custom backend requires raw RGBA (Kitty f=32 emitted by GbaGameComponent).
    if (payload.kind !== "rgba") return;
    this.component?.acceptFrame(payload.bytes, payload.width, payload.height);
    this.maybeDumpFrame(payload);
  }

  private maybeDumpFrame(payload: FramePayload): void {
    if (this.dumpDir === undefined) return;
    const seq = this.dumpSeq++;
    if (seq % this.dumpEvery !== 0) return;
    const name = `gba-${String(seq).padStart(4, "0")}.png`;
    const path = joinPath(this.dumpDir, name);
    // Copy bytes: caller may reuse/mutate the buffer before the async write completes.
    const data = new Uint8Array(payload.bytes);
    const png = encodePng({ width: payload.width, height: payload.height, data, depth: 8, channels: 4 });
    // Fire-and-forget: keep the tick loop non-blocking.
    writeFile(path, png).catch(() => {});
  }

  /** mount/unmount are no-ops here — mount happens in 9c via ctx.ui.custom. */
  mount(): void {}
  unmount(): void {}

  setLayout(_layout: "expanded" | "shrunk" | "hidden"): void {
    // 9b's component owns layout in custom mode — no-op here
  }

  dispose(): void {
    this.component?.dispose();
    this.component = undefined;
  }

  __getImageId(): number | undefined {
    return this.component?.__getImageId();
  }
}

// ---------------------------------------------------------------------------
// Upscaling helpers
// ---------------------------------------------------------------------------

function makeUpscaler(scale: 1 | 2 | 3, outW: number, outH: number): {
  upscale(rgba: Uint8Array): Uint8Array;
} {
  const scratch = scale > 1 ? new Uint8Array(outW * outH * 4) : new Uint8Array(0);

  function upscale2(rgba: Uint8Array): Uint8Array {
    for (let sy = 0; sy < GBA_H; sy++) {
      const dy0 = sy * 2;
      for (let sx = 0; sx < GBA_W; sx++) {
        const si = (sy * GBA_W + sx) * 4;
        const r = rgba[si];
        const g = rgba[si + 1];
        const b = rgba[si + 2];
        // Force alpha opaque: mGBA writes M_COLOR_WHITE = 0x00FFFFFF (alpha=0);
        // Kitty would render those pixels transparent. See ADR 0005.
        const dx0 = sx * 2;
        const di00 = (dy0 * outW + dx0) * 4;
        const di01 = di00 + 4;
        const di10 = ((dy0 + 1) * outW + dx0) * 4;
        const di11 = di10 + 4;
        scratch[di00] = r; scratch[di00 + 1] = g; scratch[di00 + 2] = b; scratch[di00 + 3] = 0xff;
        scratch[di01] = r; scratch[di01 + 1] = g; scratch[di01 + 2] = b; scratch[di01 + 3] = 0xff;
        scratch[di10] = r; scratch[di10 + 1] = g; scratch[di10 + 2] = b; scratch[di10 + 3] = 0xff;
        scratch[di11] = r; scratch[di11 + 1] = g; scratch[di11 + 2] = b; scratch[di11 + 3] = 0xff;
      }
    }
    return scratch;
  }

  function upscale3(rgba: Uint8Array): Uint8Array {
    for (let sy = 0; sy < GBA_H; sy++) {
      for (let sx = 0; sx < GBA_W; sx++) {
        const si = (sy * GBA_W + sx) * 4;
        const r = rgba[si];
        const g = rgba[si + 1];
        const b = rgba[si + 2];
        for (let dy = 0; dy < 3; dy++) {
          for (let dx = 0; dx < 3; dx++) {
            const di = ((sy * 3 + dy) * outW + (sx * 3 + dx)) * 4;
            scratch[di] = r; scratch[di + 1] = g; scratch[di + 2] = b; scratch[di + 3] = 0xff;
          }
        }
      }
    }
    return scratch;
  }

  return {
    upscale(rgba: Uint8Array): Uint8Array {
      if (scale === 1) {
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0xff;
        return rgba;
      }
      return scale === 2 ? upscale2(rgba) : upscale3(rgba);
    },
  };
}

// ---------------------------------------------------------------------------
// createRenderer — factory
// ---------------------------------------------------------------------------

export function createRenderer(
  ctx: ExtensionContext,
  emulator: EmulatorLike,
  opts?: RenderOptions,
): RenderControllerWithSwap {
  const scale = opts?.scale ?? 2;
  const frameRate = opts?.frameRate ?? 30;
  const placement = opts?.placement ?? "aboveEditor";
  const widgetKey = opts?.widgetKey ?? "gba";
  const expandedMaxCells = opts?.expandedMaxCells ?? 60;
  const shrunkMaxCells = opts?.shrunkMaxCells ?? 30;
  const initialBackend = opts?.initialBackend ?? "widget";
  const audio = opts?.audio;

  if (scale !== 1 && scale !== 2 && scale !== 3) {
    throw new RenderInitError("scale must be 1, 2, or 3");
  }
  if (frameRate < 1 || frameRate > 30) {
    throw new RenderInitError("frameRate must be between 1 and 30");
  }
  if (placement !== "aboveEditor" && placement !== "belowEditor") {
    throw new RenderInitError(
      'placement must be "aboveEditor" or "belowEditor"',
    );
  }

  const outW = GBA_W * scale;
  const outH = GBA_H * scale;
  const { upscale } = makeUpscaler(scale, outW, outH);

  const errorListeners = new Set<
    (err: RenderTickError | RenderInitError) => void
  >();

  let interval: ReturnType<typeof setInterval> | undefined;

  // Backend instances
  const widgetBackend = new WidgetRenderBackend(
    ctx,
    widgetKey,
    placement as WidgetPlacement,
    expandedMaxCells,
    shrunkMaxCells,
  );
  const customBackend = new CustomRenderBackend();

  // Allow 9c to set the game component before calling useBackend("custom")
  if (opts?.attachCustomComponent) {
    opts.attachCustomComponent({
      acceptFrame(rgba, widthPx, heightPx) {
        customBackend.pushFrame({ kind: "rgba", bytes: rgba, width: widthPx, height: heightPx });
      },
      dispose() {
        customBackend.dispose();
      },
      __getImageId() {
        return customBackend.__getImageId();
      },
    });
  }

  let activeKind: RenderBackendKind = initialBackend;
  let backend: RenderBackend = initialBackend === "widget" ? widgetBackend : customBackend;

  function getBackendForKind(kind: RenderBackendKind): RenderBackend {
    return kind === "widget" ? widgetBackend : customBackend;
  }

  /**
   * Produce a frame payload for the active backend. Widget backend needs PNG;
   * custom backend needs raw RGBA. Copying RGBA for the custom path protects
   * against mutation of the shared upscaler scratch buffer between ticks
   * (N2 hardening).
   */
  function encodeForBackend(rgba: Uint8Array): FramePayload {
    if (activeKind === "custom") {
      // Copy out of scratch so the component can store by reference safely.
      return { kind: "rgba", bytes: new Uint8Array(rgba), width: outW, height: outH };
    }
    const png = encodePng({ width: outW, height: outH, data: rgba, depth: 8, channels: 4 });
    return { kind: "png", bytes: png, width: outW, height: outH };
  }

  // 10c Bug 3 probe: opt-in per-tick audio tracing behind PI_GBA_AUDIO_TRACE=1.
  // Used to diagnose jitter in the wild: captures inter-tick interval (ms),
  // samples pulled per tick, and stdin writableLength at emission time.
  // Traces go to stderr; pi's TUI is expected to surface them inline in Ghostty
  // (the same path lifecycle diagnostics use; see lifecycle.ts:56 note).
  const audioTraceEnabled = process.env["PI_GBA_AUDIO_TRACE"] === "1";
  let lastTickAt = 0;

  function tick(): void {
    try {
      const tickStart = audioTraceEnabled ? performance.now() : 0;
      emulator.step(2);
      let pcmLen = 0;
      let writableLen: number | undefined;
      if (audio && emulator.getAudioSamples) {
        // Drain the ring completely: the core produces ~2186 frames per
        // step(2) at its native 65536 Hz, which exceeds the 2048-frame
        // scratch-buffer cap of a single getAudioSamples call. A single
        // capped read leaks ~138 frames/tick into the ring until it
        // saturates and drops samples (audible crackle). Iteration bound
        // guards against a pathological ring that never reports empty.
        for (let i = 0; i < 8; i++) {
          const pcm = emulator.getAudioSamples(2048);
          if (pcm.length === 0) break;
          pcmLen += pcm.length;
          audio.writeSamples(pcm);
        }
        if (audioTraceEnabled) {
          const probe = audio as unknown as { __probeWritableLength?: () => number | undefined };
          writableLen = typeof probe.__probeWritableLength === "function"
            ? probe.__probeWritableLength()
            : undefined;
        }
      }
      const rgba = emulator.getFramebuffer();
      const scaled = upscale(rgba);
      backend.pushFrame(encodeForBackend(scaled));
      if (audioTraceEnabled) {
        const now = tickStart;
        const dt = lastTickAt === 0 ? 0 : (now - lastTickAt);
        lastTickAt = now;
        const duration = performance.now() - tickStart;
        process.stderr.write(
          `[pi-extension-gba] audio-trace dt=${dt.toFixed(1)}ms dur=${duration.toFixed(1)}ms samples=${pcmLen} stdinBuf=${writableLen ?? "n/a"}\n`,
        );
      }
    } catch (e) {
      const err = new RenderTickError("tick failed", e);
      for (const cb of errorListeners) cb(err);
    }
  }

  /**
   * Phase 9 REVISE B3: shrink/expand need to flush one frame to the current
   * backend regardless of liveTick gating (a pending layout change must be
   * visually reflected). Bypasses the gate by calling writeFrame on widget.
   *
   * Does NOT step the emulator — same still-frame pattern as showStillFrame.
   * This runs outside the tick loop (agent_end shrink on a paused game, crash
   * handler shrink from inside the core's own crash callback), where a step(2)
   * would silently advance gameplay, push ~2185 undrained audio frames into
   * the ring, and re-enter wasm runFrame from within its own core callback.
   */
  function flushFrameToCurrentBackend(): void {
    try {
      const rgba = emulator.getFramebuffer();
      const scaled = upscale(rgba);
      const payload = encodeForBackend(scaled);
      if (activeKind === "widget" && payload.kind === "png") {
        widgetBackend.writeFrame(payload);
      } else {
        backend.pushFrame(payload);
      }
    } catch (e) {
      const err = new RenderTickError("tick failed", e);
      for (const cb of errorListeners) cb(err);
    }
  }

  const controller: RenderControllerWithSwap = {
    start() {
      if (interval !== undefined) return;
      backend.mount();
      tick();
      interval = setInterval(tick, Math.round(1000 / frameRate));
    },

    stop() {
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
      // widget backend: last frame stays frozen (unmount is a no-op)
      // custom backend: no-op
      backend.unmount();
    },

    shrink() {
      backend.setLayout("shrunk");
      // Flush a still frame immediately so the widget reflects the new size.
      // Works whether or not the tick loop is running (handles stopped state).
      flushFrameToCurrentBackend();
    },

    expand() {
      backend.setLayout("expanded");
      flushFrameToCurrentBackend();
    },

    hide() {
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
      backend.setLayout("hidden");
    },

    destroy() {
      controller.stop();
      // Dispose BOTH backends, not just the active one: a custom component
      // wired via setCustomComponent while the widget backend is active would
      // otherwise leak its write hook + raw files on destroy.
      widgetBackend.dispose();
      customBackend.dispose();
      errorListeners.clear();
    },

    onRenderError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },

    __testGetImageId() {
      return backend.__getImageId();
    },

    useBackend(kind: RenderBackendKind): void {
      if (kind === activeKind) return;
      // Pause tick during swap
      const wasRunning = interval !== undefined;
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
      // Dispose old backend (emits deleteKittyImage, removes widget)
      backend.dispose();
      // Switch
      activeKind = kind;
      backend = getBackendForKind(kind);
      // Resume if it was running
      if (wasRunning) {
        backend.mount();
        tick();
        interval = setInterval(tick, Math.round(1000 / frameRate));
      }
    },

    activeBackend(): RenderBackendKind {
      return activeKind;
    },

    setCustomComponent(component: GbaGameComponent): void {
      customBackend.setComponent(component);
    },

    showStillFrame(): void {
      // Phase 9 REVISE B3: one-shot still-frame flush on Running→Paused.
      // Skips the liveTick gate via writeFrame so callers get a deterministic
      // one-shot flush even when widget live-tick is disabled.
      if (activeKind !== "widget") return;
      try {
        const rgba = emulator.getFramebuffer();
        const scaled = upscale(rgba);
        const png = encodePng({ width: outW, height: outH, data: scaled, depth: 8, channels: 4 });
        widgetBackend.writeFrame({ kind: "png", bytes: png, width: outW, height: outH });
      } catch (e) {
        const err = new RenderTickError("showStillFrame failed", e);
        for (const cb of errorListeners) cb(err);
      }
    },

    setWidgetLiveTick(enabled: boolean): void {
      widgetBackend.setLiveTick(enabled);
    },
  };

  return controller;
}
