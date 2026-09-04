import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeLinkFor,
  childrenOf,
  emptyStore,
  findByWorktree,
  loadStore,
  markLanded,
  saveStore,
  upsertLink,
  type WorktreeLink,
} from "../src/state.ts";

function link(over: Partial<WorktreeLink> = {}): WorktreeLink {
  return {
    id: "id-1",
    originPath: "/repo",
    originBranch: "main",
    originHead: "abc",
    worktreePath: "/repo.worktrees/pi-x",
    branch: "pi/x",
    base: "abc",
    carried: true,
    createdAt: 1,
    status: "active",
    ...over,
  };
}

test("upsert + find roundtrip", () => {
  let store = emptyStore();
  store = upsertLink(store, link());
  assert.equal(findByWorktree(store, "/repo.worktrees/pi-x")?.branch, "pi/x");
  assert.equal(activeLinkFor(store, "/repo.worktrees/pi-x")?.status, "active");
  store = upsertLink(store, link({ carried: false }));
  assert.equal(store.links.length, 1);
  assert.equal(store.links[0].carried, false);
});

test("childrenOf only returns active links for the origin", () => {
  let store = emptyStore();
  store = upsertLink(store, link({ id: "a" }));
  store = upsertLink(store, link({ id: "b", worktreePath: "/repo.worktrees/pi-y", branch: "pi/y" }));
  store = upsertLink(store, link({ id: "c", worktreePath: "/other.worktrees/pi-z", originPath: "/other", branch: "pi/z" }));
  assert.equal(childrenOf(store, "/repo").length, 2);
  const landed = markLanded(store, "a", { status: "landed", landedAt: 2 });
  assert.equal(childrenOf(landed, "/repo").length, 1);
  assert.equal(activeLinkFor(landed, "/repo.worktrees/pi-x"), undefined);
  assert.equal(findByWorktree(landed, "/repo.worktrees/pi-x")?.status, "landed");
});

test("disk roundtrip tolerates missing/corrupt files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-state-"));
  const empty = await loadStore(dir);
  assert.equal(empty.links.length, 0);
  await saveStore(dir, upsertLink(emptyStore(), link()));
  const loaded = await loadStore(dir);
  assert.equal(loaded.links.length, 1);
  assert.equal(loaded.links[0].branch, "pi/x");
});
