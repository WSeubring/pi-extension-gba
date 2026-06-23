// GBA native framebuffer dimensions (kept local so this stays a pure leaf
// module — importing them from emulator.ts would pull in the mGBA WASM module).
const GBA_W = 240;
const GBA_H = 160;

export interface Upscaler {
  /**
   * Nearest-neighbour upscale a 240×160 RGBA framebuffer to the configured
   * output size. At scale 1 the input is returned in place (alpha forced
   * opaque); at 2×/3× the result is written into a reused scratch buffer, so
   * the returned array is only valid until the next call.
   */
  upscale(rgba: Uint8Array): Uint8Array;
}

/**
 * Builds a nearest-neighbour integer upscaler (1×/2×/3×). Every output pixel's
 * alpha is forced to 0xFF: mGBA writes M_COLOR_WHITE = 0x00FFFFFF (alpha=0) and
 * Kitty would otherwise render those pixels transparent (see ADR 0005).
 */
export function makeUpscaler(scale: 1 | 2 | 3, outW: number, outH: number): Upscaler {
  const scratch = scale > 1 ? new Uint8Array(outW * outH * 4) : new Uint8Array(0);

  function upscale2(rgba: Uint8Array): Uint8Array {
    for (let sy = 0; sy < GBA_H; sy++) {
      const dy0 = sy * 2;
      for (let sx = 0; sx < GBA_W; sx++) {
        const si = (sy * GBA_W + sx) * 4;
        const r = rgba[si];
        const g = rgba[si + 1];
        const b = rgba[si + 2];
        const dx0 = sx * 2;
        const di00 = (dy0 * outW + dx0) * 4;
        const di01 = di00 + 4;
        const di10 = ((dy0 + 1) * outW + dx0) * 4;
        const di11 = di10 + 4;
        scratch[di00] = r;
        scratch[di00 + 1] = g;
        scratch[di00 + 2] = b;
        scratch[di00 + 3] = 0xff;
        scratch[di01] = r;
        scratch[di01 + 1] = g;
        scratch[di01 + 2] = b;
        scratch[di01 + 3] = 0xff;
        scratch[di10] = r;
        scratch[di10 + 1] = g;
        scratch[di10 + 2] = b;
        scratch[di10 + 3] = 0xff;
        scratch[di11] = r;
        scratch[di11 + 1] = g;
        scratch[di11 + 2] = b;
        scratch[di11 + 3] = 0xff;
      }
    }
    return scratch;
  }

  function upscale3(rgba: Uint8Array): Uint8Array {
    for (let sy = 0; sy < GBA_H; sy++) {
      for (let sx = 0; sx < GBA_W; sx++) {
        const si = (sy * GBA_W + sx) * 4;
        const r = rgba[si];
        const g = rgba[si + 1];
        const b = rgba[si + 2];
        for (let dy = 0; dy < 3; dy++) {
          for (let dx = 0; dx < 3; dx++) {
            const di = ((sy * 3 + dy) * outW + (sx * 3 + dx)) * 4;
            scratch[di] = r;
            scratch[di + 1] = g;
            scratch[di + 2] = b;
            scratch[di + 3] = 0xff;
          }
        }
      }
    }
    return scratch;
  }

  return {
    upscale(rgba: Uint8Array): Uint8Array {
      if (scale === 1) {
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0xff;
        return rgba;
      }
      return scale === 2 ? upscale2(rgba) : upscale3(rgba);
    },
  };
}
