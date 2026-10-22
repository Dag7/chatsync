import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  it("sync reports already in sync when nothing to write", async () => {
    const fx = fixture();
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

  it("sync with a missing sessions folder exits 2 with a clean message", async () => {
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

    const r = await run(fx, ["restore", name as string]);
    expect(r.code).toBe(0);
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
