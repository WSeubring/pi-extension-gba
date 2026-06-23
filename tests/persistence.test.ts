import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPersistence } from "../src/persistence.js";
import type { Emulator } from "../src/emulator.js";

type FakeEmulatorControls = {
  emulator: Emulator;
  fireSramDirty: (bytes: Uint8Array) => void;
  writeSramCalls: Uint8Array[];
  loadCalls: string[];
  setSaveStateBytes: (bytes: Uint8Array) => void;
  setLoadStateThrows: (err: Error | null) => void;
  setSramForGet: (bytes: Uint8Array) => void;
  loadStateCalls: Uint8Array[];
};

function makeFakeEmulator(): FakeEmulatorControls {
  const sramCbs: ((bytes: Uint8Array) => void)[] = [];
  const writeSramCalls: Uint8Array[] = [];
  const loadCalls: string[] = [];
  const loadStateCalls: Uint8Array[] = [];
  let saveStateBytes: Uint8Array = new Uint8Array([1, 2, 3]);
  let loadStateThrows: Error | null = null;
  let sramForGet: Uint8Array = new Uint8Array(0);

  const emulator = {
    onSramDirty(cb: (bytes: Uint8Array) => void) {
      sramCbs.push(cb);
    },
    async load(romPath: string) {
      loadCalls.push(romPath);
    },
    writeSram(bytes: Uint8Array) {
      writeSramCalls.push(bytes);
    },
    getSram() {
      return sramForGet;
    },
    saveState() {
      return saveStateBytes;
    },
    loadState(bytes: Uint8Array) {
      loadStateCalls.push(bytes);
      if (loadStateThrows) throw loadStateThrows;
    },
  } as unknown as Emulator;

  return {
    emulator,
    fireSramDirty(bytes) {
      for (const cb of sramCbs) cb(bytes);
    },
    writeSramCalls,
    loadCalls,
    setSaveStateBytes(bytes) {
      saveStateBytes = bytes;
    },
    setLoadStateThrows(err) {
      loadStateThrows = err;
    },
    setSramForGet(bytes) {
      sramForGet = bytes;
    },
    loadStateCalls,
  };
}

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "gba-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

test("atomic write: when rename fails, tmp file is cleaned and target unchanged", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeEmulator();
    fake.setSaveStateBytes(new Uint8Array([9, 9, 9]));
    const persistence = createPersistence(fake.emulator, {
      romDir: dir,
      logger: () => {},
    });

    const romBasename = "game.gba";
    const romPath = path.join(dir, romBasename);
    await writeFile(romPath, new Uint8Array([0]));

    await persistence.loadRom(romBasename);

    // Force rename to fail by making the target path a non-empty directory.
    const statePath = path.join(dir, "game.state");
    await mkdir(statePath);
    await writeFile(path.join(statePath, "blocker"), new Uint8Array([0]));

    await assert.rejects(() => persistence.snapshot(), /atomically write/);

    const stillDir = await stat(statePath);
    assert.equal(stillDir.isDirectory(), true, ".state path still a directory (untouched)");

    const entries = await readdir(dir);
    const tmps = entries.filter((e) => e.endsWith(".tmp"));
    assert.deepEqual(tmps, [], "no leftover .tmp files");

    persistence.destroy();
  });
});

test("SRAM debounce: burst of 5 dirties within 80 ms coalesces to one .sav write with latest bytes", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeEmulator();
    const persistence = createPersistence(fake.emulator, {
      romDir: dir,
      debounceMs: 100,
      logger: () => {},
    });

    const romBasename = "game.gba";
    const romPath = path.join(dir, romBasename);
    await writeFile(romPath, new Uint8Array([0]));

    await persistence.loadRom(romBasename);

    const savPath = path.join(dir, "game.sav");

    for (let i = 0; i < 5; i++) {
      fake.fireSramDirty(new Uint8Array([i + 1]));
      await new Promise((r) => setTimeout(r, 16));
    }

    // Before the debounce timer fires, no .sav write should have landed.
    assert.equal(await fileExists(savPath), false, "no .sav before flush");

    await persistence.flushPending();

    assert.equal(await fileExists(savPath), true, ".sav written after flushPending");
    const mtimeAfterFlush = (await stat(savPath)).mtimeMs;

    const onDisk = await readFile(savPath);
    assert.deepEqual(Array.from(onDisk), [5], "on-disk .sav matches latest bytes");

    // flushPending is idempotent; no additional writes when nothing is queued.
    await persistence.flushPending();
    const mtimeAfterIdempotent = (await stat(savPath)).mtimeMs;
    assert.equal(
      mtimeAfterIdempotent,
      mtimeAfterFlush,
      "second flushPending produces no additional write",
    );

    persistence.destroy();
  });
});

test("corrupt .state: loadState throws → .state deleted, .sav preserved, restoredState=false", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeEmulator();
    fake.setLoadStateThrows(new Error("corrupt"));
    const persistence = createPersistence(fake.emulator, {
      romDir: dir,
      logger: () => {},
    });

    const romBasename = "game.gba";
    await writeFile(path.join(dir, romBasename), new Uint8Array([0]));

    const savPath = path.join(dir, "game.sav");
    const savBytes = new Uint8Array([1, 2, 3, 4]);
    await writeFile(savPath, savBytes);

    const statePath = path.join(dir, "game.state");
    await writeFile(statePath, new Uint8Array([5, 5, 5]));

    fake.setSramForGet(savBytes);

    const result = await persistence.loadRom(romBasename);
    assert.equal(result.restoredState, false, "restoredState=false when loadState throws");

    assert.equal(await fileExists(statePath), false, ".state deleted");
    assert.equal(await fileExists(savPath), true, ".sav preserved");
    const savOnDisk = await readFile(savPath);
    assert.deepEqual(Array.from(savOnDisk), [1, 2, 3, 4], ".sav bytes unchanged");

    persistence.destroy();
  });
});

test(".last round-trip: loadRom writes .last; lastPlayed reads it; deleted ROM → undefined", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeEmulator();
    const persistence = createPersistence(fake.emulator, {
      romDir: dir,
      logger: () => {},
    });

    const romBasename = "a.gba";
    const romPath = path.join(dir, romBasename);
    await writeFile(romPath, new Uint8Array([0]));

    await persistence.loadRom(romBasename);

    const got = await persistence.lastPlayed();
    assert.equal(got, "a.gba", "lastPlayed returns basename after loadRom");

    await rm(romPath);
    const gotAfter = await persistence.lastPlayed();
    assert.equal(gotAfter, undefined, "ROM deleted → lastPlayed undefined");

    persistence.destroy();
  });
});

// ---------------------------------------------------------------------------
// Stale .tmp cleanup on startup (crash-mid-writeAtomic leftovers)
// ---------------------------------------------------------------------------

test("startup reaps orphaned .tmp files in romDir", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "game.state.tmp"), "stale");
    await writeFile(path.join(dir, "game.sav.tmp"), "");
    await writeFile(path.join(dir, "game.sav"), "keep");

    const { emulator } = makeFakeEmulator();
    const p = createPersistence(emulator, { romDir: dir });

    // The reap runs fire-and-forget; give it a few ticks.
    await new Promise((r) => setTimeout(r, 50));

    const entries = await readdir(dir);
    assert.ok(!entries.some((e) => e.endsWith(".tmp")), `tmp files reaped, got: ${entries}`);
    assert.ok(entries.includes("game.sav"), "real files untouched");
    p.destroy();
  });
});

// ---------------------------------------------------------------------------
// SRAM flushes are serialized (no overlapping writeAtomic on the same .sav)
// ---------------------------------------------------------------------------

test("rapid dirty bursts: flushes serialize, final .sav holds latest bytes, no errors logged", async () => {
  await withTempDir(async (dir) => {
    const logs: string[] = [];
    const { emulator, fireSramDirty } = makeFakeEmulator();
    const p = createPersistence(emulator, {
      romDir: dir,
      debounceMs: 5,
      logger: (m) => logs.push(m),
    });
    await writeFile(path.join(dir, "game.gba"), "rom");
    await p.loadRom("game.gba");

    // Three bursts spaced just past the debounce so each schedules its own
    // flush; the second can start while the first's write is in flight.
    for (let n = 1; n <= 3; n++) {
      fireSramDirty(new Uint8Array([n, n, n]));
      await new Promise((r) => setTimeout(r, 12));
    }
    await p.flushPending();

    const sav = await readFile(path.join(dir, "game.sav"));
    assert.deepEqual([...sav], [3, 3, 3], "latest bytes win");
    assert.ok(!logs.some((l) => l.includes("flush failed")), `no flush errors: ${logs}`);
    p.destroy();
  });
});

// ---------------------------------------------------------------------------
// SRAM flush targets the ROM it belongs to, even across a ROM switch:
// emulator.load()/loadState() fire sramDirty with the NEW core's SRAM before
// currentBasename is updated, so a debounce firing mid-load must not write
// the incoming ROM's SRAM over the outgoing ROM's .sav.
// ---------------------------------------------------------------------------

test("ROM switch: SRAM dirtied during loadRom lands in the NEW ROM's .sav, not the old one's", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeEmulator();
    const persistence = createPersistence(fake.emulator, {
      romDir: dir,
      debounceMs: 5,
      logger: () => {},
    });

    await writeFile(path.join(dir, "a.gba"), "rom-a");
    await writeFile(path.join(dir, "b.gba"), "rom-b");
    const aSav = new Uint8Array([1, 1]);
    await writeFile(path.join(dir, "a.sav"), aSav);
    fake.setSramForGet(aSav);

    await persistence.loadRom("a.gba");

    // Make emulator.load slow and have it fire sramDirty with the NEW core's
    // SRAM mid-load, so the 5 ms debounce flushes inside the load window.
    (fake.emulator as unknown as { load: (p: string) => Promise<void> }).load = async (romPath) => {
      fake.loadCalls.push(romPath);
      fake.fireSramDirty(new Uint8Array([9, 9]));
      await new Promise((r) => setTimeout(r, 40));
    };

    await persistence.loadRom("b.gba");
    await persistence.flushPending();

    const aOnDisk = await readFile(path.join(dir, "a.sav"));
    assert.deepEqual(Array.from(aOnDisk), [1, 1], "outgoing ROM's .sav untouched by incoming SRAM");
    const bOnDisk = await readFile(path.join(dir, "b.sav"));
    assert.deepEqual(Array.from(bOnDisk), [9, 9], "incoming SRAM landed in the new ROM's .sav");

    persistence.destroy();
  });
});

// ---------------------------------------------------------------------------
// snapshot() writes are serialized on the shared chain (no torn .state via
// two writers racing on the same .state.tmp path)
// ---------------------------------------------------------------------------

test("concurrent snapshots serialize: all resolve, last bytes win, no leftover .tmp", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeEmulator();
    const persistence = createPersistence(fake.emulator, {
      romDir: dir,
      logger: () => {},
    });

    await writeFile(path.join(dir, "game.gba"), "rom");
    await persistence.loadRom("game.gba");

    // Fire many snapshots without awaiting; unserialized writers share
    // game.state.tmp and rename each other's half-written files (ENOENT /
    // torn .state). saveState is called synchronously in call order, so the
    // serialized chain must leave the LAST bytes on disk.
    const snapshots: Promise<void>[] = [];
    let last: Uint8Array = new Uint8Array(0);
    for (let n = 1; n <= 10; n++) {
      last = new Uint8Array(1024).fill(n);
      fake.setSaveStateBytes(last);
      snapshots.push(persistence.snapshot());
    }
    await Promise.all(snapshots);

    const onDisk = await readFile(path.join(dir, "game.state"));
    assert.deepEqual(Array.from(onDisk), Array.from(last), "last snapshot's bytes win");

    const entries = await readdir(dir);
    assert.ok(!entries.some((e) => e.endsWith(".tmp")), `no torn .tmp leftovers, got: ${entries}`);

    persistence.destroy();
  });
});

// ---------------------------------------------------------------------------
// Reloading the SAME ROM flushes the pending debounced SRAM before the .sav
// is read back (no stale seed that the late flush then overwrites)
// ---------------------------------------------------------------------------

test("same-ROM reload: pending SRAM flush lands before the .sav is re-read", async () => {
  await withTempDir(async (dir) => {
    const fake = makeFakeEmulator();
    const persistence = createPersistence(fake.emulator, {
      romDir: dir,
      debounceMs: 10_000, // never fires on its own — loadRom must force it
      logger: () => {},
    });

    await writeFile(path.join(dir, "game.gba"), "rom");
    await persistence.loadRom("game.gba");

    // Dirty SRAM; the debounce is still pending when we reload the same ROM.
    fake.fireSramDirty(new Uint8Array([7, 7]));
    await persistence.loadRom("game.gba");

    const savOnDisk = await readFile(path.join(dir, "game.sav"));
    assert.deepEqual(Array.from(savOnDisk), [7, 7], "pending flush forced to disk before reload");
    const seeded = fake.writeSramCalls.at(-1);
    assert.ok(seeded, ".sav was re-read and injected on reload");
    assert.deepEqual(Array.from(seeded!), [7, 7], "core seeded with the flushed (not stale) bytes");

    persistence.destroy();
  });
});

// ---------------------------------------------------------------------------
// Auto-snapshot: periodic .state writes while a ROM is loaded; destroy stops
// ---------------------------------------------------------------------------

test("autoSnapshotMs: writes .state periodically once a ROM is loaded; destroy stops the timer", async () => {
  await withTempDir(async (dir) => {
    const { emulator, setSaveStateBytes } = makeFakeEmulator();
    const p = createPersistence(emulator, { romDir: dir, autoSnapshotMs: 25 });
    const statePath = path.join(dir, "game.state");

    // No ROM loaded yet → interval ticks must not create a .state.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(await fileExists(statePath), false, "no snapshot before ROM load");

    await writeFile(path.join(dir, "game.gba"), "rom");
    setSaveStateBytes(new Uint8Array([9, 9]));
    await p.loadRom("game.gba");

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(await fileExists(statePath), true, "auto-snapshot wrote .state");
    assert.deepEqual([...(await readFile(statePath))], [9, 9]);

    p.destroy();
    await rm(statePath);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(await fileExists(statePath), false, "no snapshots after destroy()");
  });
});
