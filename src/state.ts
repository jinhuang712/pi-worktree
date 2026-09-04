/**
 * pi-worktree linkage store.
 *
 * Session entries alone are not enough: after `/worktree` the user typically
 * `cd`s into the new worktree and starts a fresh pi session with a different
 * cwd/session file. A small JSON file in the shared git dir keeps the
 * origin <-> worktree mapping discoverable from either side.
 */

export interface WorktreeLink {
  id: string;
  originPath: string;
  originBranch: string | null;
  originHead: string | null;
  worktreePath: string;
  branch: string;
  base: string | null;
  carried: boolean;
  createdAt: number;
  status: "active" | "landed" | "removed";
  /** Owning pi session (getSessionId). Absent on legacy links = unowned. */
  sessionId?: string | null;
  /** Session name snapshot at create time, for human-readable owner labels. */
  sessionName?: string | null;
  landedAt?: number;
  landStrategy?: string;
  landSha?: string | null;
}

export interface WorktreeStore {
  version: 1;
  links: WorktreeLink[];
}

export const STORE_FILE = "pi-worktree.json";

export function storePath(commonDir: string): string {
  return `${commonDir.replace(/\/+$/, "")}/${STORE_FILE}`;
}

export function emptyStore(): WorktreeStore {
  return { version: 1, links: [] };
}

export function normalizePath(p: string): string {
  return p.replace(/\/+$/, "") || "/";
}

/** Best-effort realpath; falls back to normalized input when missing. */
export async function canonicalPath(p: string): Promise<string> {
  try {
    const { realpath } = await import("node:fs/promises");
    return normalizePath(await realpath(p));
  } catch {
    const { resolve } = await import("node:path");
    return normalizePath(resolve(p));
  }
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

export async function loadStore(commonDir: string): Promise<WorktreeStore> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(storePath(commonDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<WorktreeStore>;
    if (!parsed || !Array.isArray(parsed.links)) return emptyStore();
    return {
      version: 1,
      links: parsed.links.filter(
        (l): l is WorktreeLink =>
          !!l && typeof (l as WorktreeLink).worktreePath === "string" && typeof (l as WorktreeLink).id === "string",
      ),
    };
  } catch {
    return emptyStore();
  }
}

/** Atomic write (tmp + rename) so concurrent pi sessions do not tear the file. */
export async function saveStore(commonDir: string, store: WorktreeStore): Promise<void> {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const dest = storePath(commonDir);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmp, dest);
}

export function upsertLink(store: WorktreeStore, link: WorktreeLink): WorktreeStore {
  const idx = store.links.findIndex((l) => l.id === link.id);
  const links = [...store.links];
  if (idx >= 0) links[idx] = link;
  else links.push(link);
  return { version: 1, links };
}

export function findByWorktree(store: WorktreeStore, worktreePath: string): WorktreeLink | undefined {
  const want = normalizePath(worktreePath);
  return store.links.find((l) => normalizePath(l.worktreePath) === want);
}

export function activeLinkFor(store: WorktreeStore, worktreePath: string): WorktreeLink | undefined {
  const link = findByWorktree(store, worktreePath);
  return link && link.status === "active" ? link : undefined;
}

export function childrenOf(store: WorktreeStore, originPath: string): WorktreeLink[] {
  const want = normalizePath(originPath);
  return store.links.filter((l) => normalizePath(l.originPath) === want && l.status === "active");
}

export function markLanded(
  store: WorktreeStore,
  id: string,
  patch: Partial<Pick<WorktreeLink, "status" | "landedAt" | "landStrategy" | "landSha">>,
): WorktreeStore {
  return {
    version: 1,
    links: store.links.map((l) => (l.id === id ? { ...l, ...patch } : l)),
  };
}

/**
 * Session exclusivity: a worktree belongs to the session that created it.
 * Returns the link when it is owned by a *different* live session, else undefined.
 * Unowned legacy links (no sessionId) and the owner's own links are free to land.
 * Standing inside the worktree itself also passes (physical possession — e.g. a
 * fresh session after `cd` into it), so the cd-and-land flow keeps working.
 */
export function foreignOwnerOf(
  link: WorktreeLink | undefined,
  me: string | null | undefined,
  herePath: string,
): WorktreeLink | undefined {
  if (!link || link.status !== "active") return undefined;
  if (!link.sessionId || !me || link.sessionId === me) return undefined;
  if (samePath(herePath, link.worktreePath)) return undefined;
  return link;
}

/** Short human label for an owner: `(you)`, `(“name”)`, `(session abc12345)`, or `""` when unowned. */
export function ownerLabel(link: WorktreeLink, me: string | null | undefined): string {
  if (!link.sessionId) return "";
  if (me && link.sessionId === me) return "(you)";
  if (link.sessionName) return `("${link.sessionName}")`;
  return `(session ${link.sessionId.slice(0, 8)})`;
}

/** Widget/status visibility: own links plus unowned legacy links (claimable by
 *  anyone). Foreign-owned links stay out of the glanceable chrome — they still
 *  appear in `/worktree status` and the model policy, so parallel work is not
 *  invisible where it matters. */
export function visibleKidsFor(
  kids: WorktreeLink[],
  me: string | null | undefined,
  herePath: string,
): WorktreeLink[] {
  return kids.filter((k) => !foreignOwnerOf(k, me, herePath));
}

/** The session's single active worktree for an origin, if any.
 *  One session owns at most one worktree per repo — creation is blocked
 *  while this returns a link (land it first). */
export function ownActiveLink(
  store: WorktreeStore,
  originPath: string,
  me: string | null | undefined,
): WorktreeLink | undefined {
  if (!me) return undefined;
  return childrenOf(store, originPath).find((l) => l.sessionId === me);
}

/** Display order for the origin widget: own links first, then the rest. */
export function orderKidsForDisplay(
  kids: WorktreeLink[],
  me: string | null | undefined,
): WorktreeLink[] {
  return [...kids].sort((a, b) => {
    const am = me && a.sessionId === me ? 0 : 1;
    const bm = me && b.sessionId === me ? 0 : 1;
    return am - bm;
  });
}

export function makeId(): string {  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `wt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
