# pi-worktree

Native Pi worktree flow. Isolate changes into a linked git worktree, then land back with conflict handling.

## Install

Global (recommended — makes `/worktree` / `/land` available everywhere):

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["../../dev/pi/pi-worktree"]
}
```

Then `/reload` or restart pi. Paths in `packages` are relative to `~/.pi/agent/`.

Quick test without installing:

```bash
pi -e ./src/index.ts
```

## Commands

### `/worktree [branch] [--base <ref>] [--path <path>] [--no-carry]`

From the current branch, create a new linked worktree carrying associated changes.

- Dirty workspace → uncommitted changes (tracked + untracked) are carried via a temporary stash. The stash is dropped only after a clean apply; on conflict the stash is kept and reported.
- Clean workspace → fast path. This is the ideal isolation moment: the agent proactively suggests `/worktree` for experimental / risky / parallel work instead of editing in place.
- New worktrees default to `<repo>.worktrees/<branch>` (slashes become dashes), deduplicated with `-2`, `-3`…

Subcommands: `/worktree list` (alias `status`), `/worktree prune`, `/worktree help`.

After creation: `cd <new-path>` and continue there; finish with `/land`.

### `/land [--to <path|branch>] [--strategy merge|squash] [-m <msg>] [--no-remove] [--yes]`

Land the current linked worktree back into its origin.

1. Commits pending changes in the source (prompts for a message, auto-generates with `--yes`).
2. Refuses when the target is dirty — commit/stash there first.
3. Merges (`merge --no-edit` default, or `--strategy squash`).
4. On conflict: lists conflicted files and leaves `MERGE_HEAD` in place. Resolve, `git add`, then `/land --continue`. Abort with `/land --abort`.
5. On success: marks linkage landed and cleans up (`worktree remove` + `branch -d`) unless `--no-remove`. When sitting inside the source worktree, removal is attempted from the target side and reports the manual follow-up if git refuses.

`/land --status` shows source/target state without acting.

## Tools (for the agent)

| Tool | Purpose |
|---|---|
| `worktree_status` | Branch, clean/dirty, all worktrees, origin/child linkage. Call before risky edits. |
| `worktree_create` | Non-interactive `/worktree`. Auto-generates branch/path, never prompts. |
| `worktree_land` | Non-interactive `/land`. Supports `finish:true` / `abort:true` for conflict flows. |

Policy injected every turn (`before_agent_start`):

- CLEAN + experimental/risky/parallel → proactively offer or call `worktree_create`.
- DIRTY + new task → don't mix; suggest `/worktree`.
- Inside a linked child → stay in this worktree, finish with `worktree_land`.
- Never run raw `git worktree add/remove` — use the tools so linkage stays consistent.

## Linkage

Stored in `<git-common-dir>/pi-worktree.json` (shared across worktrees) plus session entries. Survives `cd` + fresh sessions on either side. Fields: origin path/branch/head, worktree path/branch/base, carried flag, status (`active`/`landed`/`removed`).

## Safety

- Never force-pushes, never pushes at all.
- Never deletes branches with `-D` automatically (uses `-d`, keeps branch when worktree removal fails).
- Stash apply tries `--index` first, falls back plain, drops only on success.
- Target-dirty and same-path lands are blocked with explicit file lists.
- Detached-HEAD sources are blocked with a `git switch -c` hint.

## Dev

```bash
npm test        # node --test --experimental-strip-types test/*.test.ts
npm run typecheck
```
