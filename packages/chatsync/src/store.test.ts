import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionsDir } from "./paths.js";
import { loadStore, readActiveAccount, readSshNames } from "./store.js";
import { A, B, ORG1, ORG2, entry, makeAppDir, tmpDir } from "./test-helpers.js";

const exit2 = (re: RegExp) =>
  expect.objectContaining({ name: "ChatsyncError", exitCode: 2, message: expect.stringMatching(re) });

describe("loadStore", () => {
  it("reads accounts, orgs, entries", () => {
    const appDir = makeAppDir(tmpDir(), {
      accounts: {
        [A]: { [ORG1]: [entry({ id: "local_1", at: 1, title: "one" }), entry({ id: "local_2", at: 2 })] },
        [B]: { [ORG2]: [entry({ id: "local_3", at: 3, host: "h" })] },
      },
    });
    const store = loadStore(appDir);
    expect(store.accounts.map((a) => a.id).sort()).toEqual([A, B].sort());
    const a = store.accounts.find((x) => x.id === A)!;
    expect(a.orgs).toHaveLength(1);
    expect(a.orgs[0]!.id).toBe(ORG1);
    expect(a.orgs[0]!.dir).toBe(join(sessionsDir(appDir), A, ORG1));
    expect(a.orgs[0]!.entries).toHaveLength(2);
    const e = a.orgs[0]!.entries.find((x) => x.data.sessionId === "local_1")!;
    expect(e.data.title).toBe("one");
    expect(e.accountId).toBe(A);
    expect(e.orgId).toBe(ORG1);
    expect(e.file).toBe(join(a.orgs[0]!.dir, "local_1.json"));
    const total = store.accounts.flatMap((x) => x.orgs).flatMap((o) => o.entries);
    expect(total).toHaveLength(3);
  });

  it("preserves unknown fields", () => {
    const appDir = makeAppDir(tmpDir(), { accounts: { [A]: { [ORG1]: [] } } });
    const file = join(sessionsDir(appDir), A, ORG1, "local_x.json");
    writeFileSync(file, JSON.stringify({ sessionId: "local_x", lastActivityAt: 5, extra: { n: [1, 2] } }));
    const e = loadStore(appDir).accounts[0]!.orgs[0]!.entries[0]!;
    expect(e.data.extra).toEqual({ n: [1, 2] });
  });

  it("ignores .DS_Store and non-entry files", () => {
    const appDir = makeAppDir(tmpDir(), { accounts: { [A]: { [ORG1]: [entry({ id: "local_1", at: 1 })] } } });
    const root = sessionsDir(appDir);
    const org = join(root, A, ORG1);
    writeFileSync(join(root, ".DS_Store"), "x");
    writeFileSync(join(org, ".DS_Store"), "x");
    writeFileSync(join(org, "scheduled-tasks.json"), "not even json");
    writeFileSync(join(org, "archived-sessions.idx"), "x");
    mkdirSync(join(org, "waiting-input"));
    const store = loadStore(appDir);
    expect(store.accounts).toHaveLength(1);
    expect(store.accounts[0]!.orgs[0]!.entries.map((e) => e.data.sessionId)).toEqual(["local_1"]);
  });

  it("returns an empty store when there is no sessions folder", () => {
    expect(loadStore(tmpDir())).toEqual({ accounts: [] });
  });

  it("non-UUID folder -> exit 2", () => {
    const appDir = makeAppDir(tmpDir(), { accounts: { [A]: { [ORG1]: [] } } });
    mkdirSync(join(sessionsDir(appDir), "junk"));
    expect(() => loadStore(appDir)).toThrow(exit2(/junk/));
  });

  it("non-UUID org folder or stray file at account level -> exit 2", () => {
    const appDir = makeAppDir(tmpDir(), { accounts: { [A]: { [ORG1]: [] } } });
    writeFileSync(join(sessionsDir(appDir), A, "stray.json"), "{}");
    expect(() => loadStore(appDir)).toThrow(exit2(/stray\.json/));
  });

  it("stray file at root -> exit 2", () => {
    const appDir = makeAppDir(tmpDir(), { accounts: { [A]: { [ORG1]: [] } } });
    writeFileSync(join(sessionsDir(appDir), "stray.txt"), "x");
    expect(() => loadStore(appDir)).toThrow(exit2(/stray\.txt/));
  });

  it("truncated JSON -> exit 2 naming file", () => {
    const appDir = makeAppDir(tmpDir(), { accounts: { [A]: { [ORG1]: [] } } });
    writeFileSync(join(sessionsDir(appDir), A, ORG1, "local_bad.json"), '{"sessionId":');
    expect(() => loadStore(appDir)).toThrow(exit2(/local_bad\.json/));
  });

  it("missing lastActivityAt -> exit 2", () => {
    const appDir = makeAppDir(tmpDir(), { accounts: { [A]: { [ORG1]: [] } } });
    writeFileSync(join(sessionsDir(appDir), A, ORG1, "local_bad.json"), JSON.stringify({ sessionId: "local_bad" }));
    expect(() => loadStore(appDir)).toThrow(exit2(/local_bad\.json/));
  });

  it("missing sessionId -> exit 2", () => {
    const appDir = makeAppDir(tmpDir(), { accounts: { [A]: { [ORG1]: [] } } });
    writeFileSync(join(sessionsDir(appDir), A, ORG1, "local_bad.json"), JSON.stringify({ lastActivityAt: 1 }));
    expect(() => loadStore(appDir)).toThrow(exit2(/local_bad\.json/));
  });
});

describe("readActiveAccount", () => {
  it("returns lastKnownAccountUuid", () => {
    expect(readActiveAccount(makeAppDir(tmpDir(), { active: A, accounts: {} }))).toBe(A);
  });
  it("null without config.json", () => {
    expect(readActiveAccount(makeAppDir(tmpDir(), { accounts: {} }))).toBeNull();
  });
  it("null when config lacks the key", () => {
    const appDir = makeAppDir(tmpDir(), { accounts: {} });
    writeFileSync(join(appDir, "config.json"), "{}");
    expect(readActiveAccount(appDir)).toBeNull();
  });
});

describe("readSshNames", () => {
  it("maps sshHost to name", () => {
    const appDir = makeAppDir(tmpDir(), { accounts: {}, sshConfigs: [{ name: "ws-x", sshHost: "ws-x-dc" }] });
    expect(readSshNames(appDir)).toEqual({ "ws-x-dc": "ws-x" });
  });
  it("{} when file missing", () => {
    expect(readSshNames(makeAppDir(tmpDir(), { accounts: {} }))).toEqual({});
  });
});
