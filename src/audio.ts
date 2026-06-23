import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Test seam — spawn factory (overridden in tests via __setSpawnForTest)
// ---------------------------------------------------------------------------

type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
let _spawnFn: SpawnFn = (cmd, args, opts) => nodeSpawn(cmd, args, opts);

/** @internal — test-only seam. Pass undefined to reset to real spawn. */
export function __setSpawnForTest(fn: ((cmd: string, args: string[]) => unknown) | undefined): void {
  if (fn === undefined) {
    _spawnFn = (cmd, args, opts) => nodeSpawn(cmd, args, opts);
  } else {
    _spawnFn = (cmd, args, _opts) => fn(cmd, args) as ChildProcess;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AudioBackend = "pw-cat" | "pacat" | "ffplay" | "aplay";

export interface AudioOpts {
  /** Detected backend from capabilities.ts — pass undefined to no-op. */
  backend: AudioBackend | undefined;
  /** Called once when subprocess `exit` fires with non-zero code. */
  onCrash?: (err: Error) => void;
  /** Diagnostic logger — defaults to console.error (ADR 0005 stdout rule). */
  logger?: (msg: string) => void;
}

export interface AudioPlayer {
  /** Spawn the subprocess. Resolves once stdin is writable. Idempotent. */
  start(): Promise<void>;

  /**
   * Write one chunk of interleaved s16le stereo PCM to the subprocess.
   * No-op if not started, crashed, or stdin buffer exceeds the backpressure
   * threshold (~128 KiB); logs once per session when the threshold is hit.
   * Muted: writes equivalent-length silence instead of dropping.
   * Never throws.
   */
  writeSamples(pcm: Int16Array): void;

  mute(): void;
  unmute(): void;
  isMuted(): boolean;

  /** Drain stdin, send SIGTERM, await exit (200 ms cap → SIGKILL). */
  stop(): Promise<void>;

  /** Register a crash handler. Returns an unsubscribe. */
  onCrash(cb: (err: Error) => void): () => void;
}

// ---------------------------------------------------------------------------
// Spawn args per tool (stereo, s16le).
//
// Rate is 65536 Hz, NOT the 32768 Hz that ADR 0006 originally assumed: the
// vendored mGBA core (0.11-dev mAudioBuffer path) emits GBA audio at its
// native 65536 Hz and patch 0005's getAudioSamples returns those frames
// unresampled. Measured empirically in experiments/audio-rate/measure.mjs
// (1097 audio frames per video frame × 59.7275 fps ≈ 65536 Hz). Playing the
// stream at 32768 Hz halves pitch/speed and overruns the player's input pipe.
// ---------------------------------------------------------------------------

export const AUDIO_RATE_HZ = 65536;

function buildSpawnArgs(backend: AudioBackend): { cmd: string; args: string[] } {
  const rate = String(AUDIO_RATE_HZ);
  switch (backend) {
    case "pw-cat":
      return {
        cmd: "pw-cat",
        args: ["--playback", "--rate", rate, "--channels", "2", "--format", "s16", "--raw", "-"],
      };
    case "pacat":
      return {
        cmd: "pacat",
        args: [`--rate=${rate}`, "--channels=2", "--format=s16le", "--raw"],
      };
    case "ffplay":
      return {
        cmd: "ffplay",
        args: [
          "-nodisp",
          "-autoexit",
          "-loglevel",
          "error",
          "-f",
          "s16le",
          "-ar",
          rate,
          "-ch_layout",
          "stereo",
          "-i",
          "-",
        ],
      };
    case "aplay":
      return {
        cmd: "aplay",
        args: ["-q", "-f", "S16_LE", "-r", rate, "-c", "2", "-"],
      };
  }
}

// ---------------------------------------------------------------------------
// AudioPlayer implementation
// ---------------------------------------------------------------------------

class AudioPlayerImpl extends EventEmitter implements AudioPlayer {
  readonly #backend: AudioBackend;
  readonly #logger: (msg: string) => void;

  #proc: ChildProcess | undefined = undefined;
  #muted = false;
  #crashed = false;
  #stopping = false;
  #started = false;
  readonly #crashListeners: Array<(err: Error) => void> = [];
  /** True once we have logged the "stdin buffer full, dropping chunk" warning. */
  #backpressureWarnedThisSession = false;

  constructor(backend: AudioBackend, logger: (msg: string) => void) {
    super();
    this.#backend = backend;
    this.#logger = logger;
  }

  async start(): Promise<void> {
    // Idempotent
    if (this.#started) return;
    this.#started = true;
    this.#crashed = false;
    this.#stopping = false;
    this.#backpressureWarnedThisSession = false;

    const { cmd, args } = buildSpawnArgs(this.#backend);
    const proc = _spawnFn(cmd, args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });

    this.#proc = proc;

    // Log stderr from the audio subprocess
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        this.#logger(`[pi-extension-gba] audio stderr: ${chunk.toString().trimEnd()}`);
      });
    }

    // Fire crash listeners at most once per subprocess — shared between the
    // 'error' and 'exit' handlers (a spawn failure may be followed by no exit
    // at all, or an error by a late exit; the UI must hear about it once).
    let crashFired = false;
    const fireCrash = (err: Error) => {
      if (crashFired) return;
      crashFired = true;
      this.#crashed = true;
      this.#logger(`[pi-extension-gba] ${err.message} — audio off until next game-mode entry`);
      for (const cb of this.#crashListeners) cb(err);
    };

    // Swallow async stream/process errors. Without these listeners an EPIPE
    // on stdin (subprocess died with bytes still queued — observed when the
    // 200 ms SIGKILL fallback fires during stop()) becomes an
    // uncaughtException that kills the entire pi process.
    proc.on("error", (err) => {
      if (this.#proc !== proc) return;
      // Spawn failures (ENOENT/EACCES) emit 'error' but never 'exit', so the
      // exit handler alone would leave onCrash listeners silent forever.
      fireCrash(new Error(`audio backend (${this.#backend}) error: ${err.message}`));
    });
    proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      // EPIPE / write-after-end during teardown is expected noise; anything
      // else while this proc is still current marks the session crashed so
      // writeSamples stops feeding it.
      if (this.#proc !== proc || this.#stopping) return;
      this.#crashed = true;
      this.#logger(`[pi-extension-gba] audio stdin error: ${err.message}`);
    });

    // Crash handler (L10). Close over `proc` to guard against stale exit events
    // from a previous subprocess after a stop→start re-arm cycle: if `this.#proc`
    // no longer refers to this process, the exit is from the old process and must
    // be ignored so crash listeners from the new session are not mistakenly fired.
    proc.on("exit", (code, signal) => {
      if (this.#proc !== proc) return; // stale exit from a previous subprocess
      // Deliberate stop() detaches #proc before signalling, so any exit seen
      // here is unsolicited. Clean exit is code 0 with no signal; a non-zero
      // code OR a signal death (code===null, signal set — e.g. external
      // SIGKILL) is a crash the user must hear about.
      if (this.#stopping || (code === 0 && signal === null)) return;
      fireCrash(new Error(`audio backend (${this.#backend}) exited code=${code} signal=${signal}`));
    });

    // Wait until stdin is writable. For pipe stdio, the stream is writable
    // immediately after spawn — we yield one event-loop turn for safety.
    // The "open" event is never emitted on a piped stdin (it's a Writable, not
    // a FileHandle), so listening for it would hang forever. Use setImmediate
    // in both branches to guarantee the promise always resolves.
    await new Promise<void>((resolve) => {
      if (proc.stdin && !proc.stdin.destroyed) {
        setImmediate(resolve);
      } else {
        // stdin already destroyed right after spawn — resolve immediately so
        // start() does not hang; writeSamples will no-op via the destroyed guard.
        setImmediate(resolve);
      }
    });
  }

  writeSamples(pcm: Int16Array): void {
    if (!this.#proc || !this.#started || this.#crashed || this.#stopping) return;
    if (!this.#proc.stdin || this.#proc.stdin.destroyed) return;

    // Backpressure guard: if the stream buffer has grown past ~0.5 s worth
    // of audio (128 KiB at 65536 Hz stereo s16le), the subprocess is wedged.
    // Drop the new chunk silently and log once per session to avoid unbounded
    // RSS growth on a frozen audio backend.
    const BACKPRESSURE_THRESHOLD = 128 * 1024; // bytes
    if (this.#proc.stdin.writableLength > BACKPRESSURE_THRESHOLD) {
      if (!this.#backpressureWarnedThisSession) {
        this.#backpressureWarnedThisSession = true;
        this.#logger("[pi-extension-gba] audio stdin buffer full — subprocess may be wedged; dropping audio chunks");
      }
      return;
    }

    const out = this.#muted ? new Int16Array(pcm.length) : pcm;
    try {
      this.#proc.stdin.write(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
    } catch {
      // Never throws per contract
    }
  }

  mute(): void {
    this.#muted = true;
  }

  unmute(): void {
    this.#muted = false;
  }

  isMuted(): boolean {
    return this.#muted;
  }

  async stop(): Promise<void> {
    if (!this.#proc || this.#stopping) return;
    this.#stopping = true;

    const proc = this.#proc;
    // Detach state up-front so a start() issued while this stop() is still
    // awaiting exit spawns a fresh subprocess without this stop clobbering
    // the new session's #proc/#started when the old process finally exits.
    this.#proc = undefined;
    this.#started = false;

    // Process already exited (e.g. crashed earlier — external kill, backend
    // failure)? Its 'exit' event has already fired and will never fire again,
    // so the wait below would hang forever and block the caller's game→chat
    // teardown. Nothing to drain or signal; bail out.
    // Loose != so test fakes without exitCode/signalCode (undefined) take the
    // normal wait path; a real ChildProcess reports null until exit.
    if (proc.exitCode != null || proc.signalCode != null) {
      this.#stopping = false;
      return;
    }

    await new Promise<void>((resolve) => {
      let finalTimer: NodeJS.Timeout | undefined;
      const onExit = () => {
        clearTimeout(sigkillTimer);
        if (finalTimer) clearTimeout(finalTimer);
        resolve();
      };

      proc.once("exit", onExit);

      // Drain stdin then SIGTERM
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end(() => {
          try {
            proc.kill("SIGTERM");
          } catch {
            /* already dead */
          }
        });
      } else {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }

      // 200 ms SIGKILL fallback
      const sigkillTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        // Final escape hatch: a child stuck in uninterruptible I/O survives
        // even SIGKILL, and stop() pending forever would block the caller's
        // game→chat teardown. State is already detached above, so resolving
        // without an exit is safe.
        finalTimer = setTimeout(() => {
          proc.removeListener("exit", onExit);
          resolve();
        }, 200);
        finalTimer.unref?.();
      }, 200);
      // unref both timers so a pending stop() can never keep the host alive.
      sigkillTimer.unref?.();
    });
  }

  onCrash(cb: (err: Error) => void): () => void {
    this.#crashListeners.push(cb);
    return () => {
      const idx = this.#crashListeners.indexOf(cb);
      if (idx !== -1) this.#crashListeners.splice(idx, 1);
    };
  }

  /**
   * 10c Bug 3 probe: returns the subprocess stdin's current writableLength
   * (bytes queued but not yet flushed to the child). Used by the audio-trace
   * instrumentation in render.ts. Undefined when the stream is closed.
   * @internal
   */
  __probeWritableLength(): number | undefined {
    const stdin = this.#proc?.stdin;
    if (!stdin || stdin.destroyed) return undefined;
    return stdin.writableLength;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Whether audio should be active right now, given the live config value.
 * PI_GBA_AUDIO=0 forces audio off regardless of config (README contract);
 * PI_GBA_AUDIO=1 forces it on; otherwise cfg decides.
 */
export function audioEnabled(cfgAudio: boolean): boolean {
  const env = process.env.PI_GBA_AUDIO;
  if (env === "0") return false;
  if (env === "1") return true;
  return cfgAudio === true;
}

/**
 * Returns undefined when:
 *   - audio is disabled (env/config gate — see audioEnabled), OR
 *   - opts.backend === undefined (no probed tool — L9).
 * Otherwise returns a player in "idle" state (start() must be called).
 */
export function createAudioPlayer(opts: AudioOpts & { cfgAudio: boolean }): AudioPlayer | undefined {
  if (!audioEnabled(opts.cfgAudio)) return undefined;
  if (opts.backend === undefined) return undefined;

  const logger = opts.logger ?? ((msg: string) => console.error(msg));
  const player = new AudioPlayerImpl(opts.backend, logger);

  if (opts.onCrash) {
    player.onCrash(opts.onCrash);
  }

  return player;
}
