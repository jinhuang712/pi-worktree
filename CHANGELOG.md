# Changelog

All notable changes to `pi-worktree` are documented here.

## [Unreleased]

### Changed

- **One session, one tree.** A bare land/abandon resolves only the calling session's own link (or the worktree you're standing in) and never auto-grabs another session's worktree — the `Blocked: … belongs to another session` error is replaced by a `no-own-link` note that lists the others and leaves them alone. Naming a link explicitly still takes it over deliberately, flagged `foreign` with the previous owner named, and the model reports it in chat.
- **No-task `/worktree` can't stall.** With no task text and a clean workspace where nothing is inferable from the conversation, the model asks the user in one short question what to work on (explicit exception to 'never ask') instead of stalling or inventing a placeholder branch.
- **Conflicts are the model's job.** `LAND CONFLICT` still names the files in one purple card, but instead of stopping for hand resolution the model reads each file, keeps the intended result from both sides, `git add`s and finishes — explaining what it kept. It only asks the user when both sides look deliberately contradictory.
- **LAND cards separate commits from files.** The commit count and subjects now have their own section, followed by a distinct file count and path list, so the landed history is easy to scan.

### Fixed

- **`/land` on an empty worktree cleans up instead of erroring.** Landing a worktree with no commits and no changes used to fail with `Nothing to land … Use worktree_abandon to drop the worktree`, forcing a second manual step. Now it removes the worktree directory, deletes the branch, clears the link and unbinds the session in one go (`LAND 【x -> main】 · nothing new · cleaned up`). `worktree_abandon` without `confirm:true` also drops empty worktrees immediately — confirmation is only needed when commits or dirty files would be lost.

### Changed

- **Transcript visual language.** Every action renders exactly one purple block: a caps `LABEL` plus the hero in `【】` (`WORKTREE 【main -> x】`, `LAND 【x -> main】`), detail lines aligned underneath with `|--`/`--` trees for carried files, landed commits/subjects, and conflicted files. No absolute paths, no green/red blocks; lists cap at 5–6 items, full output one expand away. Cards signal with the smallest effective payload — explanations belong to the model's words.
- **`/worktree` is model-driven.** No confirmation, ever. The agent triages dirty files (selective stash via `carryPaths`, saying in one line what it left behind and why) and names the branch itself — no fixed format. Tool-side collisions auto-bump (`-2`, `-3`); an explicit human `--branch` still errors on collision so typos stay visible.
- **`/land` runs straight with zero popups** (`/land [target] [--strategy …]`). The strategy is asked once, remembered globally (`~/.pi/agent/pi-worktree/config.json`), shown on every land line; an explicit `--strategy` wins and becomes the new default. Ambiguity and foreign-owned links surface as purple cards instead of dialogs.
- **Conflict is the one full stop.** A purple `LAND CONFLICT` block names the files and stops — no auto-resolve. The model explains in its own words, asks how to proceed, and never calls `finish:true` without explicit user consent.
- Auto-checkpointed files are announced as their own `DIRTY WORKTREE` section, and land lines carry landed commit subjects plus the file list.
- `worktree_status` renders nothing (triage plumbing); global install tracks the local repo for development.

### Fixed

- **Stash leak:** `git stash drop` only accepts `stash@{n}` refs, never a raw sha — every carry used to leave an orphan `pi-worktree:*` stash entry. Now locates the entry by sha and drops it; tests assert an empty stash list after carry.

## [0.2.0] - 2026-09-04

### Added

- **Session binding (virtual cwd).** While a session owns an active worktree, built-in tool calls are re-rooted there via `tool_call`: bash starts inside the worktree, relative and omitted paths resolve against it, and `edit`/`write` aimed at the origin checkout are blocked with the worktree twin. The per-turn policy now states a single `Working root` instead of contradicting the handoff with origin-side facts.
- **`/land` preview and choice.** One-line summary (commits, diff stat, uncommitted files, how far the origin moved) then rebase→ff (default), squash, merge, or edit the commit subject. Conflicts offer agent / abort / manual on the spot. Several children at the origin open a picker.
- **`rebase` land strategy** (default): rebase the worktree onto the origin and fast-forward — linear history, no merge commit. Falls back to merge when the rebase conflicts, after aborting it.
- **`worktree_abandon` tool**: discard a worktree; dry run without `confirm:true` reports what would be lost. Refuses `main`/`master`, other sessions' links, and running from inside the worktree.
- Task text is stored on the link and drives the branch name (`wt-fix-login-retry`), the land commit subject, the widget and the session name.
- Widget readiness: `↑ahead · ↓behind · N dirty`, refreshed after every agent run; terminal title follows the bound worktree.

### Changed

- Store is one file per link in `<git-common-dir>/pi-worktree/`; sessions only write their own link, ending the load-modify-save race between parallel sessions. Legacy `pi-worktree.json` migrates on first load.
- `/worktree` grammar: every positional is task text; explicit branch names go through `--branch`. `/worktree cleanup` is a task again, not a branch.
- `/worktree` with no task and no conversation creates the worktree and waits instead of triggering a turn that has nothing to infer.
- Land/abandon restore the pre-worktree session name (or `✓ <branch>`).
- Detached `HEAD` is now blocked on the target side too; squash with nothing new reports `nothing-to-land` instead of a conflict.
- Target checkpoints are `wip(<branch>): checkpoint before landing …`; source checkpoints use the task as subject.

### Verification

- 35 tests passing (`npm test`), including re-rooting rules, per-link store isolation, legacy migration, rebase→ff and rebase-conflict fallback against real git.
- `tsc --noEmit` clean.
- Print-mode round trip against real Pi: `/worktree add retry tests --yes` → `wt-add-retry-tests` with carried changes → `/land` from inside the worktree lands as a single fast-forwarded commit titled `add retry tests`, cleans up, and restores the session name.

## [0.1.1] - 2026-09-04

### Changed

- `/worktree` is one shot: free text after the command is treated as the task (branch names only match single ASCII tokens), the agent auto-continues inside the new worktree, and asks before landing — no more idle script-like stops. Both commands trigger the next model turn instead of queueing `nextTurn` messages.
- Auto branches are short flat `wt-*` (`wt-0904-1111`) and bump `-2`/`-3` on collision, so fresh sessions never hit `already exists`; explicit names still error to keep typos visible.
- `/land` from the origin side auto-flips to the single active child, and dirty targets are checkpoint-committed instead of erroring.
- Display overhaul: two-line result cards (full output one expand away), short widget/status lines, no absolute-path repetition, session renamed to the worktree branch for session isolation.
- Session-exclusive worktrees: links record the owning session; landing another session's active link is blocked for tools and confirm-gated for `/land` (standing inside the worktree counts as possession, so cd-and-land keeps working). The widget/status show only own plus unowned links; the full list stays in `/worktree status` and the model policy.
- Self-healing linkage: every land/widget/create pass reconciles the store against `git worktree list`, so externally removed worktrees stop haunting flip/ownership logic — never hand-edit the JSON.
- DWIM land direction: naming a linked child from its origin lands it here; standing on `main` beside one unlinked worktree lands it here. Cleanup never suggests deleting `main`/`master` or removing a main working tree.
- One active worktree per session per repo: repeat creates are blocked with a pointer back at the owned link (land it first). `/worktree prune` now also heals stale store links.
- Two-command surface: `/worktree` (create one-shot) and `/land` (bare one-shot). `list`/`status`/`prune` subcommands and all `/land` flags are gone from user space — status, prune, conflict continuation and strategy live in the tools + policy for the model. Sync also prunes git metadata quietly, so no manual prune entry is needed.

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
