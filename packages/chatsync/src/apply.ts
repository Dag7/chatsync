import { join } from "node:path";
import { createBackup, pruneBackups } from "./backup.js";
import { ChatsyncError } from "./errors.js";
import { writeFileAtomic } from "./fs-util.js";
import type { Plan, SyncState } from "./plan.js";
import { saveState } from "./state.js";

export type ApplyResult = { backup: string | null; written: number; pruned: string[]; warning?: string };

/** Every chat mapped to every account holding it once the plan's writes are in place. */
function stateAfter(plan: Plan): SyncState {
  const sessions: SyncState["sessions"] = {};
  for (const chat of plan.chats) {
    const at = chat.newest.data.lastActivityAt;
    const accounts: Record<string, number> = {};
    for (const copy of chat.copies) accounts[copy.accountId] = at;
    sessions[chat.sessionId] = accounts;
  }
  for (const w of plan.writes) {
    const accounts = sessions[w.sessionId];
    if (accounts) accounts[w.accountId] = w.data.lastActivityAt;
  }
  return { sessions };
}

/**
 * Applies a plan: back up the sessions folder first (a failure aborts before anything is written),
 * then write each entry atomically, record the new sync state, and prune old backups.
 * A prune failure never fails the sync; it is returned as `warning`.
 */
export function applyPlan(plan: Plan, o: { sessionsDir: string; home: string; now?: Date }): ApplyResult {
  const state = stateAfter(plan);
  if (plan.writes.length === 0) {
    saveState(o.home, state);
    return { backup: null, written: 0, pruned: [] };
  }

  const backupsDir = join(o.home, "backups");
  const backup = createBackup({ sessionsDir: o.sessionsDir, backupsDir, ...(o.now ? { now: o.now } : {}) });

  let written = 0;
  for (const w of plan.writes) {
    const file = join(o.sessionsDir, w.accountId, w.orgId, `${w.sessionId}.json`);
    try {
      writeFileAtomic(file, JSON.stringify(w.data));
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ChatsyncError(
        `Failed to write ${file} after ${written} of ${plan.writes.length} entries: ${reason}. ` +
          `Your previous sessions are saved in ${join(backupsDir, backup)}`,
        1,
      );
    }
    written++;
  }

  saveState(o.home, state);

  try {
    return { backup, written, pruned: pruneBackups(backupsDir) };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { backup, written, pruned: [], warning: `Synced, but could not prune old backups: ${reason}` };
  }
}
