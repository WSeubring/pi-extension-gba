/**
 * Session coordinator tests.
 *
 * The coordinator owns the single agent_start / agent_end subscriptions and
 * dispatches them to lifecycle then auto-focus in a fixed order. These tests
 * cover that ordering, the post-detach self-disarm (pi.on has no unsubscribe),
 * and error isolation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutoFocus } from "../src/auto-focus.js";
import type { Lifecycle } from "../src/lifecycle.js";
import { createSessionCoordinator } from "../src/session-coordinator.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function makeMockPi(): { pi: ExtensionAPI; emit(event: string, ctx: ExtensionContext): Promise<void> } {
  const handlers = new Map<string, EventHandler>();
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    registerShortcut() {},
  } as unknown as ExtensionAPI;
  return {
    pi,
    async emit(event, ctx) {
      await handlers.get(event)?.({ type: event }, ctx);
    },
  };
}

/** Lifecycle stub that records the order of calls into a shared log. */
function makeLifecycle(log: string[]): Lifecycle {
  return {
    attach() {},
    detach() {},
    onAgentStart() {
      log.push("lifecycle.onAgentStart");
    },
    async onAgentEnd() {
      log.push("lifecycle.onAgentEnd");
    },
    manualPauseToggle() {},
    isRunning() {
      return false;
    },
    onRomLoad() {},
    isCrashed() {
      return false;
    },
    acknowledgeCrash() {},
  };
}

/** Auto-focus stub that records the order of calls into a shared log. */
function makeAutoFocus(log: string[]): AutoFocus {
  return {
    attach() {},
    detach() {},
    onAgentStart() {
      log.push("autoFocus.onAgentStart");
    },
    onAgentEnd() {
      log.push("autoFocus.onAgentEnd");
    },
    async enterManual() {},
    exitManual() {},
    isInGameMode() {
      return false;
    },
  };
}

const mockCtx = { ui: { notify() {} } } as unknown as ExtensionContext;

test("agent_start dispatches lifecycle before auto-focus", async () => {
  const log: string[] = [];
  const mockPi = makeMockPi();
  createSessionCoordinator(mockPi.pi, { lifecycle: makeLifecycle(log), autoFocus: makeAutoFocus(log) }).attach();

  await mockPi.emit("agent_start", mockCtx);

  assert.deepEqual(log, ["lifecycle.onAgentStart", "autoFocus.onAgentStart"]);
});

test("agent_end dispatches lifecycle before auto-focus (awaiting lifecycle first)", async () => {
  const log: string[] = [];
  const mockPi = makeMockPi();
  createSessionCoordinator(mockPi.pi, { lifecycle: makeLifecycle(log), autoFocus: makeAutoFocus(log) }).attach();

  await mockPi.emit("agent_end", mockCtx);

  assert.deepEqual(log, ["lifecycle.onAgentEnd", "autoFocus.onAgentEnd"]);
});

test("detach disarms: post-detach events are not dispatched", async () => {
  const log: string[] = [];
  const mockPi = makeMockPi();
  const coordinator = createSessionCoordinator(mockPi.pi, {
    lifecycle: makeLifecycle(log),
    autoFocus: makeAutoFocus(log),
  });
  coordinator.attach();
  coordinator.detach();

  await mockPi.emit("agent_start", mockCtx);
  await mockPi.emit("agent_end", mockCtx);

  assert.deepEqual(log, [], "no dispatch after detach");
});

test("a throwing handler is caught and surfaced via ctx.ui.notify, not propagated", async () => {
  const log: string[] = [];
  const notifications: string[] = [];
  const ctx = { ui: { notify: (msg: string) => notifications.push(msg) } } as unknown as ExtensionContext;

  const lifecycle = makeLifecycle(log);
  lifecycle.onAgentStart = () => {
    throw new Error("boom");
  };
  const mockPi = makeMockPi();
  createSessionCoordinator(mockPi.pi, { lifecycle, autoFocus: makeAutoFocus(log) }).attach();

  await assert.doesNotReject(() => mockPi.emit("agent_start", ctx));
  assert.equal(notifications.length, 1, "user was notified of the error");
  assert.match(notifications[0] ?? "", /GBA lifecycle error/);
  assert.ok(!log.includes("autoFocus.onAgentStart"), "dispatch aborted after the throw");
});
