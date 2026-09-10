import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  carryChangesViaStash,
  collectFacts,
  createWorktree,
  diffNames,
  ensureCommitted,
  isDetached,
  isWorkTree,
  listWorktrees,
  mergeInto,
  workingChanges,
  type ExecFn,
} from "../src/git.ts";

function sh(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}\n${stderr}` });
    });
  });
}

const exec: ExecFn = async (cmd, args, opts) => {
  const r = await sh(opts?.cwd ?? process.cwd(), args);
  void cmd;
  return { stdout: r.out, stderr: "", code: r.code };
};

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-e2e-"));
  await sh(dir, ["init", "-b", "main"]);
  await sh(dir, ["config", "user.email", "test@example.com"]);
  await sh(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  await sh(dir, ["add", "-A"]);
  await sh(dir, ["commit", "-m", "init"]);
  return dir;
}

test("a bogus target path is not a worktree and not detached", async () => {
  const origin = await initRepo();
  // The exact shape of the reported bug: origin path with text glued on.
  const bogus = join(origin, "然后推送到");
  assert.equal(await isWorkTree(exec, bogus), false);
  assert.equal(await isDetached(exec, bogus), false);
  // And a genuinely detached worktree still reads as detached.
  await sh(origin, ["checkout", "--detach", "HEAD"]);
  assert.equal(await isWorkTree(exec, origin), true);
  assert.equal(await isDetached(exec, origin), true);
});

test("workingChanges marks modified, untracked and deleted files", async () => {
  const repo = await initRepo();
  writeFileSync(join(repo, "b.txt"), "x\ny\n");
  await sh(repo, ["add", "-A"]);
  await sh(repo, ["commit", "-m", "add b"]);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "fresh.txt"), "n1\nn2\n");
  await sh(repo, ["rm", "-q", "b.txt"]);

  const by = Object.fromEntries((await workingChanges(exec, repo)).map((c) => [c.path, c]));
  assert.deepEqual(by["a.txt"], { status: "M", path: "a.txt", added: 1, deleted: 0 });
  assert.deepEqual(by["fresh.txt"], { status: "A", path: "fresh.txt", added: 2, deleted: 0 });
  assert.deepEqual(by["b.txt"], { status: "D", path: "b.txt", added: 0, deleted: 2 });

  const scoped = await workingChanges(exec, repo, ["a.txt"]);
  assert.deepEqual(scoped.map((c) => c.path), ["a.txt"]);
});

test("create + stash-carry + land clean merge", async () => {
  const origin = await initRepo();
  // Dirty: tracked edit + untracked file.
  writeFileSync(join(origin, "a.txt"), "one+dirty\n");
  writeFileSync(join(origin, "b.txt"), "new\n");

  const wtPath = join(`${origin}.worktrees`, "pi-e2e");
  const created = await createWorktree(exec, origin, { branch: "pi/e2e", path: wtPath });
  assert.equal(created.ok, true, created.output);

  const carry = await carryChangesViaStash(exec, origin, wtPath, "pi-worktree:test");
  assert.equal(carry.carried, true, JSON.stringify(carry));
  assert.equal((await sh(origin, ["stash", "list"])).out.trim(), "");

  const originFacts = await collectFacts(exec, origin);
  assert.equal(originFacts?.clean, true);
  const wtFacts = await collectFacts(exec, wtPath);
  assert.equal(wtFacts?.clean, false);
  assert.equal(readFileSync(join(wtPath, "b.txt"), "utf8"), "new\n");

  const c = await ensureCommitted(exec, wtPath, "land test");
  assert.equal(c.committed, true);

  const merged = await mergeInto(exec, origin, "pi/e2e", "merge", "squash msg");
  assert.equal(merged.ok, true, merged.output);
  assert.equal(readFileSync(join(origin, "b.txt"), "utf8"), "new\n");

  const wts = await listWorktrees(exec, origin);
  assert.ok(wts.some((w) => w.branch === "pi/e2e"));
});

test("rebase strategy lands linear and fast-forwards the origin", async () => {
  const origin = await initRepo();
  const wtPath = `${origin}-wt-rb`;
  assert.equal((await createWorktree(exec, origin, { branch: "wt-rb", path: wtPath })).ok, true);

  // Origin moves on in a different file; worktree commits its own change.
  writeFileSync(join(origin, "c.txt"), "origin progress\n");
  await sh(origin, ["add", "-A"]);
  await sh(origin, ["commit", "-m", "origin progress"]);
  writeFileSync(join(wtPath, "b.txt"), "feature\n");
  assert.equal((await ensureCommitted(exec, wtPath, "add feature")).committed, true);

  const r = await mergeInto(exec, origin, "wt-rb", "rebase", "unused", undefined, wtPath, "main");
  assert.equal(r.ok, true, r.output);
  assert.equal(r.applied, "rebase");
  const log = await sh(origin, ["log", "--format=%s %p", "-n3"]);
  // Top commit is the feature with a single parent: no merge commit.
  assert.match(log.out.split("\n")[0], /^add feature [0-9a-f]+$/);
  assert.equal(readFileSync(join(origin, "b.txt"), "utf8"), "feature\n");
  assert.equal(readFileSync(join(origin, "c.txt"), "utf8"), "origin progress\n");
});

test("rebase conflict falls back to merge and leaves MERGE_HEAD for the normal flow", async () => {
  const origin = await initRepo();
  const wtPath = `${origin}-wt-rbc`;
  assert.equal((await createWorktree(exec, origin, { branch: "wt-rbc", path: wtPath })).ok, true);
  writeFileSync(join(origin, "a.txt"), "origin-side\n");
  await sh(origin, ["add", "-A"]);
  await sh(origin, ["commit", "-m", "origin side"]);
  writeFileSync(join(wtPath, "a.txt"), "worktree-side\n");
  assert.equal((await ensureCommitted(exec, wtPath, "wt side")).committed, true);

  const r = await mergeInto(exec, origin, "wt-rbc", "rebase", "unused", undefined, wtPath, "main");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "conflict");
  assert.equal(r.applied, "merge");
  assert.ok(r.conflicted.includes("a.txt"));
  // The worktree is not left mid-rebase.
  assert.equal((await sh(wtPath, ["rev-parse", "-q", "--verify", "REBASE_HEAD"])).code === 0, false);
  await sh(origin, ["merge", "--abort"]);
});

test("squash with nothing new reports nothing-to-land, not a conflict", async () => {
  const origin = await initRepo();
  const wtPath = `${origin}-wt-empty`;
  assert.equal((await createWorktree(exec, origin, { branch: "wt-empty", path: wtPath })).ok, true);
  const r = await mergeInto(exec, origin, "wt-empty", "squash", "msg");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "nothing-to-land");
  assert.deepEqual(r.conflicted, []);
});

test("merge conflict surfaces conflicted files", async () => {
  const origin = await initRepo();
  const wtPath = `${origin}-wt2`;
  const created = await createWorktree(exec, origin, { branch: "pi/conflict", path: wtPath });
  assert.equal(created.ok, true, created.output);

  writeFileSync(join(origin, "a.txt"), "origin-side\n");
  await sh(origin, ["add", "-A"]);
  await sh(origin, ["commit", "-m", "origin side"]);

  writeFileSync(join(wtPath, "a.txt"), "worktree-side\n");
  const c = await ensureCommitted(exec, wtPath, "wt side");
  assert.equal(c.committed, true);

  const merged = await mergeInto(exec, origin, "pi/conflict", "merge", "msg");
  assert.equal(merged.ok, false);
  assert.ok(merged.conflicted.includes("a.txt"), JSON.stringify(merged));
  await sh(origin, ["merge", "--abort"]);
});

test("selective stash-carry moves only chosen paths", async () => {
  const origin = await initRepo();
  // Related change (tracked edit) + unrelated change (untracked file).
  writeFileSync(join(origin, "a.txt"), "one+dirty\n");
  writeFileSync(join(origin, "b.txt"), "unrelated\n");

  const wtPath = join(`${origin}.worktrees`, "pi-e2e-sel");
  const created = await createWorktree(exec, origin, { branch: "pi/e2e-sel", path: wtPath });
  assert.equal(created.ok, true, created.output);

  const carry = await carryChangesViaStash(exec, origin, wtPath, "pi-worktree:test", undefined, ["a.txt"]);
  assert.equal(carry.carried, true, JSON.stringify(carry));
  assert.equal(carry.selective, true);
  assert.equal(readFileSync(join(wtPath, "a.txt"), "utf8"), "one+dirty\n");

  // Unrelated change stays in the origin; the stash is dropped.
  assert.equal(readFileSync(join(origin, "b.txt"), "utf8"), "unrelated\n");
  assert.equal((await sh(origin, ["stash", "list"])).out.trim(), "");
  const wtFacts = await collectFacts(exec, wtPath);
  assert.ok(wtFacts && !wtFacts.clean);
});

test("selective carry survives a staged deletion and leaves the rest behind", async () => {
  const origin = await initRepo();
  writeFileSync(join(origin, "b.txt"), "x\ny\n");
  await sh(origin, ["add", "-A"]);
  await sh(origin, ["commit", "-m", "add b"]);
  writeFileSync(join(origin, "a.txt"), "one\ntwo\n"); // modified
  await sh(origin, ["rm", "-q", "b.txt"]); // staged deletion
  writeFileSync(join(origin, "keep-out.md"), "leave\n"); // unrelated

  const wtPath = join(`${origin}.worktrees`, "pi-e2e-sel-del");
  const created = await createWorktree(exec, origin, { branch: "pi/e2e-sel-del", path: wtPath });
  assert.equal(created.ok, true, created.output);

  const carry = await carryChangesViaStash(exec, origin, wtPath, "pi-worktree:test", undefined, ["a.txt", "b.txt"]);
  assert.equal(carry.carried, true, JSON.stringify(carry));

  const wt = await sh(wtPath, ["status", "--porcelain", "-uall"]);
  assert.match(wt.out, / M a\.txt/);
  assert.match(wt.out, /D\s+b\.txt/);
  // The unrelated file stays in the origin, and no stash entry leaks.
  const originSt = await sh(origin, ["status", "--porcelain", "-uall"]);
  assert.match(originSt.out, /\?\? keep-out\.md/);
  assert.equal((await sh(origin, ["stash", "list"])).out.trim(), "");
});

test("diffNames lists files changed on the branch", async () => {
  const origin = await initRepo();
  await sh(origin, ["checkout", "-qb", "feature"]);
  writeFileSync(join(origin, "a.txt"), "changed\n");
  writeFileSync(join(origin, "b.txt"), "added\n");
  await sh(origin, ["add", "-A"]);
  await sh(origin, ["commit", "-qm", "feature work"]);
  assert.deepEqual(await diffNames(exec, origin, "main", "HEAD"), ["a.txt", "b.txt"]);
});
