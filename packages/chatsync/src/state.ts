import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatsyncError } from "./errors.js";
import { writeFileAtomic } from "./fs-util.js";
import type { SyncState } from "./plan.js";

const stateFile = (home: string): string => join(home, "state.json");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSyncState(v: unknown): v is SyncState {
  if (!isRecord(v) || !isRecord(v.sessions)) return false;
  return Object.values(v.sessions).every((s) => isRecord(s) && Object.values(s).every((n) => typeof n === "number"));
}

/** The last synced state. Missing or unparsable state is treated as empty: it only affects conflict detection. */
export function loadState(home: string): SyncState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile(home), "utf8"));
    if (isSyncState(parsed)) return parsed;
  } catch {
    // fall through to empty state
  }
  return { sessions: {} };
}

export function saveState(home: string, state: SyncState): void {
  try {
    mkdirSync(home, { recursive: true });
    writeFileAtomic(stateFile(home), JSON.stringify(state, null, 2) + "\n");
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ChatsyncError(`Cannot save sync state to ${stateFile(home)}: ${reason}`, 1);
  }
}
