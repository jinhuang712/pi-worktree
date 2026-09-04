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
  foreignOwnerOf,
  loadStore,
  markLanded,
  orderKidsForDisplay,
  ownerLabel,
  saveStore,
  upsertLink,
  ownActiveLink,
  visibleKidsFor,
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

test("session exclusivity: foreign links gate, own/unowned/possession pass", () => {
  const mine = link({ sessionId: "sess-me", sessionName: "🌲 wt-1" });
  const others = link({ id: "o", worktreePath: "/repo.worktrees/wt-2", branch: "wt-2", sessionId: "sess-other", sessionName: "🌲 wt-2" });
  const legacy = link({ id: "l", worktreePath: "/repo.worktrees/wt-3", branch: "wt-3" });
  // Own and legacy links are free.
  assert.equal(foreignOwnerOf(mine, "sess-me", "/repo"), undefined);
  assert.equal(foreignOwnerOf(legacy, "sess-me", "/repo"), undefined);
  // Another session's link gates…
  assert.equal(foreignOwnerOf(others, "sess-me", "/repo")?.branch, "wt-2");
  // …unless standing inside it (fresh session after cd).
  assert.equal(foreignOwnerOf(others, "sess-me", "/repo.worktrees/wt-2"), undefined);
  // Landed links never gate.
  assert.equal(foreignOwnerOf({ ...others, status: "landed" }, "sess-me", "/repo"), undefined);
  // Labels.
  assert.equal(ownerLabel(mine, "sess-me"), "(you)");
  assert.equal(ownerLabel(others, "sess-me"), `("🌲 wt-2")`);
  assert.equal(ownerLabel(others, "sess-other"), "(you)");
  assert.equal(ownerLabel({ ...others, sessionName: null }, "sess-me"), "(session sess-oth)");
  assert.equal(ownerLabel(legacy, "sess-me"), "");
});

test("ownActiveLink enforces one worktree per session", () => {
  const mine = link({ id: "m", worktreePath: "/repo.worktrees/wt-m", branch: "wt-m", sessionId: "me" });
  const mineOtherRepo = link({ id: "o", originPath: "/other", worktreePath: "/other.worktrees/wt-o", branch: "wt-o", sessionId: "me" });
  const theirs = link({ id: "t", worktreePath: "/repo.worktrees/wt-t", branch: "wt-t", sessionId: "other" });
  const store = upsertLink(upsertLink(upsertLink(emptyStore(), mine), mineOtherRepo), theirs);
  assert.equal(ownActiveLink(store, "/repo", "me")?.branch, "wt-m");
  assert.equal(ownActiveLink(store, "/other", "me")?.branch, "wt-o");
  assert.equal(ownActiveLink(store, "/repo", "nobody"), undefined);
  assert.equal(ownActiveLink(store, "/repo", null), undefined);
});

test("visibleKidsFor hides foreign-owned links", () => {
  const mine = link({ id: "m", worktreePath: "/repo.worktrees/wt-m", branch: "wt-m", sessionId: "me" });
  const theirs = link({ id: "t", worktreePath: "/repo.worktrees/wt-t", branch: "wt-t", sessionId: "other" });
  const legacy = link({ id: "l", worktreePath: "/repo.worktrees/wt-l", branch: "wt-l" });
  assert.deepEqual(visibleKidsFor([mine, theirs, legacy], "me", "/repo").map((k) => k.branch), ["wt-m", "wt-l"]);
  assert.deepEqual(visibleKidsFor([theirs], "me", "/repo"), []);
});

test("origin widget orders own links first", () => {
  const mine = link({ id: "m", worktreePath: "/repo.worktrees/wt-m", branch: "wt-m", sessionId: "me" });
  const theirs = link({ id: "t", worktreePath: "/repo.worktrees/wt-t", branch: "wt-t", sessionId: "other" });
  const legacy = link({ id: "l", worktreePath: "/repo.worktrees/wt-l", branch: "wt-l" });
  assert.deepEqual(orderKidsForDisplay([theirs, legacy, mine], "me").map((k) => k.branch), ["wt-m", "wt-t", "wt-l"]);
  assert.deepEqual(orderKidsForDisplay([theirs, legacy], "me").map((k) => k.branch), ["wt-t", "wt-l"]);
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
