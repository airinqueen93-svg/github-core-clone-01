// store.ts — the forge's domain state: users, repositories (with their git object stores and refs),
// issues, pull requests, labels and comments, plus the operations every surface shares (contents
// commits, three-way tree merges, pull-request file diffs). Everything lives in memory; the trial
// is one process and determinism beats durability here.

import {
  ObjectStore,
  buildCommit,
  buildTreeFromFlat,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  peelToCommit,
  ZERO_OID,
} from './gitobj.ts';

export interface UserRec {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  nodeDbId: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
  /** Memoized REST body for GET-one-issue (app.ts), keyed by a fingerprint of every field it reads. */
  restCache?: { key: string; buf: Buffer };
}

export interface PullRec {
  nodeDbId: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  store: ObjectStore;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
}

/** The whole forge: one state object created per server. */
export class Forge {
  readonly users = new Map<string, UserRec>();
  readonly repos = new Map<string, RepoRec>();
  viewerLogin = 'adaiversen';
  private nextRepoId = 5000;
  private nextNodeDbId = 100000;
  private nextLabelId = 3000;
  private nextCommentId = 200000;
  private lastMs = 0;
  /** Cache for now(): the ISO prefix through the seconds field ('…T HH:mm:ss.') of isoSecond. */
  private isoSecond = -1;
  private isoPrefix = '';

  constructor() {
    const seed: UserRec[] = [
      { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' },
      { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' },
      { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' },
      { id: 2000, login: 'faint-meadow-org', name: 'faint-meadow-org', email: 'faint-meadow-org@example.invalid', type: 'Organization' },
    ];
    for (const user of seed) this.users.set(user.login.toLowerCase(), user);
  }

  /** A strictly increasing ISO timestamp, so created_at ordering never ties ambiguously. */
  now(): string {
    const nowMs = Date.now();
    this.lastMs = nowMs > this.lastMs ? nowMs : this.lastMs + 1;
    // Within one second, toISOString's output differs only in the 3 millisecond digits before
    // the final 'Z' (the fraction is always exactly 3 digits), so reuse the prefix computed
    // for that second and substitute the digits: byte-identical to a fresh toISOString().
    const second = Math.floor(this.lastMs / 1000);
    if (second !== this.isoSecond) {
      const iso = new Date(this.lastMs).toISOString();
      this.isoSecond = second;
      // Only the canonical 24-char layout ('YYYY-MM-DDTHH:mm:ss.sssZ') has its millisecond
      // digits at a fixed offset; anything else (expanded years) skips the cache entirely.
      this.isoPrefix = iso.length === 24 ? iso.slice(0, 20) : '';
      return iso;
    }
    if (this.isoPrefix === '') return new Date(this.lastMs).toISOString();
    const rem = this.lastMs - second * 1000;
    return `${this.isoPrefix}${rem < 10 ? '00' : rem < 100 ? '0' : ''}${rem}Z`;
  }

  nowEpoch(): number {
    return Math.floor(Date.parse(this.now()) / 1000);
  }

  user(login: string): UserRec | undefined {
    return this.users.get(login.toLowerCase());
  }

  viewer(): UserRec {
    return this.user(this.viewerLogin) ?? this.users.get('adaiversen')!;
  }

  /** Adopt `login` as the viewer when it names a known user (never an organization). */
  bindViewer(login: string): void {
    const rec = this.user(login);
    if (rec !== undefined && rec.type === 'User') this.viewerLogin = rec.login;
  }

  ensureOrg(login: string): UserRec {
    const existing = this.user(login);
    if (existing !== undefined) return existing;
    const rec: UserRec = { id: 2000 + this.users.size, login, name: login, email: `${login}@example.invalid`, type: 'Organization' };
    this.users.set(login.toLowerCase(), rec);
    return rec;
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  repo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Find a repo by name alone when exactly one owner holds it (used by the git-path rebind). */
  repoByName(name: string): RepoRec | undefined {
    let found: RepoRec | undefined;
    for (const repo of this.repos.values()) {
      if (repo.name.toLowerCase() === name.toLowerCase()) {
        if (found !== undefined) return undefined;
        found = repo;
      }
    }
    return found;
  }

  createRepo(owner: string, name: string, options: { isPrivate?: boolean; description?: string | null; defaultBranch?: string }): RepoRec {
    const stamp = this.now();
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner,
      name,
      isPrivate: options.isPrivate ?? false,
      description: options.description ?? null,
      defaultBranch: options.defaultBranch !== undefined && options.defaultBranch !== '' ? options.defaultBranch : 'main',
      createdAt: stamp,
      updatedAt: stamp,
      store: new ObjectStore(),
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
    };
    this.nextRepoId += 1;
    // Labels start empty: the suite creates the labels it uses, and a duplicate create must 422.
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  renameRepo(repo: RepoRec, newOwner: string, newName: string): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    repo.owner = newOwner;
    repo.name = newName;
    repo.updatedAt = this.now();
    this.repos.set(this.repoKey(newOwner, newName), repo);
  }

  allocNodeDbId(): number {
    const id = this.nextNodeDbId;
    this.nextNodeDbId += 1;
    return id;
  }

  allocLabelId(): number {
    const id = this.nextLabelId;
    this.nextLabelId += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  /** The ref a repo's HEAD points at: the default branch, born or not. */
  headRef(repo: RepoRec): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  identLine(user: UserRec): string {
    return `${user.name} <${user.email}> ${this.nowEpoch()} +0000`;
  }

  /** Create a commit on top of `parent` (or a root commit) authored by the viewer; returns its oid. */
  makeCommit(repo: RepoRec, tree: string, parents: readonly string[], message: string): string {
    const ident = this.identLine(this.viewer());
    return repo.store.put('commit', buildCommit({ tree, parents, author: ident, committer: ident, message }));
  }

  /**
   * The contents API as a commit: set or delete one path on a branch and commit the result.
   * Returns the new commit oid, or null when the branch state forbids it (handled by callers).
   */
  commitContentChange(
    repo: RepoRec,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commit: string; blobSha: string | null } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const flat = tip !== undefined
      ? flattenTree(repo.store, parseCommit(repo.store.get(tip)!.data).tree)
      : new Map<string, { oid: string; mode: string }>();
    let blobSha: string | null = null;
    if (content !== null) {
      blobSha = repo.store.put('blob', content);
      const existing = flat.get(path);
      flat.set(path, { oid: blobSha, mode: existing?.mode ?? '100644' });
    } else {
      flat.delete(path);
    }
    const tree = buildTreeFromFlat(repo.store, flat);
    const commit = this.makeCommit(repo, tree, tip !== undefined ? [tip] : [], message);
    repo.refs.set(ref, commit);
    repo.updatedAt = this.now();
    return { commit, blobSha };
  }

  /** The blob oid at `path` on `branch`, or undefined. */
  blobAt(repo: RepoRec, branch: string, path: string): string | undefined {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return undefined;
    const commit = repo.store.get(tip);
    if (commit === undefined) return undefined;
    return flattenTree(repo.store, parseCommit(commit.data).tree).get(path)?.oid;
  }

  /** Directory listing of `path` ('' = root) at a commit's tree; null when the path is not a directory. */
  listTree(repo: RepoRec, treeOid: string, path: string): { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }[] | null {
    // Walk to the target subtree.
    let current = treeOid;
    if (path !== '') {
      for (const part of path.split('/')) {
        const tree = repo.store.get(current);
        if (tree === undefined || tree.type !== 'tree') return null;
        const entry = parseTreeEntries(repo, current).find((e) => e.name === part);
        if (entry === undefined || !(entry.mode === '40000' || entry.mode === '040000')) return null;
        current = entry.oid;
      }
    }
    const tree = repo.store.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const prefix = path === '' ? '' : `${path}/`;
    return parseTreeEntries(repo, current).map((entry) => {
      const isDir = entry.mode === '40000' || entry.mode === '040000';
      const blob = isDir ? undefined : repo.store.get(entry.oid);
      return {
        type: isDir ? ('dir' as const) : ('file' as const),
        name: entry.name,
        path: `${prefix}${entry.name}`,
        sha: entry.oid,
        size: blob !== undefined ? blob.data.length : 0,
      };
    });
  }
}

import { parseTree, type TreeEntry } from './gitobj.ts';

function parseTreeEntries(repo: RepoRec, treeOid: string): TreeEntry[] {
  const tree = repo.store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return [];
  return parseTree(tree.data);
}

// -------------------------------------------------------------------------------------------------
// Pull request machinery: three-way tree merge, mergeability, file diffs
// -------------------------------------------------------------------------------------------------

export interface MergeOutcome {
  ok: boolean;
  tree?: string;
  conflicts: string[];
}

/** A file-level three-way merge of flattened trees. Both-sides-changed-differently is a conflict. */
export function mergeTrees(
  store: ObjectStore,
  baseFlat: ReadonlyMap<string, { oid: string; mode: string }>,
  headFlat: ReadonlyMap<string, { oid: string; mode: string }>,
  ancestorFlat: ReadonlyMap<string, { oid: string; mode: string }>,
): MergeOutcome {
  const merged = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...ancestorFlat.keys()]);
  for (const path of paths) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    const anc = ancestorFlat.get(path);
    const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
      x?.oid === y?.oid && x?.mode === y?.mode;
    if (same(head, base)) {
      if (base !== undefined) merged.set(path, base);
    } else if (same(anc, head)) {
      if (base !== undefined) merged.set(path, base);
    } else if (same(anc, base)) {
      if (head !== undefined) merged.set(path, head);
    } else if (same(head, anc)) {
      if (base !== undefined) merged.set(path, base);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, tree: buildTreeFromFlat(store, merged), conflicts: [] };
}

export interface PullSides {
  baseTip: string;
  headTip: string;
  baseCommit: string;
  mergeBaseOid: string | null;
}

/** Resolve a pull's branch tips to commits and their merge base. */
export function pullSides(repo: RepoRec, pull: PullRec): PullSides | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return null;
  const baseCommit = peelToCommit(repo.store, baseTip);
  const headCommit = peelToCommit(repo.store, headTip);
  if (baseCommit === null || headCommit === null) return null;
  return {
    baseTip: baseCommit,
    headTip: headCommit,
    baseCommit,
    mergeBaseOid: mergeBase(repo.store, baseCommit, headCommit),
  };
}

function flatAtCommit(repo: RepoRec, commitOid: string | null): Map<string, { oid: string; mode: string }> {
  if (commitOid === null) return new Map();
  const commit = repo.store.get(commitOid);
  if (commit === undefined) return new Map();
  return flattenTree(repo.store, parseCommit(commit.data).tree);
}

/** Mergeable = a merge base exists, head is not already fully contained, and the tree merge is clean. */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const sides = pullSides(repo, pull);
  if (sides === null || sides.mergeBaseOid === null) return false;
  if (sides.mergeBaseOid === sides.headTip) return false; // nothing to merge
  const outcome = mergeTrees(
    repo.store,
    flatAtCommit(repo, sides.baseTip),
    flatAtCommit(repo, sides.headTip),
    flatAtCommit(repo, sides.mergeBaseOid),
  );
  return outcome.ok;
}

/** Perform the merge: a merge commit on the base branch. Returns its oid, or null on conflict. */
export function mergePull(forge: Forge, repo: RepoRec, pull: PullRec, method: 'merge' | 'squash'): string | null {
  const sides = pullSides(repo, pull);
  if (sides === null || sides.mergeBaseOid === null) return null;
  const outcome = mergeTrees(
    repo.store,
    flatAtCommit(repo, sides.baseTip),
    flatAtCommit(repo, sides.headTip),
    flatAtCommit(repo, sides.mergeBaseOid),
  );
  if (!outcome.ok || outcome.tree === undefined) return null;
  const ident = forge.identLine(forge.viewer());
  let commit: string;
  if (method === 'squash') {
    commit = repo.store.put('commit', buildCommit({
      tree: outcome.tree,
      parents: [sides.baseTip],
      author: ident,
      committer: ident,
      message: `${pull.title} (#${pull.number})`,
    }));
  } else {
    commit = repo.store.put('commit', buildCommit({
      tree: outcome.tree,
      parents: [sides.baseTip, sides.headTip],
      author: ident,
      committer: ident,
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
    }));
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  repo.updatedAt = forge.now();
  return commit;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  sha: string | null;
}

/** The pull's changed files: merge-base tree vs head tree, with LCS line counts. */
export function pullFiles(repo: RepoRec, pull: PullRec): FileDiff[] {
  const sides = pullSides(repo, pull);
  if (sides === null) return [];
  const fromFlat = flatAtCommit(repo, sides.mergeBaseOid ?? sides.baseTip);
  const toFlat = flatAtCommit(repo, sides.headTip);
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  const diffs: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from?.oid === to?.oid && from?.mode === to?.mode) continue;
    const fromText = from !== undefined ? repo.store.get(from.oid)?.data.toString('utf8') ?? '' : '';
    const toText = to !== undefined ? repo.store.get(to.oid)?.data.toString('utf8') ?? '' : '';
    const { additions, deletions } = lineDiffCounts(fromText, toText);
    diffs.push({
      filename: path,
      status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      sha: to?.oid ?? null,
    });
  }
  return diffs;
}

/** LCS-based line diff counts (files in this world are small; the DP table is fine). */
export function lineDiffCounts(before: string, after: string): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Trim common prefix/suffix to keep the table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0) return { additions: midB.length, deletions: 0 };
  if (midB.length === 0) return { additions: 0, deletions: midA.length };
  const rows = midA.length;
  const cols = midB.length;
  const dp = new Uint32Array((rows + 1) * (cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i * (cols + 1) + j] = midA[i] === midB[j]
        ? dp[(i + 1) * (cols + 1) + j + 1]! + 1
        : Math.max(dp[(i + 1) * (cols + 1) + j]!, dp[i * (cols + 1) + j + 1]!);
    }
  }
  const common = dp[0]!;
  return { additions: midB.length - common, deletions: midA.length - common };
}

export { ZERO_OID, isAncestor };
