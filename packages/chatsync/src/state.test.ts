import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadState, saveState } from "./state.js";
import { tmpDir } from "./test-helpers.js";

function homeWith(content: unknown): string {
  const home = tmpDir();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), typeof content === "string" ? content : JSON.stringify(content));
  return home;
}

describe("loadState", () => {
  it("is empty when missing or unparsable", () => {
    expect(loadState(tmpDir())).toEqual({ sessions: {} });
    expect(loadState(homeWith("not json"))).toEqual({ sessions: {} });
  });

  it("round-trips sessions and copies", () => {
    const home = tmpDir();
    const state = { sessions: { s1: { a: 1 } }, copies: { s1: { b: { from: "a", orgIds: ["o1", "o2"] } } } };
    saveState(home, state);
    expect(loadState(home)).toEqual(state);
  });

  it("tolerates a missing copies field", () => {
    expect(loadState(homeWith({ sessions: { s1: { a: 1 } } }))).toEqual({ sessions: { s1: { a: 1 } } });
  });

  it("drops copies of the wrong shape but keeps sessions", () => {
    const bad: unknown[] = [
      "x",
      [],
      { s1: "x" },
      { s1: { b: "x" } },
      { s1: { b: { from: 1, orgIds: [] } } },
      { s1: { b: { from: "a", orgIds: "o1" } } },
      { s1: { b: { from: "a", orgIds: [1] } } },
    ];
    for (const copies of bad) {
      expect(loadState(homeWith({ sessions: { s1: { a: 1 } }, copies }))).toEqual({ sessions: { s1: { a: 1 } } });
    }
  });
});

describe("saveState with a malformed copies field on disk", () => {
  it("keeps the old file as state.json.bad before overwriting, once", () => {
    const original = JSON.stringify({ sessions: { s1: { a: 1 } }, copies: { s1: "garbage" } });
    const home = homeWith(original);
    saveState(home, { sessions: { s1: { a: 2 } } });
    expect(readFileSync(join(home, "state.json.bad"), "utf8")).toBe(original);
    expect(loadState(home)).toEqual({ sessions: { s1: { a: 2 } } });

    // A later save never replaces the kept copy.
    writeFileSync(join(home, "state.json"), JSON.stringify({ sessions: {}, copies: [] }));
    saveState(home, { sessions: {} });
    expect(readFileSync(join(home, "state.json.bad"), "utf8")).toBe(original);
  });

  it("makes no .bad file for a valid or absent copies field", () => {
    for (const content of [
      { sessions: {} },
      { sessions: {}, copies: { s1: { b: { from: "a", orgIds: ["o"] } } } },
    ]) {
      const home = homeWith(content);
      saveState(home, { sessions: {} });
      expect(existsSync(join(home, "state.json.bad"))).toBe(false);
    }
    const fresh = tmpDir();
    saveState(fresh, { sessions: {} });
    expect(existsSync(join(fresh, "state.json.bad"))).toBe(false);
  });
});
