import { readFile } from "node:fs/promises";
import path from "node:path";
import mGBA from "../vendor/mgba-wasm/dist/mgba.js";
import type { ButtonSink, GbaButton } from "./types.js";

export const GBA_WIDTH = 240 as const;
export const GBA_HEIGHT = 160 as const;
export const BYTES_PER_PIXEL = 4 as const;

const MAX_ROM_BYTES = 32 * 1024 * 1024;

const SCRATCH_FRAMES = 2048;
const SCRATCH_BYTES = SCRATCH_FRAMES * 2 * 2; // stereo × int16 = 8192 B

const BUTTON_NAMES: Record<GbaButton, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  a: "A",
  b: "B",
  l: "L",
  r: "R",
  start: "Start",
  select: "Select",
};

export class EmulatorNotLoadedError extends Error {
  constructor(message = "Emulator has no ROM loaded") {
    super(message);
    this.name = "EmulatorNotLoadedError";
  }
}

export class RomLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = "RomLoadError";
  }
}

export class StateIoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = "StateIoError";
  }
}

export class EmulatorCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmulatorCrashError";
  }
}

type MgbaModule = Awaited<ReturnType<typeof mGBA>>;

type SramListener = (bytes: Uint8Array) => void;
type CrashListener = (err: Error) => void;

export class Emulator implements ButtonSink {
  readonly #module: MgbaModule;
  #loaded = false;
  #gameBasename: string | undefined;
  #frameCounter = 0;
  #pendingSram: Uint8Array | undefined;
  readonly #heldButtons = new Set<GbaButton>();
  readonly #sramDirtyListeners: SramListener[] = [];
  readonly #crashListeners: CrashListener[] = [];
  #scratchPtr: number;

  constructor(module: MgbaModule, scratchPtr: number) {
    this.#module = module;
    this.#scratchPtr = scratchPtr;
  }

  get frameCounter(): number {
    return this.#frameCounter;
  }

  get module(): MgbaModule {
    return this.#module;
  }

  async load(romPath: string): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await readFile(romPath);
    } catch (e) {
      throw new RomLoadError(`Failed to read ROM at ${romPath}`, { cause: e });
    }
    if (bytes.length === 0) {
      throw new RomLoadError(`ROM is empty: ${romPath}`);
    }
    if (bytes.length > MAX_ROM_BYTES) {
      throw new RomLoadError(
        `ROM exceeds 32 MiB limit (${bytes.length} bytes): ${romPath}`,
      );
    }

    const basename = path.basename(romPath);
    const vfsGameDir = this.#module.filePaths().gamePath;
    const vfsRomPath = `${vfsGameDir}/${basename}`;

    try {
      this.#module.FS.writeFile(vfsRomPath, bytes);
    } catch (e) {
      throw new RomLoadError(
        `Failed to write ROM to emulator VFS at ${vfsRomPath}`,
        { cause: e },
      );
    }

    if (this.#pendingSram) {
      const savePath = this.#module.filePaths().savePath;
      const savName = `${Emulator.#gbaStem(basename)}.sav`;
      const vfsSavPath = `${savePath}/${savName}`;
      try {
        this.#module.FS.writeFile(vfsSavPath, this.#pendingSram);
      } catch (e) {
        throw new RomLoadError(
          `Failed to write SRAM to emulator VFS at ${vfsSavPath}`,
          { cause: e },
        );
      }
    }

    const ok = this.#module.loadGame(vfsRomPath);
    if (!ok) {
      throw new RomLoadError(`mGBA loadGame returned false for ${vfsRomPath}`);
    }

    this.#pendingSram = undefined;
    this.#loaded = true;
    this.#gameBasename = basename;
    this.#frameCounter = 0;

    this.#module.addCoreCallbacks({
      saveDataUpdatedCallback: () => {
        try {
          const data = this.#module.getSave();
          if (data) {
            for (const cb of this.#sramDirtyListeners) cb(data);
          }
        } catch (e) {
          console.warn("[pi-extension-gba] saveDataUpdatedCallback threw", e);
        }
      },
      coreCrashedCallback: () => {
        const err = new EmulatorCrashError("mGBA core reported crash");
        for (const cb of this.#crashListeners) cb(err);
      },
      videoFrameEndedCallback: () => {
        this.#frameCounter++;
      },
    });
  }

  step(frames: number): void {
    if (!this.#loaded) throw new EmulatorNotLoadedError();
    const n = Math.max(0, Math.floor(frames));
    // Post-ADR 0002 the SDL-free vendored host exposes a synchronous
    // per-frame advance. We prefer a JS-level `runFrame` wrapper if a future
    // pre.js patch adds one, else reach the raw Emscripten export directly.
    const mod = this.#module as unknown as {
      runFrame?: () => void;
      _runFrame?: () => void;
    };
    const rf = mod.runFrame ?? mod._runFrame;
    if (typeof rf !== "function") {
      throw new EmulatorCrashError(
        "mGBA runFrame export missing — vendor build predates ADR 0002",
      );
    }
    for (let i = 0; i < n; i++) rf();
  }

  getFramebuffer(): Uint8Array {
    if (!this.#loaded) throw new EmulatorNotLoadedError();
    const view = this.#module.getPixelBuffer();
    if (!view) throw new EmulatorNotLoadedError();
    return view.slice();
  }

  setButton(button: GbaButton, down: boolean): void {
    if (!this.#loaded) throw new EmulatorNotLoadedError();
    const name = BUTTON_NAMES[button];
    if (down) {
      if (this.#heldButtons.has(button)) return;
      this.#heldButtons.add(button);
      this.#module.buttonPress(name);
    } else {
      if (!this.#heldButtons.has(button)) return;
      this.#heldButtons.delete(button);
      this.#module.buttonUnpress(name);
    }
  }

  press(button: GbaButton): void {
    this.setButton(button, true);
  }

  release(button: GbaButton): void {
    this.setButton(button, false);
  }

  saveState(): Uint8Array {
    if (!this.#loaded) throw new EmulatorNotLoadedError();
    const ok = this.#module.saveState(0);
    if (!ok) throw new StateIoError("mGBA saveState(0) returned false");
    const vfsPath = this.#stateVfsPath(0);
    try {
      const bytes = this.#module.FS.readFile(vfsPath);
      return bytes;
    } catch (e) {
      throw new StateIoError(
        `Failed to read save-state from VFS at ${vfsPath}`,
        { cause: e },
      );
    }
  }

  loadState(bytes: Uint8Array): void {
    if (!this.#loaded) throw new EmulatorNotLoadedError();
    const vfsPath = this.#stateVfsPath(0);
    try {
      this.#module.FS.writeFile(vfsPath, bytes);
    } catch (e) {
      throw new StateIoError(
        `Failed to write save-state to VFS at ${vfsPath}`,
        { cause: e },
      );
    }
    const ok = this.#module.loadState(0);
    if (!ok) throw new StateIoError("mGBA loadState(0) returned false");
  }

  getSram(): Uint8Array {
    if (!this.#loaded) throw new EmulatorNotLoadedError();
    const data = this.#module.getSave();
    return data ?? new Uint8Array(0);
  }

  writeSram(bytes: Uint8Array): void {
    this.#pendingSram = bytes;
  }

  onSramDirty(cb: SramListener): void {
    this.#sramDirtyListeners.push(cb);
  }

  onCrash(cb: CrashListener): void {
    this.#crashListeners.push(cb);
  }

  /** @internal — smoke testing only; do not call in production code */
  __testTriggerCrash(err: Error): void {
    for (const cb of this.#crashListeners) cb(err);
  }

  /** @internal — smoke testing only; do not call in production code */
  __testForceLoad(): void {
    this.#loaded = true;
  }

  /**
   * Pull up to `maxFrames` stereo frames from the mCore audio ring buffer.
   *
   * Returns an interleaved int16 LE array of length ≤ `maxFrames * 2`
   * (L0, R0, L1, R1, ...). Zero-length result is valid: ring was empty
   * at the time of the call (no underrun error — the caller must simply
   * feed the downstream player nothing, or pad with silence if a fixed
   * tick cadence is required).
   *
   * `maxFrames` is clamped to `2048` (the persistent scratch buffer size).
   * Callers that ask for more are silently capped.
   *
   * @throws EmulatorNotLoadedError if no ROM is currently loaded.
   */
  getAudioSamples(maxFrames: number): Int16Array {
    if (!this.#loaded) throw new EmulatorNotLoadedError();
    const capped = Math.min(Math.max(0, Math.floor(maxFrames)), SCRATCH_FRAMES);
    if (capped === 0) return new Int16Array(0);

    const mod = this.#module as unknown as {
      _getAudioSamples?: (dest: number, max: number) => number;
      HEAP16: Int16Array;
    };
    if (typeof mod._getAudioSamples !== "function") {
      throw new EmulatorCrashError(
        "mGBA getAudioSamples export missing — vendor build predates ADR 0006",
      );
    }

    const framesWritten = mod._getAudioSamples(this.#scratchPtr, capped);
    if (framesWritten === 0) return new Int16Array(0);

    const samples = framesWritten * 2;
    const offset = this.#scratchPtr / 2; // Int16 element index
    return mod.HEAP16.slice(offset, offset + samples);
  }

  destroy(): void {
    if (this.#loaded) {
      try {
        this.#module.pauseGame();
      } catch {
        // best-effort on teardown
      }
    }
    this.#module.addCoreCallbacks({
      alarmCallback: null,
      coreCrashedCallback: null,
      keysReadCallback: null,
      saveDataUpdatedCallback: null,
      videoFrameEndedCallback: null,
      videoFrameStartedCallback: null,
      autoSaveStateCapturedCallback: null,
      autoSaveStateLoadedCallback: null,
    });
    this.#heldButtons.clear();
    this.#sramDirtyListeners.length = 0;
    this.#crashListeners.length = 0;
    this.#loaded = false;
    if (this.#scratchPtr !== 0) {
      const mod = this.#module as unknown as { _free: (ptr: number) => void };
      mod._free(this.#scratchPtr);
      this.#scratchPtr = 0;
    }
  }

  /**
   * Strip the .gba extension case-insensitively. Shared by SRAM seeding and
   * save-state paths so a `GAME.GBA` ROM derives the same stem for both —
   * a case-sensitive mismatch would seed pending SRAM under a wrong filename.
   */
  static #gbaStem(name: string): string {
    return name.replace(/\.gba$/i, "");
  }

  #stateVfsPath(slot: number): string {
    if (!this.#gameBasename) {
      throw new EmulatorNotLoadedError();
    }
    const saveStateDir = this.#module.filePaths().saveStatePath;
    const stem = Emulator.#gbaStem(this.#gameBasename);
    return `${saveStateDir}/${stem}.ss${slot}`;
  }
}

export async function createEmulator(): Promise<Emulator> {
  const { installWasmShims } = await import("./wasm-shims.js");
  // Post-ADR 0004: installWasmShims() is a near-no-op; the call is kept as a
  // rollback vector (see docs/decisions/0004-remove-gl-runtime-dep.md).
  installWasmShims();
  // Post-ADR 0002: the vendored WASM is SDL-free (patch 0004). main() is a
  // no-op and callMain() no longer blocks on a pthread futex, so the
  // noInitialRun workaround is retired. callMain runs once, returns 0, and
  // the KEEPALIVE exports (loadGame, runFrame, buttonPress, ...) drive the
  // emulator from JS directly. Canvas is unused (SDL-free host writes pixel
  // buffers directly via getPixelBuffer()).
  // ADR 0005: mGBA's default logger writes mLOG_* trace lines (GBA DMA:,
  // GBA BIOS:, ...) to stdout via printf/vprintf. pi reserves stdout for
  // JSONL RPC framing and TUI rendering, so any non-JSONL write corrupts
  // the widget layout. Override Module.print to drop these lines.
  // printErr stays live so Emscripten abort traces survive.
  // Set PI_GBA_DEBUG_CORE=1 to restore core logging for diagnostics.
  const silencePrint = !process.env.PI_GBA_DEBUG_CORE;
  const module = await mGBA({
    canvas: null,
    ...(silencePrint ? { print: () => {} } : {}),
  });
  await module.FSInit();
  const mod = module as unknown as { _malloc: (size: number) => number };
  const scratchPtr = mod._malloc(SCRATCH_BYTES);
  return new Emulator(module, scratchPtr);
}
