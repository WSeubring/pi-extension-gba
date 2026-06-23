import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureGbaExtension, hasGbaExtension, romStem } from "../src/rom.js";

test("romStem strips .gba case-insensitively (the emulator/persistence join key)", () => {
  assert.equal(romStem("Pokemon.gba"), "Pokemon");
  // Regression: a non-lowercase extension must yield the SAME stem on both the
  // emulator-VFS and on-disk sides, or .sav/.state silently fail to round-trip.
  assert.equal(romStem("GAME.GBA"), "GAME");
  assert.equal(romStem("Mixed.GbA"), "Mixed");
});

test("romStem leaves a name without the extension untouched", () => {
  assert.equal(romStem("noext"), "noext");
  // Only a trailing .gba is stripped — an interior occurrence stays.
  assert.equal(romStem("my.gba.backup"), "my.gba.backup");
});

test("hasGbaExtension is case-insensitive", () => {
  assert.equal(hasGbaExtension("a.gba"), true);
  assert.equal(hasGbaExtension("A.GBA"), true);
  assert.equal(hasGbaExtension("a.GbA"), true);
  assert.equal(hasGbaExtension("a.sav"), false);
  assert.equal(hasGbaExtension("gba"), false);
});

test("ensureGbaExtension appends only when absent, respecting case", () => {
  assert.equal(ensureGbaExtension("Pokemon"), "Pokemon.gba");
  assert.equal(ensureGbaExtension("Pokemon.gba"), "Pokemon.gba");
  // Already has the extension (uppercase) — must NOT double-append to GAME.GBA.gba.
  assert.equal(ensureGbaExtension("GAME.GBA"), "GAME.GBA");
});
