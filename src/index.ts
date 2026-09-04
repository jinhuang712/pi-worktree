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
import { Text } from "@earendil-works/pi-tui";
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
  resolveUniqueBranch,
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
  foreignOwnerOf,
  loadStore,
  makeId,
  markLanded,
  ownerLabel,
  samePath,
  saveStore,
  upsertLink,
  type WorktreeLink,
} from "./state.ts";

const WIDGET_KEY = "pi-worktree";
const STATUS_KEY = "pi-worktree";
const CARD_TYPE = "pi-worktree";
const LINK_ENTRY = "pi-worktree-link";
const EVENT_ENTRY = "pi-worktree-event";

function makeExec(
  pi: ExtensionAPI,
  signal?: AbortSignal,
): (cwd: string) => ExecFn {
  return (cwd: string) => (cmd, args, opts) =>
    pi.exec(cmd, args, { signal, timeout: opts?.timeout, cwd: opts?.cwd ?? cwd });
}

function pluralWorktree(n: number): string {
  return n === 1 ? "1 worktree" : `${n} worktrees`;
}

/** Compact human display, relative to the session cwd (e.g. `../repo.worktrees/wt-0904-1111`). */
async function displayPath(absPath: string, fromDir: string): Promise<string> {
  const { relative } = await import("node:path");
  const rel = relative(fromDir, absPath);
  return rel && !rel.startsWith("..") ? `./${rel}` : rel || ".";
}

function truncateMiddle(s: string, max = 60): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
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

/** True for ASCII branch-ish tokens (`my-feature`, `pi/x-1`). Anything else
 *  (CJK, sentences, …) is task text, not a branch name. */
function isBranchLike(token: string): boolean {
  return /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(token) && token.length <= 200;
}

function parseWorktreeArgs(raw: string): {
  sub?: string;
  base?: string;
  path?: string;
  carry: boolean;
  json: boolean;
  yes: boolean;
  /** Raw positionals; handler resolves branch vs task (needs async ref check). */
  positionals: string[];
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let sub: string | undefined;
  let base: string | undefined;
  let path: string | undefined;
  let carry = true;
  let json = false;
  let yes = false;
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--no-carry") carry = false;
    else if (t === "--json") json = true;
    else if (t === "--yes" || t === "-y") yes = true;
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
      return { sub, base, path, carry, json, yes, positionals: [] };
    }
  }
  return { sub, base, path, carry, json, yes, positionals };
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
      const dest = link.originBranch ?? "origin";
      ctx.ui.setWidget(WIDGET_KEY, [`🌲 ${link.branch} → ${dest}`]);
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `wt: ${link.branch}`));
    } else if (kids.length > 0) {
      const shown = kids.map((k) => k.branch).slice(0, 3).join(" · ");
      const more = kids.length > 3 ? ` +${kids.length - 3}` : "";
      ctx.ui.setWidget(WIDGET_KEY, [`🌲 ${pluralWorktree(kids.length)} · ${shown}${more}`]);
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `wt: ${pluralWorktree(kids.length)}`));
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
  me?: string | null,
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
    const tag = ownerLabel(originOfCurrent, me);
    lines.push(`Linked origin: ${originOfCurrent.originBranch ?? "?"} @ ${originOfCurrent.originPath}${tag ? ` ${tag}` : ""}`);
  }
  if (kids.length > 0) {
    lines.push(`Linked children (${kids.length}):`);
    for (const k of kids) {
      const tag = ownerLabel(k, me);
      lines.push(`  ${k.branch}  ${k.worktreePath}${tag ? ` ${tag}` : ""}`);
    }
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  const getExec = (cwd: string, signal?: AbortSignal): ExecFn =>
    makeExec(pi, signal)(cwd);

  // Compact result cards: the full handoff text stays in message content for
  // the model, but humans only see two lines (branch · task + dim rel path).
  // Full output remains one expand away. Failures render in full — they need it.
  pi.registerMessageRenderer(CARD_TYPE, (message, opts, theme) => {
    const full = typeof message.content === "string" ? message.content : "";
    const d = message.details as
      | { kind: "create"; branch: string; rel: string; task: string; carried: boolean }
      | { kind: "land"; ok: boolean; branch: string; dest: string; strategy: string; sha: string | null; note: string }
      | undefined;
    if (opts.expanded || !d || (d.kind !== "create" && d.kind !== "land") || (d.kind === "land" && !d.ok)) {
      return new Text(full, opts.outputPad, 0);
    }
    if (d.kind === "create") {
      const head = d.task
        ? `🌲 ${d.branch} · ${truncateMiddle(d.task)}`
        : `🌲 ${d.branch}`;
      const tail = d.carried ? ` · carried changes` : "";
      return new Text(
        `${theme.fg("accent", head)}\n${theme.fg("dim", `${d.rel}${tail}`)}`,
        opts.outputPad,
        0,
      );
    }
    const head = `🌲 landed ${d.branch} → ${d.dest}`;
    const tail = `${d.strategy} · ${shortSha(d.sha)}${d.note ? ` · ${d.note}` : ""}`;
    return new Text(
      `${theme.fg("accent", head)}\n${theme.fg("dim", tail)}`,
      opts.outputPad,
      0,
    );
  });

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
        facts.worktrees, link, kids, ctx.sessionManager.getSessionId(),
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
      "When work in the new worktree is finished, ask the user before landing instead of calling worktree_land silently.",
    ],
    parameters: Type.Object({
      branch: Type.Optional(Type.String({ description: "New branch name. Omit unless the user explicitly names one — never copy task text. Auto-generated when omitted." })),
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
      const explicitBranch = sanitizeBranchName(rawBranch);
      // Explicit names still error on collision (typo visibility); auto names
      // bump (-2/-3…) so parallel sessions never block each other.
      const branch = explicitBranch
        || await resolveUniqueBranch(exec, cwd, sanitizeBranchName(suggestBranchName(originBranch)));
      if (!branch) throw new Error("worktree_create: cannot determine a valid branch name.");
      if (explicitBranch && await branchExists(exec, cwd, branch)) {
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
        sessionId: ctx.sessionManager.getSessionId(),
        sessionName: pi.getSessionName() ?? null,
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
        sessionId: ctx.sessionManager.getSessionId(),
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
    /** Current pi session id — gates session-exclusive links. */
    sessionId?: string | null;
    /** Slash-side override for foreign-owned links (confirm dialog). Tools omit it → hard deny. */
    confirmForeign?: (links: WorktreeLink[]) => Promise<boolean>;
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
    // Invoked from the child side (normal): source = here, target = origin.
    // Invoked from the origin side with a single active child: flip —
    // source = the child, target = here — so /land does the right thing
    // instead of erroring about direction.
    let link = activeLinkFor(store, canon) ?? findByWorktree(store, canon);
    let sourcePath = canon;
    let sourceBranch = (await collectFacts(exec, cwd))?.branch ?? link?.branch ?? null;
    let targetPath: string | undefined;
    let targetBranch: string | undefined;

    if (link && link.status === "active") {
      targetPath = link.originPath;
      targetBranch = link.originBranch ?? undefined;
    } else if (!opts.to) {
      const kids = childrenOf(store, canon);
      if (kids.length === 1) {
        link = kids[0];
        sourcePath = await canonicalPath(link.worktreePath);
        sourceBranch = link.branch;
        targetPath = canon;
        targetBranch = (await collectFacts(exec, cwd))?.branch ?? link.originBranch ?? undefined;
      } else if (kids.length > 1) {
        const names = kids.map((k) => `${k.branch} @ ${k.worktreePath}`).join("\n");
        return {
          text: `Multiple active worktrees hang off this origin. Land one explicitly:\n${names}\nPass target (path or branch), e.g. /land --to <branch>.`,
          details: { ok: false, reason: "ambiguous-child", children: kids },
        };
      }
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

    // Session exclusivity: never silently touch another session's live worktree.
    // Either end (source child or explicit target) can be the owned one.
    {
      const candidates = [
        link,
        findByWorktree(store, targetPath),
      ];
      const foreign = [...new Set(candidates.filter((l): l is WorktreeLink => !!l))]
        .map((l) => foreignOwnerOf(l, opts.sessionId, canon))
        .filter((l): l is WorktreeLink => !!l);
      if (foreign.length > 0) {
        const who = foreign.map((l) => `\`${l.branch}\` ${ownerLabel(l, opts.sessionId)}`).join(", ");
        if (opts.confirmForeign) {
          const go = await opts.confirmForeign(foreign);
          if (!go) {
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
        details: { ok: true, finished: true, sha, target: mergeDir, cleanup, branch: effLink?.branch ?? sourceBranch, dest: effLink?.originBranch ?? undefined },
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
    // Target must be committable too — checkpoint it automatically instead of
    // erroring out, mirroring the source side above.
    let targetCheckpoint: string | null = null;
    const tgtStatus = await getStatusPorcelain(exec, targetPath);
    if (!tgtStatus.clean) {
      const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
      const c = await ensureCommitted(exec, targetPath, `land(${sourceBranch}): target checkpoint ${ts}`, undefined);
      if (!c.committed) {
        return {
          text: `Could not commit pending changes in target ${targetPath}:\n${c.output}\nConfigure git identity or commit manually, then retry.`,
          details: { ok: false, reason: "target-commit-failed", output: c.output, target: targetPath },
        };
      }
      targetCheckpoint = c.sha ?? null;
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
      text: [`Landed \`${sourceBranch}\` into ${targetPath} (${opts.strategy}, ${shortSha(sha)}).`, targetCheckpoint ? `Target had pending changes — checkpointed as ${shortSha(targetCheckpoint)} before merging.` : "", merged.output, cleanup].filter(Boolean).join("\n"),
      details: { ok: true, sha, target: targetPath, source: sourcePath, strategy: opts.strategy, cleanup, targetCheckpoint, branch: sourceBranch, dest: targetBranch },
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
    description: "Create a linked worktree and start the task in it (or list/prune)",
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
            "/worktree [branch] [task...] [--base <ref>] [--path <path>] [--no-carry] [--yes]",
            "/worktree list | status | prune",
            "Branch/path auto-generate when omitted. Extra text is the task:",
            "the agent continues it in the new worktree and asks before landing.",
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
        const text = formatWorktreeList(facts.topLevel, facts.branch, facts.clean, facts.porcelain, facts.worktrees, link, kids, ctx.sessionManager.getSessionId());
        emit(ctx, text, "info");
        if (parsed.json) {
          pi.sendMessage(
            { customType: "pi-worktree", content: text, display: false },
            { deliverAs: "nextTurn" },
          );
        }
        return;
      }

      // Create flow: branch/path auto-generate when omitted — no manual input.
      // Override via `/worktree <branch>` or `--path <path>`; skip confirm with `--yes`.
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

      // Resolve branch vs task from positionals:
      // - `/worktree my-branch` → branch (single ASCII token).
      // - `/worktree my-branch <base>` → branch + base when <base> is a real ref.
      // - Anything else (`/worktree 开始吧`, `/worktree fix the login bug`) is
      //   task text: branch auto-generates, text rides along as the task.
      const pos = parsed.positionals;
      let branch = "";
      let explicitBranch = false;
      let task = "";
      let base = parsed.base;
      if (pos.length === 1 && isBranchLike(pos[0])) {
        branch = sanitizeBranchName(pos[0]);
        explicitBranch = true;
      } else if (pos.length === 2 && isBranchLike(pos[0]) && !base && (await refExists(exec, cwd, pos[1]))) {
        branch = sanitizeBranchName(pos[0]);
        explicitBranch = true;
        base = pos[1];
      } else if (pos.length > 0) {
        task = pos.join(" ");
      }
      // Auto-generate when omitted or when input was task text (no prompt),
      // bumping on collision so a fresh session never dead-ends.
      if (!branch) branch = await resolveUniqueBranch(exec, cwd, sanitizeBranchName(suggestBranchName(facts.branch)));
      if (!branch) {
        emit(ctx, "Cannot determine a valid branch name.", "error");
        return;
      }
      if (explicitBranch && await branchExists(exec, cwd, branch)) {
        emit(ctx, `Branch \`${branch}\` already exists. Pick another name.`, "error");
        return;
      }
      if (base && !(await refExists(exec, cwd, base))) {
        emit(ctx, `Base ref \`${base}\` does not exist.`, "error");
        return;
      }

      // Auto-generate path when omitted (sibling .worktrees dir, deduped) — no prompt.
      const { resolve } = await import("node:path");
      const { mkdir } = await import("node:fs/promises");
      let targetPath: string;
      if (parsed.path) {
        targetPath = parsed.path.startsWith("/") ? parsed.path : resolve(cwd, parsed.path);
      } else {
        const { dir, path: dflt } = await defaultWorktreePath(facts.topLevel, branch);
        await mkdir(dir, { recursive: true });
        targetPath = await dedupePath(dflt);
      }

      const dirtyNote = facts.clean
        ? "Workspace CLEAN — fast path, ideal for isolation."
        : `Workspace DIRTY — ${facts.porcelain.split("\n").filter(Boolean).length} file(s) will be carried via stash.`;
      // Dirty workspaces carry via stash — confirm once. Clean takes the fast path.
      if (ctx.hasUI && !parsed.json && !parsed.yes && !facts.clean) {
        const ok = await ctx.ui.confirm(
          "Create worktree?",
          `${dirtyNote}\nBranch: ${branch}\nPath: ${targetPath}\nBase: ${base ?? shortSha(facts.head)}`,
        );
        if (!ok) {
          emit(ctx, "Cancelled.", "info");
          return;
        }
      }

      const created = await createWorktree(exec, cwd, { branch, path: targetPath, base }, ctx.signal ?? undefined);
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
        base: base ?? facts.head,
        carried,
        createdAt: Date.now(),
        status: "active",
        sessionId: ctx.sessionManager.getSessionId(),
        sessionName: pi.getSessionName() ?? null,
      };
      const store = await loadStore(commonDir);
      await saveStore(commonDir, upsertLink(store, link));
      pi.appendEntry(LINK_ENTRY, link);
      await recordEvent({ kind: "create", ...link });
      await refreshChrome(pi, ctx, cwd);

      // Bind the session to the worktree: the picker shows `🌲 wt-0904-1111`,
      // so parallel sessions stay distinguishable (session ↔ worktree isolation).
      try {
        pi.setSessionName(`🌲 ${branch}${task ? ` · ${truncateMiddle(task, 40)}` : ""}`);
      } catch {
        // Non-fatal.
      }

      const agentHandoff = task
        ? `User ran /worktree with extra text: "${task}". Work inside ${targetPath} — if the text is a real task, do it there; if it is vague chatter, infer the actual task from conversation history instead. When done, ask the user before landing — do NOT land without confirmation.`
        : `User ran /worktree with no extra text. Infer the pending task from conversation history and do it inside ${targetPath}; when done, ask the user before landing — do NOT land without confirmation.`;
      const summary = [
        `Worktree ready: \`${branch}\` at ${targetPath}`,
        carryNote,
        agentHandoff,
        `(Session cwd stays at the origin — work with \`cd ${targetPath} && ...\` / absolute paths, keep all edits in the new worktree.)`,
      ].join("\n");
      // The card below is the visible confirmation; skip emit with UI to avoid duplicates.
      // triggerTurn:true hands off to the model so /worktree is one shot:
      // create → agent continues the task in the new worktree (no manual follow-up).
      // NOTE: deliverAs:"nextTurn" only queues for the next user prompt and leaves
      // the session idle looking script-like — do NOT use it here.
      if (!ctx.hasUI) emit(ctx, summary, "info");
      pi.sendMessage(
        {
          customType: CARD_TYPE,
          content: summary,
          display: true,
          details: {
            kind: "create",
            branch,
            rel: await displayPath(targetPath, cwd),
            task,
            carried,
          },
        },
        { triggerTurn: true },
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
          `${formatWorktreeList(facts.topLevel, facts.branch, facts.clean, facts.porcelain, facts.worktrees, link, kids, ctx.sessionManager.getSessionId())}${merging ? "\nMERGE_HEAD present — merge in progress." : ""}`,
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

      // No commit-message prompt: checkpoint messages auto-generate inside landFlow.
      // Prompting here stalls the one-shot flow (and ui.input ignores placeholders).

      const result = await landFlow(exec, cwd, {
        to,
        strategy: parsed.strategy,
        message: parsed.message,
        remove: parsed.remove,
        finish: parsed.cont,
        abort: parsed.abort,
        interactive: true,
        sessionId: ctx.sessionManager.getSessionId(),
        confirmForeign: ctx.hasUI && !parsed.yes
          ? async (foreign) => {
            const who = foreign.map((l) => `\`${l.branch}\` ${ownerLabel(l, ctx.sessionManager.getSessionId())}`).join(", ");
            return ctx.ui.confirm("Land another session's worktree?", `${who} is owned by a different session. Land it anyway?`);
          }
          : undefined,
      });

      // Same one-shot rule as /worktree: the result card hands off to the model
      // (summarize / continue) instead of leaving the session idle script-like.
      // details feed the compact card renderer; failures render full text.
      if (!ctx.hasUI) emit(ctx, result.text, result.details.ok ? "info" : "error");
      {
        const rd = result.details as {
          ok?: boolean; sha?: string | null; strategy?: LandStrategy;
          cleanup?: string; branch?: string | null; dest?: string;
          source?: string; target?: string; targetCheckpoint?: string | null;
        };
        const { basename } = await import("node:path");
        const cleanup = typeof rd.cleanup === "string" ? rd.cleanup : "";
        const note = rd.targetCheckpoint
          ? `checkpoint ${shortSha(rd.targetCheckpoint)}`
          : cleanup.startsWith("Cleaned up")
            ? "cleaned up"
            : cleanup.startsWith("Cleanup skipped")
              ? "kept"
              : "";
        pi.sendMessage(
          {
            customType: CARD_TYPE,
            content: result.text,
            display: true,
            details: {
              kind: "land",
              ok: rd.ok === true,
              branch: rd.branch ?? (rd.source ? basename(rd.source) : "?"),
              dest: rd.dest ?? (rd.target ? basename(rd.target) : "?"),
              strategy: rd.strategy ?? parsed.strategy,
              sha: rd.sha ?? null,
              note,
            },
          },
          { triggerTurn: true },
        );
      }
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
