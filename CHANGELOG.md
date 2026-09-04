# Changelog

All notable changes to `pi-worktree` are documented here.

## [Unreleased]

### Changed

- `/worktree` is one shot: free text after the command is treated as the task (branch names only match single ASCII tokens), the agent auto-continues inside the new worktree, and asks before landing — no more idle script-like stops. Both commands trigger the next model turn instead of queueing `nextTurn` messages.
- Auto branches are short flat `wt-*` (`wt-0904-1111`) and bump `-2`/`-3` on collision, so fresh sessions never hit `already exists`; explicit names still error to keep typos visible.
- `/land` from the origin side auto-flips to the single active child, and dirty targets are checkpoint-committed instead of erroring.
- Display overhaul: two-line result cards (full output one expand away), short widget/status lines, no absolute-path repetition, session renamed to the worktree branch for session isolation.
- Session-exclusive worktrees: links record the owning session; landing another session's active link is blocked for tools and confirm-gated for `/land` (standing inside the worktree counts as possession, so cd-and-land keeps working). The widget/status show only own plus unowned links; the full list stays in `/worktree status` and the model policy.

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
