import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Emulator } from "../src/emulator.js";
import type { LifecycleOptions, RenderController } from "../src/lifecycle.js";
import { createLifecycle } from "../src/lifecycle.js";
import { defined } from "./harness/assert.js";

// ---- mock factories ----

function makeMockRender(): { render: RenderController; calls: string[] } {
  const calls: string[] = [];
  const render: RenderController = {
    start() {
      calls.push("start");
    },
    stop() {
      calls.push("stop");
    },
    shrink() {
      calls.push("shrink");
    },
    expand() {
      calls.push("expand");
    },
    hide() {
      calls.push("hide");
    },
  };
  return { render, calls };
}

function makeMockEmulator(): {
  emulator: Emulator;
  triggerCrash: (err: Error) => void;
  releaseCalls: string[];
} {
  let crashCb: ((err: Error) => void) | null = null;
  const releaseCalls: string[] = [];
  const emulator = {
    onCrash(cb: (err: Error) => void) {
      crashCb = cb;
    },
    release(button: string) {
      releaseCalls.push(button);
    },
    saveState() {
      return new Uint8Array(0);
    },
  } as unknown as Emulator;
  return {
    emulator,
    triggerCrash(err: Error) {
      if (crashCb) crashCb(err);
    },
    releaseCalls,
  };
}

// Lifecycle's agent_start/agent_end logic is driven by calling its
// onAgentStart/onAgentEnd methods directly (the session coordinator invokes
// them in production). The mock pi only needs no-op registration stubs.
function makeMockPi(): { pi: ExtensionAPI } {
  const pi = {
    on() {},
    registerShortcut() {},
  } as unknown as ExtensionAPI;
  return { pi };
}

function makeOpts(overrides?: Partial<LifecycleOptions>): LifecycleOptions {
  const logs: string[] = [];
  return {
    autoRunOnAgentStart: true,
    autoHideOnAgentEnd: false,
    logger: (msg) => logs.push(msg),
    ...overrides,
  };
}

// ---- tests ----

test("happy path: onRomLoad starts render; agent_end pauses; agent_start resumes", async () => {
  const { pi } = makeMockPi();
  const { emulator } = makeMockEmulator();
  const { render, calls } = makeMockRender();
  const opts = makeOpts();

  const lifecycle = createLifecycle(pi, emulator, () => render, opts);
  lifecycle.attach();

  lifecycle.onRomLoad();
  assert.deepEqual(calls, ["start", "expand"], "onRomLoad → start + expand");

  await lifecycle.onAgentEnd();
  assert.deepEqual(calls, ["start", "expand", "stop", "shrink"], "agent_end → stop + shrink");

  await lifecycle.onAgentStart();
  assert.deepEqual(calls, ["start", "expand", "stop", "shrink", "start", "expand"], "agent_start → start + expand");
});

test("manual override sticks: manualPauseToggle blocks agent_start", async () => {
  const { pi } = makeMockPi();
  const { emulator } = makeMockEmulator();
  const { render, calls } = makeMockRender();
  const opts = makeOpts();

  const lifecycle = createLifecycle(pi, emulator, () => render, opts);
  lifecycle.attach();
  lifecycle.onRomLoad();

  assert.deepEqual(calls, ["start", "expand"]);

  // Manually pause — sets manualOverride = true
  lifecycle.manualPauseToggle();
  assert.deepEqual(calls, ["start", "expand", "stop", "shrink"]);

  // agent_start should be a no-op because manualOverride = true
  await lifecycle.onAgentStart();
  assert.deepEqual(calls, ["start", "expand", "stop", "shrink"], "agent_start is no-op after manual override");

  // Manual resume — override still true
  lifecycle.manualPauseToggle();
  assert.deepEqual(calls, ["start", "expand", "stop", "shrink", "start", "expand"]);

  // agent_end should be a no-op because manualOverride = true
  await lifecycle.onAgentEnd();
  assert.deepEqual(
    calls,
    ["start", "expand", "stop", "shrink", "start", "expand"],
    "agent_end is no-op after manual override",
  );
});

test("autorun gating: autoRunOnAgentStart=false blocks agent_start transition", async () => {
  const { pi } = makeMockPi();
  const { emulator } = makeMockEmulator();
  const { render, calls } = makeMockRender();
  const opts = makeOpts({ autoRunOnAgentStart: false });

  const lifecycle = createLifecycle(pi, emulator, () => render, opts);
  lifecycle.attach();
  lifecycle.onRomLoad();

  assert.deepEqual(calls, ["start", "expand"]);

  // Simulate agent_end (no manual override, should pause)
  await lifecycle.onAgentEnd();
  assert.deepEqual(calls, ["start", "expand", "stop", "shrink"]);

  // agent_start must be a no-op when autoRunOnAgentStart=false
  await lifecycle.onAgentStart();
  assert.deepEqual(calls, ["start", "expand", "stop", "shrink"], "agent_start is no-op when autoRunOnAgentStart=false");
});

test("crash handler honours autoHideOnAgentEnd=true", () => {
  const { pi } = makeMockPi();
  const { emulator, triggerCrash } = makeMockEmulator();
  const { render, calls } = makeMockRender();
  const opts = makeOpts({ autoHideOnAgentEnd: true });

  const lifecycle = createLifecycle(pi, emulator, () => render, opts);
  lifecycle.attach();
  lifecycle.onRomLoad();
  assert.deepEqual(calls, ["start", "expand"], "after onRomLoad");

  triggerCrash(new Error("boom"));
  assert.deepEqual(calls, ["start", "expand", "stop", "hide"], "crash with autoHideOnAgentEnd=true → stop + hide");
});

test("crash handler logs via opts.logger", () => {
  const { pi } = makeMockPi();
  const { emulator, triggerCrash } = makeMockEmulator();
  const { render } = makeMockRender();

  const loggerCalls: string[] = [];
  const opts = makeOpts({ logger: (msg) => loggerCalls.push(msg) });

  const lifecycle = createLifecycle(pi, emulator, () => render, opts);
  lifecycle.attach();
  lifecycle.onRomLoad();
  // clear logger calls from onRomLoad/attach
  loggerCalls.length = 0;

  const syntheticError = new Error("coreCrash");
  triggerCrash(syntheticError);

  assert.equal(loggerCalls.length, 1, "logger called exactly once on crash");
  assert.ok(
    loggerCalls[0]?.includes("GBA crashed"),
    `logger message must contain "GBA crashed", got: ${loggerCalls[0]}`,
  );
  assert.ok(
    loggerCalls[0]?.includes(syntheticError.message),
    `logger message must contain the error message, got: ${loggerCalls[0]}`,
  );
});

test("detach() releases held buttons best-effort", () => {
  const { pi } = makeMockPi();
  const { emulator, releaseCalls } = makeMockEmulator();
  const { render } = makeMockRender();
  const opts = makeOpts();

  const lifecycle = createLifecycle(pi, emulator, () => render, opts);
  lifecycle.attach();
  lifecycle.onRomLoad();

  lifecycle.detach();

  const expectedButtons = ["up", "down", "left", "right", "a", "b", "l", "r", "start", "select"];
  assert.equal(releaseCalls.length, expectedButtons.length, "release called once per GbaButton");
  for (const button of expectedButtons) {
    assert.ok(releaseCalls.includes(button), `release called for button: ${button}`);
  }
});

// ---------------------------------------------------------------------------
// resume() — game-mode entry unpause with L3 guards
// ---------------------------------------------------------------------------

test("resume(): unpauses an auto-paused lifecycle", async () => {
  const { pi } = makeMockPi();
  const { emulator } = makeMockEmulator();
  const { render, calls } = makeMockRender();
  const lifecycle = createLifecycle(pi, emulator, () => render, makeOpts());
  lifecycle.attach();
  lifecycle.onRomLoad();
  await lifecycle.onAgentEnd(); // auto-pause
  assert.equal(lifecycle.isRunning(), false);

  lifecycle.resume?.();
  assert.equal(lifecycle.isRunning(), true, "resume() restarts a Paused lifecycle");
  assert.ok(calls.filter((c) => c === "start").length >= 2, "render restarted");
});

test("resume(): respects manual pause (alt+shift+g) — L3 still-frame", async () => {
  const { pi } = makeMockPi();
  const { emulator } = makeMockEmulator();
  const { render } = makeMockRender();
  const lifecycle = createLifecycle(pi, emulator, () => render, makeOpts());
  lifecycle.attach();
  lifecycle.onRomLoad();
  lifecycle.manualPauseToggle(); // user explicitly paused

  lifecycle.resume?.();
  assert.equal(lifecycle.isRunning(), false, "resume() must not override a manual pause");
});

test("goPaused: state flips before onPause I/O — resume during a slow onPause is not clobbered", async () => {
  const { pi } = makeMockPi();
  const { emulator } = makeMockEmulator();
  const { render } = makeMockRender();

  let resolveOnPause: (() => void) | undefined;
  const opts = makeOpts({
    onPause: () =>
      new Promise<void>((r) => {
        resolveOnPause = r;
      }),
  });

  const lifecycle = createLifecycle(pi, emulator, () => render, opts);
  lifecycle.attach();
  lifecycle.onRomLoad();

  // agent_end awaits goPaused, which is now blocked inside onPause.
  const endPromise = lifecycle.onAgentEnd();
  assert.equal(lifecycle.isRunning(), false, "state is Paused while onPause is still pending");

  // Resume mid-onPause (e.g. auto-focus game-mode entry).
  lifecycle.resume?.();
  assert.equal(lifecycle.isRunning(), true, "resume() during onPause goes Running");

  // The late onPause completion must NOT clobber Running back to Paused.
  defined(resolveOnPause, "resolveOnPause")();
  await endPromise;
  assert.equal(lifecycle.isRunning(), true, "late onPause completion must not overwrite Running");
});

test("resume(): no-op when Running and when crashed", async () => {
  const { pi } = makeMockPi();
  const { emulator, triggerCrash } = makeMockEmulator();
  const { render, calls } = makeMockRender();
  const lifecycle = createLifecycle(pi, emulator, () => render, makeOpts());
  lifecycle.attach();
  lifecycle.onRomLoad();

  const before = calls.length;
  lifecycle.resume?.(); // already Running
  assert.equal(calls.length, before, "no render calls when already Running");

  triggerCrash(new Error("boom"));
  lifecycle.resume?.();
  assert.equal(lifecycle.isRunning(), false, "resume() refuses after crash");
});
