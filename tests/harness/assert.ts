/**
 * Narrows a captured/optional value to non-null, throwing a clear error if it
 * is absent. Use in tests where a callback or handler is captured lazily into a
 * `let x: T | undefined` and the test guarantees it has been assigned before
 * use — `defined(x)` documents that invariant and fails loudly instead of with
 * a bare TypeError if the guarantee is ever broken.
 */
export function defined<T>(value: T | null | undefined, label = "value"): NonNullable<T> {
  if (value == null) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}
