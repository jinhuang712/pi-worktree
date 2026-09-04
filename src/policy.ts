/**
 * pi-worktree agent policy.
 *
 * Keeps the injected system prompt short: facts about the current repo plus
 * when the model should reach for the worktree tools instead of editing
 * in place. Clean workspaces get an explicit nudge to isolate.
 */

export interface PolicyFacts {
  branch: string | null;
  clean: boolean;
  worktreeCount: number;
  isLinkedChild: boolean;
  originBranch?: string | null;
  originPath?: string;
  childCount?: number;
  childBranches?: string[];
}

export const WORKTREE_GUIDELINES = [
  "Use worktree_status to check git cleanliness before risky edits; use worktree_create to isolate experimental work and worktree_land to merge a linked worktree back.",
  "When the workspace is CLEAN and the task is experimental, risky, or explicitly parallel, proactively offer or call worktree_create instead of editing in place.",
  "Never run raw `git worktree add/remove` shell commands; use the worktree_* tools so origin linkage stays consistent.",
];

export function buildPolicySection(f: PolicyFacts): string {
  const lines: string[] = ["## pi-worktree policy (native)"];
  const where = f.branch ? `branch \`${f.branch}\`` : "detached HEAD";
  lines.push(`- Current worktree: ${where}, ${f.clean ? "CLEAN" : "DIRTY"}, ${f.worktreeCount} worktree(s) total.`);
  if (f.isLinkedChild) {
    lines.push(
      `- This worktree was created by /worktree${f.originBranch ? ` from \`${f.originBranch}\`` : ""}${f.originPath ? ` at \`${f.originPath}\`` : ""}. Keep all edits inside this worktree and finish with worktree_land (or tell the user to run /land).`,
    );
  } else if ((f.childCount ?? 0) > 0) {
    const kids = (f.childBranches ?? []).slice(0, 5).map((b) => `\`${b}\``).join(", ");
    lines.push(
      `- This is an origin with ${f.childCount} active linked worktree(s)${kids ? `: ${kids}` : ""}. Do not edit the same files here in parallel; land children with worktree_land before reusing their branches.`,
    );
  } else if (f.clean) {
    lines.push(
      "- Workspace is CLEAN: ideal for isolation. For experimental/refactor/parallel tasks, proactively suggest `/worktree <branch>` or call worktree_create before making changes.",
    );
  } else {
    lines.push(
      "- Workspace is DIRTY with unrelated changes: do NOT mix a new task into these files. Suggest `/worktree <branch>` to isolate, or confirm before touching dirty paths.",
    );
  }
  lines.push("- Never run raw `git worktree add/remove`; use the worktree_* tools so linkage stays consistent.");
  return lines.join("\n");
}
