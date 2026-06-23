import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Emulator } from "../src/emulator.js";
import type { LifecycleOptions, RenderController } from "../src/lifecycle.js";
import { createLifecycle } from "../src/lifecycle.js";

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
} {
  let crashCb: ((err: Error) => void) | null = null;
  const emulator = {
    onCrash(cb: (err: Error) => void) {
      crashCb = cb;
    },
    release(_button: string) {},
    saveState() {
      return new Uint8Array(0);
    },
  } as unknown as Emulator;
  return {
    emulator,
    triggerCrash(err: Error) {
      if (crashCb) crashCb(err);
    },
  };
}

function makeMockPi(): { pi: ExtensionAPI } {
  const pi = {
    on() {},
    registerShortcut() {},
  } as unknown as ExtensionAPI;
  return { pi };
}

function makeOpts(overrides?: Partial<LifecycleOptions>): LifecycleOptions {
  return {
    autoRunOnAgentStart: true,
    autoHideOnAgentEnd: false,
    logger: () => {},
    ...overrides,
  };
}

test("isCrashed starts false", () => {
  const { pi } = makeMockPi();
  const { emulator } = makeMockEmulator();
  const { render } = makeMockRender();
  const lifecycle = createLifecycle(pi, emulator, () => render, makeOpts());
  lifecycle.attach();

  assert.equal(lifecycle.isCrashed(), false, "isCrashed should start false");
});

test("onCrash callback sets isCrashed to true", () => {
  const { pi } = makeMockPi();
  const { emulator, triggerCrash } = makeMockEmulator();
  const { render } = makeMockRender();
  const lifecycle = createLifecycle(pi, emulator, () => render, makeOpts());
  lifecycle.attach();
  lifecycle.onRomLoad();

  assert.equal(lifecycle.isCrashed(), false);
  triggerCrash(new Error("boom"));
  assert.equal(lifecycle.isCrashed(), true, "isCrashed should be true after crash");
});

test("onRomLoad clears the crashed flag", () => {
  const { pi } = makeMockPi();
  const { emulator, triggerCrash } = makeMockEmulator();
  const { render } = makeMockRender();
  const lifecycle = createLifecycle(pi, emulator, () => render, makeOpts());
  lifecycle.attach();
  lifecycle.onRomLoad();

  triggerCrash(new Error("boom"));
  assert.equal(lifecycle.isCrashed(), true);

  lifecycle.onRomLoad();
  assert.equal(lifecycle.isCrashed(), false, "onRomLoad should clear crashed flag");
});

test("acknowledgeCrash clears the crashed flag without ROM reload", () => {
  const { pi } = makeMockPi();
  const { emulator, triggerCrash } = makeMockEmulator();
  const { render } = makeMockRender();
  const lifecycle = createLifecycle(pi, emulator, () => render, makeOpts());
  lifecycle.attach();
  lifecycle.onRomLoad();

  triggerCrash(new Error("boom"));
  assert.equal(lifecycle.isCrashed(), true);

  lifecycle.acknowledgeCrash();
  assert.equal(lifecycle.isCrashed(), false, "acknowledgeCrash should clear crashed flag");
});

test("manualPauseToggle while crashed is a no-op (no additional render calls)", () => {
  const { pi } = makeMockPi();
  const { emulator, triggerCrash } = makeMockEmulator();
  const { render, calls } = makeMockRender();
  const lifecycle = createLifecycle(pi, emulator, () => render, makeOpts());
  lifecycle.attach();
  lifecycle.onRomLoad();

  triggerCrash(new Error("boom"));

  const callsAfterCrash = [...calls];

  lifecycle.manualPauseToggle();

  assert.deepEqual(calls, callsAfterCrash, "manualPauseToggle while crashed must not produce additional render calls");
});

test("double crash is idempotent", () => {
  const { pi } = makeMockPi();
  const { emulator, triggerCrash } = makeMockEmulator();
  const { render, calls } = makeMockRender();
  const lifecycle = createLifecycle(pi, emulator, () => render, makeOpts());
  lifecycle.attach();
  lifecycle.onRomLoad();

  triggerCrash(new Error("first"));
  const callsAfterFirst = [...calls];

  triggerCrash(new Error("second"));

  assert.equal(lifecycle.isCrashed(), true, "still crashed after second trigger");
  assert.deepEqual(
    calls,
    [...callsAfterFirst, "stop", "shrink"],
    "second crash fires render.stop+shrink again (idempotent flag)",
  );
});
