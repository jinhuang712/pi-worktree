# pi-worktree

A native [Pi](https://github.com/badlogic/pi-mono) extension for git worktree flow: `/worktree` isolates current changes into a linked worktree and binds the session to it, `/land` previews and merges them back with linear history.

`pi-worktree` shells out to your own `git` for all repository mutations and keeps one linkage file per worktree inside the shared git dir, so the mapping survives `cd` plus fresh Pi sessions on either side. The agent gets four tools (`worktree_status`, `worktree_create`, `worktree_land`, `worktree_abandon`) and a short per-turn policy: when the workspace is clean and the task is experimental, risky, or parallel, it proactively isolates instead of editing in place.

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

### `/worktree [task...] [--branch <name>] [--base <ref>] [--path <path>] [--no-carry]`

From the current branch, create a new linked worktree carrying the associated changes, bind the session to it, and hand the task to the agent.

- **Task text names the branch** — `/worktree fix the login retry bug` creates `wt-fix-login-retry`; tasks without ASCII words (CJK, emoji) get `wt-<MMDD-HHMM>`. Collisions bump `-2`, `-3`. Pass `--branch` to name it yourself.
- **Dirty workspace** — uncommitted changes (tracked plus untracked) are carried via a temporary stash after one confirmation. The stash is dropped only after a clean apply; on conflict the stash is kept and its ref is reported so nothing is lost.
- **Clean workspace** — fast path with no stash dance. This is the ideal isolation moment: for experimental, risky, or parallel work, prefer `/worktree` over editing in place.
- New worktrees default to `<repo>.worktrees/<branch>`, deduplicated with `-2`, `-3`, and so on.

```text
/worktree 先补充测试用例
/worktree add retry tests for the http client
/worktree
```

After creation the session is **bound** to the worktree: the session name, terminal title and widget show `🌲 <branch>`, and the agent's tool calls run inside it (see below). The agent continues the task there and asks whether to land when done. With no task text and no conversation yet, the worktree is created and Pi waits for you instead of guessing. One session owns at most one active worktree per repo — creating again points back at the owned link until it is landed or abandoned.

### `/land`

Land the bound worktree back into its origin. Shows a one-line preview first — `🌲 wt-fix-login → main · 3 commits · 4 files +120 −8 · main moved on by 2` — and lets you pick:

- **Land (rebase → fast-forward)** — default. The worktree branch is rebased onto the origin and fast-forwarded in: linear history, no merge commit. If the rebase hits conflicts it is aborted and a regular merge runs instead, so conflicts are resolved once, in place.
- **Squash** — one commit whose subject is the task text.
- **Merge** — keep history, add a merge commit.
- **Edit the commit subject first…** — the subject defaults to the task; change it before landing.

Pending changes on both sides are committed first: the worktree's checkpoint uses the task as its subject, the origin's is marked `wip(<branch>): checkpoint before landing …`. On conflict you choose right there: let the agent resolve, abort, or resolve by hand and run `/land` again. On success the linkage is marked landed, the worktree and branch are removed (`worktree remove` plus `branch -d`), and the session name is restored.

```text
/land
```

Running `/land` at the origin lands the child this session owns; with several children and no owner, a picker appears. `worktree_land` (the tool) never prompts and defaults to rebase.

## Session binding — the virtual cwd

Pi keeps the session cwd at the origin after `/worktree`. Rather than asking the model to remember `cd <worktree> &&` on every command, the extension re-roots built-in tool calls while the session is bound:

- `bash` commands start inside the worktree (unless they already `cd` there).
- Relative paths for `read`, `edit`, `write`, `grep`, `find`, `ls` resolve against the worktree; omitted paths default to it.
- `edit`/`write` aimed at an absolute path inside the **origin checkout** are blocked with a pointer to the worktree twin. Reads of the origin stay allowed for comparisons.
- The per-turn policy states one thing: `Working root: <worktree>`.

Standing inside the worktree yourself (a fresh session after `cd`) counts as bound too; nothing is rewritten because the cwd already is the root.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `worktree_status` | Branch, clean/dirty files, all worktrees, origin/child linkage and the session's bound worktree. The model calls this before risky edits to decide whether to isolate. |
| `worktree_create` | Non-interactive `/worktree`. Takes `task`, names the branch from it, binds the session, never prompts. |
| `worktree_land` | Non-interactive `/land` with `strategy: rebase | merge | squash` (default rebase), `finish:true` / `abort:true` for conflict flows. |
| `worktree_abandon` | Discard a worktree without landing. A dry run without `confirm:true` reports the unlanded commits and dirty files to lose; the model must confirm with you before passing `confirm:true`. |

Every turn, a short policy section is appended to the system prompt:

- Bound → the working root, that paths are re-rooted, and to ask before `worktree_land` / `worktree_abandon`.
- `CLEAN` plus an experimental, risky, or parallel task → proactively offer or call `worktree_create`.
- `DIRTY` plus a new task → do not mix it into the dirty files; suggest `/worktree`.
- Worktrees are session-exclusive: only land links owned by this session (or unowned legacy links). Never land another session's active worktree without asking the user first.
- Never run raw `git worktree add/remove` — use the tools so linkage stays consistent.

## Linkage

Stored as one file per link in `<git-common-dir>/pi-worktree/<id>.json`, shared across worktrees. Each link records origin path/branch/head, worktree path/branch/base, the task, whether changes were carried, the owning session id and its previous name, and a status of `active`, `landed`, or `removed` (`abandoned: true` when discarded). Parallel sessions only write their own file, so no session can clobber another's link. A legacy single `pi-worktree.json` is migrated on first load.

Because the store lives in the repo rather than the session, `/land` works after `cd` into the new worktree and a fresh Pi session. Every load reconciles against `git worktree list`, so externally removed worktrees are marked removed automatically.

Worktrees are session-exclusive: a link belongs to the session that created it. Landing another session's active link is blocked for tools (the model is told to ask you) and asks for confirmation for `/land` — unless you are standing inside that worktree, which counts as possession. Links created before ownership existed are unowned and landable by anyone.

The TUI widget shows readiness at a glance: `🌲 wt-fix-login → main · fix login retry · ↑3 · ↓1 · 2 dirty` (commits ahead, origin commits behind, uncommitted files), refreshed after every agent run. Origins show their own plus unowned children. Result cards stay two lines; full output is one expand away.

## Safety

- Never force-pushes; never pushes at all.
- Landing never uses `-D` (only `branch -d`, and keeps the branch when worktree removal fails). `worktree_abandon` does force-delete — after a dry run and explicit confirmation, and never `main`/`master` or another session's worktree.
- Stash apply tries `--index` first, falls back to plain apply, and drops the stash only on success.
- A failed rebase is aborted before falling back to merge; the worktree is never left mid-rebase.
- Cleanup never touches `main`/`master`: no auto-delete, no `worktree remove` against a main working tree.
- Both sides auto-commit before landing (task-named checkpoints); same-path lands and detached `HEAD` on either side are blocked with hints. Squash with nothing to land is reported as such, not as a conflict.

## Development

Run the test suite:

```bash
npm test
```

Typecheck:

```bash
npm run typecheck
```

Run Pi directly from the repository (print mode skips dialogs and uses the default strategy):

```bash
PI_OFFLINE=1 pi --no-session --no-extensions \
  --extension ./src/index.ts \
  --tools bash,read,write,edit,find,grep,ls \
  --mode json \
  -p '/worktree add retry tests --yes'
```

See the source and tests for implementation details and behavior coverage.

## License

MIT
