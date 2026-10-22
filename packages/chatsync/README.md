# chatsync

Copy Claude desktop Code-tab sidebar entries between the accounts you are signed in with on one Mac, so every account lists every chat.

## The problem

The Claude desktop app keeps a separate sidebar list for each account. Switch accounts and the chats you started under the other one are gone from view, and progress you made on a chat under account B never shows up when you come back to account A.

## How it works

A Claude Code chat has two parts, stored in different places:

- **The conversation** lives where the chat ran. For an SSH chat that is the remote machine, under `~/.claude/projects/`. It is not tied to any account.
- **The sidebar entry** is a small JSON file the desktop app keeps on your Mac, separately for each account, under `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/`.

chatsync copies only the sidebar entries between your accounts. It never reads, writes or moves conversations, and it never touches your remote machines.

For each chat, the copy with the most recent activity wins and is written into the other accounts. Nothing is ever deleted: archiving a chat in one account does not remove it from another.

## Requirements

- macOS (other systems are not supported yet; chatsync exits with a message)
- Node.js 20 or newer
- The Claude desktop app, signed in at least once with each account you want to sync

## Install

```sh
npm i -g chatsync
# or run it without installing
npx chatsync
```

## The workflow

**Run `chatsync sync` before you switch accounts.**

The account you are signed into is never written to, because the running app holds its entries in memory and could overwrite them. So the account you are about to leave is the one that pushes its latest progress to all the others. Then switch accounts in Claude, and the chats are there.

```sh
chatsync sync --dry-run   # see what would change; writes nothing
chatsync sync             # show the plan, ask, back up, write
```

## Commands

| Command | What it does |
|---|---|
| `chatsync` | Interactive menu (in a terminal): Status, Sync, Backups / restore, Accounts, Quit. Outside a terminal it prints help. |
| `chatsync status [--json]` | Shows the signed-in account, then every chat grouped by machine: which accounts have it, which copy is newest (marked `*`), and what a sync would do. Also prints the sections prompt (see below). Changes nothing. |
| `chatsync sync [--dry-run] [-y] [--json]` | Prints the plan and counts (copy, update, unchanged, conflicts). Without `--dry-run` it asks for confirmation, backs up, then writes. `-y` skips the question. `--json` prints machine-readable output. |
| `chatsync backups` | Lists backups with their chat counts. |
| `chatsync restore [name]` | Replaces the Claude sessions folder with a backup. Pick one from a menu or pass its name. Claude must be quit. |
| `chatsync accounts` | Lists the accounts with a few recent chat titles each, and lets you give each a nickname (stored in `~/.chatsync/config.json`). |

Without a terminal (or with `--json`), chatsync never prompts: `sync` then needs `-y` to write.

Exit codes: `0` ok, `1` error, `2` unsupported platform or data that chatsync does not recognize.

## Safety

- **Backup before every write.** The whole sessions folder is copied to `~/.chatsync/backups/<YYYY-MM-DD_HHMMSS>/` before `sync` or `restore` changes anything. The newest 20 backups are kept.
- **Never writes to the signed-in account.**
- **Never deletes** a sidebar entry.
- **Atomic writes.** Each entry is written to a temporary file and renamed into place.
- **Conflicts are reported, not hidden.** If a chat changed in two or more accounts since the last sync, the newest copy still wins, the chat is listed as a conflict, and the other copy stays in the backup.
- **Stops on anything unfamiliar.** If the folder layout or an entry looks different from what chatsync expects, it stops before writing anything and exits with code 2.
- **Restore needs Claude closed**, and takes a safety backup of the current state first.
- Other files in the account folders (such as `scheduled-tasks.json`) are left alone.

Local state lives in `~/.chatsync/`: `backups/`, `state.json` (what was seen at the last sync, used only to detect conflicts; safe to delete) and `config.json` (nicknames).

## Sidebar sections by machine

chatsync cannot create sidebar sections; the app keeps those in its own storage. Instead, `chatsync status` ends with a prompt you can paste into a Claude Code session in the desktop app:

```text
Put my Claude Code chats into sidebar sections by machine:
- my-server: "Fix the build", "Add pagination"
- local: "Try a new idea"
```

Claude can then file the chats into one section per machine with its sidebar tools. Machine names come from the app's SSH settings (or the SSH host name); chats that did not run over SSH are shown as `local`.

## Read this before you rely on it

chatsync works on files the Claude desktop app does not document. They can change in any update, and a change could make chatsync stop working or, in the worst case, write entries the app does not understand. It is built to fail safe: it checks what it finds, stops with exit code 2 when something is unexpected, and always backs up first. You can undo a sync with `chatsync restore`. Until you have seen it work on your own setup, start with `chatsync status` and `chatsync sync --dry-run`.

Not affiliated with Anthropic.

## License

MIT
