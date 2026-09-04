/**
 * Session ↔ worktree binding: the "virtual cwd".
 *
 * Pi keeps the session cwd at the origin after `/worktree`, so without help
 * the model has to prefix every command with `cd <worktree> &&` and remember
 * absolute paths — one slip edits the origin. Instead, while a session owns
 * an active worktree, built-in tool calls are re-rooted there before they
 * run: relative paths resolve against the worktree, bash starts inside it,
 * and edits aimed at the origin checkout are blocked with a pointer to the
 * worktree twin. Reads of the origin stay allowed (comparisons are legit).
 *
 * Pure functions only; the extension entry wires them to `tool_call`.
 */

import { isInside, normalizePath } from "./state.ts";

export interface Binding {
  /** Canonical worktree path the session is bound to. */
  root: string;
  /** Canonical origin top-level (the checkout to protect). */
  origin: string;
  branch: string;
  originBranch: string | null;
  linkId: string;
}

export interface RewriteResult {
  /** Input was changed in place. */
  changed: boolean;
  /** Set when the call must not run. */
  block?: string;
}

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** True when the command already re-roots itself into `root` (`cd <root> …`). */
export function alreadyRooted(command: string, root: string): boolean {
  const first = command.trimStart();
  const m = /^cd\s+(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(first);
  if (!m) return false;
  const target = m[1] ?? m[2] ?? m[3] ?? "";
  return normalizePath(target) === normalizePath(root) || isInside(target, root);
}

/**
 * Re-root a built-in tool call. Mutates `input` in place (pi contract) and
 * reports whether anything changed or the call must be blocked.
 */
export function rewriteToolInput(
  toolName: string,
  input: Record<string, unknown>,
  b: Binding,
  sessionCwd: string,
): RewriteResult {
  if (normalizePath(sessionCwd) === normalizePath(b.root)) return { changed: false };

  if (toolName === "bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    if (!cmd.trim() || alreadyRooted(cmd, b.root)) return { changed: false };
    input.command = `cd ${shellQuote(b.root)}\n${cmd}`;
    return { changed: true };
  }

  if (!PATH_TOOLS.has(toolName)) return { changed: false };
  const raw = typeof input.path === "string" ? input.path : undefined;

  // No path → tool defaults to cwd → make that the worktree.
  if (raw === undefined || raw.trim() === "") {
    input.path = b.root;
    return { changed: true };
  }
  const p = raw.trim();
  if (!p.startsWith("/")) {
    input.path = `${b.root}/${p.replace(/^\.\/+/, "")}`.replace(/\/+$/, "") || b.root;
    return { changed: true };
  }
  // Absolute path inside the origin checkout (and not inside the worktree,
  // which may itself live elsewhere): reads pass, writes are blocked.
  if (isInside(p, b.origin) && !isInside(p, b.root) && WRITE_TOOLS.has(toolName)) {
    const rel = normalizePath(p).slice(normalizePath(b.origin).length).replace(/^\//, "");
    const twin = rel ? `${b.root}/${rel}` : b.root;
    return {
      changed: false,
      block: `This session is bound to worktree \`${b.branch}\` at ${b.root}; ${p} is the origin checkout. Edit ${twin} instead (reads of the origin are fine).`,
    };
  }
  return { changed: false };
}
