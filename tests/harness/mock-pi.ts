/**
 * Phase 10a — Mock ExtensionAPI harness.
 *
 * createMockPi() returns a fake ExtensionAPI that records every call the
 * extension makes and exposes helpers for test-side triggering.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Recorded call types
// ---------------------------------------------------------------------------

export interface RecordedEvent {
  event: string;
  handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
}

export interface RecordedShortcut {
  keyId: string;
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}

export interface RecordedCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// ---------------------------------------------------------------------------
// MockPi shape
// ---------------------------------------------------------------------------

export interface MockPi {
  /** The fake ExtensionAPI — pass to activate(pi). */
  pi: ExtensionAPI;

  // --- Recorded calls ---
  events: RecordedEvent[];
  shortcuts: RecordedShortcut[];
  commands: RecordedCommand[];

  // --- Test-side triggers ---
  /** Trigger all handlers for the named event with optional data + ctx. */
  emit(event: string, data?: unknown, ctx?: ExtensionContext): Promise<void>;

  /**
   * Fire the handler registered for keyId with the supplied ctx.
   * Throws if no handler was registered for that key.
   */
  pressShortcut(keyId: string, ctx: ExtensionContext): Promise<void>;

  /**
   * Invoke the registered command handler.
   * Throws if no command with that name was registered.
   */
  invokeCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMockPi(): MockPi {
  const events: RecordedEvent[] = [];
  const shortcuts: RecordedShortcut[] = [];
  const commands: RecordedCommand[] = [];

  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown): void {
      events.push({ event, handler });
    },

    registerShortcut(
      keyId: string,
      opts: { description?: string; handler: (ctx: ExtensionContext) => Promise<void> | void },
    ): void {
      shortcuts.push({ keyId, description: opts.description, handler: opts.handler });
    },

    registerCommand(
      name: string,
      opts: {
        description?: string;
        getArgumentCompletions?: (prefix: string) => unknown;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ): void {
      commands.push({ name, description: opts.description, handler: opts.handler });
    },

    // Stub methods not needed for our scenarios — return safe defaults.
    registerTool() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName() {
      return undefined;
    },
    setLabel() {},
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
    setActiveTools() {},
    getCommands() {
      return [];
    },
    async setModel() {
      return false;
    },
    getThinkingLevel() {
      return "none" as const;
    },
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
    events: {
      on() {
        return () => {};
      },
      off() {},
      emit() {},
    },
  } as unknown as ExtensionAPI;

  const mock: MockPi = {
    pi,
    events,
    shortcuts,
    commands,

    async emit(event, data, ctx): Promise<void> {
      const payload = data ?? { type: event };
      const fallbackCtx = ctx ?? ({} as ExtensionContext);
      const handlers = events.filter((e) => e.event === event);
      for (const { handler } of handlers) {
        await handler(payload, fallbackCtx);
      }
    },

    async pressShortcut(keyId, ctx): Promise<void> {
      const entry = shortcuts.find((s) => s.keyId === keyId);
      if (!entry) throw new Error(`No shortcut registered for key "${keyId}"`);
      await entry.handler(ctx);
    },

    async invokeCommand(name, args, ctx): Promise<void> {
      const entry = commands.find((c) => c.name === name);
      if (!entry) throw new Error(`No command registered for name "${name}"`);
      await entry.handler(args, ctx);
    },
  };

  return mock;
}
