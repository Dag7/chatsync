import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatsyncError } from "./errors.js";
import { writeFileAtomic } from "./fs-util.js";
import type { Entry } from "./store.js";

/** The user's own names: account id -> nickname, and ssh host -> machine name override. */
export type ChatsyncConfig = { accounts: Record<string, string>; machines: Record<string, string> };

const configFile = (home: string): string => join(home, "config.json");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringMap(v: unknown): Record<string, string> | null {
  if (v === undefined) return {};
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") return null;
    out[k] = val;
  }
  return out;
}

/**
 * Reads `<home>/config.json`. A missing file is an empty config. The file is the user's own,
 * so an unreadable one is an error rather than silently discarded.
 */
export function loadConfig(home: string): ChatsyncConfig {
  const file = configFile(home);
  if (!existsSync(file)) return { accounts: {}, machines: {} };
  const bad = (why: string): ChatsyncError => new ChatsyncError(`Cannot read ${file}: ${why}`, 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err: unknown) {
    throw bad(err instanceof Error ? err.message : String(err));
  }
  if (!isRecord(parsed)) throw bad("expected a JSON object");
  const accounts = stringMap(parsed.accounts);
  if (!accounts) throw bad('"accounts" must map account ids to nickname strings');
  const machines = stringMap(parsed.machines);
  if (!machines) throw bad('"machines" must map ssh hosts to name strings');
  return { accounts, machines };
}

export function saveConfig(home: string, cfg: ChatsyncConfig): void {
  try {
    mkdirSync(home, { recursive: true });
    writeFileAtomic(configFile(home), JSON.stringify(cfg, null, 2) + "\n");
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ChatsyncError(`Cannot save config to ${configFile(home)}: ${reason}`, 1);
  }
}

/** The account's nickname, else the first 8 characters of its id. */
export function accountLabel(id: string, cfg: ChatsyncConfig): string {
  return cfg.accounts[id] ?? id.slice(0, 8);
}

/** Override > name from the app's ssh_configs.json > the raw ssh host; `local` when there is no ssh host. */
export function machineName(entry: Entry, cfg: ChatsyncConfig, sshNames: Record<string, string>): string {
  const host = entry.data.sshConfig?.sshHost;
  if (host === undefined) return "local";
  return cfg.machines[host] ?? sshNames[host] ?? host;
}
