# pi-worktree

A native [Pi](https://github.com/badlogic/pi-mono) extension for git worktree flow: `/worktree` isolates current changes into a linked worktree, `/land` merges them back with conflict handling.

`pi-worktree` shells out to your own `git` for all repository mutations and keeps an origin↔worktree linkage file inside the shared git dir, so the mapping survives `cd` plus fresh Pi sessions on either side. The agent gets three tools (`worktree_status`, `worktree_create`, `worktree_land`) and a short per-turn policy: when the workspace is clean and the task is experimental, risky, or parallel, it proactively isolates instead of editing in place.

## Installation

Install the public GitHub package:

```bash
pi install git:github.com/jinhuang712/pi-worktree
```

Or install it locally while developing:

```bash
pi install -l /absolute/path/to/pi-worktree
```

Restart Pi after installation so it discovers the extension.

## Usage

### `/worktree [branch] [--base <ref>] [--path <path>] [--no-carry]`

From the current branch, create a new linked worktree carrying the associated changes.

- **Dirty workspace** — uncommitted changes (tracked plus untracked) are carried via a temporary stash. The stash is dropped only after a clean apply; on conflict the stash is kept and its ref is reported so nothing is lost.
- **Clean workspace** — fast path with no stash dance. This is the ideal isolation moment: for experimental, risky, or parallel work, prefer `/worktree` over editing in place.
- New worktrees default to `<repo>.worktrees/<branch>` (slashes become dashes), deduplicated with `-2`, `-3`, and so on.

```text
/worktree              # one shot: auto wt-* branch, agent continues the task there
/worktree my-feature   # explicit branch, still one shot
/worktree my-feature "fix the login bug"  # branch + task
/worktree list
/worktree prune
```

After creation the agent keeps working inside the new worktree on its own; when done it asks whether to land. Finish with `/land`.

### `/land [--to <path|branch>] [--strategy merge|squash] [-m <msg>] [--no-remove] [--yes]`

Land the current linked worktree back into its origin.

1. Commits pending changes on both sides automatically (timestamped checkpoints, no prompts).
3. Merges with `merge --no-edit` by default, or `--strategy squash`.
4. On conflict, lists the conflicted files and leaves `MERGE_HEAD` in place. Resolve the files, `git add` them, then `/land --continue`. Abort with `/land --abort`. Both work no matter which side you invoke them from.
5. On success, marks the linkage landed and cleans up (`worktree remove` plus `branch -d`) unless `--no-remove`.

```text
/land
/land --strategy squash -m "land(pi/my-feature): concise summary"
/land --status
/land --continue
/land --abort
```

## Agent tools

The extension registers three tools the model can call on its own:

| Tool | Purpose |
| --- | --- |
| `worktree_status` | Branch, clean/dirty files, all worktrees, and origin/child linkage. The model calls this before risky edits to decide whether to isolate. |
| `worktree_create` | Non-interactive `/worktree`. Auto-generates branch and path, never prompts. |
| `worktree_land` | Non-interactive `/land`, including `finish:true` / `abort:true` for conflict flows. |

Every turn, a short policy section is appended to the system prompt:

- `CLEAN` plus an experimental, risky, or parallel task → proactively offer or call `worktree_create`.
- `DIRTY` plus a new task → do not mix it into the dirty files; suggest `/worktree`.
- Inside a linked child → keep all edits in that worktree and finish with `worktree_land`.
- Worktrees are session-exclusive: only land links owned by this session (or unowned legacy links). Never land another session's active worktree without asking the user first.
- Never run raw `git worktree add/remove` — use the tools so linkage stays consistent.

## Linkage

Stored in `<git-common-dir>/pi-worktree.json`, which is shared across worktrees, plus session entries for the current branch view. Each link records origin path/branch/head, worktree path/branch/base, whether changes were carried, the owning session id, and a status of `active`, `landed`, or `removed`. Because the store lives in the repo rather than the session, `/land` works after `cd` into the new worktree and a fresh Pi session.

Worktrees are session-exclusive: a link belongs to the session that created it. Landing another session's active link is blocked for tools (the model is told to ask you) and asks for confirmation for `/land` — unless you are standing inside that worktree, which counts as possession. Links created before ownership existed are unowned and landable by anyone.

The TUI shows linkage as a one-line widget and footer status: children show `🌲 <branch> → <origin>`, origins show `🌲 2 worktrees · a · b`. Result cards stay two lines; full output is one expand away.

## Safety

- Never force-pushes; never pushes at all.
- Never auto-deletes branches with `-D` (uses `-d`, and keeps the branch when worktree removal fails).
- Stash apply tries `--index` first, falls back to plain apply, and drops the stash only on success.
- Both sides auto-commit before merging (checkpoint messages); same-path and detached-`HEAD` lands are blocked with hints.

## Development

Run the test suite:

```bash
npm test
```

Typecheck:

```bash
npm run typecheck
```

Run Pi directly from the repository:

```bash
PI_OFFLINE=1 pi --no-session --no-extensions \
  --extension ./src/index.ts \
  --tools bash,read,write,edit,find,grep,ls \
  --mode json \
  -p '/worktree list'
```

See the source and tests for implementation details and behavior coverage.

## License

MIT
