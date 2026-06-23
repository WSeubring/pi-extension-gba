/**
 * Phase 8b audio module tests.
 * Design ref: docs/design/phase-8b-audio-module.md §Test plan
 *
 * Uses a child_process.spawn mock that returns a fake ChildProcess object
 * (EventEmitter + stdin Writable stub + kill() spy).
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, test } from "node:test";

// ---------------------------------------------------------------------------
// Fake ChildProcess factory
// ---------------------------------------------------------------------------

interface FakeStdin extends Writable {
  writtenChunks: Buffer[];
  ended: boolean;
}

interface FakeChildProcess extends EventEmitter {
  stdin: FakeStdin;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
  killSignals: string[];
  /** Simulate abnormal exit */
  simulateExit(code: number, signal?: string | null): void;
  /** Simulate normal exit */
  simulateNormalExit(): void;
}

function makeFakeProc(): FakeChildProcess {
  const proc = new EventEmitter() as FakeChildProcess;
  const killSignals: string[] = [];
  proc.killSignals = killSignals;

  const stdin = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      (stdin as FakeStdin).writtenChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string));
      cb();
    },
  }) as FakeStdin;
  stdin.writtenChunks = [];
  stdin.ended = false;

  const realEnd = stdin.end.bind(stdin);
  // Override end to track that it was called, then call the real end
  stdin.end = (...args: unknown[]) => {
    stdin.ended = true;
    // Call real end with the callback if provided
    if (typeof args[0] === "function") {
      return realEnd(args[0] as () => void);
    } else if (typeof args[args.length - 1] === "function") {
      return realEnd(args[args.length - 1] as () => void);
    }
    return realEnd();
  };

  proc.stdin = stdin;
  proc.stderr = new EventEmitter();

  proc.kill = (signal = "SIGTERM") => {
    killSignals.push(signal);
  };

  proc.simulateExit = (code: number, signal: string | null = null) => {
    proc.emit("exit", code, signal);
  };

  proc.simulateNormalExit = () => {
    proc.emit("exit", 0, null);
  };

  return proc;
}

// ---------------------------------------------------------------------------
// Imports from audio module
// ---------------------------------------------------------------------------

import type { AudioPlayer } from "../src/audio.js";
import { __setSpawnForTest, audioEnabled, createAudioPlayer } from "../src/audio.js";

afterEach(() => {
  __setSpawnForTest(undefined);
});

// ---------------------------------------------------------------------------
// Helper: creates a player with env gate enabled
// ---------------------------------------------------------------------------

import type { AudioBackend } from "../src/audio.js";

function makePlayer(backend: AudioBackend = "aplay"): AudioPlayer {
  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";
  const player = createAudioPlayer({ backend, cfgAudio: false });
  process.env.PI_GBA_AUDIO = saved;
  if (!player) {
    throw new Error(`makePlayer: createAudioPlayer returned undefined for backend "${backend}"`);
  }
  return player;
}

// ---------------------------------------------------------------------------
// Test 1: gate — env+cfg matrix
// ---------------------------------------------------------------------------

test("gate: PI_GBA_AUDIO unset AND cfgAudio=false → undefined", () => {
  const saved = process.env.PI_GBA_AUDIO;
  delete process.env.PI_GBA_AUDIO;

  const player = createAudioPlayer({ backend: "aplay", cfgAudio: false });

  process.env.PI_GBA_AUDIO = saved;
  assert.equal(player, undefined);
});

test("gate: PI_GBA_AUDIO=1 → player returned", () => {
  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";

  const player = createAudioPlayer({ backend: "aplay", cfgAudio: false });

  process.env.PI_GBA_AUDIO = saved;
  assert.ok(player !== undefined, "player should be returned when PI_GBA_AUDIO=1");
});

test("gate: cfgAudio=true → player returned", () => {
  const saved = process.env.PI_GBA_AUDIO;
  delete process.env.PI_GBA_AUDIO;

  const player = createAudioPlayer({ backend: "aplay", cfgAudio: true });

  process.env.PI_GBA_AUDIO = saved;
  assert.ok(player !== undefined, "player should be returned when cfgAudio=true");
});

test("gate: PI_GBA_AUDIO=1 AND cfgAudio=true → player returned", () => {
  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";

  const player = createAudioPlayer({ backend: "aplay", cfgAudio: true });

  process.env.PI_GBA_AUDIO = saved;
  assert.ok(player !== undefined);
});

// ---------------------------------------------------------------------------
// Test 2: no-backend → undefined
// ---------------------------------------------------------------------------

test("no-backend: backend=undefined → undefined regardless of gate", () => {
  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";

  const player = createAudioPlayer({ backend: undefined, cfgAudio: true });

  process.env.PI_GBA_AUDIO = saved;
  assert.equal(player, undefined);
});

// ---------------------------------------------------------------------------
// Test 3: mute/unmute/isMuted (no subprocess needed)
// ---------------------------------------------------------------------------

test("mute/unmute/isMuted: default is unmuted", () => {
  const player = makePlayer();
  assert.ok(player !== undefined);
  assert.equal(player?.isMuted(), false);
});

test("mute: isMuted returns true after mute()", () => {
  const player = makePlayer();
  player.mute();
  assert.equal(player.isMuted(), true);
});

test("unmute: isMuted returns false after unmute()", () => {
  const player = makePlayer();
  player.mute();
  player.unmute();
  assert.equal(player.isMuted(), false);
});

// ---------------------------------------------------------------------------
// Test 4: onCrash unsubscribe
// ---------------------------------------------------------------------------

test("onCrash: unsubscribe prevents later calls", () => {
  const calls: Error[] = [];
  const player = makePlayer();

  const unsub = player.onCrash((err) => calls.push(err));
  unsub();

  // No crash has occurred; listener removed without error
  assert.equal(calls.length, 0);
});

test("onCrash: calling unsubscribe multiple times is safe", () => {
  const player = makePlayer();
  const unsub = player.onCrash(() => {});
  unsub();
  assert.doesNotThrow(() => unsub());
});

// ---------------------------------------------------------------------------
// Test 5: writeSamples no-op before start
// ---------------------------------------------------------------------------

test("writeSamples: no-op before start() is called", () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();

  // Not started — should not throw and not write anything
  assert.doesNotThrow(() => {
    player.writeSamples(new Int16Array([1, 2, 3, 4]));
  });
  assert.equal(fakeProc.stdin.writtenChunks.length, 0, "no write before start");
});

// ---------------------------------------------------------------------------
// Test 6: start + writeSamples writes correct bytes
// ---------------------------------------------------------------------------

test("start+write: writeSamples writes exact bytes to stdin", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();
  await player.start();

  const pcm = new Int16Array([100, 200, 300, 400]);
  player.writeSamples(pcm);

  assert.equal(fakeProc.stdin.writtenChunks.length, 1, "one chunk written");
  const written = fakeProc.stdin.writtenChunks[0];
  assert.ok(written, "expected a written chunk");
  assert.equal(written.byteLength, pcm.byteLength, "correct byte length");
  const view = new Int16Array(written.buffer, written.byteOffset, written.byteLength / 2);
  assert.deepEqual(Array.from(view), [100, 200, 300, 400]);

  // Clean stop: call stop() then emit exit
  const stopPromise = player.stop();
  fakeProc.simulateNormalExit();
  await stopPromise;
});

// ---------------------------------------------------------------------------
// Test 7: mute semantics
// ---------------------------------------------------------------------------

test("mute: muted writeSamples writes same-length zeros", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();
  await player.start();
  player.mute();

  const pcm = new Int16Array([1000, 2000, 3000, 4000]);
  player.writeSamples(pcm);

  assert.equal(fakeProc.stdin.writtenChunks.length, 1);
  const written = fakeProc.stdin.writtenChunks[0];
  assert.ok(written, "expected a written chunk");
  const view = new Int16Array(written.buffer, written.byteOffset, written.byteLength / 2);
  assert.deepEqual(Array.from(view), [0, 0, 0, 0], "muted → zeros");
  assert.equal(view.length, pcm.length, "same length as input");

  const stopPromise = player.stop();
  fakeProc.simulateNormalExit();
  await stopPromise;
});

test("unmute: restores original bytes after unmute()", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();
  await player.start();
  player.mute();
  player.unmute();

  const pcm = new Int16Array([100, 200]);
  player.writeSamples(pcm);

  assert.equal(fakeProc.stdin.writtenChunks.length, 1);
  const written = fakeProc.stdin.writtenChunks[0];
  assert.ok(written, "expected a written chunk");
  const view = new Int16Array(written.buffer, written.byteOffset, written.byteLength / 2);
  assert.deepEqual(Array.from(view), [100, 200], "unmuted → original bytes");

  const stopPromise = player.stop();
  fakeProc.simulateNormalExit();
  await stopPromise;
});

// ---------------------------------------------------------------------------
// Test 8: crash → onCrash fires once, writeSamples is no-op
// ---------------------------------------------------------------------------

test("crash: onCrash fires once on non-zero exit", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const crashErrors: Error[] = [];
  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";
  const player = createAudioPlayer({
    backend: "aplay",
    cfgAudio: false,
    onCrash: (err) => crashErrors.push(err),
  });
  assert.ok(player, "expected audio player");
  process.env.PI_GBA_AUDIO = saved;

  await player.start();

  // Simulate crash
  fakeProc.simulateExit(1);

  assert.equal(crashErrors.length, 1, "onCrash called once");
  assert.ok(crashErrors[0]?.message.includes("code=1"), "error message has exit code");
});

test("crash: writeSamples is no-op after crash", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();
  await player.start();

  // Write something before crash to confirm it works
  player.writeSamples(new Int16Array([1, 2]));
  const beforeCount = fakeProc.stdin.writtenChunks.length;
  assert.equal(beforeCount, 1);

  // Crash
  fakeProc.simulateExit(1);

  // writeSamples should be a no-op now
  player.writeSamples(new Int16Array([999, 999]));
  assert.equal(fakeProc.stdin.writtenChunks.length, 1, "no write after crash");
});

test("crash: onCrash does NOT fire on zero exit", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const crashErrors: Error[] = [];
  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";
  const player = createAudioPlayer({
    backend: "aplay",
    cfgAudio: false,
    onCrash: (err) => crashErrors.push(err),
  });
  assert.ok(player, "expected audio player");
  process.env.PI_GBA_AUDIO = saved;

  await player.start();
  fakeProc.simulateNormalExit();

  assert.equal(crashErrors.length, 0, "onCrash should NOT fire on zero exit");
});

// ---------------------------------------------------------------------------
// Test 9: stop is idempotent
// ---------------------------------------------------------------------------

test("stop: idempotent — calling stop() twice does not throw or hang", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();
  await player.start();

  // First stop: call stop(), then emit exit to resolve it
  const stop1 = player.stop();
  fakeProc.simulateNormalExit();
  await stop1;

  // Second stop — already stopped, should return immediately
  await assert.doesNotReject(() => player.stop());
});

test("stop: stdin.end() called and SIGTERM sent", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();
  await player.start();

  // Register stop, let stdin.end's callback fire, then emit exit
  const stopPromise = player.stop();

  // Yield to allow stdin.end's callback to fire (it calls kill(SIGTERM))
  await new Promise<void>((r) => setImmediate(r));

  fakeProc.simulateNormalExit();
  await stopPromise;

  assert.equal(fakeProc.stdin.ended, true, "stdin.end() was called");
  assert.ok(fakeProc.killSignals.includes("SIGTERM"), "SIGTERM was sent");
});

// ---------------------------------------------------------------------------
// Test 10: spawn args per backend
// ---------------------------------------------------------------------------

test("spawn args: pw-cat uses correct flags", async () => {
  let spawnedCmd = "";
  let spawnedArgs: string[] = [];

  const fakeProc = makeFakeProc();
  __setSpawnForTest((cmd: string, args: string[]) => {
    spawnedCmd = cmd;
    spawnedArgs = args;
    return fakeProc;
  });

  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";
  const player = makePlayer("pw-cat");
  process.env.PI_GBA_AUDIO = saved;

  await player.start();
  const stopP = player.stop();
  fakeProc.simulateNormalExit();
  await stopP;

  assert.equal(spawnedCmd, "pw-cat");
  assert.ok(spawnedArgs.includes("--playback"), "pw-cat has --playback");
  assert.ok(spawnedArgs.includes("65536"), "pw-cat has rate 65536");
  assert.ok(spawnedArgs.includes("s16"), "pw-cat has format s16");
});

test("spawn args: pacat uses correct flags", async () => {
  let spawnedCmd = "";
  let spawnedArgs: string[] = [];

  const fakeProc = makeFakeProc();
  __setSpawnForTest((cmd: string, args: string[]) => {
    spawnedCmd = cmd;
    spawnedArgs = args;
    return fakeProc;
  });

  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";
  const player = makePlayer("pacat");
  process.env.PI_GBA_AUDIO = saved;

  await player.start();
  const stopP = player.stop();
  fakeProc.simulateNormalExit();
  await stopP;

  assert.equal(spawnedCmd, "pacat");
  assert.ok(
    spawnedArgs.some((a) => a.includes("65536")),
    "pacat has rate 65536",
  );
  assert.ok(
    spawnedArgs.some((a) => a.includes("s16le")),
    "pacat has format s16le",
  );
});

test("spawn args: ffplay uses correct flags", async () => {
  let spawnedCmd = "";
  let spawnedArgs: string[] = [];

  const fakeProc = makeFakeProc();
  __setSpawnForTest((cmd: string, args: string[]) => {
    spawnedCmd = cmd;
    spawnedArgs = args;
    return fakeProc;
  });

  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";
  const player = makePlayer("ffplay");
  process.env.PI_GBA_AUDIO = saved;

  await player.start();
  const stopP = player.stop();
  fakeProc.simulateNormalExit();
  await stopP;

  assert.equal(spawnedCmd, "ffplay");
  assert.ok(spawnedArgs.includes("-nodisp"), "ffplay has -nodisp");
  assert.ok(spawnedArgs.includes("s16le"), "ffplay has s16le format");
  assert.ok(spawnedArgs.includes("65536"), "ffplay has rate 65536");
});

test("spawn args: aplay uses correct flags", async () => {
  let spawnedCmd = "";
  let spawnedArgs: string[] = [];

  const fakeProc = makeFakeProc();
  __setSpawnForTest((cmd: string, args: string[]) => {
    spawnedCmd = cmd;
    spawnedArgs = args;
    return fakeProc;
  });

  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";
  const player = makePlayer("aplay");
  process.env.PI_GBA_AUDIO = saved;

  await player.start();
  const stopP = player.stop();
  fakeProc.simulateNormalExit();
  await stopP;

  assert.equal(spawnedCmd, "aplay");
  assert.ok(spawnedArgs.includes("S16_LE"), "aplay has S16_LE format");
  assert.ok(spawnedArgs.includes("65536"), "aplay has rate 65536");
});

// ---------------------------------------------------------------------------
// Test 11: start is idempotent
// ---------------------------------------------------------------------------

test("start: idempotent — calling start() twice is safe", async () => {
  let spawnCount = 0;
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => {
    spawnCount++;
    return fakeProc;
  });

  const player = makePlayer();
  await player.start();
  await player.start(); // second call should be a no-op

  assert.equal(spawnCount, 1, "spawn only called once");

  const stopP = player.stop();
  fakeProc.simulateNormalExit();
  await stopP;
});

// ---------------------------------------------------------------------------
// Test 12: crash → onCrash registered via onCrash() method fires and can unsubscribe
// ---------------------------------------------------------------------------

test("onCrash method: registered callback fires on crash, unsubscribed does not", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();
  await player.start();

  const calls1: Error[] = [];
  const calls2: Error[] = [];

  const unsub1 = player.onCrash((err) => calls1.push(err));
  player.onCrash((err) => calls2.push(err));

  // Unsubscribe listener 1
  unsub1();

  fakeProc.simulateExit(2);

  assert.equal(calls1.length, 0, "unsubscribed listener not called");
  assert.equal(calls2.length, 1, "remaining listener called once");
});

// ---------------------------------------------------------------------------
// Test 13: backpressure — chunks dropped and logged once when writableLength
//           exceeds 128 KiB threshold (Phase 8 nit 3)
// ---------------------------------------------------------------------------

test("backpressure: chunks dropped and logger called once when stdin buffer is full", async () => {
  const logMessages: string[] = [];

  // Build a fake proc whose stdin never drains (writableLength only grows).
  const proc = new EventEmitter() as FakeChildProcess;
  proc.killSignals = [];
  proc.kill = () => {};
  proc.simulateExit = (code, signal = null) => proc.emit("exit", code, signal);
  proc.simulateNormalExit = () => proc.emit("exit", 0, null);
  proc.stderr = new EventEmitter();

  // A Writable that accumulates writableLength but never calls cb (never drains).
  let accumulated = 0;
  const wedgedStdin = new Writable({
    write(_chunk: Buffer, _enc: BufferEncoding, _cb: () => void) {
      // Intentionally NOT calling cb() — buffer grows without draining.
      accumulated += (_chunk as Buffer).byteLength;
    },
  }) as FakeStdin;
  wedgedStdin.writtenChunks = [];
  wedgedStdin.ended = false;
  wedgedStdin.end = (..._args: unknown[]) => wedgedStdin;
  // Override writableLength to simulate a full buffer.
  Object.defineProperty(wedgedStdin, "writableLength", {
    get() {
      return accumulated;
    },
  });
  proc.stdin = wedgedStdin;

  __setSpawnForTest(() => proc);

  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";
  const player = createAudioPlayer({
    backend: "aplay",
    cfgAudio: false,
    logger: (msg) => logMessages.push(msg),
  });
  assert.ok(player, "expected audio player");
  process.env.PI_GBA_AUDIO = saved;

  await player.start();

  // Fill the buffer past the 128 KiB threshold.
  const THRESHOLD = 128 * 1024;
  const bigChunk = new Int16Array(THRESHOLD); // 256 KiB bytes
  player.writeSamples(bigChunk); // this will accumulate without draining
  // accumulated is now 256 KiB — above threshold.

  // Next write should be dropped and log once.
  const smallChunk = new Int16Array(16);
  player.writeSamples(smallChunk);
  player.writeSamples(smallChunk);
  player.writeSamples(smallChunk);

  assert.equal(
    logMessages.filter((m) => m.includes("stdin buffer full")).length,
    1,
    "backpressure warning logged exactly once",
  );

  // Signal clean shutdown.
  const stopP = player.stop();
  proc.simulateNormalExit();
  await stopP;
});

// ---------------------------------------------------------------------------
// Test 14: start→stop→start re-arm (Phase 8 nit 4)
//   Second start() spawns a fresh process; crash listeners from the first
//   start are NOT inherited by the second spawn.
// ---------------------------------------------------------------------------

test("start→stop→start re-arm: second start spawns fresh process, old crash listeners silent", async () => {
  let spawnCount = 0;
  const fakeProc1 = makeFakeProc();
  const fakeProc2 = makeFakeProc();

  __setSpawnForTest(() => {
    spawnCount++;
    return spawnCount === 1 ? fakeProc1 : fakeProc2;
  });

  const player = makePlayer();

  // First lifecycle: start → crash listeners attached.
  const crashCallsFirstSession: Error[] = [];
  const unsub = player.onCrash((err) => crashCallsFirstSession.push(err));

  await player.start();
  assert.equal(spawnCount, 1, "first start spawns one process");

  // Stop the player (clean).
  const stop1 = player.stop();
  fakeProc1.simulateNormalExit();
  await stop1;

  // Unsubscribe the first-session listener so only fresh listeners should fire.
  unsub();

  // Second lifecycle: fresh crash listeners.
  const crashCallsSecondSession: Error[] = [];
  player.onCrash((err) => crashCallsSecondSession.push(err));

  await player.start();
  assert.equal(spawnCount, 2, "second start spawns a second process");

  // Crash the second process — only second-session listener should fire.
  fakeProc2.simulateExit(1);

  assert.equal(crashCallsFirstSession.length, 0, "first-session listener not fired after unsub");
  assert.equal(crashCallsSecondSession.length, 1, "second-session crash listener fired");

  // First process crash should not re-fire anything (already stopped).
  fakeProc1.simulateExit(1);
  assert.equal(crashCallsSecondSession.length, 1, "old proc crash does not affect second session");
});

// ---------------------------------------------------------------------------
// Signal death (code=null, signal set) is a crash, not a clean exit
// ---------------------------------------------------------------------------

test("crash: signal death (code=null, signal=SIGKILL) fires crash listeners", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();
  const crashes: Error[] = [];
  player.onCrash((err) => crashes.push(err));

  await player.start();
  fakeProc.simulateExit(null as unknown as number, "SIGKILL");

  assert.equal(crashes.length, 1, "signal death must fire crash listeners");
  assert.match(crashes[0].message, /SIGKILL/);

  // Player must refuse further writes after the crash.
  player.writeSamples(new Int16Array([1, 2, 3, 4]));
  assert.equal(fakeProc.stdin.writtenChunks.length, 0, "no writes after signal-death crash");
});

// ---------------------------------------------------------------------------
// Async stdin error (EPIPE) must not propagate as uncaughtException
// ---------------------------------------------------------------------------

test("stdin 'error' event is swallowed and marks the session crashed", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const logged: string[] = [];
  const saved = process.env.PI_GBA_AUDIO;
  process.env.PI_GBA_AUDIO = "1";
  const player = createAudioPlayer({
    backend: "aplay",
    cfgAudio: false,
    logger: (msg) => logged.push(msg),
  });
  assert.ok(player, "expected audio player");
  process.env.PI_GBA_AUDIO = saved;

  await player.start();

  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  // Emitting 'error' on a stream with no listener would throw synchronously —
  // this not throwing proves the listener is attached.
  fakeProc.stdin.emit("error", epipe);

  player.writeSamples(new Int16Array([1, 2, 3, 4]));
  assert.equal(fakeProc.stdin.writtenChunks.length, 0, "no writes after stdin error");
  assert.ok(
    logged.some((m) => m.includes("EPIPE")),
    "stdin error is logged",
  );
});

// ---------------------------------------------------------------------------
// stop() after the process already died must not hang
// ---------------------------------------------------------------------------

test("stop() resolves promptly when the subprocess already exited", async () => {
  const fakeProc = makeFakeProc();
  // Mimic a real ChildProcess that died via signal before stop() was called.
  (fakeProc as unknown as { exitCode: number | null }).exitCode = null;
  (fakeProc as unknown as { signalCode: string | null }).signalCode = "SIGKILL";
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();
  await player.start();
  fakeProc.simulateExit(null as unknown as number, "SIGKILL");

  // Must resolve without simulateNormalExit ever firing again.
  await player.stop();

  // And a follow-up start() must spawn a fresh process.
  const fresh = makeFakeProc();
  let spawnedAgain = false;
  __setSpawnForTest(() => {
    spawnedAgain = true;
    return fresh;
  });
  await player.start();
  assert.ok(spawnedAgain, "restart after crash spawns a new subprocess");
  player.writeSamples(new Int16Array([1, 2]));
  assert.equal(fresh.stdin.writtenChunks.length, 1, "writes flow again after re-arm");
});

// ---------------------------------------------------------------------------
// Spawn failure ('error' event, e.g. ENOENT) fires crash listeners — Node
// emits no 'exit' after a failed spawn, so the exit handler alone never runs
// ---------------------------------------------------------------------------

test("crash: spawn 'error' (ENOENT) fires crash listeners exactly once, even with a late exit", async () => {
  const fakeProc = makeFakeProc();
  __setSpawnForTest(() => fakeProc);

  const crashes: Error[] = [];
  const player = makePlayer();
  player.onCrash((err) => crashes.push(err));

  await player.start();

  const enoent = Object.assign(new Error("spawn aplay ENOENT"), { code: "ENOENT" });
  fakeProc.emit("error", enoent);

  assert.equal(crashes.length, 1, "spawn failure must reach onCrash listeners");
  assert.ok(crashes[0]?.message.includes("ENOENT"), "error message carries the spawn failure");

  // A (hypothetical) late non-zero exit must not double-fire via the shared
  // fired-once guard.
  fakeProc.simulateExit(1);
  assert.equal(crashes.length, 1, "fired-once guard shared between error and exit handlers");

  // Player must refuse further writes after the spawn failure.
  player.writeSamples(new Int16Array([1, 2]));
  assert.equal(fakeProc.stdin.writtenChunks.length, 0, "no writes after spawn failure");
});

// ---------------------------------------------------------------------------
// stop() must resolve even when the child ignores SIGTERM AND SIGKILL
// (stuck in uninterruptible I/O — no 'exit' ever fires)
// ---------------------------------------------------------------------------

test("stop() resolves via the final fallback when the child never exits", async () => {
  const fakeProc = makeFakeProc(); // kill() is a spy; never emits 'exit'
  __setSpawnForTest(() => fakeProc);

  const player = makePlayer();
  await player.start();

  // 200 ms SIGTERM→SIGKILL + 200 ms final fallback; 2 s cap proves no hang.
  let capTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      player.stop(),
      new Promise<never>((_, reject) => {
        capTimer = setTimeout(() => reject(new Error("stop() hung on a stuck child")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(capTimer);
  }

  assert.ok(fakeProc.killSignals.includes("SIGTERM"), "SIGTERM attempted");
  assert.ok(fakeProc.killSignals.includes("SIGKILL"), "SIGKILL fallback attempted");

  // The player must be re-armable after the forced detach.
  const fresh = makeFakeProc();
  __setSpawnForTest(() => fresh);
  await player.start();
  player.writeSamples(new Int16Array([3, 4]));
  assert.equal(fresh.stdin.writtenChunks.length, 1, "writes flow again after re-arm");
});

// ---------------------------------------------------------------------------
// PI_GBA_AUDIO=0 forces audio off regardless of config (README contract)
// ---------------------------------------------------------------------------

test("PI_GBA_AUDIO=0 force-off beats cfgAudio=true; audioEnabled gate", () => {
  const saved = process.env.PI_GBA_AUDIO;
  try {
    process.env.PI_GBA_AUDIO = "0";
    assert.equal(createAudioPlayer({ backend: "aplay", cfgAudio: true }), undefined);
    assert.equal(audioEnabled(true), false, "env=0 beats cfg true");
    process.env.PI_GBA_AUDIO = "1";
    assert.equal(audioEnabled(false), true, "env=1 beats cfg false");
    delete process.env.PI_GBA_AUDIO;
    assert.equal(audioEnabled(true), true, "unset env: cfg decides (true)");
    assert.equal(audioEnabled(false), false, "unset env: cfg decides (false)");
  } finally {
    if (saved === undefined) delete process.env.PI_GBA_AUDIO;
    else process.env.PI_GBA_AUDIO = saved;
  }
});
