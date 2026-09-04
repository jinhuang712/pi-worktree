import test from "node:test";
import assert from "node:assert/strict";
import { alreadyRooted, rewriteToolInput, type Binding } from "../src/bind.ts";

const b: Binding = {
  root: "/repo.worktrees/wt-fix",
  origin: "/repo",
  branch: "wt-fix",
  originBranch: "main",
  linkId: "id",
};

test("bash is re-rooted into the worktree unless it already cds there", () => {
  const input: Record<string, unknown> = { command: "npm test" };
  const r = rewriteToolInput("bash", input, b, "/repo");
  assert.equal(r.changed, true);
  assert.equal(input.command, "cd '/repo.worktrees/wt-fix'\nnpm test");

  const rooted: Record<string, unknown> = { command: "cd /repo.worktrees/wt-fix && npm test" };
  assert.equal(rewriteToolInput("bash", rooted, b, "/repo").changed, false);
  assert.equal(alreadyRooted("cd '/repo.worktrees/wt-fix/src' && ls", b.root), true);
  assert.equal(alreadyRooted("cd /repo && ls", b.root), false);
  assert.equal(alreadyRooted("ls && cd /repo.worktrees/wt-fix", b.root), false);
});

test("relative and missing paths resolve against the worktree", () => {
  const read: Record<string, unknown> = { path: "src/index.ts" };
  assert.equal(rewriteToolInput("read", read, b, "/repo").changed, true);
  assert.equal(read.path, "/repo.worktrees/wt-fix/src/index.ts");

  const dot: Record<string, unknown> = { path: "./src/a.ts" };
  rewriteToolInput("edit", dot, b, "/repo");
  assert.equal(dot.path, "/repo.worktrees/wt-fix/src/a.ts");

  const grep: Record<string, unknown> = { pattern: "TODO" };
  assert.equal(rewriteToolInput("grep", grep, b, "/repo").changed, true);
  assert.equal(grep.path, "/repo.worktrees/wt-fix");
});

test("writes aimed at the origin checkout are blocked with the worktree twin", () => {
  const edit: Record<string, unknown> = { path: "/repo/src/index.ts" };
  const r = rewriteToolInput("edit", edit, b, "/repo");
  assert.equal(r.changed, false);
  assert.match(r.block ?? "", /\/repo\.worktrees\/wt-fix\/src\/index\.ts/);
  assert.equal(edit.path, "/repo/src/index.ts");

  // Reads of the origin pass untouched (comparisons are legit).
  const read: Record<string, unknown> = { path: "/repo/src/index.ts" };
  const rr = rewriteToolInput("read", read, b, "/repo");
  assert.equal(rr.changed, false);
  assert.equal(rr.block, undefined);

  // Absolute paths elsewhere are left alone.
  const other: Record<string, unknown> = { path: "/tmp/x.txt" };
  assert.deepEqual(rewriteToolInput("write", other, b, "/repo"), { changed: false });
});

test("no rewriting when the session cwd already is the worktree", () => {
  const input: Record<string, unknown> = { command: "npm test" };
  assert.equal(rewriteToolInput("bash", input, b, "/repo.worktrees/wt-fix").changed, false);
  assert.equal(input.command, "npm test");
});

test("unknown tools are ignored", () => {
  const input: Record<string, unknown> = { path: "x" };
  assert.equal(rewriteToolInput("worktree_status", input, b, "/repo").changed, false);
  assert.equal(input.path, "x");
});
