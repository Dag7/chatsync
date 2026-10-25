import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBackup, pruneBackups } from "./backup.js";
import { entryTarget } from "./entry-path.js";
import { ChatsyncError } from "./errors.js";
import { writeFileAtomic } from "./fs-util.js";
import type { CopyRecords, Plan, SyncState } from "./plan.js";
import { loadState, saveState } from "./state.js";

export type ApplyResult = { backup: string | null; written: number; pruned: string[]; warning?: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `previous` plus a record for every copy in the plan; an org folder is listed once. Updates add nothing. */
function mergeCopies(previous: CopyRecords | undefined, plan: Plan): CopyRecords {
  const copies: CopyRecords = {};
  for (const [sessionId, byAccount] of Object.entries(previous ?? {})) {
    copies[sessionId] = Object.fromEntries(
      Object.entries(byAccount).map(([accountId, r]) => [accountId, { from: r.from, orgIds: [...r.orgIds] }]),
    );
  }
  for (const w of plan.writes) {
    if (w.kind !== "copy") continue;
    const byAccount = (copies[w.sessionId] ??= {});
    const record = (byAccount[w.accountId] ??= { from: w.from.accountId, orgIds: [] });
    record.from = w.from.accountId;
    if (!record.orgIds.includes(w.orgId)) record.orgIds.push(w.orgId);
  }
  return copies;
}

/**
 * Each account's `lastActivityAt` for every chat once the writes are in place: accounts that
 * receive a write get the newest value, others keep their own newest copy. Provenance records of
 * earlier copies are carried over, plus one for every copy in this plan.
 */
function stateAfter(plan: Plan, previous: SyncState): SyncState {
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
  const copies = mergeCopies(previous.copies, plan);
  return Object.keys(copies).length > 0 ? { sessions, copies } : { sessions };
}

/**
 * Applies a plan: refuse any write to the signed-in account (unless `allowActiveCopies`, which permits
 * only a copy to a file that does not exist yet), validate every target, back up the sessions folder (a
 * failure aborts before anything is written), write each entry atomically, record the new sync state,
 * prune old backups.
 * Failures to save state or prune after the entries are written never fail the sync; they are
 * returned as `warning`.
 */
export function applyPlan(
  plan: Plan,
  o: { sessionsDir: string; home: string; activeAccountId: string; now?: Date; allowActiveCopies?: boolean },
): ApplyResult {
  // The running app owns the signed-in account's files; refuse before anything is touched.
  const forbidden = plan.writes.find((w) => w.accountId === o.activeAccountId && (o.allowActiveCopies !== true || w.kind !== "copy"));
  if (forbidden) {
    throw new ChatsyncError(
      `Refusing to write chat "${forbidden.sessionId}" to the signed-in account ${forbidden.accountId.slice(0, 8)}; nothing was written`,
      2,
    );
  }
  const state = stateAfter(plan, loadState(o.home));
  if (plan.writes.length === 0) {
    saveState(o.home, state);
    return { backup: null, written: 0, pruned: [] };
  }

  const targets = plan.writes.map((w) => ({ file: entryTarget(w, o.sessionsDir), data: w.data, accountId: w.accountId, sessionId: w.sessionId }));
  // Into the signed-in account we only add new files, never overwrite what the app already has.
  const activeFiles = targets.filter((t) => t.accountId === o.activeAccountId).map((t) => t.file);
  const dup = activeFiles.find((f, i) => activeFiles.indexOf(f) !== i);
  if (dup) {
    throw new ChatsyncError(`Refusing to write ${dup} twice in the signed-in account; nothing was written`, 2);
  }
  const clobber = targets.find((t) => t.accountId === o.activeAccountId && existsSync(t.file));
  if (clobber) {
    throw new ChatsyncError(
      `Refusing to overwrite chat "${clobber.sessionId}" in the signed-in account ${clobber.accountId.slice(0, 8)}: it already has an entry; nothing was written`,
      2,
    );
  }

  const backupsDir = join(o.home, "backups");
  const backup = createBackup({ sessionsDir: o.sessionsDir, backupsDir, ...(o.now ? { now: o.now } : {}) });

  let written = 0;
  for (const t of targets) {
    // The app may have created the file since validation; never overwrite it in the signed-in account.
    if (t.accountId === o.activeAccountId && existsSync(t.file)) {
      throw new ChatsyncError(
        `Not overwriting ${t.file}: it appeared after ${written} of ${targets.length} entries were written. ` +
          `Your previous sessions are saved in ${join(backupsDir, backup)}`,
        1,
      );
    }
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
