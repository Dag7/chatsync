import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createBackup, pruneBackups } from "./backup.js";
import { ChatsyncError } from "./errors.js";
import { writeFileAtomic } from "./fs-util.js";
import type { Plan, SyncState, Write } from "./plan.js";
import { saveState } from "./state.js";

export type ApplyResult = { backup: string | null; written: number; pruned: string[]; warning?: string };

const SESSION_ID = /^local_[A-Za-z0-9_-]+$/;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `child` is strictly inside `parent` (both resolved). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Where a write goes. Throws (exit 2) unless the session id is a plain `local_*` name and the
 * target is a file directly inside an existing `<sessionsDir>/<account>/<org>` folder.
 */
function targetFor(w: Write, root: string): string {
  const bad = (why: string): ChatsyncError =>
    new ChatsyncError(`Refusing to write chat "${w.sessionId}" to ${w.accountId}/${w.orgId}: ${why}`, 2);
  if (!SESSION_ID.test(w.sessionId)) throw bad("unexpected session id");
  const orgDir = resolve(root, w.accountId, w.orgId);
  const rootDir = resolve(root);
  if (!isInside(rootDir, orgDir) || relative(rootDir, orgDir).split(/[\\/]/).length !== 2) {
    throw bad("account or organization folder is outside the sessions folder");
  }
  if (!isDir(orgDir)) throw bad(`folder ${orgDir} does not exist`);
  const file = resolve(orgDir, `${w.sessionId}.json`);
  if (!isInside(orgDir, file) || resolve(file, "..") !== orgDir) throw bad("target is outside the organization folder");
  return file;
}

/**
 * Each account's `lastActivityAt` for every chat once the writes are in place: accounts that
 * receive a write get the newest value, others keep their own newest copy.
 */
function stateAfter(plan: Plan): SyncState {
  const sessions: SyncState["sessions"] = {};
  for (const chat of plan.chats) {
    const accounts: Record<string, number> = {};
    for (const copy of chat.copies) {
      accounts[copy.accountId] = Math.max(accounts[copy.accountId] ?? -Infinity, copy.data.lastActivityAt);
    }
    sessions[chat.sessionId] = accounts;
  }
  for (const w of plan.writes) {
    const accounts = sessions[w.sessionId];
    if (accounts) accounts[w.accountId] = w.data.lastActivityAt;
  }
  return { sessions };
}

/**
 * Applies a plan: refuse any write to the signed-in account, validate every target, back up the sessions folder (a failure aborts before
 * anything is written), write each entry atomically, record the new sync state, prune old backups.
 * Failures to save state or prune after the entries are written never fail the sync; they are
 * returned as `warning`.
 */
export function applyPlan(
  plan: Plan,
  o: { sessionsDir: string; home: string; activeAccountId: string; now?: Date },
): ApplyResult {
  // The running app owns the signed-in account's files; refuse before anything is touched.
  const forbidden = plan.writes.find((w) => w.accountId === o.activeAccountId);
  if (forbidden) {
    throw new ChatsyncError(
      `Refusing to write chat "${forbidden.sessionId}" to the signed-in account ${forbidden.accountId.slice(0, 8)}; nothing was written`,
      2,
    );
  }
  const state = stateAfter(plan);
  if (plan.writes.length === 0) {
    saveState(o.home, state);
    return { backup: null, written: 0, pruned: [] };
  }

  const targets = plan.writes.map((w) => ({ file: targetFor(w, o.sessionsDir), data: w.data }));

  const backupsDir = join(o.home, "backups");
  const backup = createBackup({ sessionsDir: o.sessionsDir, backupsDir, ...(o.now ? { now: o.now } : {}) });

  let written = 0;
  for (const t of targets) {
    try {
      writeFileAtomic(t.file, JSON.stringify(t.data));
    } catch (err: unknown) {
      throw new ChatsyncError(
        `Failed to write ${t.file} after ${written} of ${targets.length} entries: ${errorMessage(err)}. ` +
          `Your previous sessions are saved in ${join(backupsDir, backup)}`,
        1,
      );
    }
    written++;
  }

  const warnings: string[] = [];
  try {
    saveState(o.home, state);
  } catch (err: unknown) {
    warnings.push(`Synced, but could not save sync state: ${errorMessage(err)}`);
  }

  let pruned: string[] = [];
  try {
    pruned = pruneBackups(backupsDir);
  } catch (err: unknown) {
    warnings.push(`Synced, but could not prune old backups: ${errorMessage(err)}`);
  }

  return { backup, written, pruned, ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}) };
}
