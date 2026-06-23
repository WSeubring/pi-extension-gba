import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutoFocus } from "./auto-focus.js";
import type { Lifecycle } from "./lifecycle.js";

export interface SessionCoordinator {
  /** Subscribe to the shared agent_start / agent_end events. */
  attach(): void;
  /** Stop dispatching events (pi.on has no unsubscribe; we self-disarm). */
  detach(): void;
}

export interface SessionCoordinatorDeps {
  lifecycle: Lifecycle;
  autoFocus: AutoFocus;
  logger?: (msg: string) => void;
}

/**
 * Owns the single agent_start / agent_end subscriptions and dispatches them to
 * lifecycle and auto-focus in a fixed order. Previously both modules subscribed
 * independently, so their relative ordering depended on registration timing and
 * each had to re-implement the same "self-disarm after detach" guard. Centralising
 * the subscription makes the per-event policy readable in one place and the
 * ordering explicit: lifecycle first (it owns the tick loop), then auto-focus
 * (it decides whether to mount full-screen game mode on top of a running tick).
 */
export function createSessionCoordinator(pi: ExtensionAPI, deps: SessionCoordinatorDeps): SessionCoordinator {
  const { lifecycle, autoFocus } = deps;
  const log = (msg: string) => deps.logger?.(msg);
  let attached = false;

  return {
    attach() {
      if (attached) return;
      attached = true;

      pi.on("agent_start", async (_event, ctx) => {
        if (!attached) return;
        try {
          lifecycle.onAgentStart();
          autoFocus.onAgentStart(ctx);
        } catch (err) {
          ctx.ui.notify(`GBA lifecycle error: ${String((err as Error).message ?? err)}`, "error");
          log(`[pi-extension-gba] agent_start dispatch threw: ${String(err)}`);
        }
      });

      pi.on("agent_end", async (_event, ctx) => {
        if (!attached) return;
        try {
          await lifecycle.onAgentEnd();
          autoFocus.onAgentEnd();
        } catch (err) {
          ctx.ui.notify(`GBA lifecycle error: ${String((err as Error).message ?? err)}`, "error");
          log(`[pi-extension-gba] agent_end dispatch threw: ${String(err)}`);
        }
      });
    },

    detach() {
      attached = false;
    },
  };
}
