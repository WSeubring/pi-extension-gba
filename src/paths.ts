import { homedir } from "node:os";
import path from "node:path";

/**
 * Expands a leading `~` (exactly) or a `~/` prefix to $HOME. A `~user/...` form
 * names another user's home and is left untouched. Relative paths are returned
 * as-is — callers that need an absolute path should `path.resolve()` the result.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}
