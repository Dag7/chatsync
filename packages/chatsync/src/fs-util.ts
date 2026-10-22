import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes `contents` to a temp file next to `file`, then renames it into place, so readers see
 * either the old file or the complete new one. The temp file is removed if anything fails.
 */
export function writeFileAtomic(file: string, contents: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.chatsync-tmp`);
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, file);
  } catch (err: unknown) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
