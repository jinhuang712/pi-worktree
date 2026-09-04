/**
 * pi-worktree — native git worktree flow for pi.
 *
 * Two user commands, everything else belongs to the model:
 * - `/worktree [task]` isolates work into a new worktree, binds the session
 *   to it (tool calls are re-rooted there) and hands the task to the agent.
 * - `/land` shows what would land, lets you pick rebase→ff / squash / merge,
 *   merges the worktree back into its origin and cleans up.
 * - Status, abandon, conflict continuation and strategy details live in the
 *   worktree_* tools + policy, not in user-facing flags.
 *
 * Linkage is stored per link in `<git-common-dir>/pi-worktree/` so it
 * survives `cd` + fresh sessions on either side, plus session entries for
 * the current branch view.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { rewriteToolInput, type Binding } from "./bind.ts";
import {
  abortMerge,
  aheadBehind,
  branchExists,
  carryChangesViaStash,
  collectFacts,
  commitSubjects,
  createWorktree,
  dedupePath,
  defaultWorktreePath,
  deleteBranch,
  diffStat,
  ensureCommitted,
  getCommonDir,
  getStatusPorcelain,
  getTopLevel,
  hasMergeHead,
  isDetached,
  listWorktrees,
  mergeInto,
  pruneWorktrees,
  refExists,
  removeWorktree,
  resolveUniqueBranch,
  sanitizeBranchName,
  suggestBranchName,
  syncStoreWithGit,
  unmergedFiles,
  type DiffStat,
  type ExecFn,
  type LandStrategy,
} from "./git.ts";
import { buildPolicySection } from "./policy.ts";
import {
  activeLinkFor,
  canonicalPath,
  childrenOf,
  findByWorktree,
  foreignOwnerOf,
  loadStore,
  makeId,
  orderKidsForDisplay,
  ownerLabel,
  ownActiveLink,
  saveLink,
  samePath,
  visibleKidsFor,
  type WorktreeLink,
  type WorktreeStore,
} from "./state.ts";

const WIDGET_KEY = "pi-worktree";
const STATUS_KEY = "pi-worktree";
const CARD_TYPE = "pi-worktree";
const LINK_ENTRY = "pi-worktree-link";
const EVENT_ENTRY = "pi-worktree-event";

type Strategy = LandStrategy;
const DEFAULT_STRATEGY: Strategy = "rebase";

// ------------------------------------------------------------------ helpers

function makeExec(pi: ExtensionAPI, signal?: AbortSignal): (cwd: string) => ExecFn {
  return (cwd: string) => (cmd, args, opts) =>
    pi.exec(cmd, args, { signal, timeout: opts?.timeout, cwd: opts?.cwd ?? cwd });
}

function pluralWorktree(n: number): string {
  return n === 1 ? "1 worktree" : `${n} worktrees`;
}

/** Compact human display, relative to the session cwd (e.g. `../repo.worktrees/wt-x`). */
async function displayPath(absPath: string, fromDir: string): Promise<string> {
  const { relative } = await import("node:path");
  const rel = relative(fromDir, absPath);
  return rel && !rel.startsWith("..") ? `./${rel}` : rel || ".";
}

function truncateMiddle(s: string, max = 60): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return "unknown";
  return sha.slice(0, 7);
}

/** Visible in every mode: TUI/RPC via notify, print/json via stdout. */
function emit(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
    return;
  }
  (level === "error" ? console.error : console.log)(text);
}

/** Load linkage self-healed against `git worktree list`; falls back to the raw
 *  store when git is unavailable so reads never break. */
async function loadSyncedStore(exec: ExecFn, cwd: string, commonDir: string): Promise<WorktreeStore> {
  try {
    return await syncStoreWithGit(exec, cwd, commonDir);
  } catch {
    return loadStore(commonDir);
  }
}

/** First line of the task, trimmed to a commit-subject length. */
function subjectFromTask(task: string | null | undefined, fallback: string): string {
  const first = (task ?? "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  return first ? truncateMiddle(first, 72) : fallback;
}

function fmtStat(s: DiffStat): string {
  const parts = [`${s.files} file${s.files === 1 ? "" : "s"}`];
  if (s.insertions) parts.push(`+${s.insertions}`);
  if (s.deletions) parts.push(`−${s.deletions}`);
  return parts.join(" ");
}

/** `/worktree` grammar: every positional is task text; the branch is `--branch`. */
function parseWorktreeArgs(raw: string): {
  branch?: string;
  base?: string;
  path?: string;
  carry: boolean;
  json: boolean;
  yes: boolean;
  help: boolean;
  task: string;
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let branch: string | undefined;
  let base: string | undefined;
  let path: string | undefined;
  let carry = true;
  let json = false;
  let yes = false;
  let help = false;
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--no-carry") carry = false;
    else if (t === "--json") json = true;
    else if (t === "--yes" || t === "-y") yes = true;
    else if ((t === "--branch" || t === "-b") && tokens[i + 1]) branch = tokens[++i];
    else if (t.startsWith("--branch=")) branch = t.slice("--branch=".length);
    else if (t === "--base" && tokens[i + 1]) base = tokens[++i];
    else if (t.startsWith("--base=")) base = t.slice("--base=".length);
    else if (t === "--path" && tokens[i + 1]) path = tokens[++i];
    else if (t.startsWith("--path=")) path = t.slice("--path=".length);
    else if (t === "--help" || t === "-h") help = true;
    else if (!t.startsWith("--")) words.push(t);
  }
  return { branch, base, path, carry, json, yes, help, task: words.join(" ") };
}

function formatWorktreeList(
  topLevel: string,
  branch: string | null,
  clean: boolean,
  porcelain: string,
  worktrees: { path: string; branch: string | null; bare?: boolean; detached?: boolean }[],
  originOfCurrent?: WorktreeLink,
  kids: WorktreeLink[] = [],
  me?: string | null,
  bound?: Binding | null,
): string {
  const lines = [
    `Repo: ${topLevel}`,
    `Current: ${branch ?? "(detached)"} ${clean ? "CLEAN" : "DIRTY"}`,
  ];
  if (bound) lines.push(`Bound worktree (this session): ${bound.branch} @ ${bound.root} — tool calls are re-rooted there.`);
  if (!clean) {
    const files = porcelain.split("\n").filter(Boolean);
    lines.push(`Dirty files (${files.length}):`);
    for (const f of files.slice(0, 15)) lines.push(`  ${f}`);
    if (files.length > 15) lines.push(`  … ${files.length - 15} more`);
  }
  lines.push(`Worktrees (${worktrees.length}):`);
  for (const w of worktrees) {
    const label = w.branch ?? (w.detached ? "(detached)" : w.bare ? "(bare)" : "?");
    lines.push(`  ${label}  ${w.path}`);
  }
  if (originOfCurrent && originOfCurrent.status === "active") {
    const tag = ownerLabel(originOfCurrent, me);
    lines.push(`Linked origin: ${originOfCurrent.originBranch ?? "?"} @ ${originOfCurrent.originPath}${tag ? ` ${tag}` : ""}`);
  }
  if (kids.length > 0) {
    lines.push(`Linked children (${kids.length}):`);
    for (const k of kids) {
      const tag = ownerLabel(k, me);
      lines.push(`  ${k.branch}  ${k.worktreePath}${tag ? ` ${tag}` : ""}${k.task ? `  — ${truncateMiddle(k.task, 50)}` : ""}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  const getExec = (cwd: string, signal?: AbortSignal): ExecFn => makeExec(pi, signal)(cwd);

  /** Session ↔ worktree binding, refreshed at session start, before every
   *  agent run, and after create/land/abandon. Null = not bound. */
  let binding: (Binding & { standingInside: boolean; task?: string | null }) | null = null;

  async function resolveBinding(exec: ExecFn, cwd: string, me: string | null | undefined): Promise<typeof binding> {
    const facts = await collectFacts(exec, cwd);
    if (!facts || !facts.commonDir) return (binding = null);
    const canon = await canonicalPath(facts.topLevel);
    const store = await loadSyncedStore(exec, cwd, facts.commonDir);
    const inside = activeLinkFor(store, canon);
    const link = inside ?? ownActiveLink(store, canon, me);
    if (!link) return (binding = null);
    binding = {
      root: link.worktreePath,
      origin: link.originPath,
      branch: link.branch,
      originBranch: link.originBranch,
      linkId: link.id,
      standingInside: !!inside,
      task: link.task ?? null,
    };
    return binding;
  }

  async function recordEvent(data: Record<string, unknown>): Promise<void> {
    try {
      pi.appendEntry(EVENT_ENTRY, data);
    } catch {
      // Non-fatal.
    }
  }

  // ------------------------------------------------------------------ chrome

  /**
   * Widget + footer + terminal title. Bound sessions see one line that says
   * where they are and whether the worktree is ready to land:
   *   🌲 wt-fix-login → main · ↑3 · ↓1 · 2 dirty
   * Origins with children see their own/unowned children. Chrome never throws.
   */
  async function refreshChrome(ctx: ExtensionContext, cwd: string): Promise<void> {
    try {
      const exec = makeExec(pi, ctx.signal ?? undefined)(cwd);
      const facts = await collectFacts(exec, cwd);
      const clear = () => {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
      };
      if (!facts) return clear();
      const th = ctx.ui.theme;
      const canon = await canonicalPath(facts.topLevel);
      const store = facts.commonDir ? await loadSyncedStore(exec, cwd, facts.commonDir) : null;
      const me = ctx.sessionManager.getSessionId();
      const inside = store ? activeLinkFor(store, canon) : undefined;
      const owned = store ? ownActiveLink(store, canon, me) : undefined;
      const link = inside ?? owned;

      if (link) {
        const dest = link.originBranch ?? "origin";
        const wtFacts = inside ? facts : await collectFacts(exec, link.worktreePath);
        const dirty = wtFacts ? wtFacts.porcelain.split("\n").filter(Boolean).length : 0;
        const ab = link.originBranch
          ? await aheadBehind(exec, link.worktreePath, link.originBranch, "HEAD")
          : { ahead: 0, behind: 0 };
        const bits: string[] = [];
        if (ab.ahead) bits.push(th.fg("success", `↑${ab.ahead}`));
        if (ab.behind) bits.push(th.fg("warning", `↓${ab.behind}`));
        if (dirty) bits.push(th.fg("warning", `${dirty} dirty`));
        if (!ab.ahead && !dirty) bits.push(th.fg("dim", "nothing to land yet"));
        const head = th.fg("accent", `🌲 ${link.branch} → ${dest}`);
        const task = link.task ? th.fg("dim", ` · ${truncateMiddle(link.task, 36)}`) : "";
        ctx.ui.setWidget(WIDGET_KEY, [`${head}${task} · ${bits.join(" · ")}`]);
        ctx.ui.setStatus(STATUS_KEY, th.fg("accent", `🌲 ${link.branch}`) + (ab.ahead ? th.fg("dim", ` ↑${ab.ahead}`) : ""));
        try { ctx.ui.setTitle(`🌲 ${link.branch}`); } catch { /* optional */ }
        return;
      }

      const kids = store ? childrenOf(store, canon) : [];
      const visible = orderKidsForDisplay(visibleKidsFor(kids, me, canon), me);
      if (visible.length === 0) return clear();
      const shown = visible.slice(0, 3).map((k) => k.branch).join(" · ");
      const more = visible.length > 3 ? ` +${visible.length - 3}` : "";
      ctx.ui.setWidget(WIDGET_KEY, [`${th.fg("accent", `🌲 ${pluralWorktree(visible.length)}`)} ${th.fg("dim", `· ${shown}${more}`)}`]);
      ctx.ui.setStatus(STATUS_KEY, th.fg("accent", `🌲 ${visible.length}`));
    } catch {
      // Chrome must never break the session.
    }
  }

  // Compact result cards: the full text stays in message content for the
  // model, humans see two lines. Full output is one expand away.
  type CardDetails =
    | { kind: "create"; branch: string; rel: string; task: string; carried: boolean }
    | { kind: "land"; ok: boolean; branch: string; dest: string; strategy: string; sha: string | null; note: string; conflicted?: string[]; reason?: string }
    | { kind: "abandon"; ok: boolean; branch: string; commits: number; reason?: string };

  pi.registerMessageRenderer(CARD_TYPE, (message, opts, theme) => {
    const full = typeof message.content === "string" ? message.content : "";
    const d = message.details as CardDetails | undefined;
    if (opts.expanded || !d) return new Text(full, opts.outputPad, 0);
    const two = (head: string, tail: string) => new Text(`${head}\n${theme.fg("dim", tail)}`, opts.outputPad, 0);

    if (d.kind === "create") {
      const head = d.task ? `🌲 ${d.branch} · ${truncateMiddle(d.task)}` : `🌲 ${d.branch}`;
      return two(theme.fg("accent", head), `${d.rel}${d.carried ? " · carried changes" : ""}`);
    }
    if (d.kind === "abandon") {
      if (!d.ok) return two(theme.fg("error", `🗑 abandon ${d.branch} failed`), d.reason ?? "");
      return two(theme.fg("warning", `🗑 abandoned ${d.branch}`), d.commits ? `${d.commits} commit${d.commits === 1 ? "" : "s"} discarded` : "no commits discarded");
    }
    if (!d.ok) {
      if (d.reason === "conflict" && d.conflicted?.length) {
        const files = d.conflicted.slice(0, 4).join(", ") + (d.conflicted.length > 4 ? ` +${d.conflicted.length - 4}` : "");
        return two(theme.fg("error", `⚠ conflict landing ${d.branch} → ${d.dest}`), `${d.conflicted.length} file${d.conflicted.length === 1 ? "" : "s"}: ${files}`);
      }
      return new Text(full, opts.outputPad, 0);
    }
    const tail = `${d.strategy} · ${shortSha(d.sha)}${d.note ? ` · ${d.note}` : ""}`;
    return two(theme.fg("success", `🌲 landed ${d.branch} → ${d.dest}`), tail);
  });

  // ------------------------------------------------------------- create flow

  interface CreateOpts {
    branch?: string;
    base?: string;
    path?: string;
    carry: boolean;
    task: string;
    reason?: string | null;
    sessionId: string | null;
  }

  type CreateResult =
    | { ok: true; link: WorktreeLink; branch: string; path: string; carried: boolean; carryNote: string }
    | { ok: false; reason: string; text: string; link?: WorktreeLink };

  async function createFlow(exec: ExecFn, cwd: string, opts: CreateOpts): Promise<CreateResult> {
    const topLevel = await getTopLevel(exec, cwd);
    if (!topLevel) return { ok: false, reason: "not-a-repo", text: "Not a git repository." };
    const commonDir = await getCommonDir(exec, cwd);
    if (!commonDir) return { ok: false, reason: "no-common-dir", text: "Cannot resolve git dir." };
    const facts = await collectFacts(exec, cwd);
    if (!facts) return { ok: false, reason: "not-a-repo", text: "Not a git repository." };
    const canon = await canonicalPath(topLevel);

    // One session, one worktree per repo — point back at the owned link.
    const owned = ownActiveLink(await loadSyncedStore(exec, cwd, commonDir), canon, opts.sessionId);
    if (owned) {
      return {
        ok: false,
        reason: "already-own-active",
        link: owned,
        text: `This session already owns worktree \`${owned.branch}\` at ${owned.worktreePath}${owned.task ? ` (${truncateMiddle(owned.task, 40)})` : ""} — continue there. /land it first if the work is done.`,
      };
    }

    const explicit = sanitizeBranchName(opts.branch ?? "");
    const branch = explicit || await resolveUniqueBranch(exec, cwd, sanitizeBranchName(suggestBranchName(facts.branch, opts.task)));
    if (!branch) return { ok: false, reason: "bad-branch", text: "Cannot determine a valid branch name." };
    if (explicit && await branchExists(exec, cwd, branch)) {
      return { ok: false, reason: "branch-exists", text: `Branch \`${branch}\` already exists. Pick another name.` };
    }
    if (opts.base && !(await refExists(exec, cwd, opts.base))) {
      return { ok: false, reason: "bad-base", text: `Base ref \`${opts.base}\` does not exist.` };
    }

    const { resolve } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    let targetPath: string;
    if (opts.path) {
      targetPath = opts.path.startsWith("/") ? opts.path : resolve(cwd, opts.path);
    } else {
      const { dir, path: dflt } = await defaultWorktreePath(topLevel, branch);
      await mkdir(dir, { recursive: true });
      targetPath = await dedupePath(dflt);
    }

    const created = await createWorktree(exec, cwd, { branch, path: targetPath, base: opts.base });
    if (!created.ok) return { ok: false, reason: "worktree-add-failed", text: `git worktree add failed:\n${created.output}` };

    let carried = false;
    let carryNote = "clean — nothing to carry";
    if (opts.carry && !facts.clean) {
      const res = await carryChangesViaStash(exec, cwd, targetPath, `pi-worktree:${branch}`);
      carried = res.carried;
      carryNote = res.carried
        ? "uncommitted changes carried via stash"
        : res.conflict
          ? `carry CONFLICT — stash kept (${res.stashRef ?? "refs/stash"}); resolve in ${targetPath}. ${res.output ?? ""}`
          : `carry skipped: ${res.reason ?? res.output ?? "unknown"}`;
    } else if (!opts.carry) {
      carryNote = "carry disabled — new worktree starts from base only";
    }

    const link: WorktreeLink = {
      id: makeId(),
      originPath: canon,
      originBranch: facts.branch,
      originHead: facts.head,
      worktreePath: await canonicalPath(targetPath),
      branch,
      base: opts.base ?? facts.head,
      carried,
      createdAt: Date.now(),
      status: "active",
      sessionId: opts.sessionId,
      sessionName: pi.getSessionName() ?? null,
      task: opts.task || opts.reason || null,
    };
    await saveLink(commonDir, link);
    pi.appendEntry(LINK_ENTRY, link);
    await recordEvent({ kind: "create", ...link });
    return { ok: true, link, branch, path: targetPath, carried, carryNote };
  }

  /** Bind the session to a fresh link: name, title, chrome, policy cache. */
  async function bindSession(ctx: ExtensionContext, link: WorktreeLink): Promise<void> {
    try {
      pi.setSessionName(`🌲 ${link.branch}${link.task ? ` · ${truncateMiddle(link.task, 40)}` : ""}`);
    } catch {
      // Non-fatal.
    }
    const exec = getExec(ctx.cwd, ctx.signal ?? undefined);
    await resolveBinding(exec, ctx.cwd, ctx.sessionManager.getSessionId());
    await refreshChrome(ctx, ctx.cwd);
  }

  /** Undo bindSession after land/abandon: restore the pre-worktree name. */
  async function unbindSession(ctx: ExtensionContext, link: WorktreeLink | undefined): Promise<void> {
    if (link && binding && binding.linkId === link.id) {
      try {
        pi.setSessionName(link.sessionName || `✓ ${link.branch}`);
      } catch {
        // Non-fatal.
      }
      try {
        const { basename } = await import("node:path");
        ctx.ui.setTitle(basename(link.originPath));
      } catch {
        // Optional.
      }
    }
    const exec = getExec(ctx.cwd, ctx.signal ?? undefined);
    await resolveBinding(exec, ctx.cwd, ctx.sessionManager.getSessionId());
    await refreshChrome(ctx, ctx.cwd);
  }

  // --------------------------------------------------------------- land flow

  interface LandPreview {
    sourceBranch: string;
    targetBranch: string | null;
    ahead: number;
    behind: number;
    dirtySource: number;
    dirtyTarget: number;
    stat: DiffStat;
    subjects: string[];
    message: string;
  }

  interface LandFlowOpts {
    to?: string;
    strategy: Strategy;
    message?: string;
    remove: boolean;
    finish: boolean;
    abort: boolean;
    /** Current pi session id — gates session-exclusive links. */
    sessionId?: string | null;
    /** Slash-side override for foreign-owned links (confirm dialog). Tools omit it → hard deny. */
    confirmForeign?: (links: WorktreeLink[]) => Promise<boolean>;
    /** Slash-side picker when several children hang off this origin. */
    pickChild?: (kids: WorktreeLink[]) => Promise<WorktreeLink | undefined>;
    /** Slash-side preview: return the strategy to use, or undefined to cancel. */
    review?: (p: LandPreview) => Promise<{ strategy: Strategy; message: string } | undefined>;
  }

  interface LandResult {
    text: string;
    details: Record<string, unknown>;
    link?: WorktreeLink;
  }

  async function landFlow(exec: ExecFn, cwd: string, opts: LandFlowOpts): Promise<LandResult> {
    const topLevel = await getTopLevel(exec, cwd);
    if (!topLevel) return { text: "Not a git repository.", details: { ok: false, reason: "not-a-repo" } };
    const commonDir = await getCommonDir(exec, cwd);
    if (!commonDir) return { text: "Cannot resolve git dir.", details: { ok: false, reason: "no-common-dir" } };
    const canon = await canonicalPath(topLevel);
    const store = await loadSyncedStore(exec, cwd, commonDir);

    // Resolve source (where the feature commits live) and target (origin).
    // Standing in a child: source = here, target = origin. Standing at the
    // origin: source = the bound/only child, target = here. Both DWIM so the
    // user never has to think about direction.
    let link = activeLinkFor(store, canon) ?? findByWorktree(store, canon);
    let sourcePath = canon;
    let sourceBranch = (await collectFacts(exec, cwd))?.branch ?? link?.branch ?? null;
    let targetPath: string | undefined;
    let targetBranch: string | undefined;

    const flipTo = async (child: WorktreeLink) => {
      link = child;
      sourcePath = await canonicalPath(child.worktreePath);
      sourceBranch = child.branch;
      targetPath = canon;
      targetBranch = (await collectFacts(exec, cwd))?.branch ?? child.originBranch ?? undefined;
    };

    if (link && link.status === "active") {
      targetPath = link.originPath;
      targetBranch = link.originBranch ?? undefined;
    } else if (!opts.to) {
      const kids = childrenOf(store, canon);
      const mine = opts.sessionId ? kids.find((k) => k.sessionId === opts.sessionId) : undefined;
      if (mine) {
        await flipTo(mine);
      } else if (kids.length === 1) {
        await flipTo(kids[0]);
      } else if (kids.length > 1) {
        const picked = opts.pickChild ? await opts.pickChild(kids) : undefined;
        if (!picked) {
          const names = kids.map((k) => `${k.branch} @ ${k.worktreePath}${k.task ? ` — ${truncateMiddle(k.task, 40)}` : ""}`).join("\n");
          return {
            text: opts.pickChild
              ? "Cancelled."
              : `Multiple active worktrees hang off this origin. Specify which one (branch or path) and retry:\n${names}`,
            details: { ok: false, reason: opts.pickChild ? "cancelled" : "ambiguous-child", children: kids },
          };
        }
        await flipTo(picked);
      }
    }
    if (opts.to) {
      const { existsSync } = await import("node:fs");
      if (opts.to.startsWith("/") && existsSync(opts.to)) {
        targetPath = await canonicalPath(opts.to);
      } else {
        const wts = await listWorktrees(exec, cwd);
        const hit = wts.find((w) => w.branch === opts.to);
        if (hit) {
          targetPath = await canonicalPath(hit.path);
          targetBranch = hit.branch ?? undefined;
        } else {
          targetPath = opts.to;
        }
      }
      // DWIM: naming a linked child of the current location means "land that
      // child here" — never "merge here into the child".
      if (targetPath && !activeLinkFor(store, canon)) {
        const named = findByWorktree(store, targetPath);
        if (named && named.status === "active" && samePath(named.originPath, canon) && !samePath(targetPath, canon)) {
          await flipTo(named);
        }
      }
    }
    if (!targetPath) {
      const wts = await listWorktrees(exec, cwd);
      const others = wts.filter((w) => w.path !== canon && !w.bare);
      if (others.length === 1) {
        targetPath = await canonicalPath(others[0].path);
        targetBranch = others[0].branch ?? undefined;
        const hereBranch = (await collectFacts(exec, cwd))?.branch;
        const hereIsMain = hereBranch === "main" || hereBranch === "master";
        const otherIsMain = targetBranch === "main" || targetBranch === "master";
        if (hereIsMain && !otherIsMain) {
          sourcePath = targetPath;
          sourceBranch = targetBranch ?? null;
          targetPath = canon;
          targetBranch = hereBranch ?? undefined;
        }
      } else {
        const names = others.map((w) => `${w.branch ?? "?"} @ ${w.path}`).join("\n") || "(none)";
        return {
          text: `Cannot determine land target. Pass target explicitly.\nOther worktrees:\n${names}`,
          details: { ok: false, reason: "ambiguous-target", others },
        };
      }
    }
    targetPath = await canonicalPath(targetPath);

    if (targetPath === sourcePath) {
      return { text: "Source and target are the same worktree — nothing to land.", details: { ok: false, reason: "same-path" } };
    }
    if (!sourceBranch) {
      return {
        text: "Source HEAD is detached — create a branch first (`git switch -c <name>`) so /land knows what to merge.",
        details: { ok: false, reason: "detached-source" },
      };
    }
    if (await isDetached(exec, targetPath)) {
      return {
        text: `Target ${targetPath} is on a detached HEAD — landing there would leave the result on an anonymous commit. Check out a branch in the target first.`,
        details: { ok: false, reason: "detached-target", target: targetPath },
      };
    }
    if (!targetBranch) targetBranch = (await collectFacts(exec, targetPath))?.branch ?? undefined;

    // Session exclusivity: never silently touch another session's live worktree.
    {
      const candidates = [link, findByWorktree(store, targetPath)];
      const foreign = [...new Set(candidates.filter((l): l is WorktreeLink => !!l))]
        .map((l) => foreignOwnerOf(l, opts.sessionId, canon))
        .filter((l): l is WorktreeLink => !!l);
      if (foreign.length > 0) {
        const who = foreign.map((l) => `\`${l.branch}\` ${ownerLabel(l, opts.sessionId)}`).join(", ");
        if (opts.confirmForeign) {
          if (!(await opts.confirmForeign(foreign))) {
            return { text: "Cancelled — left the other session's worktree alone.", details: { ok: false, reason: "cancelled" } };
          }
        } else {
          return {
            text: `Blocked: ${who} belongs to another session. Ask the user before landing it — pass an explicit target from the owning session instead.`,
            details: { ok: false, reason: "owned-by-other", branches: foreign.map((l) => l.branch) },
          };
        }
      }
    }

    // Abort / finish operate on whichever side holds MERGE_HEAD.
    const mergeDir = (await hasMergeHead(exec, targetPath))
      ? targetPath
      : (await hasMergeHead(exec, sourcePath)) ? sourcePath : null;
    if (opts.abort) {
      if (!mergeDir) return { text: "No merge in progress here — nothing to abort.", details: { ok: false, reason: "no-merge" } };
      const r = await abortMerge(exec, mergeDir);
      const out = `${r.stdout}\n${r.stderr}`.trim();
      await recordEvent({ kind: "land-abort", dir: mergeDir });
      return { text: r.code === 0 ? `Merge aborted in ${mergeDir}.\n${out}` : `Abort failed in ${mergeDir}.\n${out}`, details: { ok: r.code === 0, dir: mergeDir } };
    }
    if (opts.finish || mergeDir) {
      if (!mergeDir) return { text: "No merge in progress — nothing to finish.", details: { ok: false, reason: "no-merge" } };
      const unmerged = await unmergedFiles(exec, mergeDir);
      if (unmerged.length > 0) {
        return {
          text: `Merge in progress in ${mergeDir} with conflicts:\n${unmerged.map((f) => `  ${f}`).join("\n")}\nResolve files, \`git add\` them, then finish the land (worktree_land finish:true). To abandon it, abort (worktree_land abort:true).`,
          details: { ok: false, reason: "conflict", conflicted: unmerged, target: mergeDir, branch: sourceBranch, dest: targetBranch },
        };
      }
      const commit = await exec("git", ["commit", "--no-edit"], { cwd: mergeDir });
      const out = `${commit.stdout}\n${commit.stderr}`.trim().slice(0, 2000);
      if (commit.code !== 0) return { text: `Could not conclude merge:\n${out}`, details: { ok: false, reason: "finish-failed", output: out } };
      const sha = await headOf(exec, mergeDir);
      const effLink = link ?? store.links.find((l) => l.status === "active" && samePath(l.originPath, mergeDir));
      if (effLink) await saveLink(commonDir, { ...effLink, status: "landed", landedAt: Date.now(), landStrategy: "merge", landSha: sha });
      await recordEvent({ kind: "land-finish", source: effLink?.worktreePath ?? sourcePath, target: mergeDir, sha });
      const cleanup = opts.remove && effLink
        ? await cleanupWorktree(exec, commonDir, effLink, effLink.worktreePath, effLink.branch, mergeDir)
        : opts.remove ? "Linkage not found — worktree left in place; remove manually with `git worktree remove <path>`." : "";
      return {
        text: `Merge concluded in ${mergeDir} (${shortSha(sha)}).\n${out}${cleanup ? `\n${cleanup}` : ""}`,
        details: { ok: true, finished: true, sha, target: mergeDir, cleanup, strategy: "merge", branch: effLink?.branch ?? sourceBranch, dest: effLink?.originBranch ?? targetBranch },
        link: effLink,
      };
    }

    // Preview: what lands, and with which message.
    const srcStatus = await getStatusPorcelain(exec, sourcePath);
    const tgtStatus = await getStatusPorcelain(exec, targetPath);
    const ab = targetBranch ? await aheadBehind(exec, sourcePath, targetBranch, "HEAD") : { ahead: 0, behind: 0 };
    const stat = targetBranch ? await diffStat(exec, sourcePath, targetBranch, "HEAD") : { files: 0, insertions: 0, deletions: 0 };
    const subjects = targetBranch ? await commitSubjects(exec, sourcePath, targetBranch, "HEAD") : [];
    const defaultMsg = opts.message?.trim() || subjectFromTask(link?.task, `${sourceBranch}: land into ${targetBranch ?? "origin"}`);
    const preview: LandPreview = {
      sourceBranch,
      targetBranch: targetBranch ?? null,
      ahead: ab.ahead,
      behind: ab.behind,
      dirtySource: srcStatus.porcelain.split("\n").filter(Boolean).length,
      dirtyTarget: tgtStatus.porcelain.split("\n").filter(Boolean).length,
      stat,
      subjects,
      message: defaultMsg,
    };
    if (preview.ahead === 0 && preview.dirtySource === 0) {
      return {
        text: `Nothing to land: \`${sourceBranch}\` has no commits or changes beyond \`${targetBranch ?? "origin"}\`.${link ? " Use worktree_abandon to drop the worktree." : ""}`,
        details: { ok: false, reason: "nothing-to-land", branch: sourceBranch, dest: targetBranch },
      };
    }
    let strategy = opts.strategy;
    let message = defaultMsg;
    if (opts.review) {
      const choice = await opts.review(preview);
      if (!choice) return { text: "Cancelled.", details: { ok: false, reason: "cancelled" } };
      strategy = choice.strategy;
      message = choice.message || defaultMsg;
    }

    // Checkpoint both sides. The source checkpoint carries the task as its
    // subject so the landed history reads like intent, not timestamps.
    if (!srcStatus.clean) {
      const c = await ensureCommitted(exec, sourcePath, message);
      if (!c.committed) {
        return {
          text: `Could not commit pending changes in ${sourcePath}:\n${c.output}\nConfigure git identity or commit manually, then retry.`,
          details: { ok: false, reason: "commit-failed", output: c.output },
        };
      }
    }
    let targetCheckpoint: string | null = null;
    if (!tgtStatus.clean) {
      const c = await ensureCommitted(exec, targetPath, `wip(${targetBranch ?? "origin"}): checkpoint before landing ${sourceBranch}`);
      if (!c.committed) {
        return {
          text: `Could not commit pending changes in target ${targetPath}:\n${c.output}\nConfigure git identity or commit manually, then retry.`,
          details: { ok: false, reason: "target-commit-failed", output: c.output, target: targetPath },
        };
      }
      targetCheckpoint = c.sha ?? null;
    }

    const merged = await mergeInto(exec, targetPath, sourceBranch, strategy, message, undefined, sourcePath, targetBranch ?? null);
    if (!merged.ok) {
      if (merged.reason === "conflict") {
        await recordEvent({ kind: "land-conflict", source: sourcePath, target: targetPath, conflicted: merged.conflicted });
        return {
          text: [
            `Merge conflict landing \`${sourceBranch}\` into ${targetPath}${merged.note ? ` (${merged.note})` : ""}.`,
            `Conflicted files:\n${merged.conflicted.map((f) => `  ${f}`).join("\n")}`,
            `Resolve files in ${targetPath}, \`git add\` them, then finish the land (worktree_land finish:true). To abandon it, abort (worktree_land abort:true).`,
          ].join("\n"),
          details: { ok: false, reason: "conflict", conflicted: merged.conflicted, target: targetPath, source: sourcePath, output: merged.output, branch: sourceBranch, dest: targetBranch },
          link: link ?? undefined,
        };
      }
      return {
        text: merged.reason === "nothing-to-land"
          ? `Nothing to land: \`${sourceBranch}\` introduces no changes on top of \`${targetBranch ?? "origin"}\`.`
          : `Landing \`${sourceBranch}\` failed (${merged.applied}):\n${merged.output}`,
        details: { ok: false, reason: merged.reason ?? "failed", output: merged.output, branch: sourceBranch, dest: targetBranch },
      };
    }

    const sha = await headOf(exec, targetPath);
    if (link) await saveLink(commonDir, { ...link, status: "landed", landedAt: Date.now(), landStrategy: merged.applied, landSha: sha });
    await recordEvent({ kind: "land", source: sourcePath, target: targetPath, strategy: merged.applied, sha });
    const cleanup = opts.remove ? await cleanupWorktree(exec, commonDir, link, sourcePath, sourceBranch, targetPath) : "";
    const label = merged.applied === "rebase" ? "rebase → ff" : merged.applied;
    return {
      text: [
        `Landed \`${sourceBranch}\` into ${targetPath} (${label}, ${shortSha(sha)}).`,
        merged.note ?? "",
        targetCheckpoint ? `Target had pending changes — checkpointed as ${shortSha(targetCheckpoint)} before landing.` : "",
        merged.output,
        cleanup,
      ].filter(Boolean).join("\n"),
      details: { ok: true, sha, target: targetPath, source: sourcePath, strategy: label, note: merged.note, cleanup, targetCheckpoint, branch: sourceBranch, dest: targetBranch },
      link: link ?? undefined,
    };
  }

  async function headOf(exec: ExecFn, cwd: string): Promise<string | null> {
    const r = await exec("git", ["rev-parse", "HEAD"], { cwd });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async function cleanupWorktree(
    exec: ExecFn,
    commonDir: string,
    link: WorktreeLink | undefined,
    sourcePath: string,
    sourceBranch: string,
    targetPath: string,
  ): Promise<string> {
    // main/master are never auto-deleted, and a main working tree is never
    // removed — a reverse-land must degrade to words, not dangerous commands.
    if (sourceBranch === "main" || sourceBranch === "master") {
      return `Kept branch \`${sourceBranch}\` — never auto-delete it. Worktree left in place.`;
    }
    const removal = await removeWorktree(exec, targetPath, sourcePath);
    if (removal.code !== 0) {
      const err = `${removal.stdout}\n${removal.stderr}`.trim().slice(0, 800);
      if (/main working tree|not a working tree/i.test(err)) {
        return `Cleanup skipped — ${sourcePath} is not a removable worktree. Branch \`${sourceBranch}\` kept.`;
      }
      return `Cleanup skipped (run manually): \`git -C ${targetPath} worktree remove ${sourcePath}\` — ${err}\nThen \`git branch -d ${sourceBranch}\` if merged.`;
    }
    const del = await deleteBranch(exec, targetPath, sourceBranch);
    const branchNote = del.code === 0
      ? `Branch \`${sourceBranch}\` deleted.`
      : `Worktree removed; branch kept (\`git branch -d ${sourceBranch}\` when ready).`;
    if (link) {
      try {
        const fresh = (await loadStore(commonDir)).links.find((l) => l.id === link.id) ?? link;
        await saveLink(commonDir, { ...fresh, status: "removed", landedAt: fresh.landedAt ?? Date.now() });
      } catch {
        // Store is advisory; git is truth.
      }
    }
    await pruneWorktrees(exec, targetPath);
    return `Cleaned up: worktree removed. ${branchNote}`;
  }

  // ------------------------------------------------------------ abandon flow

  interface AbandonOpts {
    target?: string;
    confirm: boolean;
    sessionId: string | null;
  }

  async function abandonFlow(exec: ExecFn, cwd: string, opts: AbandonOpts): Promise<LandResult> {
    const topLevel = await getTopLevel(exec, cwd);
    if (!topLevel) return { text: "Not a git repository.", details: { ok: false, reason: "not-a-repo" } };
    const commonDir = await getCommonDir(exec, cwd);
    if (!commonDir) return { text: "Cannot resolve git dir.", details: { ok: false, reason: "no-common-dir" } };
    const canon = await canonicalPath(topLevel);
    const store = await loadSyncedStore(exec, cwd, commonDir);

    let link = activeLinkFor(store, canon) ?? ownActiveLink(store, canon, opts.sessionId);
    if (opts.target) {
      const byBranch = store.links.find((l) => l.status === "active" && l.branch === opts.target);
      link = byBranch ?? (await (async () => {
        const p = await canonicalPath(opts.target!);
        return activeLinkFor(store, p);
      })());
    }
    if (!link) {
      return { text: "No active linked worktree to abandon here. Name its branch or path.", details: { ok: false, reason: "no-link" } };
    }
    if (foreignOwnerOf(link, opts.sessionId, canon)) {
      return {
        text: `Blocked: \`${link.branch}\` belongs to another session ${ownerLabel(link, opts.sessionId)}. Ask the user; abandon it from the owning session.`,
        details: { ok: false, reason: "owned-by-other", branch: link.branch },
      };
    }
    if (link.branch === "main" || link.branch === "master") {
      return { text: `Refusing to abandon \`${link.branch}\`.`, details: { ok: false, reason: "protected-branch" } };
    }
    if (samePath(canon, link.worktreePath)) {
      return {
        text: `You are standing inside ${link.worktreePath}. Abandon it from the origin (${link.originPath}) so the directory can be removed.`,
        details: { ok: false, reason: "standing-inside", origin: link.originPath },
      };
    }

    const ab = link.originBranch ? await aheadBehind(exec, link.worktreePath, link.originBranch, "HEAD") : { ahead: 0, behind: 0 };
    const dirty = (await getStatusPorcelain(exec, link.worktreePath)).porcelain.split("\n").filter(Boolean).length;
    const summary = `\`${link.branch}\`${link.task ? ` (${truncateMiddle(link.task, 40)})` : ""}: ${ab.ahead} unlanded commit${ab.ahead === 1 ? "" : "s"}, ${dirty} dirty file${dirty === 1 ? "" : "s"}.`;
    if (!opts.confirm) {
      return {
        text: `Would discard ${summary}\nThis deletes the worktree directory and the branch permanently. Confirm with the user, then call again with confirm:true.`,
        details: { ok: false, reason: "needs-confirm", branch: link.branch, commits: ab.ahead, dirty },
      };
    }

    const removal = await removeWorktree(exec, link.originPath, link.worktreePath, true);
    if (removal.code !== 0) {
      const err = `${removal.stdout}\n${removal.stderr}`.trim().slice(0, 800);
      return { text: `Could not remove ${link.worktreePath}:\n${err}`, details: { ok: false, reason: "remove-failed", branch: link.branch, output: err } };
    }
    const del = await deleteBranch(exec, link.originPath, link.branch, true);
    await pruneWorktrees(exec, link.originPath);
    await saveLink(commonDir, { ...link, status: "removed", landedAt: Date.now(), abandoned: true });
    await recordEvent({ kind: "abandon", branch: link.branch, path: link.worktreePath, commits: ab.ahead, dirty });
    const branchNote = del.code === 0 ? `branch \`${link.branch}\` deleted` : `branch \`${link.branch}\` kept (delete failed)`;
    return {
      text: `Abandoned ${summary} Worktree removed, ${branchNote}.`,
      details: { ok: true, branch: link.branch, commits: ab.ahead, dirty },
      link,
    };
  }

  // ------------------------------------------------------------------- tools

  pi.registerTool({
    name: "worktree_status",
    label: "Worktree Status",
    description:
      "Show git worktree state: current branch, clean/dirty files, all worktrees, pi-worktree origin/child linkage, and which worktree this session is bound to. Call this before risky edits to decide whether to isolate.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const facts = await collectFacts(exec, cwd);
      if (!facts) return { content: [{ type: "text", text: "Not a git repository." }], details: { ok: false, reason: "not-a-repo" } };
      const canon = await canonicalPath(facts.topLevel);
      const store = facts.commonDir ? await loadSyncedStore(exec, cwd, facts.commonDir) : null;
      const link = store ? (activeLinkFor(store, canon) ?? findByWorktree(store, canon)) : undefined;
      const kids = store ? childrenOf(store, canon) : [];
      const me = ctx.sessionManager.getSessionId();
      const text = formatWorktreeList(facts.topLevel, facts.branch, facts.clean, facts.porcelain, facts.worktrees, link, kids, me, binding);
      return {
        content: [{ type: "text", text }],
        details: { ok: true, topLevel: facts.topLevel, branch: facts.branch, clean: facts.clean, worktrees: facts.worktrees, link: link ?? null, children: kids, bound: binding },
      };
    },
  });

  pi.registerTool({
    name: "worktree_create",
    label: "Worktree Create",
    description:
      "Create a new git worktree on a new branch, carry uncommitted changes via stash, and bind this session to it (subsequent tool calls run inside it). Use when the workspace is CLEAN and the task is experimental, risky, or parallel.",
    promptSnippet: "Isolate experimental work with worktree_create",
    promptGuidelines: [
      "Use worktree_create when the workspace is CLEAN and the task is experimental, risky, or explicitly parallel.",
      "Pass the task text so the branch name and the eventual land commit describe the work.",
      "When work in the new worktree is finished, ask the user before landing instead of calling worktree_land silently.",
    ],
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "One line describing the work. Names the branch (wt-<slug>) and becomes the land commit subject." })),
      branch: Type.Optional(Type.String({ description: "Explicit branch name. Omit unless the user named one." })),
      base: Type.Optional(Type.String({ description: "Base ref for the new branch. Defaults to current HEAD." })),
      path: Type.Optional(Type.String({ description: "Worktree path. Defaults to a sibling .worktrees directory." })),
      carry: Type.Optional(Type.Boolean({ description: "Carry uncommitted changes via stash. Default true." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const r = await createFlow(exec, cwd, {
        branch: params.branch,
        base: params.base,
        path: params.path,
        carry: params.carry !== false,
        task: (params.task ?? "").trim(),
        sessionId: ctx.sessionManager.getSessionId(),
      });
      if (!r.ok) {
        return { content: [{ type: "text", text: r.text }], details: { ok: false, reason: r.reason, branch: r.link?.branch, path: r.link?.worktreePath } };
      }
      await bindSession(ctx, r.link);
      const text = [
        `Worktree ready: \`${r.branch}\` at ${r.path} — ${r.carryNote}.`,
        `This session is now bound to it: relative paths and bash run inside the worktree automatically; edits under the origin checkout are blocked.`,
        `Finish with worktree_land after the user confirms, or worktree_abandon to discard.`,
      ].join("\n");
      return { content: [{ type: "text", text }], details: { ok: true, branch: r.branch, path: r.path, carried: r.carried, carryNote: r.carryNote, link: r.link } };
    },
  });

  pi.registerTool({
    name: "worktree_land",
    label: "Worktree Land",
    description:
      "Land the linked worktree back into its origin: commits pending changes on both sides (subject = the task), rebases onto the origin and fast-forwards (falls back to a merge on conflict), surfaces conflicted files, and cleans up on success.",
    promptSnippet: "Land a linked worktree back into its origin",
    promptGuidelines: [
      "Use worktree_land to finish work inside a linked worktree instead of raw git merge commands.",
    ],
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Origin worktree path or branch. Auto-detected from linkage when omitted." })),
      strategy: Type.Optional(StringEnum(["rebase", "merge", "squash"] as const, { description: "rebase (default: rebase then fast-forward, linear history), merge (merge commit), squash (one commit)" })),
      message: Type.Optional(Type.String({ description: "Commit subject for pending changes / squash. Defaults to the worktree's task." })),
      remove: Type.Optional(Type.Boolean({ description: "Remove the source worktree after a successful land. Default true." })),
      finish: Type.Optional(Type.Boolean({ description: "Conclude an in-progress conflicted merge after resolving files." })),
      abort: Type.Optional(Type.Boolean({ description: "Abort an in-progress conflicted merge." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const result = await landFlow(exec, cwd, {
        to: params.target,
        strategy: params.strategy ?? DEFAULT_STRATEGY,
        message: params.message,
        remove: params.remove !== false,
        finish: params.finish ?? false,
        abort: params.abort ?? false,
        sessionId: ctx.sessionManager.getSessionId(),
      });
      if (result.details.ok) await unbindSession(ctx, result.link);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });

  pi.registerTool({
    name: "worktree_abandon",
    label: "Worktree Abandon",
    description:
      "Discard a linked worktree without landing: removes the directory and deletes its branch. Without confirm:true it only reports what would be lost — confirm with the user first.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Branch or path of the worktree. Defaults to this session's bound worktree." })),
      confirm: Type.Optional(Type.Boolean({ description: "Actually delete. Default false = dry run." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const result = await abandonFlow(exec, cwd, { target: params.target, confirm: params.confirm === true, sessionId: ctx.sessionManager.getSessionId() });
      if (result.details.ok) await unbindSession(ctx, result.link);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });

  // ---------------------------------------------------------------- commands

  pi.registerCommand("worktree", {
    description: "Isolate work in a fresh linked worktree — the agent continues the task there",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, ctx.signal ?? undefined);
      const parsed = parseWorktreeArgs(args);

      if (parsed.help) {
        emit(ctx, [
          "/worktree [task...] [--branch <name>] [--base <ref>] — isolate work in a fresh worktree; the agent continues there.",
          "/land — preview and merge the worktree back when done.",
          "Status, abandon and conflicts are the agent's job — just describe what you want.",
        ].join("\n"), "info");
        return;
      }
      // Retired subcommands: point at the agent instead of managing anything.
      if (!parsed.branch && ["list", "ls", "status", "st", "prune"].includes(parsed.task.toLowerCase())) {
        emit(ctx, "Worktree 状态和清理不用你操心 — 直接告诉 agent 要做什么，剩下的它来。", "info");
        return;
      }

      const facts = await collectFacts(exec, cwd);
      if (!facts) {
        emit(ctx, "Not a git repository.", "error");
        return;
      }
      // Dirty workspaces carry via stash — confirm once. Clean takes the fast path.
      if (ctx.hasUI && !parsed.json && !parsed.yes && !facts.clean) {
        const n = facts.porcelain.split("\n").filter(Boolean).length;
        const ok = await ctx.ui.confirm(
          "Carry uncommitted changes?",
          `${n} file${n === 1 ? "" : "s"} with uncommitted changes will move into the new worktree (via stash; the origin becomes clean).${parsed.task ? `\nTask: ${parsed.task}` : ""}`,
        );
        if (!ok) {
          emit(ctx, "Cancelled.", "info");
          return;
        }
      }

      const r = await createFlow(exec, cwd, {
        branch: parsed.branch,
        base: parsed.base,
        path: parsed.path,
        carry: parsed.carry,
        task: parsed.task,
        sessionId: ctx.sessionManager.getSessionId(),
      });
      if (!r.ok) {
        emit(ctx, r.text, "error");
        return;
      }
      await bindSession(ctx, r.link);

      // Handoff. With no task and no conversation yet there is nothing to
      // infer — just report and wait for the user instead of an awkward turn.
      const hasHistory = ctx.sessionManager.getEntries().some((e) => e.type === "message");
      const handoff = parsed.task
        ? `User ran /worktree for: "${parsed.task}". This session is now bound to the worktree at ${r.path} — relative paths and bash already run there. Do the task; when done, ask the user before landing (never land silently).`
        : `User ran /worktree with no task text. This session is now bound to the worktree at ${r.path}. Infer the pending task from the conversation and do it there; when done, ask the user before landing (never land silently).`;
      const summary = [`Worktree ready: \`${r.branch}\` at ${r.path} — ${r.carryNote}.`, handoff].join("\n");
      if (!ctx.hasUI) emit(ctx, summary, "info");
      const trigger = Boolean(parsed.task) || hasHistory;
      pi.sendMessage(
        {
          customType: CARD_TYPE,
          content: trigger ? summary : `Worktree ready: \`${r.branch}\` at ${r.path} — ${r.carryNote}. Session bound; waiting for the user's task.`,
          display: true,
          details: { kind: "create", branch: r.branch, rel: await displayPath(r.path, cwd), task: parsed.task, carried: r.carried } satisfies CardDetails,
        },
        { triggerTurn: trigger },
      );
      if (!trigger && ctx.hasUI) ctx.ui.notify(`🌲 ${r.branch} ready — tell me what to do there.`, "info");
    },
  });

  pi.registerCommand("land", {
    description: "Preview and merge the linked worktree back into its origin (rebase→ff by default)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      void _args;
      const cwd = ctx.cwd;
      const exec = getExec(cwd, ctx.signal ?? undefined);
      const me = ctx.sessionManager.getSessionId();
      const ui = ctx.hasUI;

      const result = await landFlow(exec, cwd, {
        strategy: DEFAULT_STRATEGY,
        remove: true,
        finish: false,
        abort: false,
        sessionId: me,
        confirmForeign: ui
          ? async (foreign) => {
            const who = foreign.map((l) => `\`${l.branch}\` ${ownerLabel(l, me)}`).join(", ");
            return ctx.ui.confirm("Land another session's worktree?", `${who} is owned by a different session. Land it anyway?`);
          }
          : undefined,
        pickChild: ui
          ? async (kids) => {
            const labels = kids.map((k) => `${k.branch}${k.task ? ` — ${truncateMiddle(k.task, 40)}` : ""}${ownerLabel(k, me) ? ` ${ownerLabel(k, me)}` : ""}`);
            const pick = await ctx.ui.select("Which worktree to land?", labels);
            const idx = pick ? labels.indexOf(pick) : -1;
            return idx >= 0 ? kids[idx] : undefined;
          }
          : undefined,
        review: ui
          ? async (p) => {
            const dest = p.targetBranch ?? "origin";
            const facts = [
              `${p.ahead} commit${p.ahead === 1 ? "" : "s"}`,
              p.dirtySource ? `${p.dirtySource} uncommitted` : "",
              fmtStat(p.stat),
              p.behind ? `${dest} moved on by ${p.behind}` : "",
              p.dirtyTarget ? `${dest} has ${p.dirtyTarget} dirty (will checkpoint)` : "",
            ].filter(Boolean).join(" · ");
            const REBASE = `Land — rebase onto ${dest}, fast-forward (linear)`;
            const SQUASH = `Squash — one commit: "${truncateMiddle(p.message, 48)}"`;
            const MERGE = `Merge — keep history, add a merge commit`;
            const EDIT = "Edit the commit subject first…";
            const CANCEL = "Cancel";
            let message = p.message;
            for (;;) {
              const pick = await ctx.ui.select(`🌲 ${p.sourceBranch} → ${dest} · ${facts}`, [REBASE, SQUASH, MERGE, EDIT, CANCEL]);
              if (!pick || pick === CANCEL) return undefined;
              if (pick === EDIT) {
                const edited = await ctx.ui.input("Commit subject", message);
                if (edited && edited.trim()) message = edited.trim();
                continue;
              }
              const strategy: Strategy = pick === SQUASH ? "squash" : pick === MERGE ? "merge" : "rebase";
              return { strategy, message };
            }
          }
          : undefined,
      });

      const rd = result.details as {
        ok?: boolean; reason?: string; sha?: string | null; strategy?: string; note?: string;
        cleanup?: string; branch?: string | null; dest?: string; source?: string; target?: string;
        targetCheckpoint?: string | null; conflicted?: string[];
      };
      if (rd.reason === "cancelled") {
        emit(ctx, "Cancelled.", "info");
        return;
      }
      if (rd.ok) await unbindSession(ctx, result.link);

      // Conflict: offer the agent or an abort right here instead of leaving a
      // half-merged target for the user to discover.
      let text = result.text;
      if (!rd.ok && rd.reason === "conflict" && ui && rd.target) {
        const AGENT = "Let the agent resolve the conflicts";
        const ABORT = "Abort — roll the merge back";
        const MANUAL = "I'll resolve them myself";
        const pick = await ctx.ui.select(`⚠ ${rd.conflicted?.length ?? 0} conflicted file${(rd.conflicted?.length ?? 0) === 1 ? "" : "s"} in ${rd.dest ?? "target"}`, [AGENT, ABORT, MANUAL]);
        if (pick === ABORT) {
          const r = await abortMerge(exec, rd.target);
          await recordEvent({ kind: "land-abort", dir: rd.target });
          emit(ctx, r.code === 0 ? "Merge aborted — both worktrees are back where they were." : `Abort failed:\n${r.stderr}`, r.code === 0 ? "info" : "error");
          await refreshChrome(ctx, cwd);
          return;
        }
        if (pick === MANUAL) {
          emit(ctx, `Resolve the files in ${rd.target}, \`git add\` them, then run /land again to conclude.`, "info");
          return;
        }
        text = `${result.text}\nThe user asked you to resolve these conflicts now: edit the files in ${rd.target}, \`git add\` them, then call worktree_land finish:true.`;
      }

      if (!ui) emit(ctx, result.text, rd.ok ? "info" : "error");
      const { basename } = await import("node:path");
      const cleanup = typeof rd.cleanup === "string" ? rd.cleanup : "";
      const note = [
        rd.note ? "fell back to merge" : "",
        rd.targetCheckpoint ? `checkpoint ${shortSha(rd.targetCheckpoint)}` : "",
        cleanup.startsWith("Cleaned up") ? "cleaned up" : cleanup.startsWith("Cleanup skipped") ? "kept" : "",
      ].filter(Boolean).join(" · ");
      pi.sendMessage(
        {
          customType: CARD_TYPE,
          content: text,
          display: true,
          details: {
            kind: "land",
            ok: rd.ok === true,
            branch: rd.branch ?? (rd.source ? basename(rd.source) : "?"),
            dest: rd.dest ?? (rd.target ? basename(rd.target) : "?"),
            strategy: rd.strategy ?? DEFAULT_STRATEGY,
            sha: rd.sha ?? null,
            note,
            conflicted: rd.conflicted,
            reason: rd.reason,
          } satisfies CardDetails,
        },
        { triggerTurn: true },
      );
      await refreshChrome(ctx, cwd);
    },
  });

  // ------------------------------------------------------------------ events

  pi.on("session_start", async (_event, ctx) => {
    const exec = getExec(ctx.cwd, ctx.signal ?? undefined);
    await resolveBinding(exec, ctx.cwd, ctx.sessionManager.getSessionId());
    await refreshChrome(ctx, ctx.cwd);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // Ignore teardown races.
    }
  });

  // Keep the readiness line (↑ commits, dirty count) honest after each run.
  pi.on("agent_end", async (_event, ctx) => {
    await refreshChrome(ctx, ctx.cwd);
  });

  // The virtual cwd: while bound, built-in tool calls run inside the worktree.
  pi.on("tool_call", async (event, ctx) => {
    if (!binding || binding.standingInside) return;
    try {
      const r = rewriteToolInput(event.toolName, event.input as Record<string, unknown>, binding, ctx.cwd);
      if (r.block) return { block: true, reason: r.block };
    } catch {
      // Never let re-rooting break a tool call.
    }
    return;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const exec = getExec(ctx.cwd, ctx.signal ?? undefined);
      const facts = await collectFacts(exec, ctx.cwd);
      if (!facts) return;
      const b = await resolveBinding(exec, ctx.cwd, ctx.sessionManager.getSessionId());
      const canon = await canonicalPath(facts.topLevel);
      const kids = facts.commonDir ? childrenOf(await loadStore(facts.commonDir), canon) : [];
      const section = buildPolicySection({
        branch: facts.branch,
        clean: facts.clean,
        worktreeCount: facts.worktrees.length,
        bound: b
          ? { root: b.root, branch: b.branch, originBranch: b.originBranch, originPath: b.origin, standingInside: b.standingInside, task: b.task }
          : null,
        childCount: kids.length,
        childBranches: kids.map((k) => k.branch),
      });
      return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
    } catch {
      return;
    }
  });
}
