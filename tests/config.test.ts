import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  loadConfigFile,
  saveConfigFile,
  resetConfigFile,
  getConfigPath,
  normalize,
  popQueuedWarning,
} from "../src/config.js";

// ---- helpers ----------------------------------------------------------------

/**
 * Redirects getConfigPath() by injecting a temp dir.
 * We test using real FS in a temp directory.
 */
async function withTempConfig<T>(
  fn: (configPath: string) => Promise<T>,
): Promise<T> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pi-gba-test-"));
  const configPath = path.join(dir, "gba.json");

  // Monkey-patch HOME so getConfigPath() resolves to our temp dir
  const origHome = process.env["HOME"];
  const origUserProfile = process.env["USERPROFILE"];
  process.env["HOME"] = dir;
  process.env["USERPROFILE"] = dir;

  // We also need to create the nested .config/pi/ directory structure
  // that getConfigPath() expects at ~/.config/pi/gba.json
  const nestedDir = path.join(dir, ".config", "pi");
  await fsPromises.mkdir(nestedDir, { recursive: true });
  const nestedConfigPath = path.join(nestedDir, "gba.json");

  try {
    return await fn(nestedConfigPath);
  } finally {
    process.env["HOME"] = origHome;
    process.env["USERPROFILE"] = origUserProfile;
    await fsPromises.rm(dir, { recursive: true, force: true });
    // Clear any queued warnings left over from the test
    popQueuedWarning();
  }
}

// ---- normalize tests --------------------------------------------------------

test("normalize: clamps scale 0 → 2", () => {
  const result = normalize({ scale: 0 as unknown as 1 });
  assert.equal(result.scale, 2);
});

test("normalize: keeps scale 1", () => {
  const result = normalize({ scale: 1 });
  assert.equal(result.scale, 1);
});

test("normalize: keeps scale 3", () => {
  const result = normalize({ scale: 3 });
  assert.equal(result.scale, 3);
});

test("normalize: clamps frameRate 0 → 1", () => {
  const result = normalize({ frameRate: 0 });
  assert.equal(result.frameRate, 1);
});

test("normalize: clamps frameRate 31 → 30", () => {
  const result = normalize({ frameRate: 31 });
  assert.equal(result.frameRate, 30);
});

test("normalize: keeps frameRate 20", () => {
  const result = normalize({ frameRate: 20 });
  assert.equal(result.frameRate, 20);
});

test("normalize: clamps autoFocusDebounceMs -1 → 0", () => {
  const result = normalize({ autoFocusDebounceMs: -1 });
  assert.equal(result.autoFocusDebounceMs, 0);
});

test("normalize: clamps autoFocusDebounceMs 6000 → 5000", () => {
  const result = normalize({ autoFocusDebounceMs: 6000 });
  assert.equal(result.autoFocusDebounceMs, 5000);
});

test("normalize: expands ~ in romDir", () => {
  const result = normalize({ romDir: "~/.config/pi/roms/gba" });
  assert.ok(!result.romDir.startsWith("~"), "romDir should be expanded");
  assert.ok(result.romDir.includes(".config"), "romDir should contain .config");
});

test("normalize: expands bare ~ to homedir", () => {
  const result = normalize({ romDir: "~" });
  assert.equal(result.romDir, os.homedir(), "bare ~ should expand to homedir");
});

test("normalize: leaves ~user paths untouched", () => {
  const result = normalize({ romDir: "~alice/roms/gba" });
  assert.equal(result.romDir, "~alice/roms/gba", "~user must not be mangled into $HOME/user");
});

test("normalize: always sets version: 1", () => {
  const result = normalize({});
  assert.equal(result.version, 1);
});

// ---- clamp at write ---------------------------------------------------------

test("saveConfigFile: clamps out-of-range scale to 2", async () => {
  await withTempConfig(async (configPath) => {
    await saveConfigFile({
      version: 1,
      romDir: "/roms",
      scale: 7 as unknown as 1 | 2 | 3,
      frameRate: 30,
      autoRunOnAgentStart: true,
      autoHideOnAgentEnd: false,
      autoFocusOnAgentStart: true,
      autoFocusDebounceMs: 500,
      audio: false,
    });

    const raw = await fsPromises.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { scale: number };
    assert.equal(parsed.scale, 2, "scale should be clamped to 2");
  });
});

// ---- round-trip -------------------------------------------------------------

test("round-trip: saveConfigFile + loadConfigFile preserves values", async () => {
  await withTempConfig(async (_configPath) => {
    await saveConfigFile({
      version: 1,
      romDir: "/custom/roms",
      scale: 3,
      frameRate: 20,
      autoRunOnAgentStart: false,
      autoHideOnAgentEnd: true,
      autoFocusOnAgentStart: false,
      autoFocusDebounceMs: 1000,
      audio: true,
    });

    const loaded = await loadConfigFile();
    assert.equal(loaded.scale, 3, "scale round-trips");
    assert.equal(loaded.frameRate, 20, "frameRate round-trips");
    assert.equal(loaded.autoRunOnAgentStart, false, "autoRunOnAgentStart round-trips");
    assert.equal(loaded.audio, true, "audio round-trips");
    assert.equal(loaded.autoFocusDebounceMs, 1000, "autoFocusDebounceMs round-trips");
  });
});

// ---- file missing -----------------------------------------------------------

test("loadConfigFile: missing file → empty object (no throw)", async () => {
  await withTempConfig(async (_configPath) => {
    // Don't write anything — file is missing
    const result = await loadConfigFile();
    assert.deepEqual(result, {}, "missing file should return empty object");
  });
});

// ---- corrupt-file fallback --------------------------------------------------

test("corrupt-file fallback: JSON parse error → empty + .bak created", async () => {
  await withTempConfig(async (configPath) => {
    await fsPromises.writeFile(configPath, "THIS IS NOT JSON", "utf8");

    const result = await loadConfigFile();
    assert.deepEqual(result, {}, "corrupt file should fall through to {}");

    const bakPath = configPath + ".bak";
    const bakExists = await fsPromises.access(bakPath).then(() => true).catch(() => false);
    assert.ok(bakExists, ".bak file should be created");

    const bakContent = await fsPromises.readFile(bakPath, "utf8");
    assert.equal(bakContent, "THIS IS NOT JSON", ".bak should contain the original content");

    const warning = popQueuedWarning();
    assert.ok(warning !== undefined, "a warning should be queued");
    assert.ok(warning!.includes("corrupt"), "warning should mention corrupt");
    assert.ok(warning!.includes("gba.json.bak"), "warning should mention backup file");
  });
});

test("unknown version fallback: version 99 → empty + .bak created", async () => {
  await withTempConfig(async (configPath) => {
    await fsPromises.writeFile(
      configPath,
      JSON.stringify({ version: 99, scale: 2 }),
      "utf8",
    );

    const result = await loadConfigFile();
    assert.deepEqual(result, {}, "unknown version should fall through to {}");

    const bakPath = configPath + ".bak";
    const bakExists = await fsPromises.access(bakPath).then(() => true).catch(() => false);
    assert.ok(bakExists, ".bak file should be created for unknown version");

    const warning = popQueuedWarning();
    assert.ok(warning !== undefined, "warning should be queued for unknown version");
  });
});

// ---- resetConfigFile --------------------------------------------------------

test("resetConfigFile: deletes file, subsequent loadConfigFile returns {}", async () => {
  await withTempConfig(async (_configPath) => {
    await saveConfigFile({
      version: 1,
      romDir: "/roms",
      scale: 1,
      frameRate: 15,
      autoRunOnAgentStart: true,
      autoHideOnAgentEnd: false,
      autoFocusOnAgentStart: true,
      autoFocusDebounceMs: 500,
      audio: false,
    });

    await resetConfigFile();
    const result = await loadConfigFile();
    assert.deepEqual(result, {}, "after reset, loadConfigFile should return {}");
  });
});

test("resetConfigFile: no error when file does not exist (ENOENT)", async () => {
  await withTempConfig(async (_configPath) => {
    // File doesn't exist — should not throw
    await assert.doesNotReject(() => resetConfigFile(), "resetConfigFile should not throw for missing file");
  });
});
