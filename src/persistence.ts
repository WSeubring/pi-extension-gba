import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Emulator } from "./emulator.js";
import { StateIoError } from "./emulator.js";

export { StateIoError };

export class SaveIoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = "SaveIoError";
  }
}

export interface Persistence {
  loadRom(basename: string): Promise<{ romPath: string; restoredState: boolean }>;
  snapshot(): Promise<void>;
  flushPending(): Promise<void>;
  listRoms(): Promise<string[]>;
  lastPlayed(): Promise<string | undefined>;
  currentRom(): string | undefined;
  clearState(): Promise<void>;
  destroy(): void;
}

export interface PersistenceOptions {
  romDir: string;
  logger?: (msg: string) => void;
  debounceMs?: number;
  /**
   * When set, write a `.state` snapshot every N ms while a ROM is loaded.
   * Bounds progress loss on unexpected termination (SIGKILL, terminal
   * window closed, host crash) — the regular snapshot triggers (pause,
   * ROM switch, session_shutdown) never fire in those cases. The timer is
   * unref'd so it cannot keep the process alive.
   */
  autoSnapshotMs?: number;
}

function resolveRomDir(romDir: string): string {
  // Only `~` exactly or a `~/` prefix refer to $HOME; `~user/...` names
  // another user's home and must be left untouched.
  if (romDir === "~") return homedir();
  if (romDir.startsWith("~/")) {
    return path.join(homedir(), romDir.slice(2));
  }
  return path.resolve(romDir);
}

function stripGba(basename: string): string {
  return basename.replace(/\.gba$/, "");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function createPersistence(emulator: Emulator, opts: PersistenceOptions): Persistence {
  const romDir = resolveRomDir(opts.romDir);
  const debounceMs = opts.debounceMs ?? 100;
  const log = (msg: string) => {
    if (opts.logger) opts.logger(msg);
    else console.warn(msg);
  };

  void (async () => {
    try {
      await mkdir(romDir, { recursive: true });
      // Reap `.tmp` files orphaned by a previous unexpected termination
      // mid-writeAtomic (write-then-rename never completed).
      for (const entry of await readdir(romDir)) {
        if (entry.endsWith(".tmp")) {
          await rm(path.join(romDir, entry), { force: true });
        }
      }
    } catch (err) {
      log(`[pi-extension-gba] failed to prepare romDir ${romDir}: ${String(err)}`);
    }
  })();

  let currentBasename: string | undefined;
  let pendingBytes: Uint8Array | undefined;
  /** ROM the pending SRAM bytes belong to — captured at schedule time. */
  let pendingTarget: string | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let pendingWrite: Promise<void> | undefined;
  let autoSnapshotTimer: NodeJS.Timeout | undefined;
  let autoSnapshotWarned = false;

  async function writeAtomic(absPath: string, bytes: Uint8Array): Promise<void> {
    const tmp = `${absPath}.tmp`;
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, absPath);
    } catch (e) {
      try {
        await rm(tmp, { force: true });
      } catch {
        // best-effort cleanup
      }
      throw new SaveIoError(`Failed to atomically write ${absPath}`, {
        cause: e,
      });
    }
  }

  async function flushSram(): Promise<void> {
    if (!pendingTarget || !pendingBytes) {
      pendingBytes = undefined;
      return;
    }
    const savPath = path.join(romDir, `${stripGba(pendingTarget)}.sav`);
    const bytes = pendingBytes;
    pendingBytes = undefined;
    try {
      await writeAtomic(savPath, bytes);
    } catch (e) {
      log(`[pi-extension-gba] SRAM flush failed: ${String(e)}`);
    }
  }

  /**
   * Serialize a write job after any in-flight one. Two concurrent
   * writeAtomic() calls on the same target share the same `.tmp` path, so an
   * overlap can rename the other writer's half-written tmp file or fail on a
   * vanished tmp. Both SRAM flushes and snapshots route through this chain.
   * Rejections surface to the awaiting caller but never poison the chain.
   */
  function enqueueWrite(job: () => Promise<void>): Promise<void> {
    const prev = pendingWrite ?? Promise.resolve();
    const run = prev.then(job);
    const chained = run.catch(() => {
      // Caller observes the rejection via `run`; keep the chain alive.
    });
    pendingWrite = chained.finally(() => {
      if (pendingWrite === chained) pendingWrite = undefined;
    });
    return run;
  }

  function enqueueFlush(): void {
    void enqueueWrite(() => flushSram());
  }

  function scheduleSramFlush(bytes: Uint8Array): void {
    // Capture the owning ROM NOW: during a ROM switch emulator.load()/
    // loadState() fire saveDataUpdated with the NEW core's SRAM before
    // currentBasename is updated, so resolving the basename at flush time
    // would write the incoming ROM's SRAM over the outgoing ROM's .sav.
    pendingTarget = loadingBasename ?? currentBasename;
    pendingBytes = bytes;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      enqueueFlush();
    }, debounceMs);
  }

  emulator.onSramDirty((bytes) => {
    try {
      scheduleSramFlush(bytes);
    } catch (e) {
      log(`[pi-extension-gba] onSramDirty scheduling failed: ${String(e)}`);
    }
  });

  async function writeLast(basename: string): Promise<void> {
    const lastPath = path.join(romDir, ".last");
    await writeAtomic(lastPath, Buffer.from(`${basename}\n`, "utf8"));
  }

  /** True while loadRom() is switching ROMs — blocks auto-snapshots from
   * serializing a half-loaded core into the outgoing game's .state file. */
  let loading = false;
  /** Basename of the ROM being switched to while loading===true. */
  let loadingBasename: string | undefined;

  async function snapshot(): Promise<void> {
    if (!currentBasename || loading) return;
    const bytes = emulator.saveState();
    const statePath = path.join(romDir, `${stripGba(currentBasename)}.state`);
    // Serialize on the shared write chain: concurrent snapshot() callers
    // (30 s auto-snapshot, onPause, ROM switch, session_shutdown) share the
    // same `.state.tmp` path, so an overlap can rename the other writer's
    // half-written tmp (torn .state).
    await enqueueWrite(() => writeAtomic(statePath, bytes));
  }

  async function flushPending(): Promise<void> {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
      enqueueFlush();
    }
    if (pendingWrite) {
      await pendingWrite;
    }
  }

  async function loadRom(basename: string): Promise<{ romPath: string; restoredState: boolean }> {
    if (basename.includes("/") || basename.includes("\\")) {
      throw new Error(`[pi-extension-gba] basename must not contain path separators: ${basename}`);
    }
    if (!basename.endsWith(".gba")) {
      throw new Error(`[pi-extension-gba] basename must end with .gba: ${basename}`);
    }

    if (currentBasename && currentBasename !== basename) {
      try {
        await snapshot();
      } catch (e) {
        log(`[pi-extension-gba] outgoing snapshot failed: ${String(e)}`);
      }
    }
    // Unconditional — reloading the SAME ROM must also land any pending
    // debounced SRAM flush before the .sav is read back below, or the core
    // gets seeded with stale bytes that the late flush then overwrites.
    await flushPending();
    loading = true;
    loadingBasename = basename;
    try {
      const romPath = path.join(romDir, basename);
      const savPath = path.join(romDir, `${stripGba(basename)}.sav`);
      const statePath = path.join(romDir, `${stripGba(basename)}.state`);

      let seededSavBytes: Uint8Array | undefined;
      if (await pathExists(savPath)) {
        try {
          seededSavBytes = await readFile(savPath);
          emulator.writeSram(seededSavBytes);
        } catch (e) {
          log(`[pi-extension-gba] failed to read .sav, skipping injection: ${String(e)}`);
          seededSavBytes = undefined;
        }
      }

      await emulator.load(romPath);

      if (seededSavBytes) {
        try {
          const actual = emulator.getSram();
          if (actual.length !== seededSavBytes.length) {
            log(
              `[pi-extension-gba] SRAM length mismatch after load: disk=${seededSavBytes.length} core=${actual.length}`,
            );
          }
        } catch (e) {
          log(`[pi-extension-gba] SRAM length check failed: ${String(e)}`);
        }
      }

      let restoredState = false;
      if (await pathExists(statePath)) {
        try {
          const stateBytes = await readFile(statePath);
          emulator.loadState(stateBytes);
          restoredState = true;
        } catch (e) {
          log(`[pi-extension-gba] corrupt .state, deleting: ${String(e)}`);
          try {
            await rm(statePath, { force: true });
          } catch (rmErr) {
            log(`[pi-extension-gba] failed to delete corrupt .state: ${String(rmErr)}`);
          }
          restoredState = false;
        }
      }

      try {
        await writeLast(basename);
      } catch (e) {
        log(`[pi-extension-gba] failed to write .last: ${String(e)}`);
      }

      currentBasename = basename;
      return { romPath, restoredState };
    } finally {
      loading = false;
      loadingBasename = undefined;
    }
  }

  async function listRoms(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(romDir);
    } catch {
      return [];
    }
    return entries.filter((e) => e.endsWith(".gba")).sort();
  }

  async function lastPlayed(): Promise<string | undefined> {
    const lastPath = path.join(romDir, ".last");
    let raw: string;
    try {
      raw = (await readFile(lastPath, "utf8")).trim();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log(`[pi-extension-gba] failed to read .last: ${String(e)}`);
      }
      return undefined;
    }
    if (!raw) return undefined;
    const romPath = path.join(romDir, raw);
    if (!(await pathExists(romPath))) return undefined;
    return raw;
  }

  function currentRom(): string | undefined {
    return currentBasename;
  }

  async function clearState(): Promise<void> {
    if (!currentBasename) return;
    const statePath = path.join(romDir, `${stripGba(currentBasename)}.state`);
    try {
      await unlink(statePath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw new StateIoError(`Failed to delete state file ${statePath}`, { cause: e });
    }
  }

  if (opts.autoSnapshotMs !== undefined && opts.autoSnapshotMs > 0) {
    autoSnapshotTimer = setInterval(() => {
      // snapshot() no-ops while no ROM is loaded. Failures (e.g. crashed
      // core) are logged once, not every interval.
      void snapshot().catch((err) => {
        if (autoSnapshotWarned) return;
        autoSnapshotWarned = true;
        log(`[pi-extension-gba] auto-snapshot failed: ${String(err)}`);
      });
    }, opts.autoSnapshotMs);
    autoSnapshotTimer.unref?.();
  }

  function destroy(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (autoSnapshotTimer) {
      clearInterval(autoSnapshotTimer);
      autoSnapshotTimer = undefined;
    }
    pendingBytes = undefined;
    pendingTarget = undefined;
    currentBasename = undefined;
  }

  return {
    loadRom,
    snapshot,
    flushPending,
    listRoms,
    lastPlayed,
    currentRom,
    clearState,
    destroy,
  };
}
