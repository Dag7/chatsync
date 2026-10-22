import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { applyPlan } from "./apply.js";
import { listBackups, restoreBackup } from "./backup.js";
import { accountLabel, loadConfig, saveConfig, type ChatsyncConfig } from "./config.js";
import { ChatsyncError } from "./errors.js";
import { formatPlan, formatStatus, toJson, type OutputCtx } from "./format.js";
import { appDataDir, chatsyncHome, sessionsDir } from "./paths.js";
import { buildPlan, type Plan } from "./plan.js";
import { inquirerPrompter, type Prompter } from "./prompter.js";
import { loadState } from "./state.js";
import { loadStore, readActiveAccount, readSshNames, type Store } from "./store.js";

export interface ProgramDeps {
  out?: (t: string) => void;
  errOut?: (t: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  isTTY?: boolean;
  prompter?: Prompter;
  isAppRunning?: () => boolean;
  now?: () => Date;
}

type Menu = "status" | "sync" | "backups" | "accounts" | "quit";

const NO_ACTIVE_ACCOUNT = "Cannot tell which account is active in Claude. Open the Claude desktop app, sign in, and try again.";

function packageVersion(): string {
  const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
  return pkg.version ?? "0.0.0";
}

function defaultIsAppRunning(): boolean {
  return spawnSync("pgrep", ["-x", "Claude"]).status === 0;
}

const stripNewline = (t: string): string => t.replace(/\n$/, "");

export function buildProgram(deps: ProgramDeps = {}): Command {
  const out = deps.out ?? ((t: string) => process.stdout.write(`${t}\n`));
  const errOut = deps.errOut ?? ((t: string) => process.stderr.write(`${t}\n`));
  const env = deps.env ?? process.env;
  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const isAppRunning = deps.isAppRunning ?? defaultIsAppRunning;
  const pathOpts = {
    env,
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.home ? { home: deps.home } : {}),
  };
  let prompter = deps.prompter;
  const prompts = (): Prompter => (prompter ??= inquirerPrompter());
  const nowOpt = (): { now?: Date } => (deps.now ? { now: deps.now() } : {});

  const homeDir = (): string => chatsyncHome({ env, ...(deps.home ? { home: deps.home } : {}) });
  const appDir = (): string => appDataDir(pathOpts);

  /** Reads everything needed for a plan. Read-only: creates no files. */
  function load(): { plan: Plan; ctx: OutputCtx; store: Store; app: string; home: string } {
    const app = appDir();
    const home = homeDir();
    const store = loadStore(app);
    const active = readActiveAccount(app);
    if (active === null) throw new ChatsyncError(NO_ACTIVE_ACCOUNT, 2);
    const sshNames = readSshNames(app);
    const cfg = loadConfig(home);
    const plan = buildPlan({ store, activeAccountId: active, state: loadState(home) });
    return { plan, ctx: { activeAccountId: active, cfg, sshNames }, store, app, home };
  }

  const json = (v: unknown): string => JSON.stringify(v, null, 2);

  function status(opts: { json?: boolean }): void {
    const { plan, ctx } = load();
    out(opts.json ? json(toJson(plan, ctx)) : formatStatus(plan, ctx));
  }

  async function sync(opts: { dryRun?: boolean; yes?: boolean; json?: boolean }): Promise<void> {
    const { plan, ctx, app, home } = load();
    const asJson = opts.json === true;
    if (!asJson) out(formatPlan(plan, ctx));
    if (opts.dryRun) {
      if (asJson) out(json(toJson(plan, ctx)));
      return;
    }

    if (plan.writes.length === 0) {
      // Nothing to write; still record the in-sync state so later conflicts can be detected.
      try {
        applyPlan(plan, { sessionsDir: sessionsDir(app), home });
      } catch (err: unknown) {
        errOut(`Could not record sync state: ${err instanceof Error ? err.message : String(err)}`);
      }
      out(asJson ? json(toJson(plan, ctx)) : "Already in sync");
      return;
    }

    if (!opts.yes) {
      if (!isTTY || asJson) throw new ChatsyncError("Not an interactive terminal: pass -y to apply", 1);
      if (!(await prompts().confirm("Proceed?"))) {
        out("Cancelled");
        return;
      }
    }

    const res = applyPlan(plan, { sessionsDir: sessionsDir(app), home, ...nowOpt() });
    const backupPath = res.backup === null ? null : join(home, "backups", res.backup);
    if (asJson) {
      out(json({ ...toJson(plan, ctx), result: { backup: backupPath, written: res.written, pruned: res.pruned } }));
    } else {
      if (backupPath) out(`Backup: ${backupPath}`);
      out(`Wrote ${res.written} ${res.written === 1 ? "entry" : "entries"}`);
      if (res.pruned.length > 0) out(`Pruned ${res.pruned.length} old ${res.pruned.length === 1 ? "backup" : "backups"}`);
    }
    if (res.warning) errOut(res.warning);
  }

  const backupLabel = (b: { name: string; chatCount: number }): string =>
    b.chatCount < 0 ? `${b.name}  (unreadable)` : `${b.name}  (${b.chatCount} ${b.chatCount === 1 ? "chat" : "chats"})`;

  function backups(): void {
    const list = listBackups(join(homeDir(), "backups"));
    if (list.length === 0) {
      out("No backups yet");
      return;
    }
    for (const b of list) out(backupLabel(b));
  }

  async function restore(name: string | undefined): Promise<void> {
    const home = homeDir();
    const backupsDir = join(home, "backups");
    if (isAppRunning()) throw new ChatsyncError("Quit Claude before restoring", 1);

    let target = name;
    if (target === undefined) {
      if (!isTTY) throw new ChatsyncError("Pass a backup name to restore (see `chatsync backups`)", 1);
      const list = listBackups(backupsDir);
      if (list.length === 0) {
        out("No backups yet");
        return;
      }
      target = await prompts().select(
        "Restore which backup?",
        list.map((b) => ({ name: backupLabel(b), value: b.name })),
      );
    }
    if (isTTY) {
      const ok = await prompts().confirm(`Replace your Claude sessions with backup ${target}? Current sessions are backed up first.`);
      if (!ok) {
        out("Cancelled");
        return;
      }
    }

    const res = restoreBackup({ name: target, sessionsDir: sessionsDir(appDir()), backupsDir, isAppRunning, ...nowOpt() });
    out(`Restored ${target}`);
    if (res.safetyBackup) out(`Previous sessions saved to ${join(backupsDir, res.safetyBackup)}`);
    if (res.warning) errOut(res.warning);
  }

  async function accounts(): Promise<void> {
    const home = homeDir();
    const store = loadStore(appDir());
    const cfg: ChatsyncConfig = loadConfig(home);
    const updated: ChatsyncConfig = { accounts: { ...cfg.accounts }, machines: cfg.machines };
    if (store.accounts.length === 0) {
      out("No accounts found");
      return;
    }
    let active: string | null = null;
    try {
      active = readActiveAccount(appDir());
    } catch {
      // The active account only decorates the listing.
    }

    for (const account of store.accounts) {
      const titles = account.orgs
        .flatMap((o) => o.entries)
        .sort((a, b) => b.data.lastActivityAt - a.data.lastActivityAt)
        .slice(0, 3)
        .map((e) => e.data.title ?? e.data.sessionId);
      out(`${accountLabel(account.id, cfg)} (${account.id})${account.id === active ? " [signed in]" : ""}`);
      out(titles.length > 0 ? titles.map((t) => `  ${t}`).join("\n") : "  (no chats)");
      if (!isTTY) continue;
      const answer = (await prompts().input(`Nickname for ${account.id.slice(0, 8)} (blank keeps current)`, cfg.accounts[account.id])).trim();
      if (answer !== "") updated.accounts[account.id] = answer;
    }
    if (isTTY && JSON.stringify(updated.accounts) !== JSON.stringify(cfg.accounts)) {
      saveConfig(home, updated);
      out("Saved nicknames");
    }
  }

  /** Runs one menu action; an expected failure is reported and the menu carries on. */
  async function guarded(action: () => void | Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err: unknown) {
      if (!(err instanceof ChatsyncError)) throw err;
      errOut(err.message);
    }
  }

  async function backupsMenu(): Promise<void> {
    const list = listBackups(join(homeDir(), "backups"));
    if (list.length === 0) {
      out("No backups yet");
      return;
    }
    for (const b of list) out(backupLabel(b));
    const choice = await prompts().select("Backups", [
      { name: "Restore a backup", value: "restore" },
      { name: "Back", value: "back" },
    ]);
    if (choice === "restore") await restore(undefined);
  }

  async function menu(): Promise<void> {
    for (;;) {
      const choice = await prompts().select<Menu>("chatsync", [
        { name: "Status", value: "status" },
        { name: "Sync", value: "sync" },
        { name: "Backups / restore", value: "backups" },
        { name: "Accounts", value: "accounts" },
        { name: "Quit", value: "quit" },
      ]);
      if (choice === "quit") return;
      if (choice === "status") await guarded(() => status({}));
      else if (choice === "sync") await guarded(() => sync({}));
      else if (choice === "backups") await guarded(backupsMenu);
      else await guarded(accounts);
    }
  }

  const program = new Command();
  program
    .name("chatsync")
    .description("Copy Claude desktop sidebar entries between signed-in accounts")
    .version(packageVersion(), "-V, --version", "print the version")
    .helpOption("-h, --help", "show help")
    .configureOutput({ writeOut: (s) => out(stripNewline(s)), writeErr: (s) => errOut(stripNewline(s)) })
    .exitOverride();

  program.helpCommand(true);

  program.action(async () => {
    if (program.args.length > 0) program.error(`error: unknown command '${program.args[0]}'`, { exitCode: 1 });
    if (!isTTY) {
      program.outputHelp();
      return;
    }
    await menu();
  });

  program
    .command("status")
    .description("show every chat by machine and what a sync would do (changes nothing)")
    .option("--json", "print JSON")
    .action((opts: { json?: boolean }) => status(opts));

  program
    .command("sync")
    .description("copy chats so every signed-in account lists every chat")
    .option("--dry-run", "show the plan and change nothing")
    .option("-y, --yes", "apply without asking")
    .option("--json", "print JSON")
    .action((opts: { dryRun?: boolean; yes?: boolean; json?: boolean }) => sync(opts));

  program
    .command("backups")
    .description("list backups")
    .action(() => backups());

  program
    .command("restore")
    .description("restore the sessions folder from a backup (Claude must be quit)")
    .argument("[name]", "backup name; omit to choose")
    .action((name: string | undefined) => restore(name));

  program
    .command("accounts")
    .description("list accounts and set nicknames")
    .action(() => accounts());

  return program;
}

/** Runs the CLI and returns its exit code. Never throws. */
export async function runCli(argv: string[], deps: ProgramDeps = {}): Promise<number> {
  const errOut = deps.errOut ?? ((t: string) => process.stderr.write(`${t}\n`));
  try {
    await buildProgram(deps).parseAsync(argv, { from: "user" });
    return 0;
  } catch (err: unknown) {
    if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 1;
    if (err instanceof ChatsyncError) {
      errOut(err.message);
      return err.exitCode;
    }
    if (err instanceof Error && err.name === "ExitPromptError") return 130;
    errOut(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  }
}
