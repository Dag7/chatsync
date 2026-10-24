import type { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isClaudeRunning } from "./app-running.js";

type Spawn = typeof spawnSync;
const fake = (r: { status: number | null; error?: Error }): Spawn => (() => r) as unknown as Spawn;

describe("isClaudeRunning", () => {
  it("is running when pgrep finds a process (status 0)", () => {
    expect(isClaudeRunning(fake({ status: 0 }))).toBe(true);
  });

  it("is not running only when pgrep cleanly reports no match (status 1)", () => {
    expect(isClaudeRunning(fake({ status: 1 }))).toBe(false);
  });

  it("fails closed when pgrep cannot be spawned", () => {
    expect(isClaudeRunning(fake({ status: null, error: new Error("ENOENT") }))).toBe(true);
    expect(isClaudeRunning(fake({ status: null }))).toBe(true);
  });

  it("fails closed on a pgrep error (status 2 or 3)", () => {
    expect(isClaudeRunning(fake({ status: 2 }))).toBe(true);
    expect(isClaudeRunning(fake({ status: 3 }))).toBe(true);
  });

  it("fails closed when status 1 comes with an error", () => {
    expect(isClaudeRunning(fake({ status: 1, error: new Error("boom") }))).toBe(true);
  });
});
