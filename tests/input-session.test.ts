import assert from "node:assert/strict";
import { test } from "node:test";
import { GbaInputSession } from "../src/input.js";
import type { ButtonSink, GbaButton } from "../src/types.js";

interface SinkCall {
  kind: "press" | "release";
  button: GbaButton;
}

function makeSink(): { sink: ButtonSink; calls: SinkCall[] } {
  const calls: SinkCall[] = [];
  return {
    calls,
    sink: {
      press: (button) => calls.push({ kind: "press", button }),
      release: (button) => calls.push({ kind: "release", button }),
    },
  };
}

test("exit hatches: raw ctrl+c, raw escape, and alt+g press return 'exit'", () => {
  const { sink, calls } = makeSink();
  const session = new GbaInputSession(sink);

  assert.equal(session.handleKey("\x03"), "exit", "raw ctrl+c exits");
  assert.equal(session.handleKey("\x1b"), "exit", "raw escape exits");
  assert.equal(session.handleKey("q"), "exit", "q (press) exits");
  assert.equal(calls.length, 0, "exit keys do not reach the sink");
});

test("press/release routing: z maps to the A button, deduped", () => {
  const { sink, calls } = makeSink();
  const session = new GbaInputSession(sink);

  assert.equal(session.handleKey("z"), "consumed");
  session.handleKey("z"); // already held — swallowed
  assert.deepEqual(calls, [{ kind: "press", button: "a" }]);

  session.handleKey("\x1b[122;1:3u"); // Kitty CSI-u release of 'z'
  assert.deepEqual(calls.at(-1), { kind: "release", button: "a" });
});

test("releaseAll releases every held button", () => {
  const { sink, calls } = makeSink();
  const session = new GbaInputSession(sink);

  session.handleKey("z"); // press A
  session.handleKey("x"); // press B
  calls.length = 0;

  session.releaseAll();
  const released = calls
    .filter((c) => c.kind === "release")
    .map((c) => c.button)
    .sort();
  assert.deepEqual(released, ["a", "b"], "both held buttons released");
});

test("decay timer auto-releases a stuck button after decayMs (terminals miss key-up)", async () => {
  const { sink, calls } = makeSink();
  const session = new GbaInputSession(sink, 100);

  session.handleKey("z"); // press A, arms the 100ms decay timer
  assert.deepEqual(calls, [{ kind: "press", button: "a" }]);

  await new Promise((r) => setTimeout(r, 130));

  assert.deepEqual(calls.at(-1), { kind: "release", button: "a" }, "decay released the button");
});

test("decayMs=0 disables the decay timer (reliable-release callers)", async () => {
  const { sink, calls } = makeSink();
  const session = new GbaInputSession(sink, 0);

  session.handleKey("z");
  await new Promise((r) => setTimeout(r, 130));

  assert.equal(calls.filter((c) => c.kind === "release").length, 0, "no auto-release without decay");
});
