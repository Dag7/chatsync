import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyPlan } from "./apply.js";
import { ChatsyncError } from "./errors.js";
import { sessionsDir } from "./paths.js";
import { buildPlan } from "./plan.js";
import { loadState, saveState } from "./state.js";
import { loadStore } from "./store.js";
import { A, B, ORG1, entry, makeAppDir, tmpDir } from "./test-helpers.js";

const failures = vi.hoisted(() => ({ prune: false }));

vi.mock("./backup.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./backup.js")>();
  return {
    ...real,
    pruneBackups: (...args: Parameters<typeof real.pruneBackups>) => {
      if (failures.prune) throw new ChatsyncError("Cannot read backups folder: boom", 1);
      return real.pruneBackups(...args);
    },
  };
});

const ID1 = "local_11111111-1111-4111-8111-111111111111";
const ID2 = "local_22222222-2222-4222-8222-222222222222";
const NOW = new Date(2026, 9, 22, 15, 30, 5);

function setup() {
  const root = tmpDir();
  const appDir = makeAppDir(root, {
    active: A,
    accounts: {
      [A]: { [ORG1]: [entry({ id: ID1, at: 200, title: "new" }), entry({ id: ID2, at: 50, title: "old" })] },
      [B]: { [ORG1]: [entry({ id: ID2, at: 10, title: "stale" })] },
    },
  });
  return { root, appDir, sessions: sessionsDir(appDir), home: join(root, "home") };
}

function plan(appDir: string) {
  return buildPlan({ store: loadStore(appDir), activeAccountId: A, state: { sessions: {} } });
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" });
}

describe("applyPlan", () => {
  it("applies copy and update and records state", () => {
    const { appDir, sessions, home } = setup();
    const result = applyPlan(plan(appDir), { sessionsDir: sessions, home, now: NOW });
    expect(result.written).toBe(2);
    expect(result.backup).toBe("2026-10-22_153005");
    expect(existsSync(join(home, "backups", result.backup as string, B, ORG1, `${ID2}.json`))).toBe(true);

    const store = loadStore(appDir);
    const b = store.accounts.find((a) => a.id === B)?.orgs[0]?.entries ?? [];
    const byId = Object.fromEntries(b.map((e) => [e.data.sessionId, e.data]));
    expect(byId[ID1]).toEqual(entry({ id: ID1, at: 200, title: "new" }));
    expect(byId[ID2]).toEqual(entry({ id: ID2, at: 50, title: "old" }));

    expect(loadState(home)).toEqual({
      sessions: { [ID1]: { [A]: 200, [B]: 200 }, [ID2]: { [A]: 50, [B]: 50 } },
    });
  });

  it("no writes -> no backup", () => {
    const root = tmpDir();
    const appDir = makeAppDir(root, {
      active: A,
      accounts: {
        [A]: { [ORG1]: [entry({ id: ID1, at: 5 })] },
        [B]: { [ORG1]: [entry({ id: ID1, at: 5 })] },
      },
    });
    const home = join(root, "home");
    const result = applyPlan(plan(appDir), { sessionsDir: sessionsDir(appDir), home });
    expect(result).toEqual({ backup: null, written: 0, pruned: [] });
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(loadState(home)).toEqual({ sessions: { [ID1]: { [A]: 5, [B]: 5 } } });
  });

  it("backup failure writes nothing", () => {
    const { appDir, sessions, home } = setup();
    const before = readFileSync(join(sessions, B, ORG1, `${ID2}.json`), "utf8");
    const p = plan(appDir);
    // A file where the backups folder should be makes createBackup fail.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "backups"), "not a folder");
    expect(() => applyPlan(p, { sessionsDir: sessions, home, now: NOW })).toThrow(ChatsyncError);
    expect(readFileSync(join(sessions, B, ORG1, `${ID2}.json`), "utf8")).toBe(before);
    expect(existsSync(join(sessions, B, ORG1, `${ID1}.json`))).toBe(false);
    expect(existsSync(join(home, "state.json"))).toBe(false);
  });

  it("leaves no temp files", () => {
    const { appDir, sessions, home } = setup();
    applyPlan(plan(appDir), { sessionsDir: sessions, home, now: NOW });
    expect(allFiles(sessions).filter((f) => f.includes("chatsync-tmp"))).toEqual([]);
    expect(allFiles(home).filter((f) => f.includes("chatsync-tmp"))).toEqual([]);
  });

  it("truncated entry stops before backup", () => {
    const { appDir, sessions, home } = setup();
    writeFileSync(join(sessions, B, ORG1, `${ID2}.json`), '{"sessionId": "local_');
    let code: number | undefined;
    try {
      applyPlan(plan(appDir), { sessionsDir: sessions, home, now: NOW });
    } catch (err: unknown) {
      code = err instanceof ChatsyncError ? err.exitCode : undefined;
    }
    expect(code).toBe(2);
    expect(existsSync(join(home, "backups"))).toBe(false);
  });

  it("a prune failure after writing is returned as a warning, not thrown", () => {
    const { appDir, sessions, home } = setup();
    failures.prune = true;
    try {
      const result = applyPlan(plan(appDir), { sessionsDir: sessions, home, now: NOW });
      expect(result.written).toBe(2);
      expect(result.pruned).toEqual([]);
      expect(result.warning).toContain("boom");
      expect(loadState(home).sessions[ID1]).toEqual({ [A]: 200, [B]: 200 });
    } finally {
      failures.prune = false;
    }
  });
});

describe("state", () => {
  it("loadState returns empty state when missing or unparsable", () => {
    const home = tmpDir();
    expect(loadState(home)).toEqual({ sessions: {} });
    writeFileSync(join(home, "state.json"), "{nope");
    expect(loadState(home)).toEqual({ sessions: {} });
    writeFileSync(join(home, "state.json"), '{"sessions": 3}');
    expect(loadState(home)).toEqual({ sessions: {} });
  });

  it("saveState creates the home folder and round-trips", () => {
    const home = join(tmpDir(), "nested", "home");
    saveState(home, { sessions: { x: { y: 1 } } });
    expect(loadState(home)).toEqual({ sessions: { x: { y: 1 } } });
    expect(allFiles(home)).toEqual(["state.json"]);
  });
});
