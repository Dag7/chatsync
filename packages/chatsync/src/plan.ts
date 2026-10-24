import { ChatsyncError } from "./errors.js";
import type { Entry, EntryData, Store } from "./store.js";

/** Last synced `lastActivityAt` per session per account: sessionId -> accountId -> timestamp. */
export type SyncState = { sessions: Record<string, Record<string, number>> };

/** One logical chat: every copy of a session across accounts, with the most recently active one singled out. */
export type Chat = { sessionId: string; newest: Entry; copies: Entry[] };

export type Write = {
  sessionId: string;
  accountId: string;
  orgId: string;
  kind: "copy" | "update";
  from: { accountId: string; orgId: string };
  data: EntryData;
};

/** A chat that changed in two or more accounts since the last sync. The newest copy still wins. */
export type Conflict = { sessionId: string; title: string; accountIds: string[] };

/** A chat the signed-in account lacks or holds only an older copy of. Never updated in place; copies into it happen only with `includeActive`. */
export type BehindChat = { sessionId: string; title: string; reason: "missing" | "older" };

export type Plan = {
  chats: Chat[];
  writes: Write[];
  conflicts: Conflict[];
  unchanged: number;
  /** Chats the signed-in account lacks or holds an older copy of and that this plan does not copy into it. */
  activeBehind: BehindChat[];
  /** Accounts with no org folder, so there is nowhere to write (the signed-in one only counts with `includeActive`). */
  skippedAccounts: string[];
};

/** True when `a` should be preferred over `b` as the newest copy. */
function isNewer(a: Entry, b: Entry, activeAccountId: string): boolean {
  if (a.data.lastActivityAt !== b.data.lastActivityAt) return a.data.lastActivityAt > b.data.lastActivityAt;
  if (a.accountId === b.accountId) return false;
  if (a.accountId === activeAccountId) return true;
  if (b.accountId === activeAccountId) return false;
  return a.accountId < b.accountId;
}

function groupBySession(store: Store, activeAccountId: string): Chat[] {
  const bySession = new Map<string, Entry[]>();
  for (const account of store.accounts) {
    for (const org of account.orgs) {
      for (const e of org.entries) {
        const list = bySession.get(e.data.sessionId);
        if (list) list.push(e);
        else bySession.set(e.data.sessionId, [e]);
      }
    }
  }
  const chats: Chat[] = [];
  for (const [sessionId, copies] of bySession) {
    let newest = copies[0] as Entry;
    for (const c of copies) if (isNewer(c, newest, activeAccountId)) newest = c;
    chats.push({ sessionId, newest, copies });
  }
  return chats;
}

/** Accounts whose copy moved past the last synced value. Accounts with no recorded value are ignored. */
function changedAccounts(chat: Chat, state: SyncState): string[] {
  const recorded = state.sessions[chat.sessionId];
  if (!recorded) return [];
  const latest = new Map<string, number>();
  for (const c of chat.copies) {
    latest.set(c.accountId, Math.max(latest.get(c.accountId) ?? -Infinity, c.data.lastActivityAt));
  }
  const changed: string[] = [];
  for (const [accountId, at] of latest) {
    const last = recorded[accountId];
    if (last !== undefined && at > last) changed.push(accountId);
  }
  return changed.sort();
}

/**
 * Decides what to write so every account lists every chat. Pure: reads nothing, writes nothing.
 * The active account is not a write target because the running app owns its files. With
 * `includeActive` it becomes an add-only target: chats it has no copy of are copied in, but its
 * existing entries are never updated.
 */
export function buildPlan(input: {
  store: Store;
  activeAccountId: string | null;
  state: SyncState;
  includeActive?: boolean;
}): Plan {
  const { store, activeAccountId, state } = input;
  const includeActive = input.includeActive === true;
  if (activeAccountId === null) {
    throw new ChatsyncError(
      "Cannot tell which account is active in Claude. Open the Claude desktop app, sign in, and try again.",
      2,
    );
  }
  if (!store.accounts.some((a) => a.id === activeAccountId)) {
    throw new ChatsyncError(
      `Signed-in account ${activeAccountId.slice(0, 8)} has no Code chats yet; start one chat under it, then run chatsync again.`,
      2,
    );
  }

  const chats = groupBySession(store, activeAccountId);
  const writes: Write[] = [];
  const conflicts: Conflict[] = [];
  const activeBehind: BehindChat[] = [];
  const skippedAccounts: string[] = [];
  let unchanged = 0;

  for (const account of store.accounts) {
    if ((includeActive || account.id !== activeAccountId) && account.orgs.length === 0) skippedAccounts.push(account.id);
  }

  for (const chat of chats) {
    const { newest } = chat;
    const from = { accountId: newest.accountId, orgId: newest.orgId };

    const activeCopies = chat.copies.filter((c) => c.accountId === activeAccountId);
    const title = newest.data.title ?? chat.sessionId;
    let copiedIntoActive = false;

    for (const account of store.accounts) {
      const isActive = account.id === activeAccountId;
      // The active account only gains chats it has no copy of; it is never updated.
      if (isActive && (!includeActive || activeCopies.length > 0)) continue;
      const populated = account.orgs.filter((o) => o.entries.length > 0);
      const fallback = account.orgs.find((o) => o.id === newest.orgId) ?? account.orgs[0];
      const targets = populated.length > 0 ? populated : fallback ? [fallback] : [];

      for (const org of targets) {
        const here = chat.copies.filter((c) => c.accountId === account.id && c.orgId === org.id);
        if (here.length === 0) {
          writes.push({
            sessionId: chat.sessionId,
            accountId: account.id,
            orgId: org.id,
            kind: "copy",
            from,
            data: newest.data,
          });
          if (isActive) copiedIntoActive = true;
          continue;
        }
        for (const copy of here) {
          if (copy.data.lastActivityAt < newest.data.lastActivityAt) {
            writes.push({
              sessionId: chat.sessionId,
              accountId: account.id,
              orgId: org.id,
              kind: "update",
              from,
              data: newest.data,
            });
          } else {
            unchanged++;
          }
        }
      }
    }

    if (!copiedIntoActive) {
      if (activeCopies.length === 0) {
        activeBehind.push({ sessionId: chat.sessionId, title, reason: "missing" });
      } else if (Math.max(...activeCopies.map((c) => c.data.lastActivityAt)) < newest.data.lastActivityAt) {
        activeBehind.push({ sessionId: chat.sessionId, title, reason: "older" });
      }
    }

    const changed = changedAccounts(chat, state);
    if (changed.length >= 2) {
      conflicts.push({ sessionId: chat.sessionId, title: newest.data.title ?? chat.sessionId, accountIds: changed });
    }
  }

  return { chats, writes, conflicts, unchanged, activeBehind, skippedAccounts };
}
