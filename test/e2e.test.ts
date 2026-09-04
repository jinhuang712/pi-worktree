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
