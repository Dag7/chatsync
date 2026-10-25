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
    expect(plan.writes[0]?.data).toEqual(rich);
  });

  describe("account-bound fields", () => {
    const bound = {
      sshReattach: { host: "h" },
      sshRemoteProcessId: 99,
      error: "quota exhausted",
      errorAt: 5,
      errorRows: ["r"],
      priorErrorMark: 7,
    };
    const rich = (): EntryData => ({ ...entry({ id: "s1", at: 100, title: "T" }), ...bound, cwd: "/x", extra: { n: 1 } });

    it("a cross-account copy has none of the six keys and keeps other fields", () => {
      const store = makeStore({ [A]: { [ORG1]: [rich()] }, [B]: { [ORG1]: [] } });
      const plan = buildPlan({ store, activeAccountId: A, state: noState });
      const data = plan.writes[0]?.data ?? {};
      for (const k of Object.keys(bound)) expect(data).not.toHaveProperty(k);
      expect(data).toEqual({ ...entry({ id: "s1", at: 100, title: "T" }), cwd: "/x", extra: { n: 1 } });
    });

    it("a cross-account update is stripped too", () => {
      const store = makeStore({
        [A]: { [ORG1]: [{ ...rich(), lastActivityAt: 300 }] },
        [B]: { [ORG1]: [{ ...entry({ id: "s1", at: 100 }), error: "old" }] },
        [C]: { [ORG1]: [] },
      });
      const plan = buildPlan({ store, activeAccountId: C, state: noState });
      const w = plan.writes.find((x) => x.accountId === B);
      expect(w?.kind).toBe("update");
      for (const k of Object.keys(bound)) expect(w?.data).not.toHaveProperty(k);
    });

    it("an --include-active copy into the signed-in account is stripped", () => {
      const store = makeStore({ [A]: { [ORG1]: [] }, [B]: { [ORG1]: [rich()] } });
      const plan = buildPlan({ store, activeAccountId: A, state: noState, includeActive: true });
      const w = plan.writes.find((x) => x.accountId === A);
      expect(w?.kind).toBe("copy");
      for (const k of Object.keys(bound)) expect(w?.data).not.toHaveProperty(k);
    });

    it("a copy into another org of the same account keeps them unchanged", () => {
      const src = rich();
      const store = makeStore({ [A]: { [ORG1]: [src], [ORG2]: [entry({ id: "s2", at: 1 })] }, [B]: { [ORG1]: [] } });
      const plan = buildPlan({ store, activeAccountId: B, state: noState });
      const w = plan.writes.find((x) => x.accountId === A && x.orgId === ORG2 && x.sessionId === "s1");
      expect(w?.kind).toBe("copy");
      expect(w?.data).toBe(src);
      expect(w?.data).toHaveProperty("sshReattach");
    });

    it("does not mutate the source entry", () => {
      const src = rich();
      const snapshot = JSON.parse(JSON.stringify(src)) as unknown;
      const store = makeStore({ [A]: { [ORG1]: [src] }, [B]: { [ORG1]: [] } });
      buildPlan({ store, activeAccountId: A, state: noState });
      expect(src).toEqual(snapshot);
      expect(store.accounts[0]?.orgs[0]?.entries[0]?.data).toBe(src);
    });
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

describe("buildPlan includeActive", () => {
  it("adds a copy into the signed-in account for a chat it is missing", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "mine", at: 50, title: "Mine" })] },
      [B]: { [ORG1]: [entry({ id: "theirs", at: 100, title: "Theirs" })] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState, includeActive: true });
    expect(plan.writes).toEqual([
      {
        sessionId: "mine",
        accountId: B,
        orgId: ORG1,
        kind: "copy",
        from: { accountId: A, orgId: ORG1 },
        data: entry({ id: "mine", at: 50, title: "Mine" }),
      },
      {
        sessionId: "theirs",
        accountId: A,
        orgId: ORG1,
        kind: "copy",
        from: { accountId: B, orgId: ORG1 },
        data: entry({ id: "theirs", at: 100, title: "Theirs" }),
      },
    ]);
    expect(plan.activeBehind).toEqual([]);
  });

  it("never updates the signed-in account's older copy; it stays behind as older", () => {
    const store = makeStore({
      [A]: { [ORG1]: [entry({ id: "x", at: 10, title: "X" })] },
      [B]: { [ORG1]: [entry({ id: "x", at: 20, title: "X" }), entry({ id: "y", at: 5, title: "Y" })] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState, includeActive: true });
    expect(plan.writes).toEqual([
      {
        sessionId: "y",
        accountId: A,
        orgId: ORG1,
        kind: "copy",
        from: { accountId: B, orgId: ORG1 },
        data: entry({ id: "y", at: 5, title: "Y" }),
      },
    ]);
    expect(plan.writes.filter((w) => w.accountId === A && w.kind === "update")).toEqual([]);
    expect(plan.activeBehind).toEqual([{ sessionId: "x", title: "X", reason: "older" }]);
  });

  it("uses the same target-org rule as inactive accounts", () => {
    const store = makeStore({
      [A]: { [ORG1]: [], [ORG2]: [entry({ id: "keep", at: 1 })] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 100 })] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState, includeActive: true });
    // Only ORG2 has entries, so it is the only populated target.
    expect(plan.writes.filter((w) => w.accountId === A).map((w) => [w.sessionId, w.orgId])).toEqual([["s1", ORG2]]);

    const empty = makeStore({ [A]: { [ORG1]: [], [ORG2]: [] }, [B]: { [ORG2]: [entry({ id: "s1", at: 100 })] } });
    const p2 = buildPlan({ store: empty, activeAccountId: A, state: noState, includeActive: true });
    // No populated org: falls back to the org matching the newest copy's org.
    expect(p2.writes.filter((w) => w.accountId === A).map((w) => w.orgId)).toEqual([ORG2]);

    const first = makeStore({ [A]: { [ORG1]: [], [ORG2]: [] }, [B]: { [C]: [entry({ id: "s1", at: 100 })] } });
    const p3 = buildPlan({ store: first, activeAccountId: A, state: noState, includeActive: true });
    expect(p3.writes.filter((w) => w.accountId === A).map((w) => w.orgId)).toEqual([ORG1]);
  });

  it("skips a signed-in account with no org folder and keeps the chat behind", () => {
    const store = makeStore({ [A]: {}, [B]: { [ORG1]: [entry({ id: "s1", at: 100, title: "S" })] } });
    const plan = buildPlan({ store, activeAccountId: A, state: noState, includeActive: true });
    expect(plan.writes.filter((w) => w.accountId === A)).toEqual([]);
    expect(plan.skippedAccounts).toEqual([A]);
    expect(plan.activeBehind).toEqual([{ sessionId: "s1", title: "S", reason: "missing" }]);
  });

  it("without the option the signed-in account is untouched and still reported", () => {
    const store = makeStore({
      [A]: { [ORG1]: [] },
      [B]: { [ORG1]: [entry({ id: "s1", at: 100, title: "S" })] },
    });
    const plan = buildPlan({ store, activeAccountId: A, state: noState });
    expect(plan.writes).toEqual([]);
    expect(plan.activeBehind).toEqual([{ sessionId: "s1", title: "S", reason: "missing" }]);
    const off = buildPlan({ store, activeAccountId: A, state: noState, includeActive: false });
    expect(off).toEqual(plan);
  });
});
