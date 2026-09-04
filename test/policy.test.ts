import test from "node:test";
import assert from "node:assert/strict";
import { buildPolicySection, WORKTREE_GUIDELINES } from "../src/policy.ts";

test("guidelines name the tools explicitly", () => {
  assert.ok(WORKTREE_GUIDELINES.every((g) => g.includes("worktree_")));
  assert.ok(WORKTREE_GUIDELINES.some((g) => g.includes("worktree_create")));
});

test("clean workspace nudges isolation", () => {
  const s = buildPolicySection({ branch: "main", clean: true, worktreeCount: 1, isLinkedChild: false });
  assert.match(s, /CLEAN/);
  assert.match(s, /worktree_create/);
});

test("dirty workspace warns against mixing", () => {
  const s = buildPolicySection({ branch: "main", clean: false, worktreeCount: 1, isLinkedChild: false });
  assert.match(s, /DIRTY/);
  assert.match(s, /\/worktree/);
});

test("linked child points at land", () => {
  const s = buildPolicySection({
    branch: "pi/x", clean: false, worktreeCount: 2, isLinkedChild: true,
    originBranch: "main", originPath: "/repo",
  });
  assert.match(s, /worktree_land/);
  assert.match(s, /\/land/);
});

test("origin lists children", () => {
  const s = buildPolicySection({
    branch: "main", clean: true, worktreeCount: 3, isLinkedChild: false,
    childCount: 2, childBranches: ["pi/a", "pi/b"],
  });
  assert.match(s, /pi\/a/);
});
