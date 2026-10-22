import { homedir } from "node:os";
import { join } from "node:path";
import { ChatsyncError } from "./errors.js";

/** The Claude desktop app's data directory. `CHATSYNC_APP_DIR` overrides (tests, non-standard installs). */
export function appDataDir(opts: { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env;
  if (env.CHATSYNC_APP_DIR) return env.CHATSYNC_APP_DIR;
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") throw new ChatsyncError("chatsync currently supports macOS only", 2);
  return join(opts.home ?? homedir(), "Library", "Application Support", "Claude");
}

/** Folder holding `<accountId>/<orgId>/local_<id>.json` entries. */
export function sessionsDir(appDir: string): string {
  return join(appDir, "claude-code-sessions");
}

/** chatsync's own state directory (backups, state.json, config.json). `CHATSYNC_HOME` overrides. */
export function chatsyncHome(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env;
  if (env.CHATSYNC_HOME) return env.CHATSYNC_HOME;
  return join(opts.home ?? homedir(), ".chatsync");
}
