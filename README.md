# pi-worktree

A native [Pi](https://github.com/badlogic/pi-mono) extension for git worktree flow: `/worktree` isolates work into a linked worktree and binds the session to it, `/land` merges it back with linear history.

`pi-worktree` shells out to your own `git` for all repository mutations and keeps one linkage file per worktree inside the shared git dir, so the mapping survives `cd` plus fresh Pi sessions on either side. The agent gets four tools (`worktree_status`, `worktree_create`, `worktree_land`, `worktree_abandon`) and a short per-turn policy: when the workspace is clean and the task is experimental, risky, or parallel, it proactively isolates instead of editing in place.

## Mental model

One origin, one child, one round trip. Everything else is detail.

```text
  ORIGIN                              WORKTREE
  ------                              --------

  main @ ~/repo                       wt-fix-login @ ~/repo.worktrees/wt-fix-login
  +--------------+                     +------------------+
  |  A --- B     |                     |  A --- B         |
  |  (clean or   |  /worktree          |  (bound session  |
  |   dirty)     | ------------>       |   works here)    |
  +--------------+  carry via stash    +------------------+
        ^                                      |
        |                 /land                |
        +----------------<---------------------+
              rebase (default) / merge / squash
```

Lifecycle states for a link:

```text
  active ------------------> landed ---> removed
    |                         ^
    +--> removed (abandoned) --+
```

- `active`: the worktree exists and the session is bound to it.
- `landed`: commits were merged into the origin.
- `removed`: worktree directory (and usually the branch) is cleaned up.

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

## Quick start

```text
/worktree add retry on 429 for the http client
# ... agent works in isolation, bound to the new worktree ...

/land
```

What you see: exactly one purple card per action, details aligned under a `【hero】`, item lists capped at 5-6 entries:

```text
🌲 WORKTREE 【main -> wt-http-retry】
              carrying 2 of 5 files · 3 left in origin
              |-- src/http.ts
              `-- test/http.test.ts

🌲 LAND 【wt-http-retry -> main】 · rebase · a1b2c3d
       landing 2 commits
       |-- feat(http): retry on 429
       `-- test(http): cover retry exhaustion
       landing 4 files
       |-- src/http.ts
       `-- ...
```

## /worktree — isolate

```text
/worktree [task...] [--branch <name>] [--base <ref>] [--path <path>] [--no-carry]
```

### What happens

```text
  Step 1: triage              Step 2: create             Step 3: bind
  ----------------            ----------------           ----------------

  origin status               git worktree add           session sticks to
  CLEAN or DIRTY?             -b <branch> <path>         the new worktree
        |                     [base]                         |
        v                            |                       v
  +-------------+                    v                 +------------------+
  | CLEAN       |              +-------------+         | 🌲 <branch>      |
  | -> fast path|              | new checkout|         | name, title,     |
  | no stash    |              | sibling dir |         | widget, policy   |
  +-------------+              +-------------+         | tool calls       |
  | DIRTY       |                    |                 | re-rooted there  |
  | -> selective|  stash push -u ----+----> stash      +------------------+
  | stash carry |  (only task files)      apply --index
  +-------------+  rest stays in origin    drop on success
```

- **The agent names the branch** — no fixed format, no questions asked. Model-chosen collisions auto-bump (`-2`, `-3`). Pass `--branch` to name it yourself: with a clean workspace (or `--no-carry`) that creates immediately with no model roundtrip; a colliding `--branch` stays a hard error so your typos stay visible.
- **Dirty workspaces are triaged by the agent** — it carries only files related to the task (selective stash via `carryPaths`: `carrying 2 of 5 files · 3 left in origin`) and leaves unrelated changes untouched in the origin, saying in one line what it left behind and why. No confirmation, ever. The stash is dropped only after a clean apply; on conflict the stash is kept and its ref is reported so nothing is lost.
- **Clean workspace** — fast path with no stash dance. This is the ideal isolation moment: for experimental, risky, or parallel work, prefer `/worktree` over editing in place.
- New worktrees default to `<repo>.worktrees/<branch>`, deduplicated with `-2`, `-3`:

```text
  ~/repo                         ~/repo.worktrees/
  (origin: main)                 (children)
  +--------+                     +---------------------------+
  | .git/  |                     | wt-http-retry/            |
  +--------+                     | wt-http-retry-2/          |
                                 | wt-login-fix/             |
                                 +---------------------------+
```

```text
/worktree add retry tests for the http client
/worktree --branch login-retry --base main
/worktree --no-carry spike a risky refactor
```

After creation the session is **bound** to the worktree: the session name, terminal title and widget show `🌲 <branch>`, and the agent's tool calls run inside it (see below). The agent continues the task there and asks whether to land when done. With no task text and no conversation yet, the worktree is created and Pi waits for you instead of guessing. With conversation history but no task text, the agent infers the task from the conversation and dirty files — or asks you in one short question when the workspace is clean and nothing is inferable, instead of stalling or inventing a placeholder branch. One session owns at most one active worktree per repo — creating again points back at the owned link until it is landed or abandoned.

## Session binding — the virtual cwd

Pi keeps the session cwd at the origin after `/worktree`. Rather than asking the model to remember `cd <worktree> &&` on every command, the extension re-roots built-in tool calls while the session is bound:

```text
  session cwd (unchanged)         what the tools actually touch
  -----------------------         ------------------------------

  ~/repo (origin, main)           ~/repo.worktrees/wt-http-retry (bound root)
        |                                        ^
        |  bash  ── prepend cd <root> ───────────|
        |  read/edit/write/grep/find/ls ─────────|
        |    relative path → resolve under <root>|
        |    empty path    → default to <root>   |
        |    absolute origin write → BLOCKED ────|
        |      "Edit <twin> instead"             |
        +-- absolute origin read ── ALLOWED ─────+
            (comparisons are legit)
```

- `bash` commands start inside the worktree (unless they already `cd` there).
- Relative paths for `read`, `edit`, `write`, `grep`, `find`, `ls` resolve against the worktree; omitted paths default to it.
- `edit`/`write` aimed at an absolute path inside the **origin checkout** are blocked with a pointer to the worktree twin. Reads of the origin stay allowed for comparisons.
- The per-turn policy states one thing: `Working root: <worktree>`.

Standing inside the worktree yourself (a fresh session after `cd`) counts as bound too; nothing is rewritten because the cwd already is the root.

## /land — merge back

```text
/land [target] [--strategy rebase|merge|squash]
```

Land straight back into the origin — zero popups. Direction is DWIM: standing in a child lands it into its origin; standing at the origin lands the bound/only child into it.

### Land pipeline

```text
  1. resolve            2. checkpoint          3. merge           4. cleanup
  -------------         -----------------      ------------       --------------

  source = child        source dirty?          rebase /           worktree remove
  target = origin       -> commit (task        merge /            branch -d
  (or DWIM flip)           subject)            squash             (never main)
                        target dirty?               |
                        -> commit                   v
                           wip(<branch>):      +---------+
                           checkpoint ...      | success |--> LAND card
                                               +---------+
                                                    |
                                               +---------+
                                               |conflict |--> LAND CONFLICT
                                               +---------+    card, full stop
```

- **Strategy is asked once, remembered everywhere** (`~/.pi/agent/pi-worktree/config.json`). First `/land` asks rebase / squash / merge a single time; from then on that mode is the default and every land line shows it. An explicit `--strategy` wins for that run and becomes the new default.
- Pending changes on both sides are checkpoint-committed first (the worktree's uses the task as its subject, the origin's is marked `wip(<branch>): checkpoint before landing …`) and shown as one trailing dim note per side (`checkpointed N files on <branch> as "<subject>"`) — auto-created commits stay visible without a second hero block. Land cards keep the commit summary and subjects separate from the file summary and paths.
- Empty worktrees land as cleanup: no commits and no changes means the worktree directory is removed, the branch deleted and the session unbound in the same `/land` — no second `abandon` step.

```text
/land
/land wt-http-retry --strategy squash
```

### Strategies compared

Given origin `main` at `C` and worktree branch with `W1, W2`:

```text
  BEFORE
  main:     A --- B --- C
  worktree:       C --- W1 --- W2
```

```text
  rebase (default): linear, no merge commit.
  Falls back to merge if the rebase hits conflicts.

  main:     A --- B --- C --- W1' --- W2'
```

```text
  merge: keeps history with a merge commit.

  main:     A --- B --- C ----------- M
                            \       /
                             W1 --- W2
```

```text
  squash: folds everything into one commit titled by the task.

  main:     A --- B --- C --- [W1+W2]
```

### Conflicts — the model resolves them

```text
  merge hits conflict
        |
        v
  +-------------------+
  | ⚠️ LAND CONFLICT  |
  | 【W -> main】     |
  | conflict in N     |
  | |-- file_a        |
  | `-- file_b        |
  +-------------------+
        |
        +-- model reads each file, keeps the intended result from both
        +-- sides, `git add`, finishes the land, explains the resolution
        +-- only asks you when both sides look deliberately contradictory
```

No popup. The model handles it and tells you what it kept; you only get asked when the two sides genuinely contradict each other.

Running `/land` at the origin lands the child this session owns and leaves other sessions' work alone (listed, untouched); with no own link it says so instead of popping a picker. Naming a branch/path explicitly takes it over deliberately, and the result notes the previous owner. `worktree_land` (the tool) never prompts and follows the remembered preference.

## Linkage — how sessions find each other

One file per link, in the shared git dir, so it survives `cd` and fresh sessions on either side:

```text
  .git/pi-worktree/
  |-- <link-id-1>.json     <-- session A owns wt-http-retry
  |-- <link-id-2>.json     <-- session B owns wt-login-fix
  +-- ...

  each link:
  {
    originPath, originBranch, originHead,
    worktreePath, branch, base,
    task, sessionId, status
  }
```

```text
  session A (~/repo)              git common dir              session B (worktree)
  ------------------              --------------              --------------------

  origin @ main                   pi-worktree/                cd ~/repo.worktrees/...
  creates wt-http-retry ──save──> <id-A>.json <──load── fresh session finds
                                  <id-B>.json ──save──> creates wt-login-fix
  every load reconciles against `git worktree list`:
  link points at a path git no longer lists → marked `removed`
```

- Parallel sessions only write their own file, so no session can clobber another's link. A legacy single `pi-worktree.json` is migrated on first load.
- Ownership scopes implicit work: a bare land/abandon resolves this session's own link (or the worktree you're standing in) and never auto-grabs another session's link. Naming a link explicitly takes it over deliberately — the result notes the previous owner (`foreign`), and the model says who owned it and what it did. Links created before ownership existed are unowned and landable by anyone.

```text
  who can land what?
  ------------------

  own link .............. YES
  unowned legacy link ... YES (single, auto)
  other session's link .. only when named explicitly (deliberate takeover, noted as foreign)
  standing inside it .... YES (possession counts)
```

The TUI widget shows readiness at a glance: `🌲 wt-fix-login → main · fix login retry · ↑3 · ↓1 · 2 dirty` (commits ahead, origin commits behind, uncommitted files), refreshed after every agent run. Origins show their own plus unowned children.

Transcript contract: every pi-worktree action renders exactly one purple block — a caps `LABEL` plus the hero in `【】`, dim detail lines aligned underneath with `|--` trees (`WORKTREE`, `LAND`, `LAND CONFLICT`, `ABANDON`, `ERROR`; conflict files stay bright). LAND cards show separate commit and file sections. No absolute paths, no green/red blocks; lists cap at 5–6 items and full output is one expand away. Cards signal state changes with the smallest effective payload — explanations and decisions belong to the model's own words.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `worktree_status` | Branch, clean/dirty files, all worktrees, origin/child linkage and the session's bound worktree. Silent in the transcript (pure triage plumbing). The model calls this before risky edits to decide whether to isolate. |
| `worktree_create` | The agent's `/worktree`: triages dirty files (`carryPaths`), names the branch itself (collisions auto-bump), binds the session, never prompts. Renders one purple `WORKTREE` block. |
| `worktree_land` | The agent's `/land` with `strategy` (remembered preference when omitted), `finish:true` / `abort:true` for conflict flows. Renders one purple `LAND` block. Resolves conflicts itself and explains; asks only on genuine contradiction. |
| `worktree_abandon` | Discard a worktree without landing. A dry run without `confirm:true` reports the unlanded commits and dirty files to lose; the model must confirm with you before passing `confirm:true`. Renders one purple `ABANDON` block. |

Every turn, a short policy section is appended to the system prompt:

- Bound → the working root, that paths are re-rooted, and to ask before `worktree_land` / `worktree_abandon`.
- `CLEAN` plus an experimental, risky, or parallel task → proactively offer or call `worktree_create`.
- `DIRTY` plus a new task → do not mix it into the dirty files; suggest `/worktree`.
- One session, one tree: a bare land/abandon resolves your own link and never auto-grabs another session's; name one explicitly only for a deliberate takeover.
- Never run raw `git worktree add/remove` — use the tools so linkage stays consistent.

## Safety

- Never force-pushes; never pushes at all.
- Landing never uses `-D` (only `branch -d`, and keeps the branch when worktree removal fails). `worktree_abandon` does force-delete — after a dry run and explicit confirmation for non-empty worktrees (empty ones drop immediately), and never `main`/`master`.
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
