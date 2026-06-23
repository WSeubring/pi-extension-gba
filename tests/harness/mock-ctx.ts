/**
 * Phase 10a — Mock ExtensionContext harness.
 *
 * createMockCtx() returns a fake ExtensionContext (and ExtensionCommandContext)
 * with inspectable call records and scripted answers for ui.select / ui.input.
 */

import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Recorded UI calls
// ---------------------------------------------------------------------------

export interface NotifyCall {
  message: string;
  type?: "info" | "warning" | "error";
}

export interface SetWidgetCall {
  key: string;
  content: unknown;
  options?: unknown;
}

export interface CustomCall {
  factory: unknown;
  options?: unknown;
  component: (Component & { dispose?(): void }) | undefined;
}

// ---------------------------------------------------------------------------
// Mock TUI
// ---------------------------------------------------------------------------

export interface MockTUIHandle {
  tui: TUI;
  renderCount: number;
  written: string[];
  rows: number;
  cols: number;
}

function createMockTUI(rows = 40, cols = 80): MockTUIHandle {
  let renderCount = 0;
  const written: string[] = [];

  const tui: TUI = {
    requestRender() {
      renderCount++;
    },
    terminal: {
      rows,
      cols,
      write(data: string) {
        written.push(data);
      },
    },
  } as unknown as TUI;

  return {
    tui,
    get renderCount() {
      return renderCount;
    },
    written,
    rows,
    cols,
  };
}

// ---------------------------------------------------------------------------
// MockCtx shape
// ---------------------------------------------------------------------------

export interface MockCtx {
  /** The fake ExtensionContext — pass to handlers. */
  ctx: ExtensionCommandContext;

  // --- Recorded calls ---
  notifyCalls: NotifyCall[];
  setWidgetCalls: SetWidgetCall[];
  setEditorComponentCalls: unknown[];
  customCalls: CustomCall[];

  // --- TUI handle for introspection ---
  tui: MockTUIHandle;

  /**
   * Pre-queue an answer for the next ui.select or ui.input call.
   * Calls are served FIFO. Unmatched calls return undefined (cancelled).
   */
  scriptAnswer(answer: string | undefined): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMockCtx(): MockCtx {
  const notifyCalls: NotifyCall[] = [];
  const setWidgetCalls: SetWidgetCall[] = [];
  const setEditorComponentCalls: unknown[] = [];
  const customCalls: CustomCall[] = [];
  const tuiHandle = createMockTUI();
  const answerQueue: (string | undefined)[] = [];

  // Minimal theme stub needed by showRomPicker → themeAdapter
  const theme = {
    fg(_name: string, text: string) {
      return text;
    },
    bg(_name: string, text: string) {
      return text;
    },
  } as unknown as import("@mariozechner/pi-coding-agent").ExtensionContext["ui"]["theme"];

  // Minimal keybindings stub
  const keybindings = {} as unknown as Parameters<
    Extract<
      Parameters<ExtensionContext["ui"]["custom"]>[0],
      // custom<T>(factory: (tui, theme, keybindings, done) => ...) — third arg
      (...args: unknown[]) => unknown
    >
  >[2];

  const ui: ExtensionContext["ui"] = {
    notify(message: string, type?: "info" | "warning" | "error"): void {
      notifyCalls.push({ message, type });
    },

    async select(_title: string, _options: string[]): Promise<string | undefined> {
      if (answerQueue.length > 0) return answerQueue.shift();
      return undefined;
    },

    async input(_title: string, _placeholder?: string): Promise<string | undefined> {
      if (answerQueue.length > 0) return answerQueue.shift();
      return undefined;
    },

    async confirm(_title: string, _message: string): Promise<boolean> {
      return false;
    },

    /**
     * Invokes factory synchronously with a mock TUI + done callback.
     * Returns a Promise that resolves when done() is called.
     * The created component is captured in customCalls for inspection.
     */
    async custom<T>(
      factory: (
        tui: TUI,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
      options?: unknown,
    ): Promise<T> {
      return new Promise<T>((resolve) => {
        const record: CustomCall = { factory, options, component: undefined };
        customCalls.push(record);

        const done = (result: T): void => {
          // dispose the component if it has a dispose method
          record.component?.dispose?.();
          resolve(result);
        };

        // Call factory — may return a component or a Promise<component>
        const maybePromise = factory(tuiHandle.tui, theme, keybindings, done);
        if (maybePromise && typeof (maybePromise as Promise<Component>).then === "function") {
          void (maybePromise as Promise<Component & { dispose?(): void }>).then((comp) => {
            record.component = comp;
          });
        } else {
          record.component = maybePromise as Component & { dispose?(): void };
        }
      });
    },

    setWidget(key: string, content: unknown, options?: unknown): void {
      setWidgetCalls.push({ key, content, options });
    },

    setEditorComponent(factory: unknown): void {
      setEditorComponentCalls.push(factory);
    },

    onTerminalInput(_handler: unknown): () => void {
      return () => {};
    },

    setStatus() {},
    setWorkingMessage() {},
    setHiddenThinkingLabel() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    async editor() {
      return undefined;
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},

    theme,
  } as unknown as ExtensionContext["ui"];

  const ctx: ExtensionCommandContext = {
    ui,
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: {} as ExtensionCommandContext["sessionManager"],
    modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
    model: undefined,
    isIdle() {
      return true;
    },
    signal: undefined,
    abort() {},
    hasPendingMessages() {
      return false;
    },
    shutdown() {},
    getContextUsage() {
      return undefined;
    },
    compact() {},
    getSystemPrompt() {
      return "";
    },
    // ExtensionCommandContext extras
    async waitForIdle() {},
    async newSession() {
      return { cancelled: false };
    },
    async fork() {
      return { cancelled: false };
    },
    async navigateTree() {
      return { cancelled: false };
    },
    async switchSession() {
      return { cancelled: false };
    },
    async reload() {},
  } as unknown as ExtensionCommandContext;

  const mock: MockCtx = {
    ctx,
    notifyCalls,
    setWidgetCalls,
    setEditorComponentCalls,
    customCalls,
    tui: tuiHandle,
    scriptAnswer(answer) {
      answerQueue.push(answer);
    },
  };

  return mock;
}
