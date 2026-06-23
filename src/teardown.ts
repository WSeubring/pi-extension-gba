import type { AudioPlayer } from "./audio.js";
import type { Emulator } from "./emulator.js";
import type { Persistence } from "./persistence.js";

export interface CoreParts {
  persistence: Persistence;
  emulator: Emulator;
  /** Full-mode renderer (RenderControllerWithSwap is destroyable); omitted in
   * minimal mode when no renderer was built. */
  render?: { destroy(): void };
  /** Audio player — full mode only. */
  audio?: AudioPlayer;
  logger?: (msg: string) => void;
}

const errMsg = (err: unknown): string => String((err as Error)?.message ?? err);

/**
 * One ordered, best-effort teardown shared by the full and minimal activation
 * paths (previously each hand-rolled its own session_shutdown cascade and the
 * two had drifted in ordering and completeness). Snapshot first to bound
 * progress loss, then flush queued writes, then free resources. Each step is
 * isolated so a failure can't strand the ones after it.
 *
 * Callers that own extra teardown (full mode detaches the session coordinator
 * and auto-focus) do that before calling this — at shutdown no further events
 * fire, so the relative order is immaterial.
 */
export async function teardownCore(parts: CoreParts): Promise<void> {
  const log = parts.logger ?? ((m: string) => console.warn(m));

  try {
    await parts.persistence.snapshot();
  } catch (err) {
    log(`[pi-extension-gba] shutdown snapshot failed: ${errMsg(err)}`);
  }
  try {
    await parts.persistence.flushPending();
  } catch (err) {
    log(`[pi-extension-gba] flushPending failed: ${errMsg(err)}`);
  }
  try {
    parts.persistence.destroy();
  } catch (err) {
    log(`[pi-extension-gba] persistence.destroy failed: ${errMsg(err)}`);
  }
  try {
    parts.render?.destroy();
  } catch (err) {
    log(`[pi-extension-gba] render.destroy failed: ${errMsg(err)}`);
  }
  if (parts.audio) {
    try {
      await parts.audio.stop();
    } catch (err) {
      log(`[pi-extension-gba] audio.stop failed: ${errMsg(err)}`);
    }
  }
  try {
    parts.emulator.destroy();
  } catch (err) {
    log(`[pi-extension-gba] emulator.destroy failed: ${errMsg(err)}`);
  }
}
