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
  ensureCommitted,
  listWorktrees,
  mergeInto,
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
