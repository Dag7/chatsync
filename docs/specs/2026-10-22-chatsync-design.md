# chatsync — design

Status: approved 2026-10-22 · amended same day: TypeScript + Nx (oramono setup)

## Problem

The Claude desktop app keeps a separate sidebar list of Code chats for each signed-in
account. When you switch accounts you only see that account's chats, even though
the conversations of SSH chats live on the remote machine and are not tied to any account.

People who switch between accounts (for example a personal and a work account) lose sight
of chats they started under the other account, and progress made on a chat under
account B does not show up when they return to account A.

## How the app stores chats (observed, macOS, Claude desktop as of 2026-10)

- **Conversation content** lives where the chat ran. For SSH chats that is the remote
  machine: `~/.claude/projects/<project>/<cliSessionId>.jsonl`. chatsync never reads or
  writes these files.
- **Sidebar entries** live on the host machine, one JSON file per chat:
  `~/Library/Application Support/Claude/claude-code-sessions/<accountId>/<orgId>/local_<id>.json`.
  Relevant fields: `sessionId`, `cliSessionId`, `title`, `cwd`, `lastActivityAt`,
  `isArchived`, `sshConfig.sshHost`, `sshRemoteTranscriptPath`.
- The **active account** is `lastKnownAccountUuid` in
  `~/Library/Application Support/Claude/config.json`.
- **Machine display names** are in `ssh_configs.json` (`configs[].name` for each `sshHost`).
- **Sidebar sections** (custom groups) are stored in the app's internal storage, not in
  these files, so chatsync cannot create or fill them.

These are internal, undocumented formats. chatsync must fail safe if they change.

## Goals

1. Make every chat visible under every account on the same computer.
2. Carry the latest state of a chat across accounts (A → B → A round trip).
3. Never lose data: back up before every write, never delete.
4. Installable by anyone: `npm i -g chatsync` or `npx chatsync`.

## Non-goals (v1)

- Windows and Linux. The app's data path on those systems is unverified; chatsync exits
  with a clear message there. Added later once someone verifies the layout.
- Syncing between computers. Only account folders on one computer.
- Creating sidebar sections. Done inside the app (see "Machine sections").
- Touching conversation files on remote machines.

## Sync rules

1. **Identity.** A chat is identified by `sessionId`. The same chat in several account
   folders is one chat with several copies.
2. **Newest wins.** For each chat the copy with the highest `lastActivityAt` is
   authoritative. That copy carries the current `cliSessionId` and transcript path, which
   can change when a chat is continued.
3. **Never write to the active account.** The running app holds those entries in memory
   and may overwrite them. All org folders under the active account are read-only to
   chatsync. Expected workflow: run `chatsync sync` *before* switching accounts, so the
   account you are leaving pushes its progress to the others.
4. **Targets.** For every inactive account, write the newest copy into each org folder of
   that account that already contains chats; if none does, into the org folder of the
   copy's source org when it exists, otherwise the first org folder. (Open question 2.)
5. **Never delete.** Archived or deleted in one account does not remove it elsewhere.
   `isArchived` is copied like any other field, since it is part of the newest copy.
6. **Conflicts.** If two or more accounts each changed a chat since the last sync
   (tracked in chatsync state, see below), the newest still wins and the chat is listed as
   a conflict in the report. The losing copy remains in the backup.
7. **Other files** in the account folders (`scheduled-tasks.json`, `archived-sessions.idx`,
   `waiting-input`) are not touched.
8. **Atomic writes.** Write to a temp file in the same folder, then rename.

## Backups

- Before any write (`sync`, `restore`), copy the whole `claude-code-sessions` folder to
  `~/.chatsync/backups/<YYYY-MM-DD_HHMMSS>/`.
- Keep the newest 20 backups plus the single oldest (the pre-chatsync copy); older ones are pruned after a successful new backup.
- `restore` refuses to run while the Claude app is running (`pgrep -x Claude`), backs up
  the current state first, then replaces the folder with the chosen backup.

## State

`~/.chatsync/state.json`: per `sessionId` and account, the `lastActivityAt` seen at the
last sync. Used only for conflict detection. Deleting it is safe.

`~/.chatsync/config.json`: account nicknames (`{ "<accountId>": "work" }`) and optional
machine nickname overrides (`{ "ws-gad-link-dc": "link" }`).

## CLI

TypeScript, built with `tsc` to ESM, Node ≥ 20. Binary name `chatsync`. The repo is an Nx
workspace modeled on oramono (yarn 4 workspaces, Nx 23, TypeScript 6, vitest 4, ESLint 10 +
Prettier). Runtime dependencies follow oramono's `ora-cli`: `commander` for commands and
`@inquirer/prompts` for the interactive menu, behind an injectable `Prompter` interface so
tests never need a terminal.

| Command | Behavior |
|---|---|
| `chatsync` | Interactive menu: Status, Sync, Backups/Restore, Accounts, Quit. |
| `chatsync status` | Shows active account, then chats grouped by machine: title, which accounts have it, which copy is newest, and what a sync would do. Read-only. |
| `chatsync sync [--dry-run] [-y]` | Back up, show the plan, confirm, write. `--dry-run` shows the plan only. `-y` skips the confirmation. Prints counts: copied, updated, unchanged, conflicts. |
| `chatsync backups` | Lists backups with date and chat count. |
| `chatsync restore [name]` | Pick a backup (menu if no name). Requires the app to be closed. |
| `chatsync accounts` | Name each account; shows a few chat titles per account to help identify them. |
| `chatsync --json` | Machine-readable output for `status` and `sync --dry-run`. |

Non-interactive use (no TTY, or `-y`) never prompts.

Exit codes: 0 ok, 1 error, 2 unsupported platform or unrecognized data layout.

## Machine names

Machine name for a chat = override from config, else `ssh_configs.json` name for its
`sshHost`, else the `sshHost` itself. Local (non-SSH) chats are shown as `local`.

## Machine sections

chatsync cannot create sidebar sections. `chatsync status` prints a ready-to-paste
prompt for a Claude desktop session ("file my chats into sections by machine: …") listing
each machine and its chats, which Claude can carry out with its sidebar tools. A packaged
command for this is a possible later addition.

## Fail-safe checks

Before writing, chatsync verifies the layout: the sessions folder exists, account and org
folder names are UUIDs, and every entry it will copy parses as JSON and has `sessionId`
and `lastActivityAt`. Anything unexpected stops the run before anything is written,
with exit code 2.

## Code layout

Nx workspace; the published package is `packages/chatsync`.

```
nx.json, package.json, tsconfig.base.json, eslint.config.mjs, .prettierrc, vitest.shared.ts
packages/chatsync/
  project.json             nx targets: build, typecheck, test, lint
  src/index.ts             entry: wires process to the program
  src/program.ts           commander program; all behavior injectable via ProgramDeps
  src/prompter.ts          Prompter interface + inquirer implementation
  src/paths.ts             platform detection and app data paths
  src/store.ts             read accounts/orgs/entries, active account, ssh names
  src/plan.ts              pure: entries + active account + state → writes and conflicts
  src/apply.ts             backup, atomic writes, state update
  src/backup.ts            create, list, prune, restore
  src/format.ts            tables and report text
  src/**/*.test.ts         vitest, colocated; fixture folders built in a temp dir
```

`plan.ts` is pure and carries most of the tests: round trip A → B → A, conflict,
archived chat, chat only in the active account, missing fields, multiple org folders.

## Packaging

- npm package `chatsync` (unscoped, free as of 2026-10-22), from `packages/chatsync`,
  `bin: { chatsync: ./dist/index.js }`, `files: [dist, README.md, LICENSE]`, MIT license.
  The workspace root is private.
- README: what it does, the "run sync before switching accounts" workflow, safety rules,
  the fact that it relies on undocumented app files.
- Publishing is done by the owner (`npm publish`), not by automation in v1.

## Open questions

1. Package name: unscoped `chatsync` (recommended, shortest `npx chatsync`) or
   `@chatsync/cli`.
2. Org folders: an account can have several org folders. v1 rule is in "Sync rules" 4;
   needs one manual check that a copied chat appears in the sidebar under the right org.
3. Whether copied entries need org-specific fields (`remoteMcpServersConfig`,
   `enabledMcpTools`) cleared for the other account. v1 copies as-is; verify on the first
   real sync.
