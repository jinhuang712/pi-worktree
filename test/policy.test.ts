import test from "node:test";
import assert from "node:assert/strict";
import { buildPolicySection, WORKTREE_GUIDELINES } from "../src/policy.ts";

test("guidelines name the tools explicitly", () => {
  assert.ok(WORKTREE_GUIDELINES.every((g) => g.includes("worktree_")));
  assert.ok(WORKTREE_GUIDELINES.some((g) => g.includes("worktree_create")));
});

test("clean workspace nudges isolation", () => {
  const s = buildPolicySection({ branch: "main", clean: true, worktreeCount: 1 });
  assert.match(s, /CLEAN/);
  assert.match(s, /worktree_create/);
});

test("dirty workspace warns against mixing", () => {
  const s = buildPolicySection({ branch: "main", clean: false, worktreeCount: 1 });
  assert.match(s, /DIRTY/);
  assert.match(s, /\/worktree/);
});

test("bound session hears about its worktree, not the origin's children", () => {
  const s = buildPolicySection({
    branch: "main", clean: true, worktreeCount: 2,
    bound: { root: "/repo.worktrees/wt-x", branch: "wt-x", originBranch: "main", originPath: "/repo", standingInside: false, task: "fix login" },
    childCount: 1, childBranches: ["wt-x"],
  });
  assert.match(s, /Working root: \/repo\.worktrees\/wt-x/);
  assert.match(s, /re-rooted/);
  assert.match(s, /fix login/);
  assert.match(s, /worktree_land/);
  assert.doesNotMatch(s, /This is an origin/);
  assert.doesNotMatch(s, /CLEAN/);
});

test("standing inside the worktree skips the re-rooting note", () => {
  const s = buildPolicySection({
    branch: "wt-x", clean: false, worktreeCount: 2,
    bound: { root: "/repo.worktrees/wt-x", branch: "wt-x", originBranch: "main", originPath: "/repo", standingInside: true },
  });
  assert.match(s, /cwd is this worktree/);
  assert.doesNotMatch(s, /re-rooted/);
});

test("origin lists children", () => {
  const s = buildPolicySection({
    branch: "main", clean: true, worktreeCount: 3,
    childCount: 2, childBranches: ["pi/a", "pi/b"],
  });
  assert.match(s, /pi\/a/);
});
