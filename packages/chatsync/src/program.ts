import { createRequire } from "node:module";
import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { applyPlan } from "./apply.js";
import { isClaudeRunning } from "./app-running.js";
import { listBackups, restoreBackup } from "./backup.js";
import { accountLabel, loadConfig, saveConfig, type ChatsyncConfig } from "./config.js";
import { ChatsyncError } from "./errors.js";
import { formatBreakdown, formatPlan, formatStatus, toJson, type OutputCtx } from "./format.js";
import { appDataDir, chatsyncHome, sessionsDir } from "./paths.js";
import { buildPlan, type Plan } from "./plan.js";
import { inquirerPrompter, type Prompter } from "./prompter.js";
import { applyRepair, findRepairTargets, hasCopyRecords, repairSignature, type RepairScan } from "./repair.js";
import { loadState } from "./state.js";
import { loadStore, loadStoreAt, readActiveAccount, readSshNames, type Store } from "./store.js";

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

const QUIT_FIRST =
  "Quit Claude first (⌘Q): --include-active writes to the signed-in account, which is only safe while Claude is closed.";
const RUNNING_DRY_RUN = "Claude is running: quit it before running this without --dry-run.";
const QUIT_FIRST_REPAIR = "Quit Claude first (⌘Q): repair edits sidebar entries, which is only safe while Claude is closed.";
const RUNNING_DRY_RUN_REPAIR = "Claude is running: quit it before running repair without --dry-run.";
const NO_COPY_RECORDS = "No record of earlier copies; nothing to repair.";

const entries = (n: number): string => `${n} ${n === 1 ? "entry" : "entries"}`;

function packageVersion(): string {
  const pkg = createRequire(import.meta.url)("../package.json") as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** Identifies what a plan would write, so a re-plan can be compared with what the user confirmed. */
function writeSignature(plan: Plan): string {
  return plan.writes
    .map((w) => [w.sessionId, w.accountId, w.orgId, w.kind, w.data.lastActivityAt].join("|"))
    .sort()
    .join("\n");
}

const stripNewline = (t: string): string => t.replace(/\n$/, "");

export function buildProgram(deps: ProgramDeps = {}): Command {
  const out = deps.out ?? ((t: string) => process.stdout.write(`${t}\n`));
  const errOut = deps.errOut ?? ((t: string) => process.stderr.write(`${t}\n`));
  const env = deps.env ?? process.env;
  const isTTY = deps.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const isAppRunning = deps.isAppRunning ?? isClaudeRunning;
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
  function load(includeActive = false): { plan: Plan; ctx: OutputCtx; store: Store; app: string; home: string } {
    const app = appDir();
    const home = homeDir();
    const store = loadStore(app);
    const active = readActiveAccount(app);
    if (active === null) throw new ChatsyncError(NO_ACTIVE_ACCOUNT, 2);
    const sshNames = readSshNames(app);
    const cfg = loadConfig(home);
    const plan = buildPlan({ store, activeAccountId: active, state: loadState(home), ...(includeActive ? { includeActive } : {}) });
    return { plan, ctx: { activeAccountId: active, cfg, sshNames }, store, app, home };
  }

  const json = (v: unknown): string => JSON.stringify(v, null, 2);

  function status(opts: { json?: boolean }): void {
    const { plan, ctx } = load();
    out(opts.json ? json(toJson(plan, ctx)) : formatStatus(plan, ctx));
  }

  async function sync(opts: { dryRun?: boolean; yes?: boolean; json?: boolean; includeActive?: boolean }): Promise<void> {
    const includeActive = opts.includeActive === true;
    // Writing the signed-in account is only safe while the app is closed.
    const requireClosed = (): void => {
      if (includeActive && isAppRunning()) throw new ChatsyncError(QUIT_FIRST, 1);
    };
    if (!opts.dryRun) requireClosed();
    const { plan, ctx, app, home } = load(includeActive);
    const asJson = opts.json === true;
    if (!asJson) out(formatPlan(plan, ctx));
    if (opts.dryRun) {
      if (includeActive && isAppRunning()) (asJson ? errOut : out)(RUNNING_DRY_RUN);
      if (asJson) out(json(toJson(plan, ctx)));
      return;
    }

    if (plan.writes.length === 0) {
      // Nothing to write; still record the in-sync state so later conflicts can be detected.
      try {
        applyPlan(plan, { sessionsDir: sessionsDir(app), home, activeAccountId: ctx.activeAccountId });
      } catch (err: unknown) {
        errOut(`Could not record sync state: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (asJson) out(json(toJson(plan, ctx)));
      else if (plan.activeBehind.length === 0) out("Already in sync");
      return;
    }

    let current = { plan, ctx };
    if (!opts.yes) {
      if (asJson) throw new ChatsyncError("--json never prompts: pass -y to apply", 1);
      if (!isTTY) throw new ChatsyncError("Not an interactive terminal: pass -y to apply", 1);
      out(formatBreakdown(plan, ctx));
      if (!(await prompts().confirm("Proceed?"))) {
        out("Cancelled");
        return;
      }
      // The user may have switched accounts or the app may have written files while the prompt was open.
      const again = load(includeActive);
      if (
        again.ctx.activeAccountId !== ctx.activeAccountId ||
        writeSignature(again.plan) !== writeSignature(plan)
      ) {
        throw new ChatsyncError("The signed-in account changed while waiting; run chatsync sync again", 2);
      }
      current = { plan: again.plan, ctx: again.ctx };
    }

    requireClosed();
    const res = applyPlan(current.plan, {
      sessionsDir: sessionsDir(app),
      home,
      activeAccountId: current.ctx.activeAccountId,
      ...(includeActive ? { allowActiveCopies: true } : {}),
      ...nowOpt(),
    });
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

  /** Entries chatsync copied earlier that still carry account-bound fields; null when nothing records any copy. */
  function scanRepair(): { scan: RepairScan; cfg: ChatsyncConfig; app: string; home: string } | null {
    const app = appDir();
    const home = homeDir();
    const store = loadStore(app);
    const state = loadState(home);
    const oldest = listBackups(join(home, "backups")).at(-1);
    let snapshot: Store | null = null;
    if (oldest) {
      try {
        snapshot = loadStoreAt(oldest.path);
      } catch (err: unknown) {
        throw new ChatsyncError(
          `Cannot read the oldest backup ${oldest.name}: ${err instanceof Error ? err.message : String(err)}`,
          2,
        );
      }
    }
    if (snapshot === null && !hasCopyRecords(state)) return null;
    return { scan: findRepairTargets({ store, state, snapshot }), cfg: loadConfig(home), app, home };
  }

  async function repair(opts: { dryRun?: boolean; yes?: boolean; json?: boolean }): Promise<void> {
    const asJson = opts.json === true;
    const requireClosed = (): void => {
      if (isAppRunning()) throw new ChatsyncError(QUIT_FIRST_REPAIR, 1);
    };
    if (!opts.dryRun) requireClosed();
    const warnIfRunning = (): void => {
      if (opts.dryRun && isAppRunning()) (asJson ? errOut : out)(RUNNING_DRY_RUN_REPAIR);
    };
    const first = scanRepair();
    if (first === null) {
      out(asJson ? json({ targets: [], skipped: [] }) : NO_COPY_RECORDS);
      warnIfRunning();
      return;
    }
    const { cfg, app, home } = first;
    const { targets, skipped } = first.scan;
    const summary = targets.map((t) => ({ sessionId: t.sessionId, accountId: t.accountId, orgId: t.orgId, fields: t.fields }));
    const skippedSummary = skipped.map((k) => ({ sessionId: k.sessionId, accountId: k.accountId, orgId: k.orgId }));
    const listing = (): string =>
      [
        ...skipped.map((k) => `${k.title}  [${accountLabel(k.accountId, cfg)}]  skipped: source not found`),
        ...targets.map(
          (t) => `${t.data.title ?? t.sessionId}  [${accountLabel(t.accountId, cfg)}]  removes: ${t.fields.join(", ")}`,
        ),
        targets.length === 0 ? "Nothing to repair." : `repair ${entries(targets.length)}`,
      ].join("\n");

    if (opts.dryRun || targets.length === 0) {
      if (asJson) {
        out(json({ targets: summary, skipped: skippedSummary }));
        warnIfRunning();
      } else {
        out(listing());
        warnIfRunning();
      }
      return;
    }
    if (!asJson) out(listing());

    let current = targets;
    if (opts.yes !== true) {
      if (asJson) throw new ChatsyncError("--json never prompts: pass -y to repair", 1);
      if (!isTTY) throw new ChatsyncError("Not an interactive terminal: pass -y to repair", 1);
      if (!(await prompts().confirm("Proceed?"))) {
        out("Cancelled");
        return;
      }
      // Claude may have started, or entries changed, while the prompt was open.
      requireClosed();
      const again = scanRepair();
      if (again === null || repairSignature(again.scan.targets) !== repairSignature(targets)) {
        throw new ChatsyncError("The sidebar entries changed while waiting; run chatsync repair again", 2);
      }
      current = again.scan.targets;
    }

    requireClosed();
    const res = applyRepair(current, { sessionsDir: sessionsDir(app), home, beforeWrite: requireClosed, ...nowOpt() });
    const backupPath = join(home, "backups", res.backup);
    if (asJson) {
      out(json({ targets: summary, skipped: skippedSummary, result: { backup: backupPath, repaired: res.repaired } }));
    } else {
      out(`Backup: ${backupPath}`);
      out(`Repaired ${entries(res.repaired)}.`);
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

  async function restore(name: string | undefined, yes = false): Promise<void> {
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
    if (!isTTY && !yes) throw new ChatsyncError("Not an interactive terminal: pass -y to restore", 1);
    if (isTTY && !yes) {
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
    .option("--include-active", "also copy missing chats into the account you are signed in to (Claude must be quit)")
    .option("--json", "print JSON")
    .action((opts: { dryRun?: boolean; yes?: boolean; json?: boolean; includeActive?: boolean }) => sync(opts));

  program
    .command("repair")
    .description("remove the signed-in-account links and errors that earlier versions copied into other accounts (Claude must be quit)")
    .option("--dry-run", "show what would change and change nothing")
    .option("-y, --yes", "repair without asking")
    .option("--json", "print JSON")
    .action((opts: { dryRun?: boolean; yes?: boolean; json?: boolean }) => repair(opts));

  program
    .command("backups")
    .description("list backups")
    .action(() => backups());

  program
    .command("restore")
    .description("restore the sessions folder from a backup (Claude must be quit)")
    .argument("[name]", "backup name; omit to choose")
    .option("-y, --yes", "restore without asking")
    .action((name: string | undefined, opts: { yes?: boolean }) => restore(name, opts.yes === true));

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
