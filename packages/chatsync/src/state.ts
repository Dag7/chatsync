import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatsyncError } from "./errors.js";
import { writeFileAtomic } from "./fs-util.js";
import type { CopyRecords, SyncState } from "./plan.js";

const stateFile = (home: string): string => join(home, "state.json");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSessions(v: unknown): v is SyncState["sessions"] {
  return isRecord(v) && Object.values(v).every((s) => isRecord(s) && Object.values(s).every((n) => typeof n === "number"));
}

function isCopyRecords(v: unknown): v is CopyRecords {
  return (
    isRecord(v) &&
    Object.values(v).every(
      (byAccount) =>
        isRecord(byAccount) &&
        Object.values(byAccount).every(
          (r) =>
            isRecord(r) &&
            typeof r.from === "string" &&
            Array.isArray(r.orgIds) &&
            r.orgIds.every((o) => typeof o === "string"),
        ),
    )
  );
}

/**
 * The saved state. Missing or unparsable state is treated as empty: `sessions` only affects conflict
 * detection. A `copies` field of the wrong shape is dropped without losing `sessions`.
 */
export function loadState(home: string): SyncState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile(home), "utf8"));
    if (isRecord(parsed) && isSessions(parsed.sessions)) {
      return isCopyRecords(parsed.copies)
        ? { sessions: parsed.sessions, copies: parsed.copies }
        : { sessions: parsed.sessions };
    }
  } catch {
    // fall through to empty state
  }
  return { sessions: {} };
}

/**
 * loadState drops a malformed `copies` field, so saving would erase whatever provenance it held.
 * Keep the file as `state.json.bad` first (once; best effort).
 */
function preserveMalformedCopies(home: string): void {
  const bad = `${stateFile(home)}.bad`;
  try {
    if (!existsSync(stateFile(home)) || existsSync(bad)) return;
    const parsed: unknown = JSON.parse(readFileSync(stateFile(home), "utf8"));
    if (isRecord(parsed) && parsed.copies !== undefined && !isCopyRecords(parsed.copies)) copyFileSync(stateFile(home), bad);
  } catch {
    // an unreadable previous state is not worth failing the save for
  }
}

export function saveState(home: string, state: SyncState): void {
  try {
    mkdirSync(home, { recursive: true });
    preserveMalformedCopies(home);
    writeFileAtomic(stateFile(home), JSON.stringify(state, null, 2) + "\n");
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ChatsyncError(`Cannot save sync state to ${stateFile(home)}: ${reason}`, 1);
  }
}
