import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorktreePorcelain,
  sanitizeBranchName,
  suggestBranchName,
} from "../src/git.ts";

test("parses git worktree list --porcelain", () => {
  const raw = [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo.worktrees/pi-x",
    "HEAD def456",
    "branch refs/heads/pi/x",
    "",
    "worktree /repo.worktrees/det",
    "HEAD 789aaa",
    "detached",
    "",
  ].join("\n");
  const list = parseWorktreePorcelain(raw);
  assert.equal(list.length, 3);
  assert.equal(list[0].path, "/repo");
  assert.equal(list[0].branch, "main");
  assert.equal(list[0].detached, false);
  assert.equal(list[2].branch, null);
  assert.equal(list[2].detached, true);
});

test("parses bare and locked markers without crashing", () => {
  const raw = ["worktree /repo", "HEAD abc", "branch refs/heads/main", "locked reason", "", "worktree /gone", "HEAD abc", "branch refs/heads/old", "prunable", ""].join("\n");
  const list = parseWorktreePorcelain(raw);
  assert.equal(list.length, 2);
  assert.equal(list[0].locked, "reason");
  assert.equal(list[1].prunable, "prunable");
});

test("sanitizes hostile branch names", () => {
  assert.equal(sanitizeBranchName("pi/my feature"), "pi/my-feature");
  assert.equal(sanitizeBranchName("  bad..name@{x}  "), "bad-name-x");
  assert.equal(sanitizeBranchName("a/b//c"), "a/b/c");
  assert.equal(sanitizeBranchName("..."), "");
  assert.equal(sanitizeBranchName(""), "");
});

test("suggests timestamped branches", () => {
  const d = new Date(2026, 8, 4, 10, 30);
  assert.equal(suggestBranchName("main", d), "pi/work-20260904-1030");
  assert.equal(suggestBranchName("feat-x", d), "pi/feat-x-20260904-1030");
  assert.match(suggestBranchName(null), /^pi\/work-\d{8}-\d{4}$/);
});
