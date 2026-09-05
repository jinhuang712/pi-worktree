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
import { Box, Container, Text } from "@earendil-works/pi-tui";
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
  diffNames,
  diffStat,
  ensureCommitted,
  getCommonDir,
  getStatusPorcelain,
  getTopLevel,
  hasMergeHead,
  isDetached,
  listWorktrees,
  mergeInto,
  porcelainPaths,
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
  loadPrefs,
  makeId,
  orderKidsForDisplay,
  ownerLabel,
  ownActiveLink,
  saveLink,
  savePrefs,
  samePath,
  validStrategy,
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

/** `/land [target] [--strategy rebase|merge|squash]` — everything optional.
 *  An explicit --strategy wins for this run and becomes the remembered default. */
function parseLandArgs(raw: string): {
  target?: string;
  strategy?: Strategy;
  badStrategy?: string;
  help: boolean;
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let target: string | undefined;
  let strategy: Strategy | undefined;
  let badStrategy: string | undefined;
  let help = false;
  const takeStrategy = (s: string) => {
    if (validStrategy(s)) strategy = s;
    else if (badStrategy === undefined) badStrategy = s;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--help" || t === "-h") help = true;
    else if (t === "--strategy" && tokens[i + 1]) takeStrategy(tokens[++i]);
    else if (t.startsWith("--strategy=")) takeStrategy(t.slice("--strategy=".length));
    else if (!t.startsWith("--") && target === undefined) target = t;
  }
  return { target, strategy, badStrategy, help };
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

  // Transcript visual language: every pi-worktree block is purple
  // (toolPendingBg). A caps LABEL plus the hero in 【】 lead; detail lines
  // align under the hero with dim `|--`/`--` trees for item lists (conflict files
  // stay bright — they need action). Emoji mark the
  // family: 🌲 worktree ops, ⚠️ conflicts, 🗑️ abandon, ❌ errors.
  // Cards signal state changes with the smallest effective payload —
  // explanations and decisions belong to the model's own words, and full
  // output is one expand away.
  interface CheckpointInfo {
    branch: string;
    side: "source" | "target";
    paths: string[];
    subject: string;
  }

  interface LandView {
    ok: boolean; branch: string; dest: string; strategy: string; sha: string | null;
    ahead?: number; stat?: DiffStat; names?: string[]; subjects?: string[];
    checkpoints?: CheckpointInfo[]; kept?: string | null; finished?: boolean;
    conflicted?: string[]; reason?: string;
    /** True when there was nothing to merge (0 commits, clean). */
    empty?: boolean;
    /** True when the empty worktree was auto-removed. */
    cleaned?: boolean;
  }

  type CardDetails =
    | { kind: "create"; from: string; branch: string; carried: string[]; total: number; selective: boolean; clean: boolean }
    | ({ kind: "land" } & LandView)
    | { kind: "abandon"; ok: boolean; branch: string; commits: number; dirty: number; reason?: string }
    | { kind: "error" };

  /** worktree_status stays fully silent: pure triage plumbing, the model
   *  speaks for it when anything is worth saying. */
  function silentRender() {
    return new Container();
  }

  const TREE_MAX_FILES = 6;
  const TREE_MAX_COMMITS = 5;

  function count(noun: string, n: number): string {
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
  }

  function treeLines(items: string[], max: number, indent: string, paint?: (s: string) => string): string[] {
    const line = (s: string) => (paint ? paint(s) : s);
    const shown = items.slice(0, max);
    const truncated = items.length > max;
    const out = shown.map((f, i) => {
      const last = !truncated && i === shown.length - 1;
      return line(`${indent}${last ? "`--" : "|--"} ${f}`);
    });
    if (truncated) out.push(line(`${indent}\`-- … ${items.length - max} more`));
    return out;
  }

  /** Spaces so continuations start under the hero: `E LABEL 【` counts
   *  emoji 2 + spaces 1+1 + LABEL + 【 2. */
  function heroIndent(label: string): string {
    return " ".repeat(label.length + 6);
  }

  function firstLine(full: string): string {
    return full.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  }

  function worktreeText(d: { from: string; branch: string; carried: string[]; total: number; selective: boolean; clean: boolean }, ink: { hero: (s: string) => string; dim: (s: string) => string; error: (s: string) => string }): string {
    const pad = heroIndent("WORKTREE");
    const head = `🌲 WORKTREE ${ink.hero(`【${d.from} -> ${d.branch}】`)}`;
    if (d.clean) return [head, `${pad}${ink.dim("clean · nothing to carry")}`].join("\n");
    const summary = d.carried.length === 0
      ? "nothing carried"
      : d.selective
        ? `carrying ${d.carried.length} of ${d.total} files · ${d.total - d.carried.length} left in origin`
        : `carrying ${count("file", d.carried.length)}`;
    return [head, `${pad}${ink.dim(summary)}`, ...treeLines(d.carried, TREE_MAX_FILES, pad, ink.dim)].join("\n");
  }

  function landText(d: LandView, ink: { hero: (s: string) => string; dim: (s: string) => string; error: (s: string) => string }, full: string): string {
    const hero = ink.hero(`【${d.branch} -> ${d.dest}】`);
    if (!d.ok && d.reason === "conflict") {
      const files = d.conflicted ?? [];
      const pad = heroIndent("LAND CONFLICT");
      return [
        `⚠️ LAND CONFLICT ${hero}`,
        `${pad}${ink.dim(`conflict in ${count("file", files.length)}`)}`,
        ...treeLines(files, TREE_MAX_FILES, pad),
      ].join("\n");
    }
    if (!d.ok && d.reason === "nothing-to-land") {
      return [`🌲 LAND ${hero}`, `${heroIndent("LAND")}${ink.dim("nothing new · nothing to clean")}`].join("\n");
    }
    if (!d.ok) return ink.error(`❌ ${firstLine(full)}`);
    if (d.empty) {
      const pad = heroIndent("LAND");
      const note = d.cleaned ? "nothing new · cleaned up" : "nothing new";
      return [`🌲 LAND ${hero} ${ink.dim(`· ${note}`)}`].join("\n");
    }
    const pad = heroIndent("LAND");
    const meta = [d.strategy, d.sha ? shortSha(d.sha) : ""].filter(Boolean).join(" · ");
    const lines = [`🌲 LAND ${hero}${meta ? ` ${ink.dim(`· ${meta}`)}` : ""}`];
    if (d.finished) lines.push(`${pad}${ink.dim("merge concluded")}`);
    // One summary line instead of two: `landing 2 commits · 4 files`.
    // Trees are dim footnotes — the hero already carries the signal.
    const summary: string[] = [];
    if (d.ahead !== undefined && d.stat) summary.push(`landing ${count("commit", d.ahead)} · ${count("file", d.stat.files)}`);
    else if (d.ahead !== undefined) summary.push(`landing ${count("commit", d.ahead)}`);
    else if (d.stat) summary.push(`landing ${count("file", d.stat.files)}`);
    if (summary.length) lines.push(`${pad}${ink.dim(summary.join(" · "))}`);
    lines.push(...treeLines(d.subjects ?? [], TREE_MAX_COMMITS, pad, ink.dim));
    lines.push(...treeLines(d.names ?? [], TREE_MAX_FILES, pad, ink.dim));
    // Checkpoints fold into trailing dim notes — no second hero header, no
    // file tree. The file list already appears in the landed names below,
    // but the checkpoint subject (the auto-commit message) is kept.
    for (const c of d.checkpoints ?? []) {
      lines.push(`${pad}${ink.dim(`checkpointed ${count("file", c.paths.length)} on ${c.branch} as "${truncateMiddle(c.subject, 48)}"`)}`);
    }
    if (d.kept) lines.push(`${pad}${ink.dim(d.kept)}`);
    return lines.join("\n");
  }

  function abandonText(d: { branch: string; commits: number; dirty: number }, ink: { hero: (s: string) => string; dim: (s: string) => string; error: (s: string) => string }): string {
    const bits: string[] = [];
    if (d.commits) bits.push(count("commit", d.commits));
    if (d.dirty) bits.push(count("dirty file", d.dirty));
    return [`🗑️ ABANDON ${ink.hero(`【${d.branch}】`)}`, `${heroIndent("ABANDON")}${ink.dim(bits.length ? `${bits.join(" · ")} discarded` : "nothing discarded")}`].join("\n");
  }

  pi.registerMessageRenderer(CARD_TYPE, (message, opts, theme) => {
    const full = typeof message.content === "string" ? message.content : "";
    const d = message.details as CardDetails | undefined;
    const ink = {
      hero: (s: string) => theme.fg("accent", theme.bold(s)),
      dim: (s: string) => theme.fg("dim", s),
      error: (s: string) => theme.fg("error", s),
    };
    const block = (text: string) => {
      const box = new Box(opts.outputPad, 1, (t: string) => theme.bg("toolPendingBg", t));
      box.addChild(new Text(text, 0, 0));
      return box;
    };
    if (opts.expanded || !d) return block(full);
    if (d.kind === "create") return block(worktreeText(d, ink));
    if (d.kind === "land") return block(landText(d, ink, full));
    if (d.kind === "abandon") {
      if (!d.ok) return block(ink.error(`❌ ${firstLine(full)}`));
      return block(abandonText(d, ink));
    }
    return block(ink.error(`❌ ${firstLine(full)}`));
  });

  // ------------------------------------------------------------- create flow

  interface CreateOpts {
    branch?: string;
    base?: string;
    path?: string;
    carry: boolean;
    /** Carry only these pathspecs; omit to carry all uncommitted changes. */
    carryPaths?: string[];
    /** Tool path (model): collisions auto-bump (-2, -3). Command path
     *  (human --branch): collisions stay a hard error (typo protection). */
    autoBump?: boolean;
    task: string;
    reason?: string | null;
    sessionId: string | null;
  }

  type CreateResult =
    | {
        ok: true; link: WorktreeLink; branch: string; path: string; carried: boolean; carryNote: string;
        from: string | null; carriedPaths: string[]; totalDirty: number; selective: boolean; clean: boolean;
        bumpedFrom: string | null;
      }
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
    let branch = explicit || await resolveUniqueBranch(exec, cwd, sanitizeBranchName(suggestBranchName(facts.branch, opts.task)));
    let bumpedFrom: string | null = null;
    if (!branch) return { ok: false, reason: "bad-branch", text: "Cannot determine a valid branch name." };
    if (explicit && await branchExists(exec, cwd, branch)) {
      if (!opts.autoBump) {
        return { ok: false, reason: "branch-exists", text: `Branch \`${branch}\` already exists. Pick another name.` };
      }
      bumpedFrom = branch;
      branch = await resolveUniqueBranch(exec, cwd, branch);
      if (!branch) return { ok: false, reason: "bad-branch", text: "Cannot determine a valid branch name." };
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
    const selective = !!opts.carryPaths?.length;
    if (opts.carry && !facts.clean) {
      const res = await carryChangesViaStash(exec, cwd, targetPath, `pi-worktree:${branch}`, undefined, selective ? opts.carryPaths : undefined);
      carried = res.carried;
      const n = opts.carryPaths?.length ?? 0;
      carryNote = res.carried
        ? selective
          ? `carried ${n} selected file${n === 1 ? "" : "s"} via stash — unrelated changes left in origin`
          : "uncommitted changes carried via stash"
        : res.conflict
          ? `carry CONFLICT — stash kept (${res.stashRef ?? "refs/stash"}); resolve in ${targetPath}. ${res.output ?? ""}`
          : selective && res.reason === "clean"
            ? "selected files have no changes — nothing carried (other dirty files left in origin)"
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
    const dirtyBefore = porcelainPaths(facts.porcelain);
    return {
      ok: true, link, branch, path: targetPath, carried, carryNote,
      from: facts.branch, carriedPaths: selective ? (opts.carryPaths ?? []) : carried ? dirtyBefore : [],
      totalDirty: dirtyBefore.length, selective, clean: facts.clean, bumpedFrom,
    };
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
    /** Current pi session id — recorded on links for visibility; ownership is advisory, never blocking. */
    sessionId?: string | null;
    /** Optional cancel hook for foreign-owned links. Omit it and the land proceeds with a foreign:true flag for the model to report. */
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
      // One session, one tree: a bare land means "land MY tree". Resolve only
      // the owning session's link (or a single unowned link nobody would miss).
      // Other sessions' worktrees are listed for visibility and left untouched —
      // taking one over requires naming it explicitly (deliberate intent).
      const kids = childrenOf(store, canon);
      const mine = opts.sessionId ? kids.find((k) => k.sessionId === opts.sessionId) : undefined;
      if (mine) {
        await flipTo(mine);
      } else if (kids.length === 1 && !foreignOwnerOf(kids[0], opts.sessionId, canon)) {
        await flipTo(kids[0]);
      } else if (kids.length > 0) {
        const picked = opts.pickChild ? await opts.pickChild(kids) : undefined;
        if (picked) {
          await flipTo(picked);
        } else if (opts.pickChild) {
          return { text: "Cancelled.", details: { ok: false, reason: "cancelled" } };
        } else {
          const others = kids.map((k) => `\`${k.branch}\` ${ownerLabel(k, opts.sessionId)}${k.task ? ` — ${truncateMiddle(k.task, 40)}` : ""}`).join("\n");
          return {
            text: [
              `This session has no linked worktree to land — leaving other sessions' work alone:`,
              others,
              `To land one of these, run /land from its owning session, stand inside that worktree, or name it explicitly to take it over deliberately.`,
            ].join("\n"),
            details: { ok: false, reason: "no-own-link", children: kids },
          };
        }
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

    // Ownership scopes implicit resolution (above), never explicit intent: naming
    // a branch/path or standing inside its worktree is deliberate, so it proceeds
    // with a foreign flag for the model to report. Edge cases are the model's job.
    // confirmForeign (slash) may still cancel.
    let foreign: WorktreeLink[] = [];
    let foreignNote: string | null = null;
    {
      const candidates = [link, findByWorktree(store, targetPath)];
      foreign = [...new Set(candidates.filter((l): l is WorktreeLink => !!l))]
        .map((l) => foreignOwnerOf(l, opts.sessionId, canon))
        .filter((l): l is WorktreeLink => !!l);
      if (foreign.length > 0) {
        const who = foreign.map((l) => `\`${l.branch}\` ${ownerLabel(l, opts.sessionId)}`).join(", ");
        if (opts.confirmForeign && !(await opts.confirmForeign(foreign))) {
          return { text: "Cancelled — left the other session's worktree alone.", details: { ok: false, reason: "cancelled" } };
        }
        foreignNote = `Note: ${who} was owned by another session — proceeded anyway. Say who owned it and what you did in your own words.`;
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
      // Empty worktree: nothing would be lost by removing it, so just do it.
      // This is the "替用户做了" path — /land on an empty worktree cleans up
      // instead of erroring with "use worktree_abandon to drop".
      if (link && opts.remove && !samePath(canon, sourcePath)) {
        const cleanup = await cleanupWorktree(exec, commonDir, link, sourcePath, sourceBranch, targetPath);
        await recordEvent({ kind: "land-empty-cleanup", source: sourcePath, target: targetPath, branch: sourceBranch });
        const kept = cleanup && !cleanup.startsWith("Cleaned up") ? cleanup.split("\n")[0] : null;
        if (!kept) {
          return {
            text: [`Nothing to land: \`${sourceBranch}\` was empty — cleaned up.`, foreignNote ?? ""].filter(Boolean).join("\n"),
            details: { ok: true, empty: true, cleaned: true, branch: sourceBranch, dest: targetBranch, strategy: opts.strategy, sha: null, cleanup, foreign: foreign.map((l) => l.branch) },
            link,
          };
        }
        // Cleanup refused (e.g. protected branch): surface the reason, no second step.
        return {
          text: `Nothing to land: \`${sourceBranch}\` is empty. ${kept}`,
          details: { ok: true, empty: true, cleaned: false, branch: sourceBranch, dest: targetBranch, strategy: opts.strategy, sha: null, kept },
          link,
        };
      }
      if (link && samePath(canon, sourcePath)) {
        return {
          text: `Nothing to land: \`${sourceBranch}\` is empty. You are standing inside it — go back to \`${targetBranch ?? "origin"}\` (${targetPath}) and run /land again to clean it up.`,
          details: { ok: false, reason: "standing-inside-empty", branch: sourceBranch, dest: targetBranch },
        };
      }
      if (link && !opts.remove) {
        return {
          text: `Nothing to land: \`${sourceBranch}\` is empty — kept (remove:false).`,
          details: { ok: true, empty: true, cleaned: false, branch: sourceBranch, dest: targetBranch, strategy: opts.strategy, sha: null },
          link,
        };
      }
      return {
        text: `Nothing to land: \`${sourceBranch}\` has no commits or changes beyond \`${targetBranch ?? "origin"}\`.`,
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
    // Both are recorded: auto-created commits deserve visibility.
    const checkpoints: CheckpointInfo[] = [];
    if (!srcStatus.clean) {
      const c = await ensureCommitted(exec, sourcePath, message);
      if (!c.committed) {
        return {
          text: `Could not commit pending changes in ${sourcePath}:\n${c.output}\nConfigure git identity or commit manually, then retry.`,
          details: { ok: false, reason: "commit-failed", output: c.output },
        };
      }
      checkpoints.push({ branch: sourceBranch, side: "source", paths: porcelainPaths(srcStatus.porcelain), subject: message });
    }
    let targetCheckpoint: string | null = null;
    if (!tgtStatus.clean) {
      const subject = `wip(${targetBranch ?? "origin"}): checkpoint before landing ${sourceBranch}`;
      const c = await ensureCommitted(exec, targetPath, subject);
      if (!c.committed) {
        return {
          text: `Could not commit pending changes in target ${targetPath}:\n${c.output}\nConfigure git identity or commit manually, then retry.`,
          details: { ok: false, reason: "target-commit-failed", output: c.output, target: targetPath },
        };
      }
      targetCheckpoint = c.sha ?? null;
      checkpoints.push({ branch: targetBranch ?? "origin", side: "target", paths: porcelainPaths(tgtStatus.porcelain), subject });
    }

    // Post-checkpoint truth: what actually lands (subjects/names/counts).
    const landed = targetBranch
      ? {
        ahead: (await aheadBehind(exec, sourcePath, targetBranch, "HEAD")).ahead,
        stat: await diffStat(exec, sourcePath, targetBranch, "HEAD"),
        subjects: await commitSubjects(exec, sourcePath, targetBranch, "HEAD"),
        names: await diffNames(exec, sourcePath, targetBranch, "HEAD"),
      }
      : { ahead: 0, stat: { files: 0, insertions: 0, deletions: 0 }, subjects: [] as string[], names: [] as string[] };

    const merged = await mergeInto(exec, targetPath, sourceBranch, strategy, message, undefined, sourcePath, targetBranch ?? null);
    if (!merged.ok) {
      if (merged.reason === "conflict") {
        await recordEvent({ kind: "land-conflict", source: sourcePath, target: targetPath, conflicted: merged.conflicted });
        return {
          text: [
            `Merge conflict landing \`${sourceBranch}\` into ${targetPath}${merged.note ? ` (${merged.note})` : ""}.`,
            `Conflicted files:\n${merged.conflicted.map((f) => `  ${f}`).join("\n")}`,
            `Handle it yourself: read each conflicted file, keep the intended result from both sides (task changes win on task files, origin changes win elsewhere), \`git add\` them, then finish the land (worktree_land finish:true). To throw the work away instead, abort (worktree_land abort:true). Only ask the user when both sides look deliberately contradictory and you cannot tell which is intended.`,
            foreignNote ?? "",
          ].filter(Boolean).join("\n"),
          details: { ok: false, reason: "conflict", conflicted: merged.conflicted, target: targetPath, source: sourcePath, output: merged.output, branch: sourceBranch, dest: targetBranch, foreign: foreign.map((l) => l.branch) },
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
    const label = merged.applied === "rebase" ? "rebase" : merged.applied;
    const kept = cleanup && !cleanup.startsWith("Cleaned up") ? cleanup.split("\n")[0] : null;
    return {
      text: [
        `Landed \`${sourceBranch}\` into ${targetPath} (${label}, ${shortSha(sha)}).`,
        merged.note ?? "",
        targetCheckpoint ? `Target had pending changes — checkpointed as ${shortSha(targetCheckpoint)} before landing.` : "",
        merged.output,
        cleanup,
        foreignNote ?? "",
      ].filter(Boolean).join("\n"),
      details: {
        ok: true, sha, target: targetPath, source: sourcePath, strategy: label,
        note: merged.note, cleanup, targetCheckpoint, branch: sourceBranch, dest: targetBranch,
        ahead: landed.ahead, stat: landed.stat, names: landed.names, subjects: landed.subjects,
        checkpoints, kept, foreign: foreign.map((l) => l.branch),
      },
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
    // Ownership is advisory, never a hard stop — same rule as land. The model
    // names the previous owner in chat; empty worktrees drop immediately,
    // non-empty ones still need confirm:true (model confirms with the user
    // in chat first, then calls again).
    const foreignLink = foreignOwnerOf(link, opts.sessionId, canon);
    const foreignSuffix = foreignLink ? ` (was owned by another session ${ownerLabel(link, opts.sessionId)} — proceeding anyway; say so in chat)` : "";
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
    // Empty worktree: nothing to lose, so drop it immediately — no confirm dance.
    // This keeps `worktree_abandon` one-shot for the exact case /land auto-cleans.
    if (!opts.confirm && (ab.ahead > 0 || dirty > 0)) {
      return {
        text: `Would discard ${summary}${foreignSuffix}\nThis deletes the worktree directory and the branch permanently. Confirm with the user, then call again with confirm:true.`,
        details: { ok: false, reason: "needs-confirm", branch: link.branch, commits: ab.ahead, dirty, foreign: foreignLink ? link.branch : undefined },
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
      text: `Abandoned ${summary}${foreignSuffix} Worktree removed, ${branchNote}.`,
      details: { ok: true, branch: link.branch, commits: ab.ahead, dirty, foreign: foreignLink ? link.branch : undefined },
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
      const dirty = facts.porcelain.split("\n").filter(Boolean).length;
      const text = formatWorktreeList(facts.topLevel, facts.branch, facts.clean, facts.porcelain, facts.worktrees, link, kids, me, binding);
      return {
        content: [{ type: "text", text }],
        details: { ok: true, topLevel: facts.topLevel, branch: facts.branch, clean: facts.clean, dirty, worktrees: facts.worktrees, link: link ?? null, children: kids, bound: binding },
      };
    },
    renderShell: "self",
    renderCall: silentRender,
    renderResult: silentRender,
  });

  pi.registerTool({
    name: "worktree_create",
    label: "Worktree Create",
    description:
      "Create a new git worktree on a new branch, carry uncommitted changes via stash, and bind this session to it (subsequent tool calls run inside it). Use to isolate experimental, risky, or parallel work — never raw git worktree commands.",
    promptSnippet: "Isolate experimental work with worktree_create",
    promptGuidelines: [
      "Use worktree_create to isolate experimental, risky, or parallel work — never raw git worktree commands.",
      "Always pass an explicit `branch`: name it after the work, never a fixed or date-based format.",
      "When the workspace is dirty, triage first (worktree_status): carry only files related to the task via `carryPaths`; leave unrelated files untouched in the origin.",
      "When work in the new worktree is finished, ask the user before landing instead of calling worktree_land silently (empty worktrees are the exception — just land to clean up).",
    ],
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "One line describing the work. Becomes the land commit subject." })),
      branch: Type.Optional(Type.String({ description: "Branch name — always choose a descriptive one yourself; never a fixed or date-based format. Collisions auto-bump (-2, -3), no need to pre-check." })),
      base: Type.Optional(Type.String({ description: "Base ref for the new branch. Defaults to current HEAD." })),
      path: Type.Optional(Type.String({ description: "Worktree path. Defaults to a sibling .worktrees directory." })),
      carry: Type.Optional(Type.Boolean({ description: "Carry uncommitted changes via stash. Default true; pass false to start clean." })),
      carryPaths: Type.Optional(Type.Array(Type.String(), { description: "Carry only these paths (relative to the repo root); omit to carry all uncommitted changes. Use after triaging dirty files." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const r = await createFlow(exec, cwd, {
        branch: params.branch,
        base: params.base,
        path: params.path,
        carry: params.carry !== false,
        carryPaths: params.carryPaths,
        autoBump: true,
        task: (params.task ?? "").trim(),
        sessionId: ctx.sessionManager.getSessionId(),
      });
      if (!r.ok) {
        return { content: [{ type: "text", text: r.text }], details: { ok: false, reason: r.reason, branch: r.link?.branch, path: r.link?.worktreePath } };
      }
      await bindSession(ctx, r.link);
      const text = [
        `Worktree ready: \`${r.branch}\` at ${r.path} — ${r.carryNote}.`,
        r.bumpedFrom ? `Branch \`${r.bumpedFrom}\` already existed; using \`${r.branch}\`.` : "",
        `This session is now bound to it: relative paths and bash run inside the worktree automatically; edits under the origin checkout are blocked.`,
        `Finish with worktree_land after the user confirms, or worktree_abandon to discard.`,
      ].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          ok: true, from: r.from, branch: r.branch, carried: r.carriedPaths,
          total: r.totalDirty, selective: r.selective, clean: r.clean,
        },
      };
    },
    renderShell: "self",
    renderCall: silentRender,
    renderResult(result, { expanded, isPartial }, theme) {
      const ink = {
        hero: (s: string) => theme.fg("accent", theme.bold(s)),
        dim: (s: string) => theme.fg("dim", s),
        error: (s: string) => theme.fg("error", s),
      };
      const box = (text: string) => {
        const b = new Box(1, 1, (t: string) => theme.bg("toolPendingBg", t));
        b.addChild(new Text(text, 0, 0));
        return b;
      };
      if (isPartial) return box(ink.dim("…"));
      const full = (result as { content?: Array<{ text?: unknown }> }).content?.map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n") ?? "";
      if (expanded) return box(full);
      const d = (result as { details?: { ok?: unknown; from?: unknown; branch?: unknown; carried?: unknown; total?: unknown; selective?: unknown; clean?: unknown } }).details ?? {};
      if (d.ok !== true) return box(ink.error(`❌ ${firstLine(full)}`));
      return box(worktreeText({
        from: typeof d.from === "string" ? d.from : "?",
        branch: typeof d.branch === "string" ? d.branch : "?",
        carried: Array.isArray(d.carried) ? d.carried.map(String) : [],
        total: typeof d.total === "number" ? d.total : 0,
        selective: d.selective === true,
        clean: d.clean === true,
      }, ink));
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
      "On conflict, resolve it yourself: read each conflicted file, keep the intended result from both sides, `git add`, then finish with finish:true. Explain the resolution in your own words; ask the user only when both sides look deliberately contradictory.",
      "Empty worktrees (no commits, clean) land as immediate cleanup with no confirmation needed — just call worktree_land.",
      "A bare land means YOUR tree: the tool resolves this session's own link (or the worktree you're standing in) and never auto-grabs another session's link. Name a branch/path explicitly only to deliberately take it over — then say who owned it and what you did.",
    ],
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Origin worktree path or branch. Auto-detected from linkage when omitted." })),
      strategy: Type.Optional(StringEnum(["rebase", "merge", "squash"] as const, { description: "Merge strategy. Omit to use the remembered /land preference (rebase until the user has chosen)." })),
      message: Type.Optional(Type.String({ description: "Commit subject for pending changes / squash. Defaults to the worktree's task." })),
      remove: Type.Optional(Type.Boolean({ description: "Remove the source worktree after a successful land. Default true." })),
      finish: Type.Optional(Type.Boolean({ description: "Conclude an in-progress conflicted merge after resolving files." })),
      abort: Type.Optional(Type.Boolean({ description: "Abort an in-progress conflicted merge." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const remembered = (await loadPrefs()).defaultStrategy;
      const result = await landFlow(exec, cwd, {
        to: params.target,
        strategy: params.strategy ?? (validStrategy(remembered) ? remembered : DEFAULT_STRATEGY),
        message: params.message,
        remove: params.remove !== false,
        finish: params.finish ?? false,
        abort: params.abort ?? false,
        sessionId: ctx.sessionManager.getSessionId(),
      });
      if (result.details.ok) await unbindSession(ctx, result.link);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
    renderShell: "self",
    renderCall: silentRender,
    renderResult(result, { expanded, isPartial }, theme) {
      const ink = {
        hero: (s: string) => theme.fg("accent", theme.bold(s)),
        dim: (s: string) => theme.fg("dim", s),
        error: (s: string) => theme.fg("error", s),
      };
      const box = (text: string) => {
        const b = new Box(1, 1, (t: string) => theme.bg("toolPendingBg", t));
        b.addChild(new Text(text, 0, 0));
        return b;
      };
      if (isPartial) return box(ink.dim("…"));
      const full = (result as { content?: Array<{ text?: unknown }> }).content?.map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n") ?? "";
      if (expanded) return box(full);
      const d = (result as { details?: Record<string, unknown> }).details ?? {};
      return box(landText({
        ok: d.ok === true,
        branch: typeof d.branch === "string" ? d.branch : "?",
        dest: typeof d.dest === "string" ? d.dest : "?",
        strategy: typeof d.strategy === "string" ? d.strategy : DEFAULT_STRATEGY,
        sha: typeof d.sha === "string" ? d.sha : null,
        ahead: typeof d.ahead === "number" ? d.ahead : undefined,
        stat: (d.stat ?? undefined) as DiffStat | undefined,
        names: Array.isArray(d.names) ? d.names.map(String) : undefined,
        subjects: Array.isArray(d.subjects) ? d.subjects.map(String) : undefined,
        checkpoints: Array.isArray(d.checkpoints) ? d.checkpoints as CheckpointInfo[] : undefined,
        kept: typeof d.kept === "string" ? d.kept : undefined,
        finished: d.finished === true ? true : undefined,
        conflicted: Array.isArray(d.conflicted) ? d.conflicted.map(String) : undefined,
        reason: typeof d.reason === "string" ? d.reason : undefined,
        empty: d.empty === true ? true : undefined,
        cleaned: d.cleaned === true ? true : undefined,
      }, ink, full));
    },
  });

  pi.registerTool({
    name: "worktree_abandon",
    label: "Worktree Abandon",
    description:
      "Discard a linked worktree without landing: removes the directory and deletes its branch. Empty worktrees (no commits, clean) are removed immediately; otherwise without confirm:true it only reports what would be lost — confirm with the user first.",
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
    renderShell: "self",
    renderCall: silentRender,
    renderResult(result, { expanded, isPartial }, theme) {
      const ink = {
        hero: (s: string) => theme.fg("accent", theme.bold(s)),
        dim: (s: string) => theme.fg("dim", s),
        error: (s: string) => theme.fg("error", s),
      };
      const box = (text: string) => {
        const b = new Box(1, 1, (t: string) => theme.bg("toolPendingBg", t));
        b.addChild(new Text(text, 0, 0));
        return b;
      };
      if (isPartial) return box(ink.dim("…"));
      const full = (result as { content?: Array<{ text?: unknown }> }).content?.map((b) => (typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n") ?? "";
      if (expanded) return box(full);
      const d = (result as { details?: { ok?: unknown; branch?: unknown; commits?: unknown; dirty?: unknown; reason?: unknown } }).details ?? {};
      if (d.ok !== true) {
        const head = firstLine(full);
        return box(d.reason === "needs-confirm" ? head : ink.error(`❌ ${head}`));
      }
      return box(abandonText({
        branch: typeof d.branch === "string" ? d.branch : "?",
        commits: typeof d.commits === "number" ? d.commits : 0,
        dirty: typeof d.dirty === "number" ? d.dirty : 0,
      }, ink));
    },
  });

  // ---------------------------------------------------------------- commands

  pi.registerCommand("worktree", {
    description: "Isolate work in a fresh linked worktree — the agent names it, carries related changes, and continues there",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, ctx.signal ?? undefined);
      const parsed = parseWorktreeArgs(args);

      if (parsed.help) {
        emit(ctx, [
          "/worktree [task...] [--branch <name>] [--base <ref>] [--path <path>] [--no-carry] — isolate work in a fresh worktree. The agent names it, carries only related changes, and continues there. No questions asked.",
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
      const hasHistory = ctx.sessionManager.getEntries().some((e) => e.type === "message");

      // Two cases create directly with zero dialogs. Everything else is
      // model-driven (below): the model triages dirty files and names the
      // branch itself — the command never asks and never forces a format.
      //   - fast path: the user named the branch AND there is nothing to
      //     triage (clean workspace, or carry disabled).
      //   - empty edge: no task and no conversation — nothing to infer a
      //     task or a name from, so create and wait instead of an awkward turn.
      if ((parsed.branch && (facts.clean || !parsed.carry)) || (!parsed.task && !hasHistory)) {
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
            details: {
              kind: "create", from: r.from ?? facts.branch ?? "?", branch: r.branch,
              carried: r.carriedPaths, total: r.totalDirty, selective: r.selective, clean: r.clean,
            } satisfies CardDetails,
          },
          { triggerTurn: trigger },
        );
        if (!trigger && ctx.hasUI) ctx.ui.notify(`🌲 ${r.branch} ready — tell me what to do there.`, "info");
        return;
      }

      // Model-driven isolation. The handoff stays invisible (display:false):
      // the transcript shows a single purple WORKTREE block once the model
      // creates it. Cards signal; the model speaks.
      const dirty = facts.porcelain.split("\n").filter(Boolean);
      const lines = [
        parsed.task
          ? `User ran /worktree for: "${parsed.task}".`
          : "User ran /worktree with no task text — infer the pending task from the conversation and the dirty files below. If the workspace is clean and nothing pending is inferable, ask the user in one short question what to work on instead of stalling or inventing a placeholder branch (this exception outranks 'never ask' below).",
        `Origin: ${facts.branch ?? "?"} @ ${facts.topLevel}.`,
        "Isolate the work into a new linked worktree YOURSELF by calling worktree_create — never use raw git worktree commands. Don't ask the user anything unless the no-task exception above applies.",
        "1. The dirty files are listed below — triage from this list. Call worktree_status only if you need more (current branch, existing worktrees).",
        parsed.carry
          ? "2. Triage uncommitted changes: carry only files related to this task via `carryPaths`; leave unrelated files untouched in the origin. If everything dirty belongs here, omit `carryPaths` to carry all. If you carry selectively, tell the user in one line which files you left behind and why."
          : "2. The user passed --no-carry: create without carrying any uncommitted changes.",
        parsed.branch
          ? `3. Use branch \`${sanitizeBranchName(parsed.branch) || parsed.branch}\`.`
          : "3. Name the branch yourself via `branch` — a descriptive name for this work, never a fixed or date-based format.",
      ];
      if (parsed.base) lines.push(`Base the branch on \`${parsed.base}\`.`);
      if (parsed.path) lines.push(`Create the worktree at \`${parsed.path}\`.`);
      if (dirty.length > 0) {
        lines.push(`Dirty files right now (${dirty.length}):`);
        for (const f of dirty.slice(0, 30)) lines.push(`  ${f}`);
        if (dirty.length > 30) lines.push(`  … ${dirty.length - 30} more`);
      }
      lines.push("Then continue the task inside the new worktree (tool calls are re-rooted there automatically). When done, ask the user before landing (never land silently).");
      const instruction = lines.join("\n");
      if (!ctx.hasUI) emit(ctx, instruction, "info");
      pi.sendMessage(
        {
          customType: CARD_TYPE,
          content: instruction,
          display: false,
          details: undefined,
        },
        { triggerTurn: true },
      );
    },
  });

  pi.registerCommand("land", {
    description: "Land the bound worktree straight into its origin (strategy remembered; override: /land --strategy squash)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, ctx.signal ?? undefined);
      const me = ctx.sessionManager.getSessionId();
      const ui = ctx.hasUI;
      const parsed = parseLandArgs(args);

      if (parsed.help) {
        emit(ctx, [
          "/land [target] [--strategy rebase|merge|squash] — land straight, no questions.",
          "The merge strategy is asked once, remembered across repos, and shown on every land line.",
          "An explicit --strategy wins for this run and becomes the new default.",
        ].join("\n"), "info");
        return;
      }
      if (parsed.badStrategy !== undefined) {
        emit(ctx, `Unknown strategy \`${parsed.badStrategy}\` — want rebase, merge, or squash.`, "error");
        return;
      }

      // Zero popups by design: no strategy picker, no child picker, no
      // foreign-owner confirm. Blocks and ambiguity surface as purple cards.
      const result = await landFlow(exec, cwd, {
        to: parsed.target,
        strategy: DEFAULT_STRATEGY,
        remove: true,
        finish: false,
        abort: false,
        sessionId: me,
        review: async (p) => {
          if (parsed.strategy) {
            await savePrefs({ defaultStrategy: parsed.strategy });
            return { strategy: parsed.strategy, message: p.message };
          }
          const saved = (await loadPrefs()).defaultStrategy;
          if (validStrategy(saved)) return { strategy: saved, message: p.message };
          if (ui) {
            const pick = await ctx.ui.select("How should /land merge from now on?", [
              "Rebase — linear, fast-forward",
              "Squash — one commit",
              "Merge — keep history",
            ]);
            if (!pick) return undefined;
            const strategy: Strategy = pick.startsWith("Squash") ? "squash" : pick.startsWith("Merge") ? "merge" : "rebase";
            await savePrefs({ defaultStrategy: strategy });
            return { strategy, message: p.message };
          }
          return { strategy: DEFAULT_STRATEGY, message: p.message };
        },
      });

      const rd = result.details as {
        ok?: boolean; reason?: string; sha?: string | null; strategy?: string;
        branch?: string | null; dest?: string; source?: string; target?: string;
        ahead?: number; stat?: DiffStat; names?: string[]; subjects?: string[];
        checkpoints?: CheckpointInfo[]; kept?: string | null; finished?: boolean;
        conflicted?: string[]; empty?: boolean; cleaned?: boolean;
      };
      if (rd.reason === "cancelled") {
        emit(ctx, "Cancelled — pick a strategy next time and it sticks.", "info");
        return;
      }
      if (rd.ok) await unbindSession(ctx, result.link);
      if (!ui) emit(ctx, result.text, rd.ok ? "info" : "error");

      // Conflict is the model's job, not the user's: it resolves, finishes and
      // explains. The card carries the file list; the instruction below tells
      // the model to handle it and only escalate genuine ambiguity.
      if (!rd.ok && rd.reason === "conflict") {
        const branch = rd.branch ?? "?";
        const dest = rd.dest ?? "?";
        pi.sendMessage(
          {
            customType: CARD_TYPE,
            content: [
              result.text,
              `Resolve it yourself: read each conflicted file, keep the intended result from both sides (task changes win on task files, origin changes win elsewhere), \`git add\` them, then finish with worktree_land finish:true (or conclude the /land). If you genuinely cannot tell which side is intended because both look deliberate, ask the user with both versions quoted. Explain the resolution in your own words when done.`,
            ].join("\n"),
            display: true,
            details: {
              kind: "land", ok: false, branch, dest,
              strategy: rd.strategy ?? DEFAULT_STRATEGY, sha: null,
              conflicted: rd.conflicted, reason: "conflict",
            } satisfies CardDetails,
          },
          { triggerTurn: true },
        );
        await refreshChrome(ctx, cwd);
        return;
      }

      if (rd.ok) {
        pi.sendMessage(
          {
            customType: CARD_TYPE,
            content: result.text,
            display: true,
            details: {
              kind: "land", ok: true,
              branch: rd.branch ?? "?", dest: rd.dest ?? "?",
              strategy: rd.strategy ?? DEFAULT_STRATEGY, sha: rd.sha ?? null,
              ahead: rd.ahead, stat: rd.stat, names: rd.names, subjects: rd.subjects,
              checkpoints: rd.checkpoints, kept: rd.kept ?? null, finished: rd.finished,
              empty: rd.empty, cleaned: rd.cleaned,
            } satisfies CardDetails,
          },
          { triggerTurn: true },
        );
      } else {
        pi.sendMessage(
          {
            customType: CARD_TYPE,
            content: result.text,
            display: true,
            details: { kind: "error" } satisfies CardDetails,
          },
          { triggerTurn: false },
        );
      }
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
