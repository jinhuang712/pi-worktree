/**
 * pi-worktree git helpers.
 *
 * All git I/O goes through an injected `ExecFn` so unit tests can stub it
 * and the extension entry can wire it to `pi.exec`. Pure parsers stay
 * side-effect free for fast tests.
 */

import {
  loadStore,
  normalizePath,
  saveLink,
  type WorktreeStore,
} from "./state.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked?: string;
  prunable?: string;
}

export interface RepoFacts {
  topLevel: string;
  commonDir: string;
  branch: string | null;
  head: string | null;
  clean: boolean;
  porcelain: string;
  worktrees: WorktreeInfo[];
}

const GIT_TIMEOUT_MS = 30_000;

async function run(
  exec: ExecFn,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
  return exec("git", args, { cwd, signal, timeout });
}

/** Resolve repo top-level for cwd, or null when outside a repo. */
export async function getTopLevel(exec: ExecFn, cwd: string): Promise<string | null> {
  const r = await run(exec, ["rev-parse", "--show-toplevel"], cwd);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

/** Resolve shared git dir (respects worktrees: same value everywhere). */
export async function getCommonDir(exec: ExecFn, cwd: string): Promise<string | null> {
  const r = await run(exec, ["rev-parse", "--git-common-dir"], cwd);
  if (r.code !== 0) return null;
  const raw = r.stdout.trim();
  if (!raw) return null;
  if (raw.startsWith("/") || /^[A-Za-z]:\\/.test(raw)) return raw;
  // Relative like `.git` or `../.git/worktrees/foo` — resolve against top-level.
  const top = await getTopLevel(exec, cwd);
  if (!top) return null;
  const { resolve, dirname } = await import("node:path");
  // `git rev-parse --git-common-dir` is relative to cwd when relative.
  void dirname;
  return resolve(cwd, raw);
}

export async function getCurrentBranch(exec: ExecFn, cwd: string): Promise<string | null> {
  const r = await run(exec, ["branch", "--show-current"], cwd);
  if (r.code !== 0) return null;
  const b = r.stdout.trim();
  return b || null;
}

export async function getHead(exec: ExecFn, cwd: string): Promise<string | null> {
  const r = await run(exec, ["rev-parse", "HEAD"], cwd);
  if (r.code !== 0) return null;
  const h = r.stdout.trim();
  return h || null;
}

export async function getStatusPorcelain(
  exec: ExecFn,
  cwd: string,
): Promise<{ clean: boolean; porcelain: string }> {
  const r = await run(exec, ["status", "--porcelain=v1", "-uall"], cwd);
  if (r.code !== 0) return { clean: true, porcelain: "" };
  const porcelain = r.stdout.trimEnd();
  return { clean: porcelain.trim() === "", porcelain };
}

export function parseWorktreePorcelain(text: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> & { path?: string } = {};
  const flush = () => {
    if (cur.path) {
      out.push({
        path: cur.path,
        head: cur.head ?? "",
        branch: cur.branch ?? null,
        bare: cur.bare ?? false,
        detached: cur.detached ?? false,
        locked: cur.locked,
        prunable: cur.prunable,
      });
    }
    cur = {};
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (cur.path) flush();
      cur = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice(5).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice(7).trim();
      cur.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      cur.detached = false;
    } else if (line === "detached") {
      cur.detached = true;
      cur.branch = null;
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line.startsWith("locked")) {
      cur.locked = line.slice("locked".length).trim() || "locked";
    } else if (line.startsWith("prunable")) {
      cur.prunable = line.slice("prunable".length).trim() || "prunable";
    }
  }
  flush();
  return out;
}

export async function listWorktrees(exec: ExecFn, cwd: string): Promise<WorktreeInfo[]> {
  const r = await run(exec, ["worktree", "list", "--porcelain"], cwd);
  if (r.code !== 0) return [];
  return parseWorktreePorcelain(r.stdout);
}

export async function branchExists(exec: ExecFn, cwd: string, branch: string): Promise<boolean> {
  const r = await run(exec, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
  return r.code === 0;
}

export async function refExists(exec: ExecFn, cwd: string, ref: string): Promise<boolean> {
  const r = await run(exec, ["rev-parse", "--verify", "--quiet", ref], cwd);
  return r.code === 0;
}

export async function collectFacts(exec: ExecFn, cwd: string): Promise<RepoFacts | null> {
  const topLevel = await getTopLevel(exec, cwd);
  if (!topLevel) return null;
  const commonDir = (await getCommonDir(exec, cwd)) ?? "";
  const [branch, head, status, worktrees] = await Promise.all([
    getCurrentBranch(exec, cwd),
    getHead(exec, cwd),
    getStatusPorcelain(exec, cwd),
    listWorktrees(exec, cwd),
  ]);
  return {
    topLevel,
    commonDir,
    branch,
    head,
    clean: status.clean,
    porcelain: status.porcelain,
    worktrees,
  };
}

/** Replace git-hostile characters; keep `/` hierarchy. Returns "" when unusable. */
export function sanitizeBranchName(input: string): string {
  let s = input.trim();
  // Common `git check-ref-format` offenders.
  s = s.replace(/~|\^|:|\?|\*|\[|\\|\.\.|@{|\{|\}/g, "-");
  s = s.replace(/[\s'"]/g, "-");
  s = s.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  s = s.replace(/^\.+|\.+$/g, "").replace(/\.lock$/i, "");
  if (s === "" || s === "-" || s === "/") return "";
  if (s.endsWith(".") || s.endsWith("/")) return "";
  return s.slice(0, 200);
}

const SLUG_STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "and", "or", "with", "into",
  "please", "pls", "let", "lets", "let's", "me", "my", "we", "our", "this", "that",
  "it", "is", "be", "do", "go", "now", "then", "some", "all", "up",
]);

/**
 * Turn free task text into a short ASCII slug for branch names:
 * `"Fix the login retry bug"` → `fix-login-retry`. Up to three meaningful
 * words, 24 chars max. Returns "" when the text has no ASCII words (CJK
 * tasks fall back to the timestamp form).
 */
export function slugFromTask(task: string | null | undefined): string {
  if (!task) return "";
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/[\s_-]+/)
    .filter((w) => w.length > 1 && !SLUG_STOPWORDS.has(w));
  const picked: string[] = [];
  let len = 0;
  for (const w of words) {
    if (picked.length === 3 || len + w.length + (picked.length ? 1 : 0) > 24) break;
    picked.push(w);
    len += w.length + (picked.length > 1 ? 1 : 0);
  }
  return picked.join("-");
}

/**
 * Suggest a short, flat auto branch name. With task text that has ASCII
 * words: `wt-<slug>` (`wt-fix-login-retry`) so `git branch` reads like a
 * todo list. Otherwise `wt-<base>-<MMDD-HHMM>` (`wt-0904-1111` on
 * main/master). Pair with resolveUniqueBranch so collisions never hard-fail.
 */
export function suggestBranchName(originBranch: string | null, task?: string | null, now = new Date()): string {
  const rawBase = originBranch && originBranch !== "main" && originBranch !== "master"
    ? sanitizeBranchName(originBranch).replace(/\//g, "-")
    : "";
  const base = rawBase.slice(0, 24).replace(/-+$/, "");
  const slug = slugFromTask(task);
  if (slug) return base ? `wt-${base}-${slug}` : `wt-${slug}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return base ? `wt-${base}-${stamp}` : `wt-${stamp}`;
}

/** Bump `candidate` with -2/-3… until no branch collides. For auto names only;
 *  explicit user-supplied branches still error so typos stay visible. */
export async function resolveUniqueBranch(exec: ExecFn, cwd: string, candidate: string): Promise<string> {
  if (!(await branchExists(exec, cwd, candidate))) return candidate;
  for (let i = 2; i < 100; i++) {
    const next = `${candidate}-${i}`;
    if (!(await branchExists(exec, cwd, next))) return next;
  }
  return `${candidate}-${Date.now().toString(36)}`;
}

/**
 * Default sibling location that groups worktrees without polluting the repo:
 * `<parent>/<repo>.worktrees/<branch-with-slashes-as-dashes>`.
 */
export async function defaultWorktreePath(
  repoTop: string,
  branch: string,
): Promise<{ dir: string; path: string }> {
  const { basename, dirname, join } = await import("node:path");
  const flat = sanitizeBranchName(branch).replace(/\//g, "-") || "work";
  const dir = join(dirname(repoTop), `${basename(repoTop)}.worktrees`);
  return { dir, path: join(dir, flat) };
}

/** Append -2/-3… until the path does not exist on disk. */
export async function dedupePath(basePath: string): Promise<string> {
  const { existsSync } = await import("node:fs");
  if (!existsSync(basePath)) return basePath;
  for (let i = 2; i < 100; i++) {
    const cand = `${basePath}-${i}`;
    if (!existsSync(cand)) return cand;
  }
  return `${basePath}-${Date.now()}`;
}

/**
 * Self-heal the linkage store against git reality: active links whose
 * worktree no longer exists in `git worktree list` are marked removed.
 * Stores lie (manual removals, hand edits, crashes) — git is truth. Without
 * this, a stale store silently disables flip/ownership logic and the land
 * flow falls back to guessing direction. Empty live lists (git failing)
 * never wipe anything.
 */
export async function syncStoreWithGit(
  exec: ExecFn,
  cwd: string,
  commonDir: string,
): Promise<WorktreeStore> {
  const store = await loadStore(commonDir);
  const live = new Set((await listWorktrees(exec, cwd)).map((w) => normalizePath(w.path)));
  if (live.size === 0) return store;
  let changed = false;
  const links = store.links.map((l) => {
    if (l.status === "active" && !live.has(normalizePath(l.worktreePath))) {
      changed = true;
      return { ...l, status: "removed" as const, landedAt: Date.now() };
    }
    return l;
  });
  if (changed) {
    const next: WorktreeStore = { ...store, links };
    for (const l of links) {
      if (l.status === "removed" && store.links.some((o) => o.id === l.id && o.status === "active")) {
        await saveLink(commonDir, l);
      }
    }
    // Quiet git-side maintenance so no manual `prune` entry point is needed.
    try {
      await pruneWorktrees(exec, cwd);
    } catch {
      // Non-fatal.
    }
    return next;
  }
  return store;
}

export interface CarryResult {
  carried: boolean;
  stashRef?: string;
  reason?: string;
  conflict?: boolean;
  output?: string;
}

/**
 * Carry uncommitted changes (tracked + untracked) from origin to a fresh
 * worktree via a temporary stash. The stash lives in the shared repo so it
 * is visible from both worktrees. Drops the stash only on clean apply.
 */
export async function carryChangesViaStash(
  exec: ExecFn,
  originCwd: string,
  newCwd: string,
  label: string,
  signal?: AbortSignal,
): Promise<CarryResult> {
  const before = await run(exec, ["rev-parse", "-q", "--verify", "refs/stash"], originCwd, signal);
  const beforeSha = before.code === 0 ? before.stdout.trim() : "";

  const push = await run(exec, ["stash", "push", "-u", "-m", label], originCwd, signal);
  const pushOut = `${push.stdout}\n${push.stderr}`.trim();
  if (/No local changes to save/i.test(pushOut)) {
    return { carried: false, reason: "clean" };
  }
  if (push.code !== 0) {
    return { carried: false, reason: pushOut.slice(0, 500) || "stash push failed" };
  }

  const after = await run(exec, ["rev-parse", "-q", "--verify", "refs/stash"], originCwd, signal);
  const stashSha = after.code === 0 ? after.stdout.trim() : "";
  const stashRef = stashSha && stashSha !== beforeSha ? stashSha : "refs/stash";

  // Prefer `--index` to restore staged/unstaged separation; fall back plain.
  let apply = await run(exec, ["stash", "apply", "--index", stashRef], newCwd, signal);
  if (apply.code !== 0) {
    apply = await run(exec, ["stash", "apply", stashRef], newCwd, signal);
  }
  const applyOut = `${apply.stdout}\n${apply.stderr}`.trim();
  if (apply.code !== 0) {
    return { carried: false, stashRef, conflict: true, output: applyOut.slice(0, 2000) };
  }
  await run(exec, ["stash", "drop", "-q", stashRef], newCwd, signal);
  void beforeSha;
  return { carried: true, stashRef, output: applyOut.slice(0, 1000) };
}

export interface CreateWorktreeOptions {
  branch: string;
  path: string;
  base?: string;
  useExistingBranch?: boolean;
}

export interface CreateWorktreeResult {
  ok: boolean;
  output: string;
}

/** Run `git worktree add` for a new or existing branch. */
export async function createWorktree(
  exec: ExecFn,
  cwd: string,
  opts: CreateWorktreeOptions,
  signal?: AbortSignal,
): Promise<CreateWorktreeResult> {
  const args = opts.useExistingBranch
    ? ["worktree", "add", opts.path, opts.branch]
    : ["worktree", "add", "-b", opts.branch, opts.path, ...(opts.base ? [opts.base] : [])];
  const r = await run(exec, args, cwd, signal, 120_000);
  return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim().slice(0, 2000) };
}

export async function hasMergeHead(exec: ExecFn, cwd: string): Promise<boolean> {
  const r = await run(exec, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd);
  return r.code === 0 && r.stdout.trim() !== "";
}

export async function unmergedFiles(exec: ExecFn, cwd: string): Promise<string[]> {
  const r = await run(exec, ["diff", "--name-only", "--diff-filter=U"], cwd);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export async function abortMerge(exec: ExecFn, cwd: string): Promise<ExecResult> {
  return run(exec, ["merge", "--abort"], cwd);
}

export async function ensureCommitted(
  exec: ExecFn,
  cwd: string,
  message: string,
  signal?: AbortSignal,
): Promise<{ committed: boolean; sha?: string; output: string }> {
  const st = await getStatusPorcelain(exec, cwd);
  if (st.clean) return { committed: false, output: "clean" };
  const add = await run(exec, ["add", "-A"], cwd, signal);
  if (add.code !== 0) {
    return { committed: false, output: `git add failed: ${add.stderr.trim()}`.slice(0, 1000) };
  }
  const commit = await run(exec, ["commit", "-m", message], cwd, signal);
  const out = `${commit.stdout}\n${commit.stderr}`.trim().slice(0, 2000);
  if (commit.code !== 0) return { committed: false, output: out };
  const sha = await getHead(exec, cwd);
  return { committed: true, sha: sha ?? undefined, output: out };
}

/**
 * - `rebase`: rebase the source branch onto the target, then fast-forward
 *   the target — linear history, no merge commit. Falls back to `merge`
 *   when the rebase hits conflicts (so the normal MERGE_HEAD conflict flow
 *   applies instead of a half-done rebase).
 * - `merge`: plain `git merge --no-edit`.
 * - `squash`: one commit on the target carrying the whole worktree.
 */
export type LandStrategy = "rebase" | "merge" | "squash";

export interface LandMergeResult {
  ok: boolean;
  output: string;
  conflicted: string[];
  /** Distinguishes "conflict, MERGE_HEAD left in place" from plain failures
   *  (e.g. squash produced nothing to commit). */
  reason?: "conflict" | "nothing-to-land" | "failed";
  /** Strategy actually applied (rebase may fall back to merge). */
  applied: LandStrategy;
  note?: string;
}

export async function isDetached(exec: ExecFn, cwd: string): Promise<boolean> {
  const r = await run(exec, ["symbolic-ref", "-q", "HEAD"], cwd);
  return r.code !== 0;
}

/** Commits in `head` not in `base` (ahead) and vice versa (behind). */
export async function aheadBehind(
  exec: ExecFn,
  cwd: string,
  base: string,
  head: string,
): Promise<{ ahead: number; behind: number }> {
  const r = await run(exec, ["rev-list", "--left-right", "--count", `${base}...${head}`], cwd);
  if (r.code !== 0) return { ahead: 0, behind: 0 };
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export function parseShortstat(text: string): DiffStat {
  const files = /(\d+) files? changed/.exec(text);
  const ins = /(\d+) insertions?/.exec(text);
  const del = /(\d+) deletions?/.exec(text);
  return {
    files: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/** What landing `head` onto `base` would change (three-dot: since merge base). */
export async function diffStat(exec: ExecFn, cwd: string, base: string, head: string): Promise<DiffStat> {
  const r = await run(exec, ["diff", "--shortstat", `${base}...${head}`], cwd);
  return parseShortstat(r.code === 0 ? r.stdout : "");
}

/** Subject lines of commits in `head` not in `base`, newest first. */
export async function commitSubjects(exec: ExecFn, cwd: string, base: string, head: string, max = 20): Promise<string[]> {
  const r = await run(exec, ["log", "--format=%s", `-n${max}`, `${base}..${head}`], cwd);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Rebase the branch checked out at `cwd` onto `onto`. Aborts itself on
 *  conflict so the worktree is never left mid-rebase. */
export async function rebaseOnto(
  exec: ExecFn,
  cwd: string,
  onto: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string }> {
  const r = await run(exec, ["rebase", onto], cwd, signal, 120_000);
  const out = `${r.stdout}\n${r.stderr}`.trim().slice(0, 3000);
  if (r.code === 0) return { ok: true, output: out };
  await run(exec, ["rebase", "--abort"], cwd, signal);
  return { ok: false, output: out };
}

/** Land sourceBranch into the repo at targetCwd. Caller must pre-commit both sides. */
export async function mergeInto(
  exec: ExecFn,
  targetCwd: string,
  sourceBranch: string,
  strategy: LandStrategy,
  squashMessage: string,
  signal?: AbortSignal,
  sourceCwd?: string,
  targetBranch?: string | null,
): Promise<LandMergeResult> {
  if (strategy === "squash") {
    const m = await run(exec, ["merge", "--squash", sourceBranch], targetCwd, signal, 120_000);
    const out = `${m.stdout}\n${m.stderr}`.trim().slice(0, 3000);
    if (m.code !== 0) {
      const conflicted = await unmergedFiles(exec, targetCwd);
      return { ok: false, output: out, conflicted, reason: conflicted.length ? "conflict" : "failed", applied: "squash" };
    }
    const staged = await run(exec, ["diff", "--cached", "--quiet"], targetCwd, signal);
    if (staged.code === 0) {
      return { ok: false, output: out, conflicted: [], reason: "nothing-to-land", applied: "squash" };
    }
    const c = await run(exec, ["commit", "-m", squashMessage], targetCwd, signal);
    const cout = `${c.stdout}\n${c.stderr}`.trim().slice(0, 3000);
    if (c.code !== 0) {
      return { ok: false, output: `${out}\n${cout}`.slice(0, 3000), conflicted: [], reason: "failed", applied: "squash" };
    }
    return { ok: true, output: `${out}\n${cout}`.slice(0, 3000), conflicted: [], applied: "squash" };
  }

  let note: string | undefined;
  if (strategy === "rebase" && sourceCwd && targetBranch) {
    const rb = await rebaseOnto(exec, sourceCwd, targetBranch, signal);
    if (rb.ok) {
      const ff = await run(exec, ["merge", "--ff-only", sourceBranch], targetCwd, signal, 120_000);
      const out = `${rb.output}\n${ff.stdout}\n${ff.stderr}`.trim().slice(0, 3000);
      if (ff.code === 0) return { ok: true, output: out, conflicted: [], applied: "rebase" };
      note = "fast-forward failed after rebase; merged instead";
    } else {
      note = "rebase hit conflicts; merged instead so they can be resolved in place";
    }
  } else if (strategy === "rebase") {
    note = "rebase needs source path + target branch; merged instead";
  }

  const m = await run(exec, ["merge", "--no-edit", sourceBranch], targetCwd, signal, 120_000);
  const out = `${m.stdout}\n${m.stderr}`.trim().slice(0, 3000);
  if (m.code !== 0) {
    const conflicted = await unmergedFiles(exec, targetCwd);
    return { ok: false, output: out, conflicted, reason: conflicted.length ? "conflict" : "failed", applied: "merge", note };
  }
  return { ok: true, output: out, conflicted: [], applied: "merge", note };
}

export async function removeWorktree(
  exec: ExecFn,
  cwd: string,
  targetPath: string,
  force = false,
): Promise<ExecResult> {
  return run(exec, ["worktree", "remove", ...(force ? ["--force"] : []), targetPath], cwd);
}

export async function deleteBranch(
  exec: ExecFn,
  cwd: string,
  branch: string,
  force = false,
): Promise<ExecResult> {
  return run(exec, ["branch", force ? "-D" : "-d", branch], cwd);
}

export async function pruneWorktrees(exec: ExecFn, cwd: string): Promise<ExecResult> {
  return run(exec, ["worktree", "prune"], cwd);
}
