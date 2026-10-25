import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBackup, pruneBackups } from "./backup.js";
import { ACCOUNT_BOUND_FIELDS, hasAccountBound, withoutAccountBound } from "./entry-fields.js";
import { entryTarget } from "./entry-path.js";
import { ChatsyncError } from "./errors.js";
import { writeFileAtomic } from "./fs-util.js";
import type { SyncState } from "./plan.js";
import type { EntryData, Store } from "./store.js";

/** A copy made by chatsync that still carries fields belonging to the account it was copied from. */
export type RepairTarget = {
  sessionId: string;
  accountId: string;
  orgId: string;
  file: string;
  data: EntryData;
  /** The account-bound fields present in `data`. */
  fields: string[];
};

export type RepairResult = { backup: string; repaired: number; warning?: string };

/** Accounts that hold each chat in a store: sessionId -> accountIds. */
function holders(store: Store): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const account of store.accounts) {
    for (const org of account.orgs) {
      for (const e of org.entries) {
        const set = map.get(e.data.sessionId);
        if (set) set.add(account.id);
        else map.set(e.data.sessionId, new Set([account.id]));
      }
    }
  }
  return map;
}

/** True when `state` has at least one provenance record. */
export function hasCopyRecords(state: SyncState): boolean {
  return Object.keys(state.copies ?? {}).length > 0;
}

/**
 * Entries chatsync copied in the past that still hold account-bound fields. An entry is a copy when
 * state recorded a copy of its chat into its account and org folder, or when the pre-chatsync
 * `snapshot` has the chat only in other accounts. A chat absent from the snapshot is never a copy
 * on that basis: it may be a brand-new chat.
 */
export function findRepairTargets(o: { store: Store; state: SyncState; snapshot: Store | null }): RepairTarget[] {
  const inSnapshot = o.snapshot ? holders(o.snapshot) : new Map<string, Set<string>>();
  const targets: RepairTarget[] = [];
  for (const account of o.store.accounts) {
    for (const org of account.orgs) {
      for (const e of org.entries) {
        const { sessionId } = e.data;
        const recorded = o.state.copies?.[sessionId]?.[account.id]?.orgIds.includes(org.id) === true;
        const before = inSnapshot.get(sessionId);
        const fromSnapshot = before !== undefined && before.size > 0 && !before.has(account.id);
        if (!recorded && !fromSnapshot) continue;
        if (!hasAccountBound(e.data)) continue;
        targets.push({
          sessionId,
          accountId: account.id,
          orgId: org.id,
          file: e.file,
          data: e.data,
          fields: ACCOUNT_BOUND_FIELDS.filter((f) => Object.hasOwn(e.data, f)),
        });
      }
    }
  }
  return targets;
}

/** Identifies what repair would write, so a re-scan can be compared with what the user confirmed. */
export function repairSignature(targets: RepairTarget[]): string {
  return targets
    .map((t) => [t.accountId, t.orgId, t.sessionId, t.fields.join(",")].join("|"))
    .sort()
    .join("\n");
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Removes the account-bound fields from each target. Every target path is validated and must be an
 * existing entry before anything is touched; then the sessions folder is backed up (a failure
 * aborts) and `beforeWrite` runs (it may throw to abort, e.g. because Claude started) right before
 * the first write.
 */
export function applyRepair(
  targets: RepairTarget[],
  o: { sessionsDir: string; home: string; now?: Date; beforeWrite?: () => void },
): RepairResult {
  const files = targets.map((t) => {
    const file = entryTarget(t, o.sessionsDir);
    if (!existsSync(file)) {
      throw new ChatsyncError(`Refusing to repair chat "${t.sessionId}" in ${t.accountId}/${t.orgId}: ${file} does not exist`, 2);
    }
    return file;
  });

  const backupsDir = join(o.home, "backups");
  const backup = createBackup({ sessionsDir: o.sessionsDir, backupsDir, ...(o.now ? { now: o.now } : {}) });
  o.beforeWrite?.();

  let repaired = 0;
  for (const [i, t] of targets.entries()) {
    const file = files[i] as string;
    try {
      writeFileAtomic(file, JSON.stringify(withoutAccountBound(t.data)));
    } catch (err: unknown) {
      throw new ChatsyncError(
        `Failed to write ${file} after ${repaired} of ${targets.length} entries: ${errorMessage(err)}. ` +
          `Your previous sessions are saved in ${join(backupsDir, backup)}`,
        1,
      );
    }
    repaired++;
  }

  try {
    pruneBackups(backupsDir);
  } catch (err: unknown) {
    return { backup, repaired, warning: `Repaired, but could not prune old backups: ${errorMessage(err)}` };
  }
  return { backup, repaired };
}
