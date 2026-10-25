import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBackup } from "./backup.js";
import { ACCOUNT_BOUND_FIELDS } from "./entry-fields.js";
import type { Prompter } from "./prompter.js";
import { type ProgramDeps, runCli } from "./program.js";
import { applyRepair, type RepairTarget } from "./repair.js";
import { saveState } from "./state.js";
import type { EntryData } from "./store.js";
import { A, B, ORG1, entry, makeAppDir, tmpDir } from "./test-helpers.js";

const ID1 = "local_11111111-1111-4111-8111-111111111111"; // original in A, copied to B
const ID2 = "local_22222222-2222-4222-8222-222222222222"; // original in B, copied to A
const ID3 = "local_33333333-3333-4333-8333-333333333333"; // brand-new chat in B, never in the snapshot

const BOUND = {
  sshReattach: { sshHost: "h", pid: 1 },
  sshRemoteProcessId: 4242,
  error: "quota exhausted",
  errorAt: 1700,
  errorRows: [{ r: 1 }],
  priorErrorMark: 12,
};
const bound = (id: string, at: number, title: string): EntryData => ({
  ...entry({ id, at, title }),
  ...BOUND,
  cwd: "/work",
  nested: { keep: [1, 2, 3] },
});

type Fx = { root: string; appDir: string; home: string; sessions: string };

const OLD = new Date(2026, 8, 1, 10, 0, 0);

/**
 * Current state: A holds ID1 (original) and ID2 (a copy from B); B holds ID2 (original), ID1 (a copy
 * from A) and ID3 (a new chat). All carry the account-bound fields. With `snapshot`, a backup taken
 * before any copy exists is placed in the backups folder.
 */
function fixture(o: { snapshot: boolean; corrupt?: boolean } = { snapshot: true }): Fx {
  const root = tmpDir();
  const appDir = makeAppDir(root, {
    active: A,
    accounts: {
      [A]: { [ORG1]: [bound(ID1, 100, "Alpha"), bound(ID2, 90, "Beta")] },
      [B]: { [ORG1]: [bound(ID2, 90, "Beta"), bound(ID1, 100, "Alpha"), bound(ID3, 50, "Gamma")] },
    },
  });
  const home = join(root, "home");
  if (o.snapshot) {
    const beforeRoot = tmpDir();
    const before = makeAppDir(beforeRoot, {
      accounts: { [A]: { [ORG1]: [bound(ID1, 100, "Alpha")] }, [B]: { [ORG1]: [bound(ID2, 90, "Beta")] } },
    });
    createBackup({ sessionsDir: join(before, "claude-code-sessions"), backupsDir: join(home, "backups"), now: OLD });
    if (o.corrupt) writeFileSync(join(home, "backups", "2026-09-01_100000", A, ORG1, `${ID1}.json`), "{nope");
  }
  return { root, appDir, home, sessions: join(appDir, "claude-code-sessions") };
}

function prompter(confirm: boolean[] = []): Prompter & { calls: string[] } {
  const calls: string[] = [];
  const answers = [...confirm];
  return {
    calls,
    async select<T extends string>(): Promise<T> {
      throw new Error("unexpected select");
    },
    async confirm(m: string): Promise<boolean> {
      calls.push(m);
      const v = answers.shift();
      if (v === undefined) throw new Error("unexpected confirm");
      return v;
    },
    async input(): Promise<string> {
      throw new Error("unexpected input");
    },
  };
}

async function run(fx: Fx, argv: string[], over: Partial<ProgramDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    out: (t) => out.push(t),
    errOut: (t) => err.push(t),
    env: { CHATSYNC_APP_DIR: fx.appDir, CHATSYNC_HOME: fx.home },
    platform: "darwin",
    isTTY: false,
    isAppRunning: () => false,
    now: () => new Date(2026, 9, 25, 12, 0, 0),
    ...over,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const file = (fx: Fx, account: string, id: string): string => join(fx.sessions, account, ORG1, `${id}.json`);
const read = (fx: Fx, account: string, id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file(fx, account, id), "utf8")) as Record<string, unknown>;
const snapshotOf = (fx: Fx): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const rel of readdirSync(fx.sessions, { recursive: true, encoding: "utf8" })) {
    if (rel.endsWith(".json")) out[rel] = readFileSync(join(fx.sessions, rel), "utf8");
  }
  return out;
};
const stripped = (data: EntryData): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...data };
  for (const f of ACCOUNT_BOUND_FIELDS) delete copy[f];
  return copy;
};

describe("chatsync repair", () => {
  it("--dry-run identifies copies via the oldest backup and writes nothing", async () => {
    const fx = fixture();
    const before = snapshotOf(fx);
    const r = await run(fx, ["repair", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Beta  [aaaaaaaa]  removes: sshReattach, sshRemoteProcessId, error, errorAt, errorRows, priorErrorMark");
    expect(r.out).toContain("Alpha  [bbbbbbbb]  removes: sshReattach");
    expect(r.out).not.toContain("Gamma");
    expect(r.out).toContain("repair 2 entries");
    expect(snapshotOf(fx)).toEqual(before);
    expect(readdirSync(join(fx.home, "backups"))).toEqual(["2026-09-01_100000"]);
  });

  it("--dry-run --json lists targets", async () => {
    const fx = fixture();
    const r = await run(fx, ["repair", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { targets: { sessionId: string; accountId: string; orgId: string; fields: string[] }[] };
    expect(parsed.targets.map((t) => [t.sessionId, t.accountId, t.orgId]).sort()).toEqual(
      [[ID2, A, ORG1], [ID1, B, ORG1]].sort(),
    );
    expect(parsed.targets[0]?.fields).toEqual([...ACCOUNT_BOUND_FIELDS]);
  });

  it("identifies copies via state records, even without any backup", async () => {
    const fx = fixture({ snapshot: false });
    saveState(fx.home, { sessions: {}, copies: { [ID1]: { [B]: { from: A, orgIds: [ORG1] } } } });
    const r = await run(fx, ["repair", "--dry-run", "--json"]);
    const parsed = JSON.parse(r.out) as { targets: { sessionId: string; accountId: string }[] };
    expect(parsed.targets).toEqual([expect.objectContaining({ sessionId: ID1, accountId: B })]);
  });

  it("a state record for one org does not make the account's other-org original a copy", async () => {
    const fx = fixture({ snapshot: false });
    const org2 = "22222222-2222-4222-8222-222222222222";
    mkdirSync(join(fx.sessions, B, org2));
    writeFileSync(join(fx.sessions, B, org2, `${ID1}.json`), JSON.stringify(bound(ID1, 100, "Alpha")));
    saveState(fx.home, { sessions: {}, copies: { [ID1]: { [B]: { from: A, orgIds: [org2] } } } });
    const r = await run(fx, ["repair", "--dry-run", "--json"]);
    const parsed = JSON.parse(r.out) as { targets: { sessionId: string; accountId: string; orgId: string }[] };
    expect(parsed.targets).toEqual([expect.objectContaining({ sessionId: ID1, accountId: B, orgId: org2 })]);
  });

  it("with no backups and no state records nothing is a copy", async () => {
    const fx = fixture({ snapshot: false });
    const before = snapshotOf(fx);
    const r = await run(fx, ["repair", "-y"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No record of earlier copies; nothing to repair.");
    expect(snapshotOf(fx)).toEqual(before);
    expect(existsSync(join(fx.home, "backups"))).toBe(false);
  });

  it("-y removes only the six fields from copies, keeps everything else, makes a backup", async () => {
    const fx = fixture();
    const r = await run(fx, ["repair", "-y"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Repaired 2 entries.");
    const backups = readdirSync(join(fx.home, "backups")).sort();
    expect(backups).toHaveLength(2);
    expect(backups).toContain("2026-09-01_100000");
    const made = backups.find((b) => b !== "2026-09-01_100000") as string;
    expect(r.out).toContain(join(fx.home, "backups", made));
    // The new backup holds the entries as they were before the repair.
    expect(JSON.parse(readFileSync(join(fx.home, "backups", made, B, ORG1, `${ID1}.json`), "utf8"))).toEqual(bound(ID1, 100, "Alpha"));

    expect(read(fx, A, ID2)).toEqual(stripped(bound(ID2, 90, "Beta")));
    expect(read(fx, B, ID1)).toEqual(stripped(bound(ID1, 100, "Alpha")));
    // Originals and the brand-new chat are untouched, byte for byte.
    for (const [acct, id, title, at] of [[A, ID1, "Alpha", 100], [B, ID2, "Beta", 90], [B, ID3, "Gamma", 50]] as const) {
      expect(readFileSync(file(fx, acct, id), "utf8")).toBe(JSON.stringify(bound(id, at, title)));
    }
    expect(readdirSync(join(fx.sessions, A, ORG1)).filter((n) => n.includes("chatsync-tmp"))).toEqual([]);
  });

  it("an entry already clean is not a target", async () => {
    const fx = fixture();
    await run(fx, ["repair", "-y"]);
    const r = await run(fx, ["repair", "-y"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing to repair.");
    expect(readdirSync(join(fx.home, "backups"))).toHaveLength(2);
  });

  it("zero targets makes no backup", async () => {
    const fx = fixture();
    writeFileSync(file(fx, A, ID2), JSON.stringify(stripped(bound(ID2, 90, "Beta"))));
    writeFileSync(file(fx, B, ID1), JSON.stringify(stripped(bound(ID1, 100, "Alpha"))));
    const r = await run(fx, ["repair", "-y"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing to repair.");
    expect(readdirSync(join(fx.home, "backups"))).toEqual(["2026-09-01_100000"]);
  });

  it("while Claude runs: exit 1 and nothing written", async () => {
    const fx = fixture();
    const before = snapshotOf(fx);
    const r = await run(fx, ["repair", "-y"], { isAppRunning: () => true });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Quit Claude first (⌘Q): repair edits sidebar entries, which is only safe while Claude is closed.");
    expect(snapshotOf(fx)).toEqual(before);
    expect(readdirSync(join(fx.home, "backups"))).toHaveLength(1);
  });

  it("--dry-run while Claude runs warns but succeeds", async () => {
    const fx = fixture();
    const r = await run(fx, ["repair", "--dry-run"], { isAppRunning: () => true });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Claude is running: quit it before running repair without --dry-run.");
    const j = await run(fx, ["repair", "--dry-run", "--json"], { isAppRunning: () => true });
    expect(j.err).toContain("Claude is running: quit it before running repair without --dry-run.");
    expect(() => JSON.parse(j.out)).not.toThrow();
  });

  it("without a TTY and without -y: exit 1, nothing written", async () => {
    const fx = fixture();
    const before = snapshotOf(fx);
    const r = await run(fx, ["repair"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pass -y to repair");
    expect(snapshotOf(fx)).toEqual(before);
    expect(readdirSync(join(fx.home, "backups"))).toHaveLength(1);
  });

  it("with a TTY asks to proceed; declining writes nothing", async () => {
    const fx = fixture();
    const before = snapshotOf(fx);
    const p = prompter([false]);
    const r = await run(fx, ["repair"], { isTTY: true, prompter: p });
    expect(r.code).toBe(0);
    expect(p.calls).toEqual(["Proceed?"]);
    expect(r.out).toContain("Cancelled");
    expect(snapshotOf(fx)).toEqual(before);
  });

  it("with a TTY, accepting repairs", async () => {
    const fx = fixture();
    const r = await run(fx, ["repair"], { isTTY: true, prompter: prompter([true]) });
    expect(r.code).toBe(0);
    expect(read(fx, A, ID2)).toEqual(stripped(bound(ID2, 90, "Beta")));
  });

  it("re-checks that Claude is closed after the confirm", async () => {
    const fx = fixture();
    const before = snapshotOf(fx);
    let calls = 0;
    const r = await run(fx, ["repair"], { isTTY: true, prompter: prompter([true]), isAppRunning: () => ++calls > 1 });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Quit Claude first");
    expect(snapshotOf(fx)).toEqual(before);
  });

  it("stops without writing when Claude starts between the backup and the writes", async () => {
    const fx = fixture();
    const before = snapshotOf(fx);
    let calls = 0;
    // 1: at the start, 2: just before applying, 3: right before the first write (after the backup).
    const r = await run(fx, ["repair", "-y"], { isAppRunning: () => ++calls > 2 });
    expect(calls).toBe(3);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Quit Claude first");
    expect(snapshotOf(fx)).toEqual(before);
    expect(readdirSync(join(fx.home, "backups"))).toHaveLength(2);
  });

  it("a corrupt oldest backup exits 2 naming the backup", async () => {
    const fx = fixture({ snapshot: true, corrupt: true });
    const before = snapshotOf(fx);
    const r = await run(fx, ["repair", "-y"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("2026-09-01_100000");
    expect(snapshotOf(fx)).toEqual(before);
  });

  it("--json -y includes the result", async () => {
    const fx = fixture();
    const r = await run(fx, ["repair", "-y", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { targets: unknown[]; result: { repaired: number; backup: string } };
    expect(parsed.targets).toHaveLength(2);
    expect(parsed.result.repaired).toBe(2);
    expect(existsSync(parsed.result.backup)).toBe(true);
  });
});

describe("applyRepair path checks", () => {
  const target = (over: Partial<RepairTarget> = {}): RepairTarget => ({
    sessionId: ID2,
    accountId: A,
    orgId: ORG1,
    file: "",
    data: bound(ID2, 90, "Beta"),
    fields: [...ACCOUNT_BOUND_FIELDS],
    ...over,
  });

  it("rejects an escaping or unknown location before any backup or write", () => {
    for (const bad of [
      target({ sessionId: "../../x" }),
      target({ sessionId: "session-1" }),
      target({ accountId: ".." }),
      target({ orgId: "../.." }),
      target({ orgId: "33333333-3333-4333-8333-333333333333" }),
    ]) {
      const fx = fixture();
      const before = snapshotOf(fx);
      expect(() => applyRepair([target(), bad], { sessionsDir: fx.sessions, home: fx.home })).toThrow(
        expect.objectContaining({ name: "ChatsyncError", exitCode: 2 }),
      );
      expect(snapshotOf(fx)).toEqual(before);
      expect(readdirSync(join(fx.home, "backups"))).toEqual(["2026-09-01_100000"]);
    }
  });

  it("refuses an entry that no longer exists", () => {
    const fx = fixture();
    expect(() => applyRepair([target({ sessionId: "local_missing" })], { sessionsDir: fx.sessions, home: fx.home })).toThrow(
      expect.objectContaining({ exitCode: 2 }),
    );
    expect(existsSync(file(fx, A, "local_missing"))).toBe(false);
  });
});
