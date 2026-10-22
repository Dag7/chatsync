import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBackup, listBackups, pruneBackups, restoreBackup } from "./backup.js";
import { ChatsyncError } from "./errors.js";
import { sessionsDir } from "./paths.js";
import { A, B, ORG1, entry, makeAppDir, tmpDir } from "./test-helpers.js";

function setup() {
  const root = tmpDir();
  const appDir = makeAppDir(root, {
    accounts: { acct1: { [ORG1]: [entry({ id: `local_${A}`, at: 1, title: "one" })] } },
  });
  return { root, sessions: sessionsDir(appDir), backups: join(root, "backups") };
}

function fakeBackup(backups: string, name: string, chats = 0): void {
  const dir = join(backups, name, "acct", "org");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < chats; i++) writeFileSync(join(dir, `local_${i}.json`), "{}");
}

const file = (s: string) => join(s, "acct1", ORG1, `local_${A}.json`);

describe("createBackup", () => {
  it("copies the tree and names by local time", () => {
    const { sessions, backups } = setup();
    const name = createBackup({ sessionsDir: sessions, backupsDir: backups, now: new Date(2026, 9, 22, 15, 30, 5) });
    expect(name).toBe("2026-10-22_153005");
    expect(readFileSync(join(backups, name, "acct1", ORG1, `local_${A}.json`), "utf8")).toBe(
      readFileSync(file(sessions), "utf8"),
    );
    expect(readdirSync(backups)).toEqual([name]);
  });

  it("same-second backups get -2, -3", () => {
    const { sessions, backups } = setup();
    const now = new Date(2026, 9, 22, 15, 30, 5);
    const names = [1, 2, 3].map(() => createBackup({ sessionsDir: sessions, backupsDir: backups, now }));
    expect(names).toEqual(["2026-10-22_153005", "2026-10-22_153005-2", "2026-10-22_153005-3"]);
  });

  it("fails clearly when the sessions folder is missing", () => {
    const { root, backups } = setup();
    expect(() => createBackup({ sessionsDir: join(root, "nope"), backupsDir: backups })).toThrow(ChatsyncError);
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
  });
});

describe("listBackups", () => {
  it("lists newest first with chat counts, ignores .partial", () => {
    const { backups } = setup();
    fakeBackup(backups, "2026-10-22_100000", 1);
    fakeBackup(backups, "2026-10-22_100000-2", 3);
    fakeBackup(backups, "2026-10-22_100000-10", 0);
    fakeBackup(backups, "2026-10-21_235959", 2);
    fakeBackup(backups, "2026-10-23_000000.partial", 5);
    writeFileSync(join(backups, "stray.txt"), "x");
    const list = listBackups(backups);
    expect(list.map((b) => b.name)).toEqual([
      "2026-10-22_100000-10",
      "2026-10-22_100000-2",
      "2026-10-22_100000",
      "2026-10-21_235959",
    ]);
    expect(list.map((b) => b.chatCount)).toEqual([0, 3, 1, 2]);
    expect(list[0]?.path).toBe(join(backups, "2026-10-22_100000-10"));
  });

  it("returns [] when the directory is missing", () => {
    expect(listBackups(join(tmpDir(), "missing"))).toEqual([]);
  });
});

describe("pruneBackups", () => {
  it("keeps 20 newest", () => {
    const { backups } = setup();
    for (let i = 1; i <= 22; i++) fakeBackup(backups, `2026-10-${String(i).padStart(2, "0")}_000000`);
    const removed = pruneBackups(backups);
    expect(removed.sort()).toEqual(["2026-10-01_000000", "2026-10-02_000000"]);
    expect(listBackups(backups)).toHaveLength(20);
    expect(existsSync(join(backups, "2026-10-01_000000"))).toBe(false);
  });

  it("does nothing when under the limit or dir missing", () => {
    const { backups } = setup();
    expect(pruneBackups(join(backups, "missing"))).toEqual([]);
    fakeBackup(backups, "2026-10-01_000000");
    expect(pruneBackups(backups, 5)).toEqual([]);
  });
});

describe("restoreBackup", () => {
  it("refuses while app running", () => {
    const { sessions, backups } = setup();
    const name = createBackup({ sessionsDir: sessions, backupsDir: backups, now: new Date(2026, 0, 1) });
    writeFileSync(file(sessions), "changed");
    expect(() => restoreBackup({ name, sessionsDir: sessions, backupsDir: backups, isAppRunning: () => true })).toThrow(
      "Quit Claude before restoring",
    );
    expect(readFileSync(file(sessions), "utf8")).toBe("changed");
    expect(listBackups(backups)).toHaveLength(1);
  });

  it("rejects unknown names, including path traversal", () => {
    const { sessions, backups } = setup();
    createBackup({ sessionsDir: sessions, backupsDir: backups });
    for (const name of ["nope", "../backups", ".."]) {
      expect(() => restoreBackup({ name, sessionsDir: sessions, backupsDir: backups, isAppRunning: () => false })).toThrow(
        ChatsyncError,
      );
    }
    expect(existsSync(file(sessions))).toBe(true);
  });

  it("replaces sessions and makes a safety backup first", () => {
    const { sessions, backups } = setup();
    const original = readFileSync(file(sessions), "utf8");
    const name = createBackup({ sessionsDir: sessions, backupsDir: backups, now: new Date(2026, 0, 1) });
    writeFileSync(file(sessions), "changed");
    writeFileSync(join(sessions, "acct1", ORG1, `local_${B}.json`), "extra");
    const { safetyBackup } = restoreBackup({
      name,
      sessionsDir: sessions,
      backupsDir: backups,
      isAppRunning: () => false,
      now: new Date(2026, 0, 2),
    });
    expect(readFileSync(file(sessions), "utf8")).toBe(original);
    expect(existsSync(join(sessions, "acct1", ORG1, `local_${B}.json`))).toBe(false);
    expect(existsSync(`${sessions}.chatsync-old`)).toBe(false);
    expect(readFileSync(join(backups, safetyBackup, "acct1", ORG1, `local_${A}.json`), "utf8")).toBe("changed");
    expect(safetyBackup).not.toBe(name);
  });

  it("keeps the old folder when copying the backup in fails", () => {
    const { sessions, backups } = setup();
    const name = createBackup({ sessionsDir: sessions, backupsDir: backups, now: new Date(2026, 0, 1) });
    writeFileSync(file(sessions), "changed");
    const unreadable = join(backups, name, "acct1", ORG1, `local_${A}.json`);
    chmodSync(unreadable, 0o000);
    try {
      expect(() =>
        restoreBackup({ name, sessionsDir: sessions, backupsDir: backups, isAppRunning: () => false }),
      ).toThrow();
    } finally {
      chmodSync(unreadable, 0o644);
    }
    expect(readFileSync(file(sessions), "utf8")).toBe("changed");
    expect(existsSync(`${sessions}.chatsync-old`)).toBe(false);
  });

  it("restores even when the sessions folder is gone", () => {
    const { sessions, backups } = setup();
    const name = createBackup({ sessionsDir: sessions, backupsDir: backups, now: new Date(2026, 0, 1) });
    rmSync(sessions, { recursive: true });
    restoreBackup({ name, sessionsDir: sessions, backupsDir: backups, isAppRunning: () => false });
    expect(existsSync(file(sessions))).toBe(true);
  });
});
