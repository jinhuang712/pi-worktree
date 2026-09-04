# Changelog

All notable changes to `pi-worktree` are documented here.

## [0.1.0] - 2026-09-04

### Added

- `/worktree [branch] [--base <ref>] [--path <path>] [--no-carry]` creates a linked worktree on a new branch, carrying uncommitted changes (tracked plus untracked) via a temporary stash; clean workspaces take a stash-free fast path.
- `/worktree list` (`status`), `/worktree prune`, and `/worktree help` subcommands.
- `/land [--to <path|branch>] [--strategy merge|squash] [-m <msg>] [--no-remove] [--yes]` commits pending source changes, refuses dirty targets, merges back, and cleans up (`worktree remove` plus `branch -d`) on success.
- Conflict flow: conflicted files are listed, `MERGE_HEAD` is left in place, `/land --continue` concludes after resolution and `/land --abort` rolls back; both work from either worktree.
- `worktree_status`, `worktree_create`, and `worktree_land` agent tools, plus a per-turn system-prompt policy that proactively isolates experimental, risky, or parallel work when the workspace is clean.
- Origin↔worktree linkage in `<git-common-dir>/pi-worktree.json` so `/land` survives `cd` plus fresh sessions; TUI widget and footer status for linked children and origins.
- Safety rails: no pushes, no `-D` branch deletes, stash dropped only on clean apply, dirty-target and same-path lands blocked, detached-`HEAD` sources blocked with a hint.

### Verification

- Unit plus real-git end-to-end suite: 14 tests passing (`npm test`).
- `tsc --noEmit` clean.
- Print-mode round trip verified against real Pi: dirty carry, `--yes` land with auto-cleanup, and abort/continue through a forced conflict.
- Public GitHub distribution as a Pi package (`jinhuang712/pi-worktree`).
