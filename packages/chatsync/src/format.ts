import { accountLabel, machineName, type ChatsyncConfig } from "./config.js";
import type { BehindChat, Chat, Conflict, Plan, Write } from "./plan.js";

export type OutputCtx = { activeAccountId: string; cfg: ChatsyncConfig; sshNames: Record<string, string> };

export type JsonOutput = {
  activeAccount: string;
  chats: { sessionId: string; title: string; machine: string; accounts: string[]; newestAccount: string }[];
  writes: { sessionId: string; accountId: string; orgId: string; kind: string }[];
  conflicts: Conflict[];
  activeBehind: BehindChat[];
  skippedAccounts: string[];
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const chatTitle = (chat: Chat): string => chat.newest.data.title ?? chat.sessionId;

/** Newest activity first; session id breaks ties so the order is stable. */
function byRecency(a: Chat, b: Chat): number {
  return b.newest.data.lastActivityAt - a.newest.data.lastActivityAt || byText(a.sessionId, b.sessionId);
}

/** Chats grouped by machine name, machines sorted by name, chats most recently active first. */
function groupByMachine(plan: Plan, ctx: OutputCtx): { machine: string; chats: Chat[] }[] {
  const groups = new Map<string, Chat[]>();
  for (const chat of plan.chats) {
    const machine = machineName(chat.newest, ctx.cfg, ctx.sshNames);
    const list = groups.get(machine);
    if (list) list.push(chat);
    else groups.set(machine, [chat]);
  }
  return [...groups.keys()]
    .sort(byText)
    .map((machine) => ({ machine, chats: (groups.get(machine) ?? []).sort(byRecency) }));
}

function accountsHolding(chat: Chat): string[] {
  return [...new Set(chat.copies.map((c) => c.accountId))];
}

/** One `→ copy to X` / `→ update X` per target account, however many orgs it is written into. */
function plannedWrites(chat: Chat, writes: Write[], ctx: OutputCtx): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of writes) {
    if (w.sessionId !== chat.sessionId) continue;
    const label = accountLabel(w.accountId, ctx.cfg);
    const text = w.kind === "copy" ? `→ copy to ${label}` : `→ update ${label}`;
    if (!seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out.sort(byText);
}

function chatLine(chat: Chat, writes: Write[], ctx: OutputCtx): string {
  const holders = accountsHolding(chat)
    .map((id) => ({ id, label: accountLabel(id, ctx.cfg) }))
    .sort((a, b) => byText(a.label, b.label) || byText(a.id, b.id))
    .map(({ id, label }) => (id === chat.newest.accountId ? `${label}*` : label));
  const parts = [`  ${chatTitle(chat)}  [${holders.join(", ")}]`, ...plannedWrites(chat, writes, ctx)];
  return parts.join("  ");
}

export function formatPlan(plan: Plan, ctx: OutputCtx): string {
  const copies = plan.writes.filter((w) => w.kind === "copy").length;
  const updates = plan.writes.length - copies;
  const lines = [`copy ${copies} · update ${updates} · unchanged ${plan.unchanged} · conflicts ${plan.conflicts.length}`];
  for (const c of plan.conflicts) {
    const labels = c.accountIds.map((id) => accountLabel(id, ctx.cfg)).join(", ");
    lines.push(`conflict: "${c.title}" changed in ${labels}`);
  }
  for (const id of plan.skippedAccounts) lines.push(`account ${accountLabel(id, ctx.cfg)} has no org folder; skipped`);
  const behind = plan.activeBehind.length;
  if (behind > 0) {
    lines.push(
      `${behind} ${behind === 1 ? "chat is" : "chats are"} missing or older in the signed-in account. ` +
        "Switch to an account that has them, run chatsync sync, then switch back.",
    );
  }
  return lines.join("\n");
}

/** Per target account counts, e.g. `copy 9 to work, 8 to personal · update 1 to work`. */
export function formatBreakdown(plan: Plan, ctx: OutputCtx): string {
  const parts: string[] = [];
  for (const kind of ["copy", "update"] as const) {
    const counts = new Map<string, number>();
    for (const w of plan.writes) {
      if (w.kind !== kind) continue;
      const label = accountLabel(w.accountId, ctx.cfg);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    const targets = [...counts.keys()].sort(byText).map((label) => `${counts.get(label)} to ${label}`);
    parts.push(`${kind} ${targets.join(", ")}`);
  }
  return parts.join(" · ");
}

export function sortPrompt(plan: Plan, ctx: OutputCtx): string {
  const lines = ["Put my Claude Code chats into sidebar sections by machine:"];
  for (const { machine, chats } of groupByMachine(plan, ctx)) {
    lines.push(`- ${machine}: ${chats.map((c) => JSON.stringify(chatTitle(c))).join(", ")}`);
  }
  return lines.join("\n");
}

export function formatStatus(plan: Plan, ctx: OutputCtx): string {
  const blocks = [`Signed in as: ${accountLabel(ctx.activeAccountId, ctx.cfg)}`];
  for (const { machine, chats } of groupByMachine(plan, ctx)) {
    blocks.push([machine, ...chats.map((c) => chatLine(c, plan.writes, ctx))].join("\n"));
  }
  blocks.push(formatPlan(plan, ctx), sortPrompt(plan, ctx));
  return blocks.join("\n\n");
}

export function toJson(plan: Plan, ctx: OutputCtx): JsonOutput {
  return {
    activeAccount: ctx.activeAccountId,
    chats: [...plan.chats].sort(byRecency).map((chat) => ({
      sessionId: chat.sessionId,
      title: chatTitle(chat),
      machine: machineName(chat.newest, ctx.cfg, ctx.sshNames),
      accounts: accountsHolding(chat).sort(byText),
      newestAccount: chat.newest.accountId,
    })),
    writes: plan.writes.map((w) => ({ sessionId: w.sessionId, accountId: w.accountId, orgId: w.orgId, kind: w.kind })),
    conflicts: plan.conflicts,
    activeBehind: plan.activeBehind,
    skippedAccounts: plan.skippedAccounts,
  };
}
