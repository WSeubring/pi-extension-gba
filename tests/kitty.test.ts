import assert from "node:assert/strict";
import { test } from "node:test";
import { setCellDimensions } from "@mariozechner/pi-tui";
import { computeLayout, encodeKittyRawFile, rawFilePath } from "../src/kitty.js";

test("encodeKittyRawFile builds a t=f transmit without an S= param (Ghostty rejects S)", () => {
  const seq = encodeKittyRawFile("L3RtcC9waS1nYmEtNy5yYXc=", {
    widthPx: 480,
    heightPx: 320,
    columns: 80,
    rows: 30,
    imageId: 7,
  });

  assert.ok(seq.startsWith("\x1b_G"), "starts with the Kitty APC graphics intro");
  assert.ok(seq.endsWith("\x1b\\"), "ends with ST");
  assert.ok(seq.includes("a=T") && seq.includes("t=f") && seq.includes("f=32"), "file-transport RGBA transmit");
  assert.ok(seq.includes("i=7") && seq.includes("c=80") && seq.includes("r=30"), "carries id + cell rect");
  assert.ok(!/[,;]S=/.test(seq), "must NOT carry an S= (data size) param");
  assert.ok(seq.includes(";L3RtcC9waS1nYmEtNy5yYXc="), "payload is the base64 path after ';'");
});

test("rawFilePath namespaces by image id under the given dir", () => {
  assert.equal(rawFilePath("/dev/shm", 3), "/dev/shm/pi-gba-3.raw");
});

test("computeLayout: square cells (via getCellDimensions) beat the 0.5 fallback", () => {
  setCellDimensions({ widthPx: 10, heightPx: 10 });
  try {
    // 480×320 image, 80 cols, 10×10 cells → calculateImageRows ≈ 32 rows;
    // the 0.5 fallback would give ceil((320/480)*80*0.5) ≈ 27.
    const layout = computeLayout(80, 50, 480, 320);
    assert.ok(layout.rows >= 30, `expected ≥30 rows from real cell dims, got ${layout.rows}`);
    assert.equal(layout.availableRows, 47, "availableRows = terminalRows - FOOTER_ROWS(3)");
  } finally {
    setCellDimensions({ widthPx: 0, heightPx: 0 });
  }
});

test("computeLayout: when the height cap binds, cols shrink proportionally", () => {
  setCellDimensions({ widthPx: 0, heightPx: 0 }); // force the 0.5 fallback
  // Tiny terminal: 10 rows → availableRows 7 → maxRows floor(7*0.9)=6. A tall
  // image needs more rows than the cap, so cols must shrink to keep aspect.
  const layout = computeLayout(80, 10, 240, 160);
  assert.ok(layout.rows <= 6, `rows capped at maxRows, got ${layout.rows}`);
  assert.ok(layout.cols < 80, `cols shrink when the height cap binds, got ${layout.cols}`);
});
