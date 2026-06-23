// Phase 2 smoke: animated gradient mock emulator → createRenderer → assert design §9(c).
// Run: node --import ../../node_modules/tsx/dist/esm/index.mjs smoke.mjs

import assert from "node:assert/strict";
import { createRenderer } from "../../src/render.ts";

const GBA_W = 240;
const GBA_H = 160;
const FRAME_BYTES = GBA_W * GBA_H * 4;

let frameIdx = 0;
const framebuf = new Uint8Array(FRAME_BYTES);

const mockEmulator = {
  step(_n) {},
  getFramebuffer() {
    const t = frameIdx++ & 0xff;
    for (let i = 0; i < FRAME_BYTES; i += 4) {
      framebuf[i] = (t + i) & 0xff;
      framebuf[i + 1] = (t * 2 + i) & 0xff;
      framebuf[i + 2] = (t * 3 + i) & 0xff;
      framebuf[i + 3] = 255;
    }
    return framebuf.slice();
  },
};

const setWidgetCalls = [];
let errorFired = false;

const mockCtx = {
  ui: {
    setWidget(key, content, options) {
      setWidgetCalls.push({ key, content, options });
    },
  },
};

const renderer = createRenderer(mockCtx, mockEmulator, { frameRate: 30, scale: 2 });

renderer.onRenderError((_err) => {
  errorFired = true;
});

renderer.start();

await new Promise((resolve) => setTimeout(resolve, 3100));

renderer.destroy();

const imageId = renderer.__testGetImageId();

const renderCalls = setWidgetCalls.filter(
  (c) => c.key === "gba" && c.content !== undefined,
);
const unmountCalls = setWidgetCalls.filter(
  (c) => c.key === "gba" && c.content === undefined,
);

assert.ok(!errorFired, "onRenderError must not fire");
assert.ok(
  renderCalls.length >= 85,
  `expected >= 85 setWidget render calls, got ${renderCalls.length}`,
);
assert.strictEqual(
  unmountCalls.length,
  1,
  `expected exactly 1 unmount call, got ${unmountCalls.length}`,
);
assert.strictEqual(
  imageId,
  undefined,
  "imageId should be undefined after destroy()",
);

const observedIds = new Set();
for (const call of renderCalls) {
  if (typeof call.content === "function") {
    const fakeTheme = { fallbackColor: (s) => s };
    const widget = call.content({ requestRender() {} }, fakeTheme);
    const id = widget.getImageId?.();
    if (id !== undefined) observedIds.add(id);
  }
}
assert.strictEqual(
  observedIds.size,
  1,
  `expected exactly 1 imageId across all frames, got ${observedIds.size} (ids: ${[...observedIds].join(", ")})`,
);

console.log(
  `[smoke] PASS: ${renderCalls.length} render calls, 1 unmount, 1 imageId (${[...observedIds][0]}), no errors`,
);
process.exit(0);
