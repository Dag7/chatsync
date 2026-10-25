import type { EntryData } from "./store.js";

/**
 * Fields of a sidebar entry that only make sense for the account that created it: the link to its
 * remote `claude` process (which runs under that account's quota) and its last error banner.
 * Copying them into another account makes the copy reattach to the other account's process.
 */
export const ACCOUNT_BOUND_FIELDS = [
  "sshReattach",
  "sshRemoteProcessId",
  "error",
  "errorAt",
  "errorRows",
  "priorErrorMark",
] as const;

/** A shallow copy of `data` without the account-bound fields. Never mutates its input. */
export function withoutAccountBound(data: EntryData): EntryData {
  const copy: EntryData = { ...data };
  for (const f of ACCOUNT_BOUND_FIELDS) delete copy[f];
  return copy;
}

/** True when `data` carries at least one account-bound field. */
export function hasAccountBound(data: EntryData): boolean {
  return ACCOUNT_BOUND_FIELDS.some((f) => Object.hasOwn(data, f));
}
