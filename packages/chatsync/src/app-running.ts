import { spawnSync } from "node:child_process";

/**
 * True unless `pgrep` cleanly reports that no Claude process exists (exit status 1).
 * Fails closed: a spawn failure or any other pgrep error counts as running, so a broken
 * check can never green-light writing files the app may be holding.
 */
export function isClaudeRunning(spawn: typeof spawnSync = spawnSync): boolean {
  const r = spawn("pgrep", ["-x", "Claude"]);
  return !(r.error === undefined && r.status === 1);
}
