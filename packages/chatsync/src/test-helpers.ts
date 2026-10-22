import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryData } from "./store.js";

export const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const ORG1 = "11111111-1111-4111-8111-111111111111";
export const ORG2 = "22222222-2222-4222-8222-222222222222";

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "chatsync-test-"));
}

export function entry(o: { id: string; at: number; title?: string; host?: string; archived?: boolean }): EntryData {
  const data: EntryData = { sessionId: o.id, lastActivityAt: o.at };
  if (o.title !== undefined) data.title = o.title;
  if (o.archived !== undefined) data.isArchived = o.archived;
  if (o.host !== undefined) data.sshConfig = { sshHost: o.host };
  return data;
}

/** Builds a fake app data dir under `root`; each entry is written as `<sessionId>.json`. */
export function makeAppDir(
  root: string,
  spec: {
    active?: string;
    accounts: Record<string, Record<string, EntryData[]>>;
    sshConfigs?: { name: string; sshHost: string }[];
  },
): string {
  const appDir = join(root, "Claude");
  mkdirSync(appDir, { recursive: true });
  if (spec.active !== undefined) {
    writeFileSync(join(appDir, "config.json"), JSON.stringify({ lastKnownAccountUuid: spec.active }));
  }
  if (spec.sshConfigs) {
    const configs = spec.sshConfigs.map((c, i) => ({ ...c, id: `id-${i}` }));
    writeFileSync(join(appDir, "ssh_configs.json"), JSON.stringify({ configs, trustedHosts: [] }));
  }
  for (const [account, orgs] of Object.entries(spec.accounts)) {
    for (const [org, entries] of Object.entries(orgs)) {
      const dir = join(appDir, "claude-code-sessions", account, org);
      mkdirSync(dir, { recursive: true });
      for (const e of entries) writeFileSync(join(dir, `${e.sessionId}.json`), JSON.stringify(e));
    }
  }
  return appDir;
}
