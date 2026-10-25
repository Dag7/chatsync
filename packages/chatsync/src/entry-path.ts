import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ChatsyncError } from "./errors.js";

const SESSION_ID = /^local_[A-Za-z0-9_-]+$/;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `child` is strictly inside `parent` (both resolved). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Where an entry file goes. Throws (exit 2) unless the session id is a plain `local_*` name and the
 * target is a file directly inside an existing `<sessionsDir>/<account>/<org>` folder.
 */
export function entryTarget(e: { sessionId: string; accountId: string; orgId: string }, root: string): string {
  const bad = (why: string): ChatsyncError =>
    new ChatsyncError(`Refusing to write chat "${e.sessionId}" to ${e.accountId}/${e.orgId}: ${why}`, 2);
  if (!SESSION_ID.test(e.sessionId)) throw bad("unexpected session id");
  const orgDir = resolve(root, e.accountId, e.orgId);
  const rootDir = resolve(root);
  if (!isInside(rootDir, orgDir) || relative(rootDir, orgDir).split(/[\\/]/).length !== 2) {
    throw bad("account or organization folder is outside the sessions folder");
  }
  if (!isDir(orgDir)) throw bad(`folder ${orgDir} does not exist`);
  const file = resolve(orgDir, `${e.sessionId}.json`);
  if (!isInside(orgDir, file) || resolve(file, "..") !== orgDir) throw bad("target is outside the organization folder");
  return file;
}
