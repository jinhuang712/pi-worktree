/**
 * pi-worktree linkage store.
 *
 * Session entries alone are not enough: after `/worktree` the user typically
 * `cd`s into the new worktree and starts a fresh pi session with a different
 * cwd/session file. Small JSON files in the shared git dir keep the
 * origin <-> worktree mapping discoverable from either side.
 *
 * Layout: `<git-common-dir>/pi-worktree/<link-id>.json`, one file per link.
 * Parallel sessions only ever write their own link file, so a stale in-memory
 * snapshot in one session can never clobber another session's link — the
 * classic load-modify-save race of a single shared JSON file is gone.
 * The legacy single-file store (`pi-worktree.json`) is migrated on first load.
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
  /** Session name snapshot at create time, for human-readable owner labels
   *  and for restoring the name after land/abandon. */
  sessionName?: string | null;
  /** What the worktree is for — drives the land commit message. */
  task?: string | null;
  landedAt?: number;
  landStrategy?: string;
  landSha?: string | null;
  /** True when the worktree was discarded instead of landed. */
  abandoned?: boolean;
}

export interface WorktreeStore {
  version: 1;
  links: WorktreeLink[];
}

export const STORE_FILE = "pi-worktree.json";
export const STORE_DIR = "pi-worktree";

export function storePath(commonDir: string): string {
  return `${commonDir.replace(/\/+$/, "")}/${STORE_FILE}`;
}

export function storeDir(commonDir: string): string {
  return `${commonDir.replace(/\/+$/, "")}/${STORE_DIR}`;
}

function linkPath(commonDir: string, id: string): string {
  return `${storeDir(commonDir)}/${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
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

/** True when `p` is `root` or lives under it. */
export function isInside(p: string, root: string): boolean {
  const a = normalizePath(p);
  const r = normalizePath(root);
  return a === r || a.startsWith(r === "/" ? "/" : `${r}/`);
}

function isLink(l: unknown): l is WorktreeLink {
  return !!l
    && typeof (l as WorktreeLink).worktreePath === "string"
    && typeof (l as WorktreeLink).id === "string";
}

async function readLegacy(commonDir: string): Promise<WorktreeLink[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(storePath(commonDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<WorktreeStore>;
    return Array.isArray(parsed?.links) ? parsed.links.filter(isLink) : [];
  } catch {
    return [];
  }
}

async function readDir(commonDir: string): Promise<WorktreeLink[]> {
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = storeDir(commonDir);
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    const out: WorktreeLink[] = [];
    for (const n of names) {
      try {
        const parsed = JSON.parse(await readFile(`${dir}/${n}`, "utf8"));
        if (isLink(parsed)) out.push(parsed);
      } catch {
        // Corrupt file: skip, never fail the whole store.
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function writeJsonAtomic(dest: string, value: unknown): Promise<void> {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, dest);
}

/**
 * Load every link. Per-link files win; a legacy single-file store is merged
 * in and migrated to per-link files (then renamed aside) so it is read once.
 */
export async function loadStore(commonDir: string): Promise<WorktreeStore> {
  const files = await readDir(commonDir);
  const legacy = await readLegacy(commonDir);
  const seen = new Set(files.map((l) => l.id));
  const fresh = legacy.filter((l) => !seen.has(l.id));
  if (fresh.length > 0) {
    try {
      for (const l of fresh) await writeJsonAtomic(linkPath(commonDir, l.id), l);
      const { rename } = await import("node:fs/promises");
      await rename(storePath(commonDir), `${storePath(commonDir)}.migrated`);
    } catch {
      // Migration is best-effort; the legacy file stays readable.
    }
  }
  const links = [...files, ...fresh].sort((a, b) => a.createdAt - b.createdAt);
  return { version: 1, links };
}

/** Persist one link. This is the only write path sessions should use for
 *  their own links — it never touches other links on disk. */
export async function saveLink(commonDir: string, link: WorktreeLink): Promise<void> {
  await writeJsonAtomic(linkPath(commonDir, link.id), link);
}

/** Persist every link in `store` (per-link files). Prefer saveLink for
 *  single mutations; this exists for tests and bulk repair. */
export async function saveStore(commonDir: string, store: WorktreeStore): Promise<void> {
  for (const l of store.links) await saveLink(commonDir, l);
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
  patch: Partial<Pick<WorktreeLink, "status" | "landedAt" | "landStrategy" | "landSha" | "abandoned">>,
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

/**
 * Global preferences shared across repos — e.g. the /land strategy the user
 * picked the one time they were asked. Lives under the pi data dir (outside
 * any repo) so it applies everywhere. Missing/corrupt file = no preferences.
 * All IO is best-effort: failures resolve to `{}` / no-op, never throw.
 */
export interface GlobalPrefs {
  defaultStrategy?: string;
}

export const STRATEGIES = ["rebase", "merge", "squash"] as const;

export function prefsPath(homeDir?: string): string {
  const home = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return `${normalizePath(home)}/.pi/agent/pi-worktree/config.json`;
}

export function validStrategy(s: unknown): s is (typeof STRATEGIES)[number] {
  return typeof s === "string" && (STRATEGIES as readonly string[]).includes(s);
}

export async function loadPrefs(homeDir?: string): Promise<GlobalPrefs> {
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(prefsPath(homeDir), "utf8")) as GlobalPrefs;
    if (parsed && typeof parsed === "object" && (parsed.defaultStrategy === undefined || validStrategy(parsed.defaultStrategy))) {
      return parsed.defaultStrategy === undefined ? {} : { defaultStrategy: parsed.defaultStrategy };
    }
  } catch {
    // Missing/corrupt = no preferences.
  }
  return {};
}

export async function savePrefs(prefs: GlobalPrefs, homeDir?: string): Promise<void> {
  try {
    await writeJsonAtomic(prefsPath(homeDir), prefs);
  } catch {
    // Preference persistence is advisory; the run continues with the choice.
  }
}

/** Widget/status visibility: own links plus unowned legacy links (claimable by
 *  anyone). Foreign-owned links stay out of the glanceable chrome — they still
 *  appear in worktree_status and the model policy, so parallel work is not
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

export function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `wt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
