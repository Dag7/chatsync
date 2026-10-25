import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBackup, pruneBackups } from "./backup.js";
import { ACCOUNT_BOUND_FIELDS, hasAccountBound } from "./entry-fields.js";
import { entryTarget } from "./entry-path.js";
import { ChatsyncError } from "./errors.js";
import { writeFileAtomic } from "./fs-util.js";
import type { SyncState } from "./plan.js";
import type { Entry, EntryData, Store } from "./store.js";

/** A copy made by chatsync that still carries fields belonging to the account it was copied from. */
export type RepairTarget = {
  sessionId: string;
  accountId: string;
  orgId: string;
  file: string;
  data: EntryData;
  /** The inherited account-bound fields to remove: present in `data` with the same value as in the source. */
  fields: string[];
};

export type RepairResult = { backup: string; repaired: number; warning?: string };

/** True when `state` records at least one cross-account copy (same-account copies keep their fields). */
export function hasCopyRecords(state: SyncState): boolean {
  return Object.values(state.copies ?? {}).some((byAccount) =>
    Object.entries(byAccount).some(([accountId, rec]) => rec.from !== accountId),
  );
}

/** A copy whose origin cannot be found, so nothing can be told apart from values the copy's own account wrote. */
export type RepairSkip = { sessionId: string; accountId: string; orgId: string; title: string };

export type RepairScan = { targets: RepairTarget[]; skipped: RepairSkip[] };

function bySession(store: Store | null): Map<string, Entry[]> {
  const map = new Map<string, Entry[]>();
  for (const account of store?.accounts ?? []) {
    for (const org of account.orgs) {
      for (const e of org.entries) {
        const list = map.get(e.data.sessionId);
        if (list) list.push(e);
        else map.set(e.data.sessionId, [e]);
      }
    }
  }
  return map;
}

/** The most recently active entry, or undefined for none. */
function mostActive(entries: Entry[]): Entry | undefined {
  let best: Entry | undefined;
  for (const e of entries) if (best === undefined || e.data.lastActivityAt > best.data.lastActivityAt) best = e;
  return best;
}

/**
 * Entries chatsync copied in the past that still hold inherited account-bound fields. An entry is a
 * copy when state recorded a cross-account copy of its chat into its account and org folder, or when
 * the pre-chatsync `snapshot` has the chat only in other accounts. A chat absent from the snapshot is
 * never a copy on that basis: it may be a brand-new chat.
 *
 * Only inherited values are removed: a field goes only if the copy's source entry has it with the
 * same value (what Claude wrote later for the copy's own account stays). The source is the current
 * entry of the chat in the recorded account (else the snapshot's), or for the snapshot rule the most
 * recently active snapshot entry in another account. A copy with no findable source is skipped.
 */
export function findRepairTargets(o: { store: Store; state: SyncState; snapshot: Store | null }): RepairScan {
  const current = bySession(o.store);
  const before = bySession(o.snapshot);
  const targets: RepairTarget[] = [];
  const skipped: RepairSkip[] = [];
  for (const account of o.store.accounts) {
    for (const org of account.orgs) {
      for (const e of org.entries) {
        const { sessionId } = e.data;
        if (!hasAccountBound(e.data)) continue;
        const rec = o.state.copies?.[sessionId]?.[account.id];
        const recorded = rec !== undefined && rec.from !== account.id && rec.orgIds.includes(org.id);
        const snapshotEntries = before.get(sessionId) ?? [];
        const elsewhere = snapshotEntries.filter((s) => s.accountId !== account.id);
        const fromSnapshot = elsewhere.length > 0 && elsewhere.length === snapshotEntries.length;
        if (!recorded && !fromSnapshot) continue;

        let source: EntryData | undefined;
        if (recorded) {
          const from = (list: Entry[]): Entry | undefined => mostActive(list.filter((x) => x.accountId === rec.from));
          source = (from(current.get(sessionId) ?? []) ?? from(snapshotEntries))?.data;
        }
        if (source === undefined && fromSnapshot) source = mostActive(elsewhere)?.data;

        if (source === undefined) {
          skipped.push({ sessionId, accountId: account.id, orgId: org.id, title: e.data.title ?? sessionId });
          continue;
        }
        const src = source;
        const fields = ACCOUNT_BOUND_FIELDS.filter(
          (f) => Object.hasOwn(e.data, f) && Object.hasOwn(src, f) && JSON.stringify(e.data[f]) === JSON.stringify(src[f]),
        );
        if (fields.length === 0) continue;
        targets.push({ sessionId, accountId: account.id, orgId: org.id, file: e.file, data: e.data, fields: [...fields] });
      }
    }
  }
  return { targets, skipped };
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
      const next: EntryData = { ...t.data };
      for (const f of t.fields) delete next[f];
      writeFileAtomic(file, JSON.stringify(next));
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
