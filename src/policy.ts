/**
 * pi-worktree agent policy.
 *
 * Keeps the injected system prompt short: facts about where the session is
 * working plus when the model should reach for the worktree tools instead of
 * editing in place. Exactly one "where you are" statement per turn — bound
 * sessions hear about their worktree, never about the origin's children.
 */

export interface PolicyFacts {
  branch: string | null;
  clean: boolean;
  worktreeCount: number;
  /** Session is bound to a worktree it owns (or is standing inside one). */
  bound?: {
    root: string;
    branch: string;
    originBranch: string | null;
    originPath: string;
    /** True when the session cwd is already the worktree (no re-rooting needed). */
    standingInside: boolean;
    task?: string | null;
  } | null;
  childCount?: number;
  childBranches?: string[];
}

export const WORKTREE_GUIDELINES = [
  "Use worktree_status to check git cleanliness before risky edits; use worktree_create to isolate experimental work, worktree_land to merge a linked worktree back, and worktree_abandon to discard one.",
  "When the workspace is CLEAN and the task is experimental, risky, or explicitly parallel, proactively offer or call worktree_create instead of editing in place.",
  "Never run raw `git worktree add/remove` shell commands; use the worktree_* tools so origin linkage stays consistent.",
  "When work in a linked worktree is finished, ask the user before calling worktree_land — never land or merge silently. Empty worktrees (no commits, clean) are the exception: land/abandon cleans them up immediately with no confirmation needed.",
  "A bare worktree_land/worktree_abandon means YOUR tree: it resolves this session's own link (or the worktree you're standing in) and never auto-grabs another session's link. Name a branch/path explicitly only to deliberately take one over — then say who owned it and what you did.",
  "Conflicts are yours to resolve with worktree_land: read each conflicted file, keep the intended result from both sides, `git add`, then finish with finish:true. Explain the resolution; ask the user only when both sides look deliberately contradictory.",
  "One active worktree per session per repo: reuse the owned link instead of calling worktree_create again; call worktree_land first when its work is done.",
];

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

export function buildPolicySection(f: PolicyFacts): string {
  const lines: string[] = ["## pi-worktree policy (native)"];
  if (f.bound) {
    const b = f.bound;
    const from = b.originBranch ? `\`${b.originBranch}\`` : "its origin";
    lines.push(
      `- Working root: ${b.root} — worktree \`${b.branch}\` forked from ${from} at ${b.originPath}${b.task ? ` for: "${b.task}"` : ""}.`,
    );
    lines.push(
      b.standingInside
        ? "- The session cwd is this worktree; relative paths already resolve here."
        : "- Relative paths and bash commands are re-rooted into the working root automatically — do not prefix `cd`, do not use origin paths for edits (edits under the origin checkout are blocked; reading it for comparison is fine).",
    );
    lines.push(
      "- When the task is done, ask the user whether to land instead of landing silently; run worktree_land (or tell the user to run /land) only after confirmation. Empty worktrees (no commits, clean) need no confirmation — land/abandon removes them immediately. To throw non-empty work away, worktree_abandon (needs confirmation).",
    );
  } else {
    const where = f.branch ? `branch \`${f.branch}\`` : "detached HEAD";
    lines.push(`- Current worktree: ${where}, ${f.clean ? "CLEAN" : "DIRTY"}, ${plural(f.worktreeCount, "worktree")}.`);
    if ((f.childCount ?? 0) > 0) {
      const kids = (f.childBranches ?? []).slice(0, 5).map((b) => `\`${b}\``).join(", ");
      lines.push(
        `- This is an origin with ${plural(f.childCount ?? 0, "active linked worktree")}${kids ? `: ${kids}` : ""}. Do not edit the same files here in parallel; land children with worktree_land before reusing their branches.`,
      );
    } else if (f.clean) {
      lines.push(
        "- Workspace is CLEAN: ideal for isolation. For experimental/refactor/parallel tasks, proactively suggest `/worktree <task>` or call worktree_create before making changes.",
      );
    } else {
      lines.push(
        "- Workspace is DIRTY with unrelated changes: do NOT mix a new task into these files. Suggest `/worktree <task>` to isolate, or confirm before touching dirty paths.",
      );
    }
  }
  lines.push("- Never run raw `git worktree add/remove`; use the worktree_* tools so linkage stays consistent.");
  lines.push("- A bare land/abandon means YOUR tree: this session's own link (or the worktree you're standing in). Never auto-grab another session's link; name it explicitly only for a deliberate takeover, then say who owned it.");
  lines.push("- Conflicts are yours to resolve: read, merge sensibly, `git add`, finish with finish:true, explain. Ask only when both sides look deliberately contradictory.");
  return lines.join("\n");
}
