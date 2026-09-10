import { wrapTextWithAnsi, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Diagram-tree layout shared by every pi-worktree card.
 *
 * Rows (commits, files, carried files, checkpoints) hang off `├─`/`└─` stems
 * with `│` continuations, so the block reads as one diagram: the row head
 * carries the count, the children carry the names. Glyphs are painted by the
 * caller (cards keep them dim) while content stays readable — structure
 * recedes, data leads.
 */

/** A child entry: one painted line, or several wrapped lines (the extra lines
 *  hang under the text, keeping the diagram aligned). */
export type DiagramChild = string | string[];

export interface DiagramRow {
  /** Painted row label, e.g. `3 commits` — numbers bright, noun dim. */
  head: string;
  /** Painted child lines, one entry per item. */
  children?: DiagramChild[];
}

/** The diagram hangs this far in from the hero line. */
export const TREE_INDENT = "   ";

/** Render rows as one diagram; the last row drops its `│` continuation. */
export function diagramTree(
  rows: DiagramRow[],
  paintGlyph: (s: string) => string,
  indent = TREE_INDENT,
): string[] {
  const out: string[] = [];
  rows.forEach((row, i) => {
    const lastRow = i === rows.length - 1;
    out.push(`${indent}${paintGlyph(lastRow ? "└─" : "├─")} ${row.head}`);
    const children = row.children ?? [];
    const stem = `${indent}${lastRow ? "   " : `${paintGlyph("│")}  `}`;
    children.forEach((child, j) => {
      const glyph = j === children.length - 1 ? "└─" : "├─";
      const parts = Array.isArray(child) ? child : [child];
      parts.forEach((part, k) => {
        // Continuations drop the glyph but keep the width (2 + 1 space), so
        // wrapped text starts under the first line instead of under the stem.
        out.push(`${stem}${k === 0 ? `${paintGlyph(glyph)} ` : "   "}${part}`);
      });
    });
  });
  return out;
}

/** Clip by cells, keeping the tail: paths lose leading directories, never the
 *  file name the reader is looking for. */
export function clipPath(path: string, max: number): string {
  if (visibleWidth(path) <= max) return path;
  const segs = path.split("/");
  let tail = segs.pop() ?? path;
  while (segs.length > 0) {
    const next = `${segs[segs.length - 1]}/${tail}`;
    if (visibleWidth(`…/${next}`) > max) break;
    tail = next;
    segs.pop();
  }
  const out = `…/${tail}`;
  if (visibleWidth(out) <= max) return out;
  const hard = wrapTextWithAnsi(tail, Math.max(1, max - 2));
  return `…/${hard[0] ?? ""}`;
}

/** One row of a file list: path plus its line counts (null = binary). */
export interface FileCounts {
  path: string;
  added: number | null;
  deleted: number | null;
}

/** Aligned columns for a file list: path (tail-kept clip), `+N`, `-N`. Rows
 *  are padded to the widest cell in each column so the list reads as a table. */
export function fileColumns(rows: FileCounts[], pathMax = 56): { path: string; added: string; deleted: string }[] {
  const paths = rows.map((r) => clipPath(r.path, pathMax));
  const binary = (r: FileCounts) => r.added === null && r.deleted === null;
  const adds = rows.map((r) => (binary(r) ? "bin" : `+${r.added ?? 0}`));
  const dels = rows.map((r) => (binary(r) ? "" : `-${r.deleted ?? 0}`));
  const width = (list: string[]) => Math.max(0, ...list.map(visibleWidth));
  const [pathW, addW, delW] = [width(paths), width(adds), width(dels)];
  const padLeft = (s: string, w: number) => " ".repeat(Math.max(0, w - visibleWidth(s))) + s;
  return rows.map((_, i) => ({
    path: paths[i] + " ".repeat(Math.max(0, pathW - visibleWidth(paths[i]))),
    added: padLeft(adds[i], addW),
    deleted: padLeft(dels[i], delW),
  }));
}
