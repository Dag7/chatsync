import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ChatsyncError } from "./errors.js";
import { sessionsDir } from "./paths.js";

export type EntryData = {
  sessionId: string;
  lastActivityAt: number;
  title?: string;
  isArchived?: boolean;
  sshConfig?: { sshHost?: string };
  [k: string]: unknown;
};

export type Entry = { accountId: string; orgId: string; file: string; data: EntryData };

export type Store = { accounts: { id: string; orgs: { id: string; dir: string; entries: Entry[] }[] }[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRY_FILE = /^local_.*\.json$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Names of UUID-named subfolders of `dir`. Dotfiles are skipped; anything else is an unrecognized layout. */
function uuidFolders(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (!UUID.test(name) || !statSync(path).isDirectory()) {
      throw new ChatsyncError(`Unrecognized item in the app's data folder: ${path} (expected a UUID-named folder)`, 2);
    }
    out.push(name);
  }
  return out;
}

function readEntry(file: string, accountId: string, orgId: string): Entry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err: unknown) {
    throw new ChatsyncError(`Cannot read sidebar entry ${file}: ${describeError(err)}`, 2);
  }
  if (!isRecord(parsed) || typeof parsed.sessionId !== "string" || typeof parsed.lastActivityAt !== "number") {
    throw new ChatsyncError(
      `Unrecognized sidebar entry ${file}: expected string "sessionId" and number "lastActivityAt"`,
      2,
    );
  }
  return { accountId, orgId, file, data: parsed as EntryData };
}

/** Reads every `local_*.json` entry under `<appDir>/claude-code-sessions/<account>/<org>/`. */
export function loadStore(appDir: string): Store {
  const root = sessionsDir(appDir);
  if (!existsSync(root)) return { accounts: [] };
  const accounts: Store["accounts"] = [];
  for (const accountId of uuidFolders(root)) {
    const orgs: Store["accounts"][number]["orgs"] = [];
    for (const orgId of uuidFolders(join(root, accountId))) {
      const dir = join(root, accountId, orgId);
      const entries: Entry[] = [];
      for (const name of readdirSync(dir).sort()) {
        if (!ENTRY_FILE.test(name)) continue;
        const file = join(dir, name);
        if (!statSync(file).isFile()) continue;
        entries.push(readEntry(file, accountId, orgId));
      }
      orgs.push({ id: orgId, dir, entries });
    }
    accounts.push({ id: accountId, orgs });
  }
  return { accounts };
}

function readJsonObject(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err: unknown) {
    throw new ChatsyncError(`Cannot read ${file}: ${describeError(err)}`, 2);
  }
  if (!isRecord(parsed)) throw new ChatsyncError(`Unrecognized format in ${file}: expected a JSON object`, 2);
  return parsed;
}

/** The account the desktop app last signed in with, or null when unknown. */
export function readActiveAccount(appDir: string): string | null {
  const config = readJsonObject(join(appDir, "config.json"));
  const id = config?.lastKnownAccountUuid;
  return typeof id === "string" ? id : null;
}

/** Maps SSH host aliases (`sshHost`) to the friendly names shown in the app. `{}` if not configured. */
export function readSshNames(appDir: string): Record<string, string> {
  const file = readJsonObject(join(appDir, "ssh_configs.json"));
  const names: Record<string, string> = {};
  const configs = file?.configs;
  if (!Array.isArray(configs)) return names;
  for (const c of configs) {
    if (isRecord(c) && typeof c.sshHost === "string" && typeof c.name === "string") names[c.sshHost] = c.name;
  }
  return names;
}
