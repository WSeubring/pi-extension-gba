/**
 * Rollback vector for ADR 0001 (docs/decisions/0001-mgba-sdl-headless-gl.md).
 * Post-ADR 0004 (docs/decisions/0004-remove-gl-runtime-dep.md) the `gl` dep
 * and all canvas/WebGL/DOM stubs are removed. The indexedDB stub below is
 * still load-bearing: Emscripten IDBFS (used by FSInit to mount /data and
 * /autosave) calls indexedDB.open() on init. If a future vendor bump relinks
 * SDL, restore the full shim bundle from git history and re-add `gl`.
 */

let installed = false;

export function installWasmShims(): void {
  if (installed) return;
  installed = true;

  // ---- indexedDB stub (used by Emscripten IDBFS) ----
  // IDBFS mounts /data and /autosave via FSInit and calls indexedDB.open().
  // We provide a minimal in-memory stub so IDBFS initialises cleanly (with an
  // empty "remote" store) and proceeds to create the VFS directories it needs.
  if (typeof (globalThis as Record<string, unknown>).indexedDB === "undefined") {
    function makeFakeCursorRequest(): Record<string, unknown> {
      const req: Record<string, unknown> = { onsuccess: null, onerror: null, result: null };
      Promise.resolve().then(() => {
        if (typeof req.onsuccess === "function") {
          (req.onsuccess as (e: unknown) => void)({ target: { result: null } });
        }
      });
      return req;
    }

    function makeFakeIndex(): Record<string, unknown> {
      return {
        openKeyCursor(): Record<string, unknown> {
          return makeFakeCursorRequest();
        },
      };
    }

    function makeFakeSuccessRequest(): Record<string, unknown> {
      const req: Record<string, unknown> = { onsuccess: null, onerror: null, result: undefined };
      Promise.resolve().then(() => {
        if (typeof req.onsuccess === "function") {
          (req.onsuccess as (e: unknown) => void)({ target: { result: undefined } });
        }
      });
      return req;
    }

    function makeFakeObjectStore(): Record<string, unknown> {
      return {
        indexNames: { contains: (_n: string): boolean => false },
        createObjectStore: (_n: string): Record<string, unknown> => makeFakeObjectStore(),
        createIndex: (_n: string, _k: string, _opts?: unknown): Record<string, unknown> => makeFakeIndex(),
        index: (_n: string): Record<string, unknown> => makeFakeIndex(),
        // IDBFS persist direction (autoPersist on /autosave, plus an EM_ASM
        // `FS.syncfs(assert(!err))` in the vendored build) calls put/get/delete
        // on the store. No-op success requests keep that path from erroring —
        // a missing put guarantees err → wasm runtime abort.
        put: (_value: unknown, _key?: unknown): Record<string, unknown> => makeFakeSuccessRequest(),
        get: (_key: unknown): Record<string, unknown> => makeFakeSuccessRequest(),
        delete: (_key: unknown): Record<string, unknown> => makeFakeSuccessRequest(),
      };
    }

    function makeFakeTransaction(store: Record<string, unknown>): Record<string, unknown> {
      const txn: Record<string, unknown> = {
        onerror: null,
        onabort: null,
        oncomplete: null,
        objectStore(_name: string): Record<string, unknown> {
          return store;
        },
      };
      // Fire oncomplete after the per-request microtasks so IDBFS.reconcile
      // (which reports success via transaction.oncomplete) finishes cleanly.
      Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
          if (typeof txn.oncomplete === "function") {
            (txn.oncomplete as (e: unknown) => void)({ target: txn });
          }
        });
      return txn;
    }

    function makeFakeDatabase(): Record<string, unknown> {
      const store = makeFakeObjectStore();
      return {
        objectStoreNames: { contains: (_n: string): boolean => true },
        transaction(_storeNames: unknown, _mode?: string): Record<string, unknown> {
          return makeFakeTransaction(store);
        },
        close(): void {
          /* no-op */
        },
      };
    }

    (globalThis as Record<string, unknown>).indexedDB = {
      open(_name: string, _version?: number): Record<string, unknown> {
        const db = makeFakeDatabase();
        const req: Record<string, unknown> = {
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          result: db,
        };
        Promise.resolve().then(() => {
          if (typeof req.onsuccess === "function") {
            (req.onsuccess as () => void)();
          }
        });
        return req;
      },
    };
  }
}
