import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyPlan } from "./apply.js";
import { ChatsyncError } from "./errors.js";
import { sessionsDir } from "./paths.js";
import { type Plan, type Write, buildPlan } from "./plan.js";
import { loadState, saveState } from "./state.js";
import { loadStore } from "./store.js";
import { A, B, C, ORG1, ORG2, entry, makeAppDir, tmpDir } from "./test-helpers.js";

const failures = vi.hoisted(() => ({ prune: false, saveState: false, afterBackup: null as (() => void) | null }));

vi.mock("./backup.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./backup.js")>();
  return {
    ...real,
    createBackup: (...args: Parameters<typeof real.createBackup>) => {
      const name = real.createBackup(...args);
      failures.afterBackup?.();
      return name;
    },
    pruneBackups: (...args: Parameters<typeof real.pruneBackups>) => {
      if (failures.prune) throw new ChatsyncError("Cannot read backups folder: boom", 1);
      return real.pruneBackups(...args);
    },
  };
});

vi.mock("./state.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./state.js")>();
  return {
    ...real,
    saveState: (...args: Parameters<typeof real.saveState>) => {
      if (failures.saveState) throw new ChatsyncError("Cannot save sync state to x: boom", 1);
      return real.saveState(...args);
    },
  };
});

const ID1 = "local_11111111-1111-4111-8111-111111111111";
const ID2 = "local_22222222-2222-4222-8222-222222222222";
const ID3 = "local_33333333-3333-4333-8333-333333333333";
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
    const result = applyPlan(plan(appDir), { sessionsDir: sessions, activeAccountId: A, home, now: NOW });
    expect(result.written).toBe(2);
    expect(result.backup).toBe("2026-10-22_153005");
    expect(existsSync(join(home, "backups", result.backup as string, B, ORG1, `${ID2}.json`))).toBe(true);

    const store = loadStore(appDir);
    const b = store.accounts.find((a) => a.id === B)?.orgs[0]?.entries ?? [];
    const byId = Object.fromEntries(b.map((e) => [e.data.sessionId, e.data]));
    expect(byId[ID1]).toEqual(entry({ id: ID1, at: 200, title: "new" }));
    expect(byId[ID2]).toEqual(entry({ id: ID2, at: 50, title: "old" }));

    // A is the active account and was never written, so its older copy keeps its own value.
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
    const result = applyPlan(plan(appDir), { sessionsDir: sessionsDir(appDir), activeAccountId: A, home });
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
    expect(() => applyPlan(p, { sessionsDir: sessions, activeAccountId: A, home, now: NOW })).toThrow(ChatsyncError);
    expect(readFileSync(join(sessions, B, ORG1, `${ID2}.json`), "utf8")).toBe(before);
    expect(existsSync(join(sessions, B, ORG1, `${ID1}.json`))).toBe(false);
    expect(existsSync(join(home, "state.json"))).toBe(false);
  });

  it("leaves no temp files", () => {
    const { appDir, sessions, home } = setup();
    applyPlan(plan(appDir), { sessionsDir: sessions, activeAccountId: A, home, now: NOW });
    expect(allFiles(sessions).filter((f) => f.includes("chatsync-tmp"))).toEqual([]);
    expect(allFiles(home).filter((f) => f.includes("chatsync-tmp"))).toEqual([]);
  });

  it("truncated entry stops before backup", () => {
    const { appDir, sessions, home } = setup();
    writeFileSync(join(sessions, B, ORG1, `${ID2}.json`), '{"sessionId": "local_');
    let code: number | undefined;
    try {
      applyPlan(plan(appDir), { sessionsDir: sessions, activeAccountId: A, home, now: NOW });
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
      const result = applyPlan(plan(appDir), { sessionsDir: sessions, activeAccountId: A, home, now: NOW });
      expect(result.written).toBe(2);
      expect(result.pruned).toEqual([]);
      expect(result.warning).toContain("boom");
      expect(loadState(home).sessions[ID1]).toEqual({ [A]: 200, [B]: 200 });
    } finally {
      failures.prune = false;
    }
  });
});

describe("applyPlan safety", () => {
  const firstWrite = (p: Plan): Write => {
    const w = p.writes[0];
    if (!w) throw new Error("expected a write");
    return w;
  };

  it("rejects a path-escaping sessionId before any backup or write", () => {
    const { appDir, sessions, home } = setup();
    const p = plan(appDir);
    const good = firstWrite(p);
    const evil: Write = { ...good, sessionId: "../../../x" };
    const bad = { ...p, writes: [good, evil] };
    const before = allFiles(dirname(sessions));
    expect(() => applyPlan(bad, { sessionsDir: sessions, activeAccountId: A, home, now: NOW })).toThrow(
      expect.objectContaining({ name: "ChatsyncError", exitCode: 2 }),
    );
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(allFiles(dirname(sessions))).toEqual(before);
  });

  it("rejects a sessionId that is not local_*", () => {
    const { appDir, sessions, home } = setup();
    const p = plan(appDir);
    const bad = { ...p, writes: [{ ...firstWrite(p), sessionId: "session-1" }] };
    expect(() => applyPlan(bad, { sessionsDir: sessions, activeAccountId: A, home })).toThrow(expect.objectContaining({ exitCode: 2 }));
    expect(existsSync(join(home, "backups"))).toBe(false);
  });

  it("rejects an account or org that escapes the sessions folder, or whose folder is missing", () => {
    const { appDir, sessions, home } = setup();
    const p = plan(appDir);
    const w = firstWrite(p);
    for (const variant of [
      { ...w, accountId: ".." },
      { ...w, orgId: "../.." },
      { ...w, orgId: ORG2 },
    ]) {
      expect(() => applyPlan({ ...p, writes: [variant] }, { sessionsDir: sessions, activeAccountId: A, home })).toThrow(
        expect.objectContaining({ exitCode: 2 }),
      );
    }
    expect(existsSync(join(home, "backups"))).toBe(false);
  });

  it("stops mid-write with a clear error naming the file, count and backup; state is not saved", () => {
    const root = tmpDir();
    const appDir = makeAppDir(root, {
      active: A,
      accounts: {
        [A]: { [ORG1]: [entry({ id: ID1, at: 200 })] },
        [B]: { [ORG1]: [entry({ id: ID2, at: 1 })], [ORG2]: [entry({ id: ID3, at: 1 })] },
      },
    });
    const sessions = sessionsDir(appDir);
    const home = join(root, "home");
    const p = plan(appDir);
    // A directory where the second target file should go makes that one write fail.
    mkdirSync(join(sessions, B, ORG2, `${ID1}.json`));
    let error: unknown;
    try {
      applyPlan(p, { sessionsDir: sessions, activeAccountId: A, home, now: NOW });
    } catch (err: unknown) {
      error = err;
    }
    expect(error).toBeInstanceOf(ChatsyncError);
    const message = (error as ChatsyncError).message;
    expect(message).toContain(join(sessions, B, ORG2, `${ID1}.json`));
    expect(message).toMatch(/after 1 of \d+ entries/);
    expect(message).toContain(join(home, "backups", "2026-10-22_153005"));
    expect(existsSync(join(home, "state.json"))).toBe(false);
    expect(allFiles(sessions).filter((f) => f.includes("chatsync-tmp"))).toEqual([]);
  });
});

describe("applyPlan active account guard", () => {
  it("refuses a write to the signed-in account before backup or any write", () => {
    const { appDir, sessions, home } = setup();
    const p = plan(appDir);
    const good = p.writes[0];
    if (!good) throw new Error("expected a write");
    const intoActive: Write = { ...good, accountId: A };
    const before = allFiles(dirname(sessions));
    expect(() =>
      applyPlan({ ...p, writes: [good, intoActive] }, { sessionsDir: sessions, home, activeAccountId: A, now: NOW }),
    ).toThrow(expect.objectContaining({ name: "ChatsyncError", exitCode: 2 }));
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(existsSync(join(home, "state.json"))).toBe(false);
    expect(allFiles(dirname(sessions))).toEqual(before);
  });

  it("refuses when the signed-in account is one the plan was going to write", () => {
    const { appDir, sessions, home } = setup();
    // The plan targets B; if B has since become the signed-in account, nothing may be written.
    expect(() => applyPlan(plan(appDir), { sessionsDir: sessions, home, activeAccountId: B, now: NOW })).toThrow(
      expect.objectContaining({ exitCode: 2 }),
    );
    expect(existsSync(join(home, "backups"))).toBe(false);
  });
});

describe("applyPlan allowActiveCopies", () => {
  /** A is signed in and lacks ID3, which B holds; A holds an older ID2 than B's. */
  function activeSetup() {
    const root = tmpDir();
    const appDir = makeAppDir(root, {
      active: A,
      accounts: {
        [A]: { [ORG1]: [entry({ id: ID2, at: 10, title: "old" })] },
        [B]: { [ORG1]: [entry({ id: ID2, at: 50, title: "new" }), entry({ id: ID3, at: 70, title: "only B" })] },
      },
    });
    const p = buildPlan({ store: loadStore(appDir), activeAccountId: A, state: { sessions: {} }, includeActive: true });
    return { appDir, p, sessions: sessionsDir(appDir), home: join(root, "home") };
  }

  it("permits a new-file copy into the signed-in account", () => {
    const { p, sessions, home } = activeSetup();
    expect(p.writes.filter((w) => w.accountId === A).map((w) => [w.sessionId, w.kind])).toEqual([[ID3, "copy"]]);
    const result = applyPlan(p, { sessionsDir: sessions, activeAccountId: A, home, now: NOW, allowActiveCopies: true });
    expect(result.written).toBe(p.writes.length);
    expect(result.backup).toBe("2026-10-22_153005");
    expect(JSON.parse(readFileSync(join(sessions, A, ORG1, `${ID3}.json`), "utf8"))).toEqual(
      entry({ id: ID3, at: 70, title: "only B" }),
    );
    // The older copy A already had is untouched.
    expect(JSON.parse(readFileSync(join(sessions, A, ORG1, `${ID2}.json`), "utf8"))).toEqual(
      entry({ id: ID2, at: 10, title: "old" }),
    );
    expect(loadState(home).sessions[ID3]).toEqual({ [A]: 70, [B]: 70 });
  });

  it("rejects an update to the signed-in account before the backup", () => {
    const { p, sessions, home } = activeSetup();
    const copy = p.writes.find((w) => w.accountId === A);
    if (!copy) throw new Error("expected a write into A");
    const update: Write = { ...copy, sessionId: ID2, kind: "update", data: entry({ id: ID2, at: 50, title: "new" }) };
    const before = allFiles(dirname(sessions));
    expect(() =>
      applyPlan({ ...p, writes: [...p.writes, update] }, { sessionsDir: sessions, activeAccountId: A, home, now: NOW, allowActiveCopies: true }),
    ).toThrow(expect.objectContaining({ name: "ChatsyncError", exitCode: 2 }));
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(existsSync(join(home, "state.json"))).toBe(false);
    expect(allFiles(dirname(sessions))).toEqual(before);
  });

  it("rejects a copy whose target file already exists before the backup", () => {
    const { p, sessions, home } = activeSetup();
    const copy = p.writes.find((w) => w.accountId === A);
    if (!copy) throw new Error("expected a write into A");
    const clobber: Write = { ...copy, sessionId: ID2, kind: "copy", data: entry({ id: ID2, at: 50, title: "new" }) };
    const before = allFiles(dirname(sessions));
    const old = readFileSync(join(sessions, A, ORG1, `${ID2}.json`), "utf8");
    expect(() =>
      applyPlan({ ...p, writes: [...p.writes, clobber] }, { sessionsDir: sessions, activeAccountId: A, home, now: NOW, allowActiveCopies: true }),
    ).toThrow(expect.objectContaining({ name: "ChatsyncError", exitCode: 2 }));
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(allFiles(dirname(sessions))).toEqual(before);
    expect(readFileSync(join(sessions, A, ORG1, `${ID2}.json`), "utf8")).toBe(old);
  });

  it("rejects a mixed plan (active copy plus active update) whole, before any backup or write", () => {
    const { p, sessions, home } = activeSetup();
    const copy = p.writes.find((w) => w.accountId === A);
    if (!copy) throw new Error("expected a write into A");
    const update: Write = { ...copy, sessionId: ID2, kind: "update", data: entry({ id: ID2, at: 50, title: "new" }) };
    const before = allFiles(dirname(sessions));
    const old = readFileSync(join(sessions, A, ORG1, `${ID2}.json`), "utf8");
    expect(() =>
      applyPlan({ ...p, writes: [copy, update] }, { sessionsDir: sessions, activeAccountId: A, home, now: NOW, allowActiveCopies: true }),
    ).toThrow(expect.objectContaining({ name: "ChatsyncError", exitCode: 2 }));
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(existsSync(join(home, "state.json"))).toBe(false);
    expect(allFiles(dirname(sessions))).toEqual(before);
    expect(readFileSync(join(sessions, A, ORG1, `${ID2}.json`), "utf8")).toBe(old);
  });

  it("rejects two writes to the same signed-in target file before the backup", () => {
    const { p, sessions, home } = activeSetup();
    const copy = p.writes.find((w) => w.accountId === A);
    if (!copy) throw new Error("expected a write into A");
    const before = allFiles(dirname(sessions));
    expect(() =>
      applyPlan({ ...p, writes: [copy, { ...copy }] }, { sessionsDir: sessions, activeAccountId: A, home, now: NOW, allowActiveCopies: true }),
    ).toThrow(expect.objectContaining({ name: "ChatsyncError", exitCode: 2 }));
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(allFiles(dirname(sessions))).toEqual(before);
  });

  it("re-checks right before each write: a file that appears after the backup is not overwritten", () => {
    const { p, sessions, home } = activeSetup();
    const target = join(sessions, A, ORG1, `${ID3}.json`);
    const appVersion = JSON.stringify(entry({ id: ID3, at: 999, title: "app wrote this" }));
    failures.afterBackup = () => writeFileSync(target, appVersion);
    let error: unknown;
    try {
      applyPlan(p, { sessionsDir: sessions, activeAccountId: A, home, now: NOW, allowActiveCopies: true });
    } catch (err: unknown) {
      error = err;
    } finally {
      failures.afterBackup = null;
    }
    expect(error).toBeInstanceOf(ChatsyncError);
    const message = (error as ChatsyncError).message;
    expect(message).toContain(target);
    expect(message).toMatch(/after \d+ of \d+ entries/);
    expect(message).toContain(join(home, "backups", "2026-10-22_153005"));
    expect(readFileSync(target, "utf8")).toBe(appVersion);
    expect(existsSync(join(home, "state.json"))).toBe(false);
  });

  it("still rejects any write to the signed-in account by default", () => {
    const { p, sessions, home } = activeSetup();
    const before = allFiles(dirname(sessions));
    expect(() => applyPlan(p, { sessionsDir: sessions, activeAccountId: A, home, now: NOW })).toThrow(
      expect.objectContaining({ name: "ChatsyncError", exitCode: 2 }),
    );
    expect(() => applyPlan(p, { sessionsDir: sessions, activeAccountId: A, home, now: NOW, allowActiveCopies: false })).toThrow(
      expect.objectContaining({ exitCode: 2 }),
    );
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(allFiles(dirname(sessions))).toEqual(before);
  });
});

describe("applyPlan state", () => {
  it("records each account's actual post-sync value", () => {
    const root = tmpDir();
    const appDir = makeAppDir(root, {
      active: A,
      accounts: {
        [A]: { [ORG1]: [entry({ id: ID1, at: 50 })] },
        [B]: { [ORG1]: [entry({ id: ID1, at: 200 })] },
        [C]: { [ORG1]: [] },
      },
    });
    const home = join(root, "home");
    applyPlan(plan(appDir), { sessionsDir: sessionsDir(appDir), activeAccountId: A, home, now: NOW });
    expect(loadState(home)).toEqual({ sessions: { [ID1]: { [A]: 50, [B]: 200, [C]: 200 } } });
  });

  it("a saveState failure after writing is returned as a warning, combined with a prune warning", () => {
    const { appDir, sessions, home } = setup();
    failures.saveState = true;
    failures.prune = true;
    try {
      const result = applyPlan(plan(appDir), { sessionsDir: sessions, activeAccountId: A, home, now: NOW });
      expect(result.written).toBe(2);
      expect(result.warning).toContain("save sync state");
      expect(result.warning).toContain("prune");
    } finally {
      failures.saveState = false;
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
