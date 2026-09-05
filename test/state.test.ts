import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeLinkFor,
  childrenOf,
  emptyStore,
  findByWorktree,
  foreignOwnerOf,
  isInside,
  loadPrefs,
  loadStore,
  markLanded,
  orderKidsForDisplay,
  ownerLabel,
  prefsPath,
  saveLink,
  savePrefs,
  saveStore,
  STORE_DIR,
  storePath,
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
  writeFileSync(join(dir, STORE_DIR, "garbage.json"), "{not json");
  const loaded = await loadStore(dir);
  assert.equal(loaded.links.length, 1);
  assert.equal(loaded.links[0].branch, "pi/x");
});

test("per-link files: a stale snapshot cannot clobber another session's link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-state-"));
  const a = link({ id: "a", worktreePath: "/repo.worktrees/wt-a", branch: "wt-a", sessionId: "A" });
  const b = link({ id: "b", worktreePath: "/repo.worktrees/wt-b", branch: "wt-b", sessionId: "B" });
  await saveLink(dir, a);
  await saveLink(dir, b);
  // Session A loaded both while B was active…
  const snapshotA = await loadStore(dir);
  // …then B lands and writes only its own file…
  await saveLink(dir, { ...b, status: "landed", landedAt: 5 });
  // …and A persists a change to its own link from the stale snapshot.
  await saveLink(dir, { ...snapshotA.links.find((l) => l.id === "a")!, carried: false });
  const now = await loadStore(dir);
  assert.equal(findByWorktree(now, "/repo.worktrees/wt-b")?.status, "landed");
  assert.equal(findByWorktree(now, "/repo.worktrees/wt-a")?.carried, false);
});

test("legacy single-file store migrates to per-link files once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-state-"));
  writeFileSync(storePath(dir), JSON.stringify({ version: 1, links: [link({ id: "legacy" })] }));
  const loaded = await loadStore(dir);
  assert.equal(loaded.links.length, 1);
  assert.equal(loaded.links[0].id, "legacy");
  assert.ok(existsSync(join(dir, STORE_DIR, "legacy.json")));
  assert.ok(!existsSync(storePath(dir)));
  assert.equal((await loadStore(dir)).links.length, 1);
});

test("isInside handles root, children and lookalike siblings", () => {
  assert.equal(isInside("/repo", "/repo"), true);
  assert.equal(isInside("/repo/src/a.ts", "/repo"), true);
  assert.equal(isInside("/repo.worktrees/wt-x/a.ts", "/repo"), false);
  assert.equal(isInside("/other", "/repo"), false);
});

test("global prefs roundtrip in an isolated home", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-wt-prefs-"));
  assert.deepEqual(await loadPrefs(home), {});
  await savePrefs({ defaultStrategy: "squash" }, home);
  assert.deepEqual(await loadPrefs(home), { defaultStrategy: "squash" });
  // Corrupt file reads as no preferences, never throws.
  writeFileSync(join(home, ".pi", "agent", "pi-worktree", "config.json"), "{oops");
  assert.deepEqual(await loadPrefs(home), {});
});

test("prefsPath falls back to ~/.pi/agent layout", () => {
  assert.ok(prefsPath("/home/u").endsWith("/home/u/.pi/agent/pi-worktree/config.json"));
});
