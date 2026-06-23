/**
 * wasm-shims tests — fake indexedDB stub used by Emscripten IDBFS.
 *
 * The persist direction of FS.syncfs (autoPersist on /autosave, plus the
 * vendored build's EM_ASM `FS.syncfs(function(err){assert(!err)})`) calls
 * put/get/delete on the object store. A store without them guarantees err →
 * wasm runtime abort. These tests pin the stub's success-path contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { installWasmShims } from "../src/wasm-shims.js";

interface FakeRequest {
  onsuccess: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  result: unknown;
}

interface FakeStore {
  put(value: unknown, key?: unknown): FakeRequest;
  get(key: unknown): FakeRequest;
  delete(key: unknown): FakeRequest;
  index(name: string): { openKeyCursor(): FakeRequest };
}

interface FakeTransaction {
  oncomplete: ((e: unknown) => void) | null;
  objectStore(name: string): FakeStore;
}

/** Open the stubbed DB and hand back a readwrite transaction + store. */
async function openStoreViaStub(): Promise<{ txn: FakeTransaction; store: FakeStore }> {
  installWasmShims();
  const idb = (globalThis as Record<string, unknown>).indexedDB as {
    open(name: string): FakeRequest;
  };
  assert.ok(idb, "indexedDB stub must be installed");

  const openReq = idb.open("pi-gba-test");
  const db = await new Promise<Record<string, unknown>>((resolve) => {
    openReq.onsuccess = () => resolve(openReq.result as Record<string, unknown>);
  });

  const txn = (db.transaction as (n: string[], m?: string) => FakeTransaction)(["FILE_DATA"], "readwrite");
  return { txn, store: txn.objectStore("FILE_DATA") };
}

/** Await a fake request's onsuccess, resolving with the event it fires. */
function awaitSuccess(req: FakeRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (e: unknown) => resolve(e);
    req.onerror = (e: unknown) => reject(e);
  });
}

test("object store stub: put/get/delete succeed asynchronously with result undefined", async () => {
  const { store } = await openStoreViaStub();

  // IDBFS.storeRemoteEntry — store.put(entry, path)
  const putReq = store.put({ mode: 0o100644 }, "/autosave/state.ss0");
  await awaitSuccess(putReq);
  assert.strictEqual(putReq.result, undefined, "put result is undefined (no-op store)");

  // IDBFS.loadRemoteEntry — store.get(path); event.target.result drives it
  const getReq = store.get("/autosave/state.ss0");
  const getEvent = (await awaitSuccess(getReq)) as { target: { result: unknown } };
  assert.strictEqual(getEvent.target.result, undefined, "get yields undefined entry");

  // IDBFS.removeRemoteEntry — store.delete(path)
  const delReq = store.delete("/autosave/state.ss0");
  await awaitSuccess(delReq);
  assert.strictEqual(delReq.result, undefined, "delete result is undefined");
});

test("transaction stub: oncomplete fires so IDBFS.reconcile reports success", async () => {
  const { txn, store } = await openStoreViaStub();

  // reconcile attaches oncomplete after queueing its puts.
  store.put({ contents: new Uint8Array(1) }, "/autosave/a");
  const completed = await new Promise<boolean>((resolve) => {
    txn.oncomplete = () => resolve(true);
    // Guard: fail fast instead of hanging the test if oncomplete never fires.
    setTimeout(() => resolve(false), 1000);
  });
  assert.ok(completed, "transaction oncomplete must fire asynchronously");
});
