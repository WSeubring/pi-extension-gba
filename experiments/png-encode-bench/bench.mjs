// V5 microbenchmark: PNG encode of a 480x320 RGBA buffer.
//
// Target: per-frame encode budget is <33 ms at 30 fps (SPEC §3.3 / §6 V5).
// We compare `fast-png` vs `upng-js` on a synthetic animated gradient that
// roughly mimics a GBA framebuffer after 2x nearest-neighbour scaling.
//
// Usage: node bench.mjs [iterations]

import { encode as fastPngEncode } from "fast-png";
import UPNG from "upng-js";
import { performance } from "node:perf_hooks";

const WIDTH = 480;
const HEIGHT = 320;
const CHANNELS = 4;
const DEFAULT_ITERS = 1000;
const WARMUP = 50;

const iters = Number(process.argv[2] ?? DEFAULT_ITERS);

/**
 * Build a single frame's RGBA buffer. `t` shifts the gradient so the encoder
 * cannot cache / dedupe repeated input — each frame has different bytes, the
 * same situation the GBA framebuffer produces.
 */
function makeFrame(t) {
    const buf = Buffer.allocUnsafe(WIDTH * HEIGHT * CHANNELS);
    let i = 0;
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            buf[i++] = (x + t) & 0xff;           // R: horizontal sweep
            buf[i++] = (y + (t >> 1)) & 0xff;    // G: vertical sweep
            buf[i++] = ((x ^ y) + t) & 0xff;     // B: checker-ish
            buf[i++] = 0xff;                      // A: opaque
        }
    }
    return buf;
}

function percentile(sortedMs, p) {
    if (sortedMs.length === 0) return NaN;
    const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
    return sortedMs[idx];
}

function stats(label, times, sizes) {
    const sorted = [...times].sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const max = sorted[sorted.length - 1];
    const meanSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    console.log(
        `${label.padEnd(12)}  mean=${mean.toFixed(2)}ms  p50=${p50.toFixed(2)}ms  ` +
        `p95=${p95.toFixed(2)}ms  p99=${p99.toFixed(2)}ms  max=${max.toFixed(2)}ms  ` +
        `bytes/frame~=${(meanSize / 1024).toFixed(1)}KB`,
    );
}

function benchFastPng(frames) {
    const times = new Array(frames.length);
    const sizes = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
        const t0 = performance.now();
        const out = fastPngEncode({ width: WIDTH, height: HEIGHT, data: frames[i], depth: 8, channels: 4 });
        const t1 = performance.now();
        times[i] = t1 - t0;
        sizes[i] = out.byteLength;
    }
    return { times, sizes };
}

function benchUpng(frames) {
    const times = new Array(frames.length);
    const sizes = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
        // UPNG.encode takes an array of frame buffers (ArrayBuffer), width, height, cnum (0 = lossless truecolor).
        // We have to pass `.buffer` because upng-js expects ArrayBuffer, not Buffer.
        const ab = frames[i].buffer.slice(frames[i].byteOffset, frames[i].byteOffset + frames[i].byteLength);
        const t0 = performance.now();
        const out = UPNG.encode([ab], WIDTH, HEIGHT, 0);
        const t1 = performance.now();
        times[i] = t1 - t0;
        sizes[i] = out.byteLength;
    }
    return { times, sizes };
}

// Generate `iters + WARMUP` distinct frames up-front so allocation / gradient
// work does not pollute the per-frame timings.
console.log(`Generating ${iters + WARMUP} frames (${WIDTH}x${HEIGHT} RGBA)...`);
const frames = [];
for (let i = 0; i < iters + WARMUP; i++) frames.push(makeFrame(i));

console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`Running ${iters} encodes per library (after ${WARMUP} warmup iterations).\n`);

// Warmup (both libraries) - discard timings, JIT tiers have to settle.
benchFastPng(frames.slice(0, WARMUP));
benchUpng(frames.slice(0, WARMUP));

const payload = frames.slice(WARMUP);

const fp = benchFastPng(payload);
const up = benchUpng(payload);

console.log("--- Results ---");
stats("fast-png", fp.times, fp.sizes);
stats("upng-js", up.times, up.sizes);
console.log("\nBudget at 30 fps: 33.33 ms per frame.");
console.log("Budget at 15 fps: 66.67 ms per frame.");
