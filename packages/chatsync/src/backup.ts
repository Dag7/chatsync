import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ChatsyncError } from "./errors.js";

export type BackupInfo = { name: string; path: string; chatCount: number };

const PARTIAL = ".partial";
const OLD_SUFFIX = ".chatsync-old";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD_HHMMSS` in local time. */
function timestampName(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Copies the whole sessions folder into `backupsDir`, returning the new backup's name. */
export function createBackup(o: { sessionsDir: string; backupsDir: string; now?: Date }): string {
  if (!isDir(o.sessionsDir)) throw new ChatsyncError(`Nothing to back up: ${o.sessionsDir} does not exist`, 1);
  const base = timestampName(o.now ?? new Date());
  mkdirSync(o.backupsDir, { recursive: true });
  let name = base;
  for (let n = 2; existsSync(join(o.backupsDir, name)) || existsSync(join(o.backupsDir, name + PARTIAL)); n++) {
    name = `${base}-${n}`;
  }
  const finalPath = join(o.backupsDir, name);
  const partialPath = finalPath + PARTIAL;
  try {
    cpSync(o.sessionsDir, partialPath, { recursive: true });
    renameSync(partialPath, finalPath);
  } catch (err: unknown) {
    rmSync(partialPath, { recursive: true, force: true });
    const reason = err instanceof Error ? err.message : String(err);
    throw new ChatsyncError(`Backup failed: ${reason}`, 1);
  }
  return name;
}

function countChats(dir: string): number {
  let count = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) count += countChats(join(dir, e.name));
    else if (e.isFile() && e.name.startsWith("local_") && e.name.endsWith(".json")) count++;
  }
  return count;
}

/** Sort key: timestamp, then collision counter (`-2`, `-3`, … compared numerically). */
function parseName(name: string): { base: string; n: number } {
  const m = /^(.*?)(?:-(\d+))?$/.exec(name);
  return { base: m?.[1] ?? name, n: m?.[2] ? Number(m[2]) : 1 };
}

function compareNewestFirst(a: string, b: string): number {
  const pa = parseName(a);
  const pb = parseName(b);
  if (pa.base !== pb.base) return pa.base < pb.base ? 1 : -1;
  return pb.n - pa.n;
}

/** Backups newest first. A missing directory means no backups. */
export function listBackups(backupsDir: string): BackupInfo[] {
  let names: string[];
  try {
    names = readdirSync(backupsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.endsWith(PARTIAL))
      .map((e) => e.name);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    const reason = err instanceof Error ? err.message : String(err);
    throw new ChatsyncError(`Cannot read backups folder: ${reason}`, 1);
  }
  return names.sort(compareNewestFirst).map((name) => {
    const path = join(backupsDir, name);
    return { name, path, chatCount: countChats(path) };
  });
}

/** Deletes all but the `keep` newest backups; returns the removed names. */
export function pruneBackups(backupsDir: string, keep = 20): string[] {
  const removed: string[] = [];
  for (const b of listBackups(backupsDir).slice(keep)) {
    rmSync(b.path, { recursive: true, force: true });
    removed.push(b.name);
  }
  return removed;
}

/**
 * Replaces the sessions folder with a backup. The current folder is backed up first, then swapped
 * out by rename, so a failed copy-in puts the old folder back.
 */
export function restoreBackup(o: {
  name: string;
  sessionsDir: string;
  backupsDir: string;
  isAppRunning: () => boolean;
  now?: Date;
}): { safetyBackup: string } {
  if (o.isAppRunning()) throw new ChatsyncError("Quit Claude before restoring", 1);
  const target = listBackups(o.backupsDir).find((b) => b.name === o.name);
  if (!target) throw new ChatsyncError(`No such backup: ${o.name}`, 1);

  const old = o.sessionsDir + OLD_SUFFIX;
  if (existsSync(old)) {
    throw new ChatsyncError(`${old} is left over from an interrupted restore; inspect it and remove it first`, 1);
  }

  const hadSessions = isDir(o.sessionsDir);
  const safetyBackup = hadSessions
    ? createBackup({ sessionsDir: o.sessionsDir, backupsDir: o.backupsDir, ...(o.now ? { now: o.now } : {}) })
    : "";

  if (hadSessions) renameSync(o.sessionsDir, old);
  try {
    cpSync(target.path, o.sessionsDir, { recursive: true });
  } catch (err: unknown) {
    rmSync(o.sessionsDir, { recursive: true, force: true });
    if (hadSessions) renameSync(old, o.sessionsDir);
    const reason = err instanceof Error ? err.message : String(err);
    throw new ChatsyncError(`Restore failed, sessions left unchanged: ${reason}`, 1);
  }
  if (hadSessions) {
    try {
      rmSync(old, { recursive: true, force: true });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ChatsyncError(`Restored, but could not remove ${old}: ${reason}`, 1);
    }
  }
  return { safetyBackup };
}
