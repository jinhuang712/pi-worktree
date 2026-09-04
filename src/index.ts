/**
 * pi-worktree — native git worktree flow for pi.
 *
 * - `/worktree [branch]` isolates current changes into a new worktree
 *   (stash-carry when dirty, fast path when clean).
 * - `/land` merges the current linked worktree back into its origin,
 *   with conflict surfacing (`--continue` / `--abort`) and safe cleanup.
 * - Tools (`worktree_status` / `worktree_create` / `worktree_land`) let the
 *   agent check cleanliness and isolate proactively in clean workspaces.
 *
 * Linkage is stored in `<git-common-dir>/pi-worktree.json` so it survives
 * `cd` + fresh sessions on either side, plus session entries for the
 * current branch view.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  abortMerge,
  branchExists,
  carryChangesViaStash,
  collectFacts,
  createWorktree,
  dedupePath,
  defaultWorktreePath,
  deleteBranch,
  getCommonDir,
  getStatusPorcelain,
  getTopLevel,
  hasMergeHead,
  listWorktrees,
  mergeInto,
  pruneWorktrees,
  refExists,
  removeWorktree,
  sanitizeBranchName,
  suggestBranchName,
  unmergedFiles,
  ensureCommitted,
  type ExecFn,
  type LandStrategy,
} from "./git.ts";
import { buildPolicySection } from "./policy.ts";
import {
  activeLinkFor,
  canonicalPath,
  childrenOf,
  findByWorktree,
  loadStore,
  makeId,
  markLanded,
  samePath,
  saveStore,
  upsertLink,
  type WorktreeLink,
} from "./state.ts";

const WIDGET_KEY = "pi-worktree";
const STATUS_KEY = "pi-worktree";
const LINK_ENTRY = "pi-worktree-link";
const EVENT_ENTRY = "pi-worktree-event";

function makeExec(
  pi: ExtensionAPI,
  signal?: AbortSignal,
): (cwd: string) => ExecFn {
  return (cwd: string) => (cmd, args, opts) =>
    pi.exec(cmd, args, { signal, timeout: opts?.timeout, cwd: opts?.cwd ?? cwd });
}

function shortSha(sha: string | null): string {
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

function parseWorktreeArgs(raw: string): {
  sub?: string;
  branch?: string;
  base?: string;
  path?: string;
  carry: boolean;
  json: boolean;
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let sub: string | undefined;
  let branch: string | undefined;
  let base: string | undefined;
  let path: string | undefined;
  let carry = true;
  let json = false;
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--no-carry") carry = false;
    else if (t === "--json") json = true;
    else if (t === "--base" && tokens[i + 1]) base = tokens[++i];
    else if (t.startsWith("--base=")) base = t.slice("--base=".length);
    else if (t === "--path" && tokens[i + 1]) path = tokens[++i];
    else if (t.startsWith("--path=")) path = t.slice("--path=".length);
    else if (t === "--help" || t === "-h") sub = "help";
    else if (!t.startsWith("--")) positionals.push(t);
  }
  if (!sub && positionals.length > 0) {
    const first = positionals[0].toLowerCase();
    if (["list", "ls", "status", "st", "prune", "help"].includes(first)) {
      sub = first === "ls" ? "list" : first === "st" ? "status" : first;
    } else {
      branch = positionals[0];
      if (positionals[1] && !base) {
        // `/worktree <branch> <base>` convenience.
        base = positionals[1];
      }
    }
  }
  return { sub, branch, base, path, carry, json };
}

function parseLandArgs(raw: string): {
  to?: string;
  strategy: LandStrategy;
  message?: string;
  remove: boolean;
  yes: boolean;
  json: boolean;
  cont: boolean;
  abort: boolean;
  status: boolean;
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let to: string | undefined;
  let strategy: LandStrategy = "merge";
  let message: string | undefined;
  let remove = true;
  let yes = false;
  let json = false;
  let cont = false;
  let abort = false;
  let status = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--continue") cont = true;
    else if (t === "--abort") abort = true;
    else if (t === "--status") status = true;
    else if (t === "--yes" || t === "-y") yes = true;
    else if (t === "--json") json = true;
    else if (t === "--no-remove") remove = false;
    else if ((t === "--strategy" || t === "--how") && tokens[i + 1]) {
      strategy = tokens[++i] === "squash" ? "squash" : "merge";
    } else if (t.startsWith("--strategy=")) {
      strategy = t.endsWith("squash") ? "squash" : "merge";
    } else if ((t === "--to" || t === "--into") && tokens[i + 1]) {
      to = tokens[++i];
    } else if (t.startsWith("--to=")) {
      to = t.slice("--to=".length);
    } else if ((t === "-m" || t === "--message") && tokens[i + 1]) {
      message = tokens[++i];
    } else if (t.startsWith("--message=")) {
      message = t.slice("--message=".length);
    } else if (!t.startsWith("--")) {
      to = to ?? t;
    }
  }
  return { to, strategy, message, remove, yes, json, cont, abort, status };
}

async function refreshChrome(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  cwd: string,
): Promise<void> {
  try {
    const exec = makeExec(pi, ctx.signal ?? undefined)(cwd);
    const facts = await collectFacts(exec, cwd);
    if (!facts) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const canon = await canonicalPath(facts.topLevel);
    const store = facts.commonDir ? await loadStore(facts.commonDir) : null;
    const link = store ? activeLinkFor(store, canon) ?? findByWorktree(store, canon) : undefined;
    const kids = store ? childrenOf(store, canon) : [];
    if (link && link.status === "active") {
      const line = `🌲 ${link.branch} → origin ${link.originBranch ?? "?"} (${link.originPath})`;
      ctx.ui.setWidget(WIDGET_KEY, [line]);
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `wt: ${link.branch}`));
    } else if (kids.length > 0) {
      const names = kids.map((k) => k.branch).slice(0, 3).join(", ");
      ctx.ui.setWidget(WIDGET_KEY, [`🌲 origin: ${kids.length} worktree(s): ${names}`]);
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `wt-origin: ${kids.length}`));
    } else {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  } catch {
    // Chrome must never break the session.
  }
}

function formatWorktreeList(
  topLevel: string,
  branch: string | null,
  clean: boolean,
  porcelain: string,
  worktrees: { path: string; branch: string | null; bare?: boolean; detached?: boolean }[],
  originOfCurrent?: WorktreeLink,
  kids: WorktreeLink[] = [],
): string {
  const lines = [
    `Repo: ${topLevel}`,
    `Current: ${branch ?? "(detached)"} ${clean ? "CLEAN" : "DIRTY"}`,
  ];
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
    lines.push(`Linked origin: ${originOfCurrent.originBranch ?? "?"} @ ${originOfCurrent.originPath}`);
  }
  if (kids.length > 0) {
    lines.push(`Linked children (${kids.length}):`);
    for (const k of kids) lines.push(`  ${k.branch}  ${k.worktreePath}`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  const getExec = (cwd: string, signal?: AbortSignal): ExecFn =>
    makeExec(pi, signal)(cwd);

  async function recordEvent(data: Record<string, unknown>): Promise<void> {
    try {
      pi.appendEntry(EVENT_ENTRY, data);
    } catch {
      // Non-fatal.
    }
  }

  // ---------------------------------------------------------------- tools

  pi.registerTool({
    name: "worktree_status",
    label: "Worktree Status",
    description:
      "Show git worktree state: current branch, clean/dirty files, all worktrees, and pi-worktree origin/child linkage. Call this before risky edits to decide whether to isolate.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, _signal ?? undefined);
      const facts = await collectFacts(exec, cwd);
      if (!facts) {
        return {
          content: [{ type: "text", text: "Not a git repository." }],
          details: { ok: false, reason: "not-a-repo" },
        };
      }
      const canon = await canonicalPath(facts.topLevel);
      const store = facts.commonDir ? await loadStore(facts.commonDir) : null;
      const link = store ? (activeLinkFor(store, canon) ?? findByWorktree(store, canon)) : undefined;
      const kids = store ? childrenOf(store, canon) : [];
      const text = formatWorktreeList(
        facts.topLevel, facts.branch, facts.clean, facts.porcelain,
        facts.worktrees, link, kids,
      );
      return {
        content: [{ type: "text", text }],
        details: {
          ok: true,
          topLevel: facts.topLevel,
          branch: facts.branch,
          clean: facts.clean,
          worktrees: facts.worktrees,
          link: link ?? null,
          children: kids,
        },
      };
    },
  });

  pi.registerTool({
    name: "worktree_create",
    label: "Worktree Create",
    description:
      "Create a new git worktree on a new branch and carry uncommitted changes via stash. Use worktree_create when the workspace is CLEAN and the task is experimental, risky, or parallel, so the main checkout stays safe.",
    promptSnippet: "Isolate experimental work with worktree_create",
    promptGuidelines: [
      "Use worktree_create when the workspace is CLEAN and the task is experimental, risky, or explicitly parallel.",
    ],
    parameters: Type.Object({
      branch: Type.Optional(Type.String({ description: "New branch name. Auto-generated when omitted." })),
      base: Type.Optional(Type.String({ description: "Base ref for the new branch. Defaults to current HEAD." })),
      path: Type.Optional(Type.String({ description: "Worktree path. Defaults to a sibling .worktrees directory." })),
      carry: Type.Optional(Type.Boolean({ description: "Carry uncommitted changes via stash. Default true." })),
      reason: Type.Optional(Type.String({ description: "Why this isolation is needed (recorded in linkage)." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const topLevel = await getTopLevel(exec, cwd);
      if (!topLevel) throw new Error("worktree_create: not a git repository.");
      const commonDir = await getCommonDir(exec, cwd);
      if (!commonDir) throw new Error("worktree_create: cannot resolve git dir.");
      const facts = await collectFacts(exec, cwd);
      const originBranch = facts?.branch ?? null;
      const originHead = facts?.head ?? null;

      const rawBranch = (params.branch ?? "").trim();
      const branch = sanitizeBranchName(rawBranch) || sanitizeBranchName(suggestBranchName(originBranch));
      if (!branch) throw new Error("worktree_create: cannot determine a valid branch name.");
      if (await branchExists(exec, cwd, branch)) {
        return {
          content: [{ type: "text", text: `Error: branch \`${branch}\` already exists. Pick another name or run \`git worktree add <path> ${branch}\` manually.` }],
          details: { ok: false, reason: "branch-exists", branch },
        };
      }
      if (params.base && !(await refExists(exec, cwd, params.base))) {
        return {
          content: [{ type: "text", text: `Error: base ref \`${params.base}\` does not exist.` }],
          details: { ok: false, reason: "bad-base", base: params.base },
        };
      }
      const { resolve } = await import("node:path");
      const { mkdir } = await import("node:fs/promises");
      let targetPath: string;
      if (params.path) {
        targetPath = params.path.startsWith("/") ? params.path : resolve(cwd, params.path);
      } else {
        const { dir, path: dflt } = await defaultWorktreePath(topLevel, branch);
        await mkdir(dir, { recursive: true });
        targetPath = await dedupePath(dflt);
      }

      const created = await createWorktree(exec, cwd, {
        branch,
        path: targetPath,
        base: params.base,
      }, signal ?? undefined);
      if (!created.ok) {
        return {
          content: [{ type: "text", text: `Error: git worktree add failed.\n${created.output}` }],
          details: { ok: false, reason: "worktree-add-failed", output: created.output },
        };
      }

      let carried = false;
      let carryNote = "clean — nothing to carry";
      const wantCarry = params.carry !== false;
      if (wantCarry && facts && !facts.clean) {
        const res = await carryChangesViaStash(
          exec, cwd, targetPath, `pi-worktree:${branch}`, signal ?? undefined,
        );
        carried = res.carried;
        carryNote = res.carried
          ? "uncommitted changes carried via stash"
          : res.conflict
            ? `carry CONFLICT — stash kept as ${res.stashRef ?? "refs/stash"}; resolve manually in ${targetPath}. ${res.output ?? ""}`
            : `carry skipped: ${res.reason ?? res.output ?? "unknown"}`;
      } else if (!wantCarry) {
        carryNote = "carry disabled — new worktree starts from base only";
      }

      const link: WorktreeLink = {
        id: makeId(),
        originPath: await canonicalPath(topLevel),
        originBranch,
        originHead,
        worktreePath: await canonicalPath(targetPath),
        branch,
        base: params.base ?? originHead,
        carried,
        createdAt: Date.now(),
        status: "active",
      };
      const store = await loadStore(commonDir);
      await saveStore(commonDir, upsertLink(store, link));
      pi.appendEntry(LINK_ENTRY, link);
      await recordEvent({ kind: "create", ...link, reason: params.reason ?? null });
      await refreshChrome(pi, ctx, cwd);

      const text = [
        `Worktree ready: \`${branch}\` at ${targetPath}`,
        `Base: ${params.base ?? shortSha(originHead)} — ${carryNote}.`,
        `Origin: ${topLevel} (${originBranch ?? "detached"}).`,
        `Next: \`cd ${targetPath}\` and continue there; finish with worktree_land (or /land).`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { ok: true, branch, path: targetPath, carried, carryNote, link },
      };
    },
  });

  pi.registerTool({
    name: "worktree_land",
    label: "Worktree Land",
    description:
      "Merge the current linked worktree back into its origin worktree. Commits pending changes, merges (or squash-merges), surfaces file conflicts for resolution, and cleans up the worktree on success.",
    promptSnippet: "Land a linked worktree back into its origin",
    promptGuidelines: [
      "Use worktree_land to finish work inside a linked worktree instead of raw git merge commands.",
    ],
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Origin worktree path or branch. Auto-detected from linkage when omitted." })),
      strategy: Type.Optional(StringEnum(["merge", "squash"] as const, { description: "merge (default) or squash" })),
      message: Type.Optional(Type.String({ description: "Commit message for pending changes / squash. Auto-generated when omitted." })),
      remove: Type.Optional(Type.Boolean({ description: "Remove the source worktree after a successful land. Default true." })),
      finish: Type.Optional(Type.Boolean({ description: "Conclude an in-progress conflicted merge after resolving files." })),
      abort: Type.Optional(Type.Boolean({ description: "Abort an in-progress conflicted merge." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, signal ?? undefined);
      const result = await landFlow(exec, cwd, {
        to: params.target,
        strategy: params.strategy ?? "merge",
        message: params.message,
        remove: params.remove !== false,
        finish: params.finish ?? false,
        abort: params.abort ?? false,
        interactive: false,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });

  interface LandFlowOpts {
    to?: string;
    strategy: LandStrategy;
    message?: string;
    remove: boolean;
    finish: boolean;
    abort: boolean;
    interactive: boolean;
  }

  async function landFlow(
    exec: ExecFn,
    cwd: string,
    opts: LandFlowOpts,
  ): Promise<{ text: string; details: Record<string, unknown> }> {
    const topLevel = await getTopLevel(exec, cwd);
    if (!topLevel) return { text: "Not a git repository.", details: { ok: false, reason: "not-a-repo" } };
    const commonDir = await getCommonDir(exec, cwd);
    if (!commonDir) return { text: "Cannot resolve git dir.", details: { ok: false, reason: "no-common-dir" } };
    const canon = await canonicalPath(topLevel);
    const store = await loadStore(commonDir);

    // Resolve source (where the feature commits live) and target (origin).
    let link = activeLinkFor(store, canon) ?? findByWorktree(store, canon);
    let sourcePath = canon;
    let sourceBranch = (await collectFacts(exec, cwd))?.branch ?? link?.branch ?? null;
    let targetPath: string | undefined;
    let targetBranch: string | undefined;

    if (link && link.status === "active") {
      targetPath = link.originPath;
      targetBranch = link.originBranch ?? undefined;
    }
    if (opts.to) {
      // Explicit target wins: may be a path or a branch name.
      const { existsSync } = await import("node:fs");
      if (opts.to.startsWith("/") && existsSync(opts.to)) {
        targetPath = await canonicalPath(opts.to);
      } else {
        // Try worktree list match by branch, else treat as path to resolve.
        const wts = await listWorktrees(exec, cwd);
        const hit = wts.find((w) => w.branch === opts.to);
        if (hit) {
          targetPath = await canonicalPath(hit.path);
          targetBranch = hit.branch ?? undefined;
        } else {
          targetPath = opts.to;
        }
      }
    }
    if (!targetPath) {
      // Fallback: the other worktree when exactly two exist.
      const wts = await listWorktrees(exec, cwd);
      const others = wts.filter((w) => w.path !== canon && !w.bare);
      if (others.length === 1) {
        targetPath = await canonicalPath(others[0].path);
        targetBranch = others[0].branch ?? undefined;
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
        text: "Current HEAD is detached — create a branch first (`git switch -c <name>`) so /land knows what to merge.",
        details: { ok: false, reason: "detached-source" },
      };
    }

    // Abort / finish operate on whichever side holds MERGE_HEAD (normally
    // the target, since the merge runs there — but the user may invoke from
    // either worktree).
    const mergeDir = (await hasMergeHead(exec, targetPath))
      ? targetPath
      : (await hasMergeHead(exec, sourcePath)) ? sourcePath : null;
    if (opts.abort) {
      if (!mergeDir) {
        return { text: "No merge in progress here — nothing to abort.", details: { ok: false, reason: "no-merge" } };
      }
      const r = await abortMerge(exec, mergeDir);
      const out = `${r.stdout}\n${r.stderr}`.trim();
      await recordEvent({ kind: "land-abort", dir: mergeDir });
      return { text: r.code === 0 ? `Merge aborted in ${mergeDir}.\n${out}` : `Abort failed in ${mergeDir}.\n${out}`, details: { ok: r.code === 0, dir: mergeDir } };
    }

    // Finish an in-progress merge (normally in the target).
    if (opts.finish || mergeDir) {
      if (!mergeDir) {
        return { text: "No merge in progress — nothing to finish.", details: { ok: false, reason: "no-merge" } };
      }
      const unmerged = await unmergedFiles(exec, mergeDir);
      if (unmerged.length > 0 && !opts.finish) {
        return {
          text: `Merge in progress in ${targetPath} with conflicts:\n${unmerged.map((f) => `  ${f}`).join("\n")}\nResolve files, \`git add\` them, then re-run with finish:true (or /land --continue).`,
          details: { ok: false, reason: "conflict", conflicted: unmerged, target: targetPath },
        };
      }
      if (unmerged.length > 0) {
        return {
          text: `Still conflicted:\n${unmerged.map((f) => `  ${f}`).join("\n")}\nResolve and \`git add\` before finishing.`,
          details: { ok: false, reason: "conflict", conflicted: unmerged, target: targetPath },
        };
      }
      const commit = await exec("git", ["commit", "--no-edit"], { cwd: mergeDir });
      const out = `${commit.stdout}\n${commit.stderr}`.trim().slice(0, 2000);
      if (commit.code !== 0) {
        return { text: `Could not conclude merge:\n${out}`, details: { ok: false, reason: "finish-failed", output: out } };
      }
      const sha = await (async () => {
        const r = await exec("git", ["rev-parse", "HEAD"], { cwd: mergeDir });
        return r.code === 0 ? r.stdout.trim() : null;
      })();
      // Normal orientation: invoked from the source side, link known. If
      // invoked directly from the merging side, recover the link by origin.
      const effLink = link ?? store.links.find((l) => l.status === "active" && samePath(l.originPath, mergeDir));
      if (effLink) await saveStore(commonDir, markLanded(store, effLink.id, { status: "landed", landedAt: Date.now(), landStrategy: opts.strategy, landSha: sha }));
      await recordEvent({ kind: "land-finish", source: effLink?.worktreePath ?? sourcePath, target: mergeDir, sha });
      const cleanup = opts.remove && effLink
        ? await cleanupWorktree(exec, commonDir, store, effLink, effLink.worktreePath, effLink.branch, mergeDir)
        : opts.remove ? "Linkage not found — worktree left in place; remove manually with `git worktree remove <path>`." : "";
      return {
        text: `Merge concluded in ${mergeDir} (${shortSha(sha)}).\n${out}${cleanup ? `\n${cleanup}` : ""}`,
        details: { ok: true, finished: true, sha, target: mergeDir, cleanup },
      };
    }

    // Fresh land: source must be committable, target must be clean.
    const srcStatus = await getStatusPorcelain(exec, sourcePath);
    if (!srcStatus.clean) {
      const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
      const msg = opts.message?.trim() || `land(${sourceBranch}): ${ts}`;
      const c = await ensureCommitted(exec, sourcePath, msg, undefined);
      if (!c.committed) {
        return {
          text: `Could not commit pending changes in ${sourcePath}:\n${c.output}\nConfigure git identity or commit manually, then retry.`,
          details: { ok: false, reason: "commit-failed", output: c.output },
        };
      }
    }
    const tgtStatus = await getStatusPorcelain(exec, targetPath);
    if (!tgtStatus.clean) {
      const files = tgtStatus.porcelain.split("\n").filter(Boolean).slice(0, 10).join("\n");
      return {
        text: `Target ${targetPath} has uncommitted changes — commit or stash there first so the merge is safe:\n${files}`,
        details: { ok: false, reason: "target-dirty", target: targetPath },
      };
    }

    const squashMsg = opts.message?.trim() || `land(${sourceBranch}): squash into ${targetBranch ?? "origin"}`;
    const merged = await mergeInto(exec, targetPath, sourceBranch, opts.strategy, squashMsg, undefined);
    if (!merged.ok) {
      await recordEvent({ kind: "land-conflict", source: sourcePath, target: targetPath, conflicted: merged.conflicted });
      return {
        text: [
          `Merge conflict landing \`${sourceBranch}\` into ${targetPath} (${opts.strategy}).`,
          merged.conflicted.length > 0 ? `Conflicted files:\n${merged.conflicted.map((f) => `  ${f}`).join("\n")}` : merged.output,
          `Resolve files in ${targetPath}, \`git add\` them, then run /land --continue (or worktree_land finish:true). Abort with /land --abort.`,
        ].join("\n"),
        details: { ok: false, reason: "conflict", conflicted: merged.conflicted, target: targetPath, source: sourcePath, output: merged.output },
      };
    }

    const sha = await (async () => {
      const r = await exec("git", ["rev-parse", "HEAD"], { cwd: targetPath });
      return r.code === 0 ? r.stdout.trim() : null;
    })();
    if (link) await saveStore(commonDir, markLanded(store, link.id, { status: "landed", landedAt: Date.now(), landStrategy: opts.strategy, landSha: sha }));
    await recordEvent({ kind: "land", source: sourcePath, target: targetPath, strategy: opts.strategy, sha });
    const cleanup = opts.remove ? await cleanupWorktree(exec, commonDir, store, link, sourcePath, sourceBranch, targetPath) : "";
    return {
      text: [`Landed \`${sourceBranch}\` into ${targetPath} (${opts.strategy}, ${shortSha(sha)}).`, merged.output, cleanup].filter(Boolean).join("\n"),
      details: { ok: true, sha, target: targetPath, source: sourcePath, strategy: opts.strategy, cleanup },
    };
  }

  async function cleanupWorktree(
    exec: ExecFn,
    commonDir: string,
    store: Awaited<ReturnType<typeof loadStore>>,
    link: WorktreeLink | undefined,
    sourcePath: string,
    sourceBranch: string,
    targetPath: string,
  ): Promise<string> {
    // Never auto-remove the worktree the user is sitting in without them
    // opting in interactively — report the exact follow-up instead.
    const removal = await removeWorktree(exec, targetPath, sourcePath);
    if (removal.code !== 0) {
      const err = `${removal.stdout}\n${removal.stderr}`.trim().slice(0, 800);
      return `Cleanup skipped (run manually): \`git -C ${targetPath} worktree remove ${sourcePath}\` — ${err}\nThen \`git branch -d ${sourceBranch}\` if merged.`;
    }
    const del = await deleteBranch(exec, targetPath, sourceBranch);
    const branchNote = del.code === 0
      ? `Branch \`${sourceBranch}\` deleted.`
      : `Worktree removed; branch kept (\`git branch -d ${sourceBranch}\` when ready).`;
    if (link) {
      try {
        const fresh = await loadStore(commonDir);
        await saveStore(commonDir, markLanded(fresh, link.id, { status: "removed", landedAt: Date.now() }));
      } catch {
        void store;
      }
    }
    await pruneWorktrees(exec, targetPath);
    return `Cleaned up: worktree removed. ${branchNote}`;
  }

  // ------------------------------------------------------------ commands

  pi.registerCommand("worktree", {
    description: "Create a linked worktree carrying current changes (or list/prune)",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["list", "status", "prune", "help"];
      const filtered = subs.filter((s) => s.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, ctx.signal ?? undefined);
      const parsed = parseWorktreeArgs(args);
      const topLevel = await getTopLevel(exec, cwd);

      if (parsed.sub === "help" || args.trim() === "--help" || args.trim() === "-h") {
        emit(ctx, 
          [
            "/worktree [branch] [--base <ref>] [--path <path>] [--no-carry]",
            "/worktree list | status | prune",
            "Creates a linked worktree carrying uncommitted changes (stash). Clean trees take the fast path.",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (!topLevel) {
        emit(ctx, "Not a git repository.", "error");
        return;
      }

      if (parsed.sub === "prune") {
        const r = await pruneWorktrees(exec, cwd);
        emit(ctx, r.code === 0 ? "Pruned stale worktree metadata." : `Prune failed:\n${r.stderr.trim()}`, r.code === 0 ? "info" : "error");
        return;
      }

      if (parsed.sub === "list" || parsed.sub === "status") {
        const facts = await collectFacts(exec, cwd);
        if (!facts) {
          emit(ctx, "Not a git repository.", "error");
          return;
        }
        const commonDir = facts.commonDir;
        const store = commonDir ? await loadStore(commonDir) : null;
        const canon = await canonicalPath(facts.topLevel);
        const link = store ? (activeLinkFor(store, canon) ?? findByWorktree(store, canon)) : undefined;
        const kids = store ? childrenOf(store, canon) : [];
        const text = formatWorktreeList(facts.topLevel, facts.branch, facts.clean, facts.porcelain, facts.worktrees, link, kids);
        emit(ctx, text, "info");
        if (parsed.json) {
          pi.sendMessage(
            { customType: "pi-worktree", content: text, display: false },
            { deliverAs: "nextTurn" },
          );
        }
        return;
      }

      // Create flow.
      const facts = await collectFacts(exec, cwd);
      if (!facts) {
        emit(ctx, "Not a git repository.", "error");
        return;
      }
      const commonDir = await getCommonDir(exec, cwd);
      if (!commonDir) {
        emit(ctx, "Cannot resolve git dir.", "error");
        return;
      }

      let branch = sanitizeBranchName(parsed.branch ?? "");
      if (!branch) {
        if (!ctx.hasUI) {
          branch = sanitizeBranchName(suggestBranchName(facts.branch));
        } else {
          const input = await ctx.ui.input("New worktree branch", suggestBranchName(facts.branch));
          if (!input) {
            emit(ctx, "Cancelled.", "info");
            return;
          }
          branch = sanitizeBranchName(input);
          if (!branch) {
            emit(ctx, `Invalid branch name: ${input}`, "error");
            return;
          }
        }
      }
      if (await branchExists(exec, cwd, branch)) {
        emit(ctx, `Branch \`${branch}\` already exists. Pick another name.`, "error");
        return;
      }
      if (parsed.base && !(await refExists(exec, cwd, parsed.base))) {
        emit(ctx, `Base ref \`${parsed.base}\` does not exist.`, "error");
        return;
      }

      const { resolve } = await import("node:path");
      const { mkdir } = await import("node:fs/promises");
      let targetPath: string;
      if (parsed.path) {
        targetPath = parsed.path.startsWith("/") ? parsed.path : resolve(cwd, parsed.path);
      } else if (!ctx.hasUI) {
        const { dir, path: dflt } = await defaultWorktreePath(facts.topLevel, branch);
        await mkdir(dir, { recursive: true });
        targetPath = await dedupePath(dflt);
      } else {
        const { dir, path: dflt } = await defaultWorktreePath(facts.topLevel, branch);
        await mkdir(dir, { recursive: true });
        const picked = await ctx.ui.input("Worktree path", await dedupePath(dflt));
        if (!picked) {
          emit(ctx, "Cancelled.", "info");
          return;
        }
        targetPath = picked.startsWith("/") ? picked : resolve(cwd, picked);
      }

      const dirtyNote = facts.clean
        ? "Workspace CLEAN — fast path, ideal for isolation."
        : `Workspace DIRTY — ${facts.porcelain.split("\n").filter(Boolean).length} file(s) will be carried via stash.`;
      if (ctx.hasUI && !parsed.json) {
        const ok = await ctx.ui.confirm(
          "Create worktree?",
          `${dirtyNote}\nBranch: ${branch}\nPath: ${targetPath}\nBase: ${parsed.base ?? shortSha(facts.head)}`,
        );
        if (!ok) {
          emit(ctx, "Cancelled.", "info");
          return;
        }
      }

      const created = await createWorktree(exec, cwd, { branch, path: targetPath, base: parsed.base }, ctx.signal ?? undefined);
      if (!created.ok) {
        emit(ctx, `git worktree add failed:\n${created.output}`, "error");
        return;
      }

      let carryNote = "clean — nothing to carry";
      let carried = false;
      if (parsed.carry && !facts.clean) {
        const res = await carryChangesViaStash(exec, cwd, targetPath, `pi-worktree:${branch}`, ctx.signal ?? undefined);
        carried = res.carried;
        carryNote = res.carried
          ? "uncommitted changes carried via stash"
          : res.conflict
            ? `carry CONFLICT — stash kept (${res.stashRef ?? "refs/stash"}); resolve in ${targetPath}`
            : `carry skipped: ${res.reason ?? res.output ?? "unknown"}`;
      } else if (!parsed.carry) {
        carryNote = "carry disabled";
      }

      const link: WorktreeLink = {
        id: makeId(),
        originPath: await canonicalPath(facts.topLevel),
        originBranch: facts.branch,
        originHead: facts.head,
        worktreePath: await canonicalPath(targetPath),
        branch,
        base: parsed.base ?? facts.head,
        carried,
        createdAt: Date.now(),
        status: "active",
      };
      const store = await loadStore(commonDir);
      await saveStore(commonDir, upsertLink(store, link));
      pi.appendEntry(LINK_ENTRY, link);
      await recordEvent({ kind: "create", ...link });
      await refreshChrome(pi, ctx, cwd);

      const summary = [
        `Worktree ready: \`${branch}\` at ${targetPath}`,
        carryNote,
        `Next: \`cd ${targetPath}\` then continue; finish with /land.`,
      ].join("\n");
      emit(ctx, summary, "info");
      pi.sendMessage(
        { customType: "pi-worktree", content: summary, display: true },
        { deliverAs: "nextTurn" },
      );
    },
  });

  pi.registerCommand("land", {
    description: "Land the current linked worktree back into its origin (handles conflicts)",
    getArgumentCompletions: (prefix: string) => {
      const flags = ["--continue", "--abort", "--status", "--strategy ", "--to ", "--no-remove", "--yes"];
      const filtered = flags.filter((f) => f.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((f) => ({ value: f, label: f })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd;
      const exec = getExec(cwd, ctx.signal ?? undefined);
      const parsed = parseLandArgs(args);

      if (parsed.status) {
        const facts = await collectFacts(exec, cwd);
        if (!facts) {
          emit(ctx, "Not a git repository.", "error");
          return;
        }
        const store = facts.commonDir ? await loadStore(facts.commonDir) : null;
        const canon = await canonicalPath(facts.topLevel);
        const link = store ? (activeLinkFor(store, canon) ?? findByWorktree(store, canon)) : undefined;
        const kids = store ? childrenOf(store, canon) : [];
        const merging = await hasMergeHead(exec, cwd);
        emit(ctx, 
          `${formatWorktreeList(facts.topLevel, facts.branch, facts.clean, facts.porcelain, facts.worktrees, link, kids)}${merging ? "\nMERGE_HEAD present — merge in progress." : ""}`,
          "info",
        );
        return;
      }

      // Interactive target resolution when linkage is missing.
      let to = parsed.to;
      if (!to && !parsed.cont && !parsed.abort) {
        const topLevel = await getTopLevel(exec, cwd);
        if (topLevel) {
          const commonDir = await getCommonDir(exec, cwd);
          const store = commonDir ? await loadStore(commonDir) : null;
          const canon = await canonicalPath(topLevel);
          const link = store ? activeLinkFor(store, canon) ?? findByWorktree(store, canon) : undefined;
          if (!link && ctx.hasUI) {
            const wts = await listWorktrees(exec, cwd);
            const others = wts.filter((w) => w.path !== canon && !w.bare);
            if (others.length > 1) {
              const labels = others.map((w) => `${w.branch ?? "?"} @ ${w.path}`);
              const picked = await ctx.ui.select("Land into which worktree?", labels);
              if (!picked) {
                emit(ctx, "Cancelled.", "info");
                return;
              }
              const hit = others[labels.indexOf(picked)];
              to = hit?.path;
            }
          }
        }
      }

      // Confirm destructive-looking lands interactively.
      if (ctx.hasUI && !parsed.yes && !parsed.cont && !parsed.abort) {
        const facts = await collectFacts(exec, cwd);
        if (facts && !facts.clean && !parsed.message) {
          const msg = await ctx.ui.input(
            "Pending changes will be committed first — message (empty = auto)",
            `land(${facts.branch ?? "work"}): ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
          );
          if (msg === undefined) {
            emit(ctx, "Cancelled.", "info");
            return;
          }
          if (msg.trim()) parsed.message = msg.trim();
        }
      }

      const result = await landFlow(exec, cwd, {
        to,
        strategy: parsed.strategy,
        message: parsed.message,
        remove: parsed.remove,
        finish: parsed.cont,
        abort: parsed.abort,
        interactive: true,
      });

      emit(ctx, result.text, result.details.ok ? "info" : "error");
      pi.sendMessage(
        { customType: "pi-worktree", content: result.text, display: true },
        { deliverAs: "nextTurn" },
      );
      const topAfter = await getTopLevel(exec, cwd);
      if (topAfter) await refreshChrome(pi, ctx, topAfter);
    },
  });

  // ------------------------------------------------------------- events

  pi.on("session_start", async (_event, ctx) => {
    await refreshChrome(pi, ctx, ctx.cwd);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // Ignore teardown races.
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const exec = getExec(ctx.cwd, ctx.signal ?? undefined);
      const facts = await collectFacts(exec, ctx.cwd);
      if (!facts) return;
      const canon = await canonicalPath(facts.topLevel);
      const store = facts.commonDir ? await loadStore(facts.commonDir) : null;
      const link = store ? activeLinkFor(store, canon) ?? findByWorktree(store, canon) : undefined;
      const kids = store ? childrenOf(store, canon) : [];
      const section = buildPolicySection({
        branch: facts.branch,
        clean: facts.clean,
        worktreeCount: facts.worktrees.length,
        isLinkedChild: !!link && link.status === "active",
        originBranch: link?.originBranch,
        originPath: link?.originPath,
        childCount: kids.length,
        childBranches: kids.map((k) => k.branch),
      });
      return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
    } catch {
      return;
    }
  });
}
