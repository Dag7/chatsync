import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Prompter } from "./prompter.js";
import { type ProgramDeps, runCli } from "./program.js";
import { A, B, ORG1, entry, makeAppDir, tmpDir } from "./test-helpers.js";

const ID1 = "local_11111111-1111-4111-8111-111111111111";
const ID2 = "local_22222222-2222-4222-8222-222222222222";

type Fixture = { root: string; appDir: string; home: string; sessions: string };

/** Active account A has one chat B lacks; B has one chat A lacks (older). */
function fixture(active: string | null = A): Fixture {
  const root = tmpDir();
  const appDir = makeAppDir(root, {
    ...(active !== null ? { active } : {}),
    accounts: {
      [A]: { [ORG1]: [entry({ id: ID1, at: 2000, title: "Alpha chat" })] },
      [B]: { [ORG1]: [entry({ id: ID2, at: 1000, title: "Beta chat" })] },
    },
  });
  return { root, appDir, home: join(root, "chatsync-home"), sessions: join(appDir, "claude-code-sessions") };
}

type FakePrompter = Prompter & { calls: string[] };

function fakePrompter(answers: { select?: string[]; confirm?: boolean[]; input?: string[] } = {}): FakePrompter {
  const select = [...(answers.select ?? [])];
  const confirm = [...(answers.confirm ?? [])];
  const input = [...(answers.input ?? [])];
  const calls: string[] = [];
  return {
    calls,
    async select<T extends string>(message: string): Promise<T> {
      calls.push(`select:${message}`);
      const v = select.shift();
      if (v === undefined) throw new Error("unexpected select");
      return v as T;
    },
    async confirm(message: string): Promise<boolean> {
      calls.push(`confirm:${message}`);
      const v = confirm.shift();
      if (v === undefined) throw new Error("unexpected confirm");
      return v;
    },
    async input(message: string): Promise<string> {
      calls.push(`input:${message}`);
      const v = input.shift();
      if (v === undefined) throw new Error("unexpected input");
      return v;
    },
  };
}

async function run(
  fx: Fixture,
  argv: string[],
  over: Partial<ProgramDeps> = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    out: (t) => out.push(t),
    errOut: (t) => err.push(t),
    env: { CHATSYNC_APP_DIR: fx.appDir, CHATSYNC_HOME: fx.home },
    platform: "darwin",
    isTTY: false,
    isAppRunning: () => false,
    ...over,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const bEntry = (fx: Fixture): string => join(fx.sessions, A, ORG1, `${ID1}.json`).replace(A, B);

describe("chatsync CLI", () => {
  it("status prints machines and writes nothing", async () => {
    const fx = fixture();
    const r = await run(fx, ["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Signed in as: aaaaaaaa");
    expect(r.out).toContain("local");
    expect(r.out).toContain("Alpha chat");
    expect(r.out).toContain("Beta chat");
    expect(existsSync(fx.home)).toBe(false);
    expect(existsSync(bEntry(fx))).toBe(false);
  });

  it("status --json parses and has activeAccount", async () => {
    const fx = fixture();
    const r = await run(fx, ["status", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { activeAccount: string; chats: unknown[] };
    expect(parsed.activeAccount).toBe(A);
    expect(parsed.chats).toHaveLength(2);
  });

  it("sync --dry-run writes nothing, exit 0", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("copy 1");
    expect(existsSync(bEntry(fx))).toBe(false);
    expect(existsSync(fx.home)).toBe(false);
  });

  it("sync --dry-run --json parses and lists writes", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { writes: { sessionId: string; accountId: string; kind: string }[] };
    expect(parsed.writes).toEqual([{ sessionId: ID1, accountId: B, orgId: ORG1, kind: "copy" }]);
    expect(existsSync(bEntry(fx))).toBe(false);
  });

  it("sync without TTY and without -y exits 1 and writes nothing", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pass -y");
    expect(existsSync(bEntry(fx))).toBe(false);
    expect(existsSync(fx.home)).toBe(false);
  });

  it("sync -y copies and prints backup path", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync", "-y"], { now: () => new Date(2026, 9, 22, 15, 30, 5) });
    expect(r.code).toBe(0);
    expect(existsSync(bEntry(fx))).toBe(true);
    const backups = readdirSync(join(fx.home, "backups"));
    expect(backups).toHaveLength(1);
    expect(r.out).toContain(join(fx.home, "backups", backups[0] as string));
    expect(r.out).toContain("1");
  });

  it("sync reports already in sync when nothing to write and the signed-in account is current", async () => {
    const root = tmpDir();
    const appDir = makeAppDir(root, {
      active: A,
      accounts: {
        [A]: { [ORG1]: [entry({ id: ID1, at: 2000, title: "Alpha chat" }), entry({ id: ID2, at: 1000, title: "Beta chat" })] },
        [B]: { [ORG1]: [entry({ id: ID2, at: 500, title: "Beta chat" })] },
      },
    });
    const fx: Fixture = { root, appDir, home: join(root, "chatsync-home"), sessions: join(appDir, "claude-code-sessions") };
    await run(fx, ["sync", "-y"]);
    const r = await run(fx, ["sync", "-y"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Already in sync");
  });

  it("sync with TTY asks to confirm; answering no writes nothing", async () => {
    const fx = fixture();
    const prompter = fakePrompter({ confirm: [false] });
    const r = await run(fx, ["sync"], { isTTY: true, prompter });
    expect(r.code).toBe(0);
    expect(prompter.calls).toEqual(["confirm:Proceed?"]);
    expect(existsSync(bEntry(fx))).toBe(false);
  });

  it("sync with TTY applies when confirmed", async () => {
    const fx = fixture();
    const prompter = fakePrompter({ confirm: [true] });
    const r = await run(fx, ["sync"], { isTTY: true, prompter });
    expect(r.code).toBe(0);
    expect(existsSync(bEntry(fx))).toBe(true);
  });

  it("sync with no active account exits 2", async () => {
    const fx = fixture(null);
    const r = await run(fx, ["sync", "-y"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("active");
    expect(existsSync(bEntry(fx))).toBe(false);
  });

  it("status with a missing sessions folder exits 2 with a clean message", async () => {
    const fx = fixture();
    const r = await run(fx, ["status"], { env: { CHATSYNC_APP_DIR: join(fx.root, "nope"), CHATSYNC_HOME: fx.home } });
    expect(r.code).toBe(2);
    expect(r.err).toContain("sessions folder not found");
    expect(r.err).not.toContain("    at ");
  });

  it("restore while app running exits 1", async () => {
    const fx = fixture();
    const r = await run(fx, ["restore", "2026-01-01_00-00-00"], { isAppRunning: () => true });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Quit Claude before restoring");
  });

  it("restore without a name and without TTY exits 1", async () => {
    const fx = fixture();
    const r = await run(fx, ["restore"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("backup name");
  });

  it("backups lists backups and restore brings one back", async () => {
    const fx = fixture();
    await run(fx, ["sync", "-y"]);
    const [name] = readdirSync(join(fx.home, "backups"));
    const listed = await run(fx, ["backups"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(name as string);

    const r = await run(fx, ["restore", name as string, "-y"]);
    expect(r.code).toBe(0);
    expect(existsSync(bEntry(fx))).toBe(false);
  });

  it("restore <name> without TTY and without -y exits 1 and changes nothing", async () => {
    const fx = fixture();
    await run(fx, ["sync", "-y"]);
    const [name] = readdirSync(join(fx.home, "backups"));
    const before = readdirSync(join(fx.home, "backups"));
    const r = await run(fx, ["restore", name as string]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pass -y to restore");
    expect(existsSync(bEntry(fx))).toBe(true);
    expect(readdirSync(join(fx.home, "backups"))).toEqual(before);
  });

  it("restore <name> -y with a TTY skips the confirm", async () => {
    const fx = fixture();
    await run(fx, ["sync", "-y"]);
    const [name] = readdirSync(join(fx.home, "backups"));
    const prompter = fakePrompter();
    const r = await run(fx, ["restore", name as string, "-y"], { isTTY: true, prompter });
    expect(r.code).toBe(0);
    expect(prompter.calls).toEqual([]);
    expect(existsSync(bEntry(fx))).toBe(false);
  });

  it("restore with TTY and no name selects then confirms", async () => {
    const fx = fixture();
    await run(fx, ["sync", "-y"]);
    const [name] = readdirSync(join(fx.home, "backups"));
    const prompter = fakePrompter({ select: [name as string], confirm: [true] });
    const r = await run(fx, ["restore"], { isTTY: true, prompter });
    expect(r.code).toBe(0);
    expect(prompter.calls).toHaveLength(2);
    expect(existsSync(bEntry(fx))).toBe(false);
  });

  it("sync --json without -y says --json never prompts, even on a TTY", async () => {
    const fx = fixture();
    const prompter = fakePrompter();
    const r = await run(fx, ["sync", "--json"], { isTTY: true, prompter });
    expect(r.code).toBe(1);
    expect(r.err).toContain("--json never prompts: pass -y to apply");
    expect(prompter.calls).toEqual([]);
    expect(existsSync(bEntry(fx))).toBe(false);
  });

  it("sync prints a per-account breakdown before asking to proceed", async () => {
    const fx = fixture();
    const prompter = fakePrompter({ confirm: [false] });
    const r = await run(fx, ["sync"], { isTTY: true, prompter });
    expect(r.out).toContain("copy 1 to bbbbbbbb");
  });

  it("accounts saves a nickname and keeps current on blank", async () => {
    const fx = fixture();
    const prompter = fakePrompter({ input: ["Work", ""] });
    const r = await run(fx, ["accounts"], { isTTY: true, prompter });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Alpha chat");
    const cfg = JSON.parse(readFileSync(join(fx.home, "config.json"), "utf8")) as { accounts: Record<string, string> };
    expect(cfg.accounts).toEqual({ [A]: "Work" });
  });

  it("no command without TTY prints help, exit 0", async () => {
    const fx = fixture();
    const r = await run(fx, []);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: chatsync");
    expect(r.out).toContain("sync");
  });

  it("menu runs Status then Quit", async () => {
    const fx = fixture();
    const prompter = fakePrompter({ select: ["status", "quit"] });
    const r = await run(fx, [], { isTTY: true, prompter });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Signed in as");
    expect(prompter.calls).toHaveLength(2);
  });

  it("menu keeps going after an error", async () => {
    const fx = fixture(null);
    const prompter = fakePrompter({ select: ["status", "quit"] });
    const r = await run(fx, [], { isTTY: true, prompter });
    expect(r.code).toBe(0);
    expect(r.err).toContain("active");
  });

  it("--version prints package version", async () => {
    const fx = fixture();
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const r = await run(fx, ["--version"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(pkg.version);
  });

  it("unknown command exits 1", async () => {
    const fx = fixture();
    const r = await run(fx, ["bogus"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("bogus");
  });
});

/** A is signed in and holds X at 10; B holds X at 20 plus Y that A lacks. Nothing can be written. */
function behindFixture(): Fixture {
  const root = tmpDir();
  const appDir = makeAppDir(root, {
    active: A,
    accounts: {
      [A]: { [ORG1]: [entry({ id: ID1, at: 10, title: "X" })] },
      [B]: { [ORG1]: [entry({ id: ID1, at: 20, title: "X" }), entry({ id: ID2, at: 5, title: "Y" })] },
    },
  });
  return { root, appDir, home: join(root, "chatsync-home"), sessions: join(appDir, "claude-code-sessions") };
}

const BEHIND = "2 chats are missing or older in the signed-in account.";

describe("signed-in account behind", () => {
  it("status says so instead of looking in sync", async () => {
    const fx = behindFixture();
    const r = await run(fx, ["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("copy 0 · update 0 · unchanged 2");
    expect(r.out).toContain(BEHIND);
    expect(r.out).toContain("Switch to an account that has them, run chatsync sync, then switch back.");
  });

  it("sync -y prints the plan and the line, exits 0, never says Already in sync, writes nothing", async () => {
    const fx = behindFixture();
    const r = await run(fx, ["sync", "-y"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(BEHIND);
    expect(r.out).not.toContain("Already in sync");
    expect(existsSync(join(fx.home, "backups"))).toBe(false);
  });

  it("sync --json -y includes activeBehind", async () => {
    const fx = behindFixture();
    const r = await run(fx, ["sync", "-y", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { activeBehind: { sessionId: string; reason: string }[] };
    expect(parsed.activeBehind.map((b) => [b.sessionId, b.reason])).toEqual([
      [ID1, "older"],
      [ID2, "missing"],
    ]);
  });
});

describe("sync while the confirm prompt is open", () => {
  /** A prompter whose confirm runs `during` first, then answers yes. */
  function prompterThatActs(during: () => void): Prompter {
    return {
      async select<T extends string>(): Promise<T> {
        throw new Error("unexpected select");
      },
      async confirm(): Promise<boolean> {
        during();
        return true;
      },
      async input(): Promise<string> {
        throw new Error("unexpected input");
      },
    };
  }

  it("stops with exit 2 and writes nothing when the signed-in account changed", async () => {
    const fx = fixture();
    const prompter = prompterThatActs(() => {
      writeFileSync(join(fx.appDir, "config.json"), JSON.stringify({ lastKnownAccountUuid: B }));
    });
    const r = await run(fx, ["sync"], { isTTY: true, prompter });
    expect(r.code).toBe(2);
    expect(r.err).toContain("The signed-in account changed while waiting; run chatsync sync again");
    expect(existsSync(bEntry(fx))).toBe(false);
    expect(existsSync(join(fx.home, "backups"))).toBe(false);
  });

  it("stops with exit 2 and writes nothing when the write set changed", async () => {
    const fx = fixture();
    const prompter = prompterThatActs(() => {
      // B gains the chat that was about to be copied, so the shown plan is stale.
      writeFileSync(
        join(fx.sessions, B, ORG1, `${ID1}.json`),
        JSON.stringify(entry({ id: ID1, at: 2000, title: "Alpha chat" })),
      );
    });
    const r = await run(fx, ["sync"], { isTTY: true, prompter });
    expect(r.code).toBe(2);
    expect(r.err).toContain("changed while waiting");
    expect(existsSync(join(fx.home, "backups"))).toBe(false);
  });
});

describe("sync --include-active", () => {
  const QUIT =
    "Quit Claude first (⌘Q): --include-active writes to the signed-in account, which is only safe while Claude is closed.";
  const RUNNING = "Claude is running: quit it before running this without --dry-run.";
  const aEntry = (fx: Fixture): string => join(fx.sessions, A, ORG1, `${ID2}.json`);

  it("while Claude is running exits 1 and writes nothing", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync", "--include-active", "-y"], { isAppRunning: () => true });
    expect(r.code).toBe(1);
    expect(r.err).toContain(QUIT);
    expect(existsSync(aEntry(fx))).toBe(false);
    expect(existsSync(bEntry(fx))).toBe(false);
    expect(existsSync(fx.home)).toBe(false);
  });

  it("--dry-run while Claude is running exits 0, warns, and writes nothing", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync", "--include-active", "--dry-run"], { isAppRunning: () => true });
    expect(r.code).toBe(0);
    expect(r.out).toContain("copy 2");
    expect(r.out).toContain(RUNNING);
    expect(existsSync(aEntry(fx))).toBe(false);
    expect(existsSync(bEntry(fx))).toBe(false);
    expect(existsSync(fx.home)).toBe(false);
  });

  it("--dry-run --json while Claude is running keeps stdout valid JSON", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync", "--include-active", "--dry-run", "--json"], { isAppRunning: () => true });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { writes: { accountId: string }[] };
    expect(parsed.writes.map((w) => w.accountId).sort()).toEqual([A, B]);
    expect(r.err).toContain(RUNNING);
  });

  it("--dry-run while Claude is closed does not warn", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync", "--include-active", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(RUNNING);
  });

  it("while Claude is closed copies into the signed-in account and prints the backup path", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync", "--include-active", "-y"], { now: () => new Date(2026, 9, 22, 15, 30, 5) });
    expect(r.code).toBe(0);
    expect(existsSync(aEntry(fx))).toBe(true);
    expect(existsSync(bEntry(fx))).toBe(true);
    const backups = readdirSync(join(fx.home, "backups"));
    expect(backups).toHaveLength(1);
    expect(r.out).toContain(join(fx.home, "backups", backups[0] as string));
    expect(r.out).toContain("Wrote 2 entries");
    // The signed-in account now has every chat, so nothing is reported behind.
    expect(r.out).not.toContain("missing or older");
  });

  it("without the flag the signed-in account is still never written", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync", "-y"]);
    expect(r.code).toBe(0);
    expect(existsSync(aEntry(fx))).toBe(false);
  });

  it("stops with exit 1 and writes nothing when Claude is running again at the second check", async () => {
    const fx = fixture();
    const answers = [false, true];
    const r = await run(fx, ["sync", "--include-active", "-y"], { isAppRunning: () => answers.shift() ?? true });
    expect(r.code).toBe(1);
    expect(r.err).toContain(QUIT);
    expect(existsSync(aEntry(fx))).toBe(false);
    expect(existsSync(bEntry(fx))).toBe(false);
    expect(existsSync(join(fx.home, "backups"))).toBe(false);
  });

  it("re-checks after the confirm prompt", async () => {
    const fx = fixture();
    let running = false;
    const prompter: Prompter = {
      async select<T extends string>(): Promise<T> {
        throw new Error("unexpected select");
      },
      async confirm(): Promise<boolean> {
        running = true; // Claude reopened while the prompt was open
        return true;
      },
      async input(): Promise<string> {
        throw new Error("unexpected input");
      },
    };
    const r = await run(fx, ["sync", "--include-active"], { isTTY: true, prompter, isAppRunning: () => running });
    expect(r.code).toBe(1);
    expect(r.err).toContain(QUIT);
    expect(existsSync(aEntry(fx))).toBe(false);
    expect(existsSync(bEntry(fx))).toBe(false);
    expect(existsSync(join(fx.home, "backups"))).toBe(false);
  });

  it("labels copies into the signed-in account like any other account", async () => {
    const fx = fixture();
    const prompter = fakePrompter({ confirm: [false] });
    const r = await run(fx, ["sync", "--include-active"], { isTTY: true, prompter });
    expect(r.out).toContain("copy 1 to aaaaaaaa, 1 to bbbbbbbb");
  });

  it("--json includes the signed-in account's writes and the result", async () => {
    const fx = fixture();
    const r = await run(fx, ["sync", "--include-active", "-y", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as {
      writes: { sessionId: string; accountId: string; kind: string }[];
      result: { written: number };
    };
    expect(parsed.writes).toContainEqual({ sessionId: ID2, accountId: A, orgId: ORG1, kind: "copy" });
    expect(parsed.result.written).toBe(2);
  });

  it("restore undoes it", async () => {
    const fx = fixture();
    await run(fx, ["sync", "--include-active", "-y"]);
    const [name] = readdirSync(join(fx.home, "backups"));
    const r = await run(fx, ["restore", name as string, "-y"]);
    expect(r.code).toBe(0);
    expect(existsSync(aEntry(fx))).toBe(false);
  });
});
