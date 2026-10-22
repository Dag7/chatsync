import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountLabel, loadConfig, machineName, saveConfig, type ChatsyncConfig } from "./config.js";
import { ChatsyncError } from "./errors.js";
import { formatBreakdown, formatPlan, formatStatus, sortPrompt, toJson, type OutputCtx } from "./format.js";
import { buildPlan } from "./plan.js";
import type { Entry, EntryData, Store } from "./store.js";
import { A, B, C, entry, ORG1, ORG2, tmpDir } from "./test-helpers.js";

const noCfg: ChatsyncConfig = { accounts: {}, machines: {} };

function makeEntry(accountId: string, data: EntryData): Entry {
  return { accountId, orgId: ORG1, file: `/mem/${accountId}/${data.sessionId}.json`, data };
}

/** One org per account; account id -> entries. */
function makeStore(spec: Record<string, EntryData[]>): Store {
  return {
    accounts: Object.entries(spec).map(([id, datas]) => ({
      id,
      orgs: [{ id: ORG1, dir: `/mem/${id}`, entries: datas.map((d) => makeEntry(id, d)) }],
    })),
  };
}

const plan = (spec: Record<string, EntryData[]>) =>
  buildPlan({ store: makeStore(spec), activeAccountId: A, state: { sessions: {} } });

const ctx: OutputCtx = {
  activeAccountId: A,
  cfg: { accounts: { [A]: "home", [B]: "work" }, machines: { "ws-gad-link": "link" } },
  sshNames: { "ws-gad-yoshi": "yoshi" },
};

/** A has two chats (link, yoshi) plus one without a title; B holds an older copy of the yoshi chat. */
function fixturePlan() {
  return plan({
    [A]: [
      entry({ id: "s-link", at: 300, title: "Fix build", host: "ws-gad-link" }),
      entry({ id: "s-yoshi", at: 200, title: "Deploy", host: "ws-gad-yoshi" }),
      entry({ id: "s-local", at: 100 }),
    ],
    [B]: [entry({ id: "s-yoshi", at: 50, title: "Deploy", host: "ws-gad-yoshi" })],
  });
}

describe("machineName", () => {
  const e = (host?: string) => makeEntry(A, entry({ id: "s", at: 1, host }));

  it("prefers override, then ssh_configs name, then the raw host", () => {
    const cfg: ChatsyncConfig = { accounts: {}, machines: { h1: "override" } };
    const ssh = { h1: "from-ssh", h2: "from-ssh-2" };
    expect(machineName(e("h1"), cfg, ssh)).toBe("override");
    expect(machineName(e("h2"), cfg, ssh)).toBe("from-ssh-2");
    expect(machineName(e("h3"), cfg, ssh)).toBe("h3");
  });

  it("is local without an ssh host", () => {
    expect(machineName(e(), noCfg, {})).toBe("local");
  });
});

describe("accountLabel", () => {
  it("uses the nickname, else the first 8 characters", () => {
    expect(accountLabel(A, { accounts: { [A]: "home" }, machines: {} })).toBe("home");
    expect(accountLabel(B, noCfg)).toBe("bbbbbbbb");
  });
});

describe("formatStatus", () => {
  it("groups by machine, marks the newest copy and shows planned writes", () => {
    const out = formatStatus(fixturePlan(), ctx);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Signed in as: home");
    const link = lines.indexOf("link");
    const local = lines.indexOf("local");
    const yoshi = lines.indexOf("yoshi");
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(local);
    expect(local).toBeLessThan(yoshi);
    expect(out).toContain("Fix build  [home*]  → copy to work");
    expect(out).toContain("Deploy  [home*, work]  → update work");
    expect(out).toContain("s-local  [home*]  → copy to work");
    expect(out).toContain("copy 2 · update 1 · unchanged 0 · conflicts 0");
    expect(out).toContain("Put my Claude Code chats into sidebar sections by machine:");
  });

  it("orders chats newest first within a machine and omits arrows when nothing is planned", () => {
    const p = plan({
      [A]: [
        entry({ id: "old", at: 1, title: "Old", host: "h" }),
        entry({ id: "new", at: 2, title: "New", host: "h" }),
      ],
      [B]: [
        entry({ id: "old", at: 1, title: "Old", host: "h" }),
        entry({ id: "new", at: 2, title: "New", host: "h" }),
      ],
    });
    const out = formatStatus(p, ctx);
    expect(out.indexOf("New  [")).toBeLessThan(out.indexOf("Old  ["));
    expect(out).not.toContain("→ copy");
    expect(out).not.toContain("→ update");
  });

  it("mentions each target account once per chat even with several orgs", () => {
    const other = entry({ id: "other", at: 1, title: "Other" });
    const store = makeStore({ [A]: [entry({ id: "s", at: 5, title: "T" }), other], [B]: [other] });
    // B is populated in two orgs, so the planner writes the chat into both.
    store.accounts[1]?.orgs.push({ id: ORG2, dir: "/mem/b2", entries: [{ ...makeEntry(B, other), orgId: ORG2 }] });
    const p = buildPlan({ store, activeAccountId: A, state: { sessions: {} } });
    expect(p.writes.length).toBe(2);
    const out = formatStatus(p, ctx);
    expect(out.match(/→ copy to work/g)?.length).toBe(1);
  });
});

describe("formatPlan", () => {
  it("counts copies, updates, unchanged and conflicts on the first line", () => {
    const p = plan({
      [A]: [entry({ id: "s1", at: 10 }), entry({ id: "s2", at: 20 })],
      [B]: [entry({ id: "s2", at: 5 })],
    });
    expect(formatPlan(p, ctx).split("\n")[0]).toBe("copy 1 · update 1 · unchanged 0 · conflicts 0");
  });

  it("adds one line per conflict", () => {
    const p = buildPlan({
      store: makeStore({
        [A]: [entry({ id: "s", at: 30, title: "Both" })],
        [B]: [entry({ id: "s", at: 20, title: "Both" })],
      }),
      activeAccountId: A,
      state: { sessions: { s: { [A]: 10, [B]: 10 } } },
    });
    const lines = formatPlan(p, ctx).split("\n");
    expect(lines[0]).toBe("copy 0 · update 1 · unchanged 0 · conflicts 1");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('conflict: "Both" changed in home, work');
  });
});

describe("active account behind and skipped accounts", () => {
  const BEHIND_LINE =
    "chats are missing or older in the signed-in account. Switch to an account that has them, run chatsync sync, then switch back.";
  const behindPlan = () =>
    plan({
      [A]: [entry({ id: "x", at: 10, title: "X" })],
      [B]: [entry({ id: "x", at: 20, title: "X" }), entry({ id: "y", at: 5, title: "Y" })],
    });

  it("formatPlan and formatStatus print the behind line", () => {
    const p = behindPlan();
    expect(formatPlan(p, ctx).split("\n")).toEqual([
      "copy 0 · update 0 · unchanged 2 · conflicts 0",
      `2 ${BEHIND_LINE}`,
    ]);
    expect(formatStatus(p, ctx)).toContain(`2 ${BEHIND_LINE}`);
  });

  it("uses the singular for one chat and prints nothing when none are behind", () => {
    const one = plan({ [A]: [entry({ id: "x", at: 10 })], [B]: [entry({ id: "x", at: 20 })] });
    expect(formatPlan(one, ctx)).toContain("1 chat is missing or older in the signed-in account.");
    expect(formatPlan(fixturePlan(), ctx)).not.toContain("signed-in account");
  });

  it("toJson includes activeBehind and skippedAccounts", () => {
    const store = makeStore({ [A]: [entry({ id: "x", at: 10 })], [B]: [entry({ id: "x", at: 20 })] });
    store.accounts.push({ id: C, orgs: [] });
    const json = toJson(buildPlan({ store, activeAccountId: A, state: { sessions: {} } }), ctx);
    expect(json.activeBehind).toEqual([{ sessionId: "x", title: "x", reason: "older" }]);
    expect(json.skippedAccounts).toEqual([C]);
  });

  it("prints a line for each skipped account", () => {
    const store = makeStore({ [A]: [entry({ id: "x", at: 10 })] });
    store.accounts.push({ id: B, orgs: [] });
    const out = formatPlan(buildPlan({ store, activeAccountId: A, state: { sessions: {} } }), ctx);
    expect(out).toContain("account work has no org folder; skipped");
  });
});

describe("formatBreakdown", () => {
  it("counts copies and updates per target account", () => {
    const p = plan({
      [A]: [entry({ id: "s1", at: 10 }), entry({ id: "s2", at: 20 }), entry({ id: "s3", at: 30 })],
      [B]: [entry({ id: "s2", at: 5 })],
      [C]: [],
    });
    expect(formatBreakdown(p, ctx)).toBe("copy 3 to cccccccc, 2 to work · update 1 to work");
  });
});

describe("sortPrompt", () => {
  it("lists each machine once with its chat titles", () => {
    const lines = sortPrompt(fixturePlan(), ctx).split("\n");
    expect(lines[0]).toBe("Put my Claude Code chats into sidebar sections by machine:");
    expect(lines.slice(1)).toEqual(['- link: "Fix build"', '- local: "s-local"', '- yoshi: "Deploy"']);
  });
});

describe("toJson", () => {
  it("has the documented shape", () => {
    const json = toJson(fixturePlan(), ctx);
    expect(json.activeAccount).toBe(A);
    expect(json.chats).toContainEqual({
      sessionId: "s-yoshi",
      title: "Deploy",
      machine: "yoshi",
      accounts: [A, B],
      newestAccount: A,
    });
    expect(json.writes).toContainEqual({ sessionId: "s-yoshi", accountId: B, orgId: ORG1, kind: "update" });
    expect(json.writes).toHaveLength(3);
    expect(json.conflicts).toEqual([]);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe("config", () => {
  it("round trips through save and load", () => {
    const home = tmpDir();
    const cfg: ChatsyncConfig = { accounts: { [A]: "home" }, machines: { h: "box" } };
    saveConfig(home, cfg);
    expect(loadConfig(home)).toEqual(cfg);
    expect(readFileSync(join(home, "config.json"), "utf8").endsWith("\n")).toBe(true);
  });

  it("creates the home folder when saving", () => {
    const home = join(tmpDir(), "nested", ".chatsync");
    saveConfig(home, noCfg);
    expect(loadConfig(home)).toEqual(noCfg);
  });

  it("returns empty config when the file is missing", () => {
    expect(loadConfig(tmpDir())).toEqual({ accounts: {}, machines: {} });
  });

  it("fills missing sections", () => {
    const home = tmpDir();
    writeFileSync(join(home, "config.json"), JSON.stringify({ accounts: { [C]: "x" } }));
    expect(loadConfig(home)).toEqual({ accounts: { [C]: "x" }, machines: {} });
  });

  it("throws a ChatsyncError naming the path for an unparsable or malformed file", () => {
    const home = tmpDir();
    const file = join(home, "config.json");
    for (const bad of ["{not json", "[]", JSON.stringify({ accounts: { a: 1 } })]) {
      writeFileSync(file, bad);
      const run = () => loadConfig(home);
      expect(run).toThrow(ChatsyncError);
      expect(run).toThrow(file);
    }
  });
});
