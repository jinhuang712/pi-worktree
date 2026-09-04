import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseWorktreePorcelain,
  resolveUniqueBranch,
  sanitizeBranchName,
  suggestBranchName,
  syncStoreWithGit,
  type ExecFn,
} from "../src/git.ts";
import {
  emptyStore,
  findByWorktree,
  loadStore,
  saveStore,
  upsertLink,
} from "../src/state.ts";

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

test("suggests short wt- branches", () => {
  const d = new Date(2026, 8, 4, 10, 30);
  assert.equal(suggestBranchName("main", d), "wt-0904-1030");
  assert.equal(suggestBranchName("feat-x", d), "wt-feat-x-0904-1030");
  assert.equal(suggestBranchName("pi/my-feature", d), "wt-pi-my-feature-0904-1030");
  assert.match(suggestBranchName(null), /^wt-\d{4}-\d{4}$/);
});

test("resolveUniqueBranch bumps on collision", async () => {  const taken = new Set(["wt-0904-1030", "wt-0904-1030-2"]);
  const exec: ExecFn = async (_cmd, args) => {
    const ref = args[args.length - 1];
    const branch = ref.replace(/^refs\/heads\//, "");
    return { stdout: "", stderr: "", code: taken.has(branch) ? 0 : 1 };
  };
  assert.equal(await resolveUniqueBranch(exec, "/repo", "wt-0904-1030"), "wt-0904-1030-3");
  assert.equal(await resolveUniqueBranch(exec, "/repo", "wt-fresh-0000"), "wt-fresh-0000");
});

test("syncStoreWithGit marks gone worktrees removed, keeps live ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-sync-"));
  const base = {
    id: "x", originPath: "/repo", originBranch: "main", originHead: "abc",
    base: "abc", carried: false, createdAt: 1, status: "active" as const,
  };
  await saveStore(dir, upsertLink(upsertLink(emptyStore(),
    { ...base, id: "live", worktreePath: "/repo.worktrees/wt-live", branch: "wt-live" }),
    { ...base, id: "gone", worktreePath: "/repo.worktrees/wt-gone", branch: "wt-gone" }));
  const porcelain = [
    "worktree /repo", "HEAD abc", "branch refs/heads/main", "",
    "worktree /repo.worktrees/wt-live", "HEAD def", "branch refs/heads/wt-live", "",
  ].join("\n");
  const exec: ExecFn = async () => ({ stdout: porcelain, stderr: "", code: 0 });
  const synced = await syncStoreWithGit(exec, "/repo", dir);
  assert.equal(findByWorktree(synced, "/repo.worktrees/wt-live")?.status, "active");
  assert.equal(findByWorktree(synced, "/repo.worktrees/wt-gone")?.status, "removed");
  // Persisted too.
  assert.equal(findByWorktree(await loadStore(dir), "/repo.worktrees/wt-gone")?.status, "removed");
});

test("syncStoreWithGit never wipes on git failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-sync-"));
  await saveStore(dir, upsertLink(emptyStore(),
    {
      id: "a", originPath: "/repo", originBranch: "main", originHead: "abc",
      worktreePath: "/repo.worktrees/wt-a", branch: "wt-a",
      base: "abc", carried: false, createdAt: 1, status: "active",
    }));
  const exec: ExecFn = async () => ({ stdout: "", stderr: "boom", code: 128 });
  const synced = await syncStoreWithGit(exec, "/repo", dir);
  assert.equal(findByWorktree(synced, "/repo.worktrees/wt-a")?.status, "active");
});
