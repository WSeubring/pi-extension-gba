/**
 * Tests for classifyGbaKey — the shared key-classification helper.
 * GbaFocusEditor and createGbaFocusMode have been removed (dead code).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyGbaKey } from "../src/input.js";

test("classifyGbaKey: mapped key 'z' → press('a')", () => {
  const ev = classifyGbaKey("z");
  assert.deepEqual(ev, { kind: "press", button: "a" });
});

test("classifyGbaKey: mapped key 'x' → press('b')", () => {
  const ev = classifyGbaKey("x");
  assert.deepEqual(ev, { kind: "press", button: "b" });
});

test("classifyGbaKey: mapped key 'a' → press('l')", () => {
  const ev = classifyGbaKey("a");
  assert.deepEqual(ev, { kind: "press", button: "l" });
});

test("classifyGbaKey: mapped key 's' → press('r')", () => {
  const ev = classifyGbaKey("s");
  assert.deepEqual(ev, { kind: "press", button: "r" });
});

test("classifyGbaKey: printable unmapped key → drop", () => {
  const ev = classifyGbaKey("q");
  assert.deepEqual(ev, { kind: "drop" });
});

test("classifyGbaKey: printable unmapped uppercase → drop", () => {
  const ev = classifyGbaKey("Q");
  assert.deepEqual(ev, { kind: "drop" });
});

test("classifyGbaKey: ctrl+c (\\x03) → passthrough", () => {
  const ev = classifyGbaKey("\x03");
  assert.deepEqual(ev, { kind: "passthrough", data: "\x03" });
});

test("classifyGbaKey: escape sequence → passthrough", () => {
  const ev = classifyGbaKey("\x1b[15~");
  assert.deepEqual(ev, { kind: "passthrough", data: "\x1b[15~" });
});
