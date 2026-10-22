import { describe, expect, it } from "vitest";
import { buildPlan, type SyncState } from "./plan.js";
import type { Entry, EntryData, Store } from "./store.js";
import { A, B, C, entry, ORG1, ORG2 } from "./test-helpers.js";

type OrgSpec = Record<string, EntryData[]>;

/** Builds an in-memory store: account id -> org id -> entries. */
function makeStore(spec: Record<string, OrgSpec>): Store {
  return {
    accounts: Object.entries(spec).map(([accountId, orgs]) => ({
      id: accountId,
      orgs: Object.entries(orgs).map(([orgId, datas]) => ({
        id: orgId,
        dir: `/mem/${accountId}/${orgId}`,
        entries: datas.map(
          (data): Entry => ({ accountId, orgId, file: `/mem/${accountId}/${orgId}/${data.sessionId}.json`, data }),
        ),
      })),
    })),
  };
}

const noState: SyncState = { sessions: {} };

describe("buildPlan", () => {
  it("copies a chat only in A to inactive B", () => {
    const store = makeStore({ [A]: { [ORG1]: [entry({ id: "s1", at: 100, title: "Hi" })] }, [B]: { [ORG1]: [] } });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    expect(plan.writes).toEqual([
      {
        sessionId: "s1",
        accountId: B,
        orgId: ORG1,
        kind: "copy",
        from: { accountId: A, orgId: ORG1 },
        data: entry({ id: "s1", at: 100, title: "Hi" }),
      },
    ]);
    expect(plan.chats).toHaveLength(1);
    expect(plan.chats[0]?.sessionId).toBe("s1");
    expect(plan.conflicts).toEqual([]);
  });

  it("round trip A to B to A", () => {
    const first = makeStore({
      [A]: { [ORG1]: [entry({ id: "s1", at: 100, title: "old" })] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 200, title: "new" })] },
    });
    const p1 = buildPlan({ store: first, activeAccountId: B, state: noState });
    expect(p1.writes).toHaveLength(1);
    expect(p1.writes[0]).toMatchObject({
      accountId: A,
      orgId: ORG1,
      kind: "update",
      from: { accountId: B, orgId: ORG1 },
      data: entry({ id: "s1", at: 200, title: "new" }),
    });

    const second = makeStore({
      [A]: { [ORG1]: [entry({ id: "s1", at: 200, title: "new" })] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 200, title: "new" })] },
    });
    const p2 = buildPlan({ store: second, activeAccountId: B, state: noState });
    expect(p2.writes).toEqual([]);
    expect(p2.unchanged).toBe(1);
  });

  it("never writes the active account", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 500 })] },
      [C]: { [ORG1]: [] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    expect(plan.writes.map((w) => [w.accountId, w.kind])).toEqual([[C, "copy"]]);
    expect(plan.writes.filter((w) => w.accountId === A)).toEqual([]);
  });

  it("updates a stale copy and copies into another populated org of the same account", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "s1", at: 200 })] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 100 })], [ORG2]: [entry({ id: "other", at: 1 })] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    const s1 = plan.writes.filter((w) => w.sessionId === "s1");
    expect(s1.map((w) => [w.accountId, w.orgId, w.kind])).toEqual([
      [B, ORG1, "update"],
      [B, ORG2, "copy"],
    ]);
  });

  it("updates only the older of two copies in one inactive account", () => {
    const store = makeStore({
      [A]: { [ORG1]: [] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 100 })], [ORG2]: [entry({ id: "s1", at: 300 })] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    expect(plan.writes.map((w) => [w.accountId, w.orgId, w.kind, w.from.orgId])).toEqual([
      [B, ORG1, "update", ORG2],
    ]);
    expect(plan.unchanged).toBe(1);
  });

  it("writes to every org of the target that has chats", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
      [B]: { [ORG1]: [entry({ id: "other", at: 1 })], [ORG2]: [entry({ id: "other2", at: 1 })] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    const s1 = plan.writes.filter((w) => w.sessionId === "s1");
    expect(s1.map((w) => [w.accountId, w.orgId, w.kind])).toEqual([
      [B, ORG1, "copy"],
      [B, ORG2, "copy"],
    ]);
  });

  it("target with no populated org uses source org id", () => {
    const store = makeStore({
      [A]: { [ORG2]: [entry({ id: "s1", at: 100 })] },
      [B]: { [ORG1]: [], [ORG2]: [] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    expect(plan.writes.map((w) => [w.accountId, w.orgId])).toEqual([[B, ORG2]]);
  });

  it("falls back to the first org when the source org id is absent in an empty target", () => {
    const store = makeStore({
      [A]: { [ORG2]: [entry({ id: "s1", at: 100 })] },
      [B]: { [ORG1]: [] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    expect(plan.writes.map((w) => [w.accountId, w.orgId])).toEqual([[B, ORG1]]);
  });

  it("skips a target account that has no orgs", () => {
    const store = makeStore({ [A]: { [ORG1]: [entry({ id: "s1", at: 100 })] }, [B]: {} });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    expect(plan.writes).toEqual([]);
  });

  it("archived newest copy propagates isArchived", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 200, archived: true })] },
    });
    const plan = buildPlan({ store, activeAccountId: B, state: noState });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.data.isArchived).toBe(true);
  });

  it("preserves unknown fields on the written data", () => {
    const rich: EntryData = { ...entry({ id: "s1", at: 100 }), cwd: "/x", extra: { n: 1 } };
    const store = makeStore({ [A]: { [ORG1]: [rich] }, [B]: { [ORG1]: [] } });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    expect(plan.writes[0]?.data).toBe(rich);
  });

  it("conflict when two accounts changed since last state", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "s1", at: 150, title: "from A" })] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 160, title: "from B" })] },
      [C]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
    });
    const state: SyncState = { sessions: { s1: { [A]: 100, [B]: 100 } } };
    const plan = buildPlan({ store, activeAccountId: C, state });
    expect(plan.conflicts).toEqual([{ sessionId: "s1", title: "from B", accountIds: [A, B] }]);
    expect(plan.chats[0]?.newest.accountId).toBe(B);
  });

  it("no conflict when only one account changed", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "s1", at: 150 })] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
    });
    const state: SyncState = { sessions: { s1: { [A]: 100, [B]: 100 } } };
    expect(buildPlan({ store, activeAccountId: B, state }).conflicts).toEqual([]);
  });

  it("accounts without a state value do not count towards conflicts", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "s1", at: 150 })] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 160 })] },
    });
    const state: SyncState = { sessions: { s1: { [A]: 100 } } };
    expect(buildPlan({ store, activeAccountId: B, state }).conflicts).toEqual([]);
  });

  it("breaks ties on newest by active account first, then account id", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
      [C]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
    });
    expect(buildPlan({ store, activeAccountId: C, state: noState }).chats[0]?.newest.accountId).toBe(C);
    expect(buildPlan({ store, activeAccountId: B, state: noState }).chats[0]?.newest.accountId).toBe(B);
  });

  it("breaks ties between inactive accounts by account id when the active account has no copy", () => {
    const store = makeStore({
      [C]: { [ORG1]: [] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
      [A]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
    });
    expect(buildPlan({ store, activeAccountId: C, state: noState }).chats[0]?.newest.accountId).toBe(A);
  });

  it("throws exit 2 for a null active account", () => {
    const store = makeStore({ [A]: { [ORG1]: [] } });
    const run = () => buildPlan({ store, activeAccountId: null, state: noState });
    expect(run).toThrow(expect.objectContaining({ name: "ChatsyncError", exitCode: 2 }));
    expect(run).toThrow(/Cannot tell which account is active in Claude/);
  });

  it("explains that a signed-in account without a sessions folder has no Code chats yet", () => {
    const store = makeStore({ [A]: { [ORG1]: [] } });
    const run = () => buildPlan({ store, activeAccountId: C, state: noState });
    expect(run).toThrow(expect.objectContaining({ name: "ChatsyncError", exitCode: 2 }));
    expect(run).toThrow("Signed-in account cccccccc has no Code chats yet; start one chat under it, then run chatsync again.");
  });

  it("reports chats the signed-in account is missing or holds an older copy of", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "x", at: 10, title: "X" })] },
      [B]: { [ORG1]: [entry({ id: "x", at: 20, title: "X" }), entry({ id: "y", at: 5, title: "Y" })] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    expect(plan.writes).toEqual([]);
    expect(plan.unchanged).toBe(2);
    expect(plan.activeBehind).toEqual([
      { sessionId: "x", title: "X", reason: "older" },
      { sessionId: "y", title: "Y", reason: "missing" },
    ]);
  });

  it("has nothing behind when the signed-in account holds the newest copies", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "x", at: 20 })] },
      [B]: { [ORG1]: [entry({ id: "x", at: 20 })] },
    });
    expect(buildPlan({ store, activeAccountId: A, state: noState }).activeBehind).toEqual([]);
  });

  it("lists inactive accounts without an org folder as skipped", () => {
    const store = makeStore({ [A]: { [ORG1]: [entry({ id: "s1", at: 100 })] }, [B]: {}, [C]: { [ORG1]: [] } });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    expect(plan.skippedAccounts).toEqual([B]);
    expect(plan.writes.map((w) => w.accountId)).toEqual([C]);
  });
});
