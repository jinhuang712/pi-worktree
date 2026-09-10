import test from "node:test";
import assert from "node:assert/strict";
import { clipPath, diagramTree, fileColumns } from "../src/card.ts";

const plain = (s: string) => s;

test("diagram tree hangs rows off ├─/└─ with a │ stem", () => {
  const rows = [
    { head: "1 commit", children: ["feat: retry on 429"] },
    { head: "3 files", children: ["src/a.ts", "src/b.ts", "test/a.test.ts"] },
    { head: "2 files checkpointed on main" },
  ];
  assert.deepEqual(diagramTree(rows, plain), [
    "   ├─ 1 commit",
    "   │  └─ feat: retry on 429",
    "   ├─ 3 files",
    "   │  ├─ src/a.ts",
    "   │  ├─ src/b.ts",
    "   │  └─ test/a.test.ts",
    "   └─ 2 files checkpointed on main",
  ]);
});

test("the last row and last child drop their continuation", () => {
  assert.deepEqual(diagramTree([{ head: "clean · nothing to carry" }], plain), [
    "   └─ clean · nothing to carry",
  ]);
  assert.deepEqual(diagramTree([{ head: "1 commit", children: ["only"] }], plain), [
    "   └─ 1 commit",
    "      └─ only",
  ]);
});

test("wrapped children hang under the text, not under the stem", () => {
  assert.deepEqual(diagramTree([{ head: "1 commit", children: [["first line", "second line"]] }], plain), [
    "   └─ 1 commit",
    "      └─ first line",
    "         second line",
  ]);
});

test("the │ stem is painted with the glyph painter", () => {
  const seen: string[] = [];
  const paint = (s: string) => { seen.push(s); return s; };
  diagramTree([{ head: "1 commit", children: ["x"] }, { head: "2 files" }], paint);
  assert.deepEqual(seen, ["├─", "│", "└─", "└─"]);
});

test("file columns align paths, +N and -N", () => {
  const cols = fileColumns([
    { path: "CHANGELOG.md", added: 1, deleted: 0 },
    { path: "src/git.ts", added: 13, deleted: 1 },
    { path: "test/git.test.ts", added: 16, deleted: 0 },
  ]);
  assert.deepEqual(cols, [
    { path: "CHANGELOG.md    ", added: " +1", deleted: "-0" },
    { path: "src/git.ts      ", added: "+13", deleted: "-1" },
    { path: "test/git.test.ts", added: "+16", deleted: "-0" },
  ]);
});

test("file columns mark binary files instead of counting lines", () => {
  const cols = fileColumns([
    { path: "a.png", added: null, deleted: null },
    { path: "b.ts", added: 2, deleted: 0 },
  ]);
  assert.deepEqual(cols, [
    { path: "a.png", added: "bin", deleted: "  " },
    { path: "b.ts ", added: " +2", deleted: "-0" },
  ]);
});

test("clipPath keeps the tail and respects display width", () => {
  assert.equal(clipPath("src/git.ts", 20), "src/git.ts");
  assert.equal(clipPath("src/features/a/b/c/component.ts", 20), "…/a/b/c/component.ts");
  assert.ok(clipPath(`src/${"深/".repeat(30)}file.ts`, 24).startsWith("…/"));
});
