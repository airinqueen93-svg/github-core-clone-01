// gitobj.ts — a pure-TypeScript git object store: SHA-1 addressing, pack read/write with delta
// resolution, tree/commit parsing and rebuilding, ancestry and reachability walks. Node stdlib only
// (node:crypto for SHA-1, node:zlib for (de)compression); no git binary is ever invoked.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(type: GitObjectType, data: Buffer): string {
  // Streaming hash of header‖data: SHA-1 is a streaming digest, so update(header).update(data)
  // hashes exactly the bytes the old Buffer.concat([header, data]) path hashed — same oid, one
  // less allocation and no copy of `data`.
  return createHash('sha1').update(`${type} ${data.length}\0`, 'utf8').update(data).digest('hex');
}

/** One repository's object database: oid -> raw (inflated) object. */
export class ObjectStore {
  readonly objects = new Map<string, { type: GitObjectType; data: Buffer }>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): { type: GitObjectType; data: Buffer } | undefined {
    return this.objects.get(oid);
  }

  /** Store an object whose bytes are already known; returns its oid. */
  put(type: GitObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object under a caller-known oid (pack ingest: the oid is computed, but stay explicit). */
  putWithId(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }
}

// -------------------------------------------------------------------------------------------------
// Pack reading
// -------------------------------------------------------------------------------------------------

/** Adler-32 of `data` (the checksum every zlib stream ends with), as one unsigned 32-bit number. */
function adler32(data: Buffer): number {
  const MOD = 65521;
  const NMAX = 5552; // longest run before the sums are reduced (the classic zlib bound)
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + NMAX, data.length);
    for (; i < end; i += 1) {
      a += data[i]!;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

const PACK_TYPE_CODES: ReadonlySet<number> = new Set([1, 2, 3, 4, 6, 7]);

/**
 * Inflate one zlib stream whose inflated size is known, starting the scan at `offset`. Returns the
 * inflated bytes and the offset just past the stream.
 *
 * Fast path: Node's sync inflate stops at the stream's end and ignores trailing bytes, so one call
 * on the rest of the pack inflates exactly this entry. The stream's last four bytes are the
 * Adler-32 of the inflated bytes, so scanning for that trailer locates the entry's end; a
 * candidate end is accepted only when what follows is the pack trailer (the final entry) or a
 * plausible next entry header. parsePackEntries additionally verifies the whole pack (entry count
 * consumed exactly, trailer SHA-1) and re-parses with the probing path when anything is off, so a
 * false trailer match can never slip through.
 */
function inflateEntry(buf: Buffer, offset: number, expectedSize: number, isLast = false): { data: Buffer; next: number } {
  try {
    const data = inflateSync(buf.subarray(offset));
    if (data.length === expectedSize) {
      // The pack's final entry ends exactly where the 20-byte trailer begins, so its end
      // needs no scan. A malformed pack is still caught by parsePackEntries' whole-pack
      // verification, which re-parses with the probing path on any mismatch.
      if (isLast) return { data, next: buf.length - 20 };
      const adler = adler32(data);
      const needle = Buffer.from([(adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff]);
      // The trailer sits at least 2 header bytes + 1 deflate byte into the stream.
      let from = offset + 3;
      while (from < buf.length) {
        const idx = buf.indexOf(needle, from);
        if (idx === -1) break;
        const next = idx + 4;
        if (next === buf.length - 20) return { data, next };
        const head = buf[next];
        if (head !== undefined && PACK_TYPE_CODES.has((head >> 4) & 0x7)) return { data, next };
        from = idx + 1;
      }
    }
  } catch {
    // Corrupt stream: the probing path below raises the proper error.
  }
  return inflateEntryProbed(buf, offset, expectedSize);
}

/**
 * The original probing inflate: Node's sync inflate ignores trailing bytes, so the exact end is
 * found by bisecting for the shortest prefix that still inflates completely. Kept as the fallback
 * for packs the fast path cannot place, and as the error source for corrupt streams.
 */
function inflateEntryProbed(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  let lo = offset; // known too short (or the start)
  let hi = Math.min(buf.length, offset + Math.max(64, expectedSize * 2 + 64));
  let data: Buffer | null = null;
  // Grow until a slice inflates to exactly the declared size.
  for (;;) {
    try {
      const out = inflateSync(buf.subarray(offset, hi));
      if (out.length === expectedSize) {
        data = out;
        break;
      }
      if (out.length > expectedSize) throw new Error('pack entry inflated past its declared size');
    } catch (err) {
      if (err instanceof Error && err.message.includes('declared size')) throw err;
      // truncated or corrupt: grow if possible
    }
    if (hi >= buf.length) throw new Error('pack entry does not inflate');
    lo = hi;
    hi = Math.min(buf.length, hi + Math.max(1024, (hi - offset) * 2));
  }
  // Bisect [lo, hi) for the shortest prefix that inflates to the full output.
  let low = lo;
  let high = hi;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    let ok = false;
    try {
      const out = inflateSync(buf.subarray(offset, mid));
      ok = out.length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) high = mid;
    else low = mid;
  }
  return { data, next: high };
}

interface PackEntry {
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  entryOffset: number;
}

type InflateFn = (buf: Buffer, offset: number, expectedSize: number, isLast?: boolean) => { data: Buffer; next: number };

/**
 * Parse a pack's entries with the given entry inflate, returning the entries and the offset just
 * past the last one (where the 20-byte trailer sits in a well-formed pack).
 */
function parsePackEntriesPass(pack: Buffer, inflate: InflateFn): { entries: PackEntry[]; endOffset: number } {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('latin1') !== 'PACK') {
    throw new Error('not a pack file');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = CODE_TYPES[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    if (type === 'ofs-delta') {
      let b = pack[offset]!;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      const { data, next } = inflate(pack, offset, size, i === count - 1);
      offset = next;
      entries.push({ type, data, baseOffset: entryOffset - back, entryOffset });
    } else if (type === 'ref-delta') {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, next } = inflate(pack, offset, size, i === count - 1);
      offset = next;
      entries.push({ type, data, baseOid, entryOffset });
    } else {
      const { data, next } = inflate(pack, offset, size, i === count - 1);
      offset = next;
      entries.push({ type, data, entryOffset });
    }
  }
  return { entries, endOffset: offset };
}

/**
 * Parse a pack's entries. The fast inflate's boundaries are verified against the pack as a
 * whole — the entries must end exactly where the trailer begins and the trailer must be the
 * SHA-1 of everything before it — and any doubt re-parses with the probing inflate, whose
 * boundaries are exact by construction (and which throws for genuinely corrupt packs).
 */
function parsePackEntries(pack: Buffer): PackEntry[] {
  let fast: { entries: PackEntry[]; endOffset: number } | null = null;
  try {
    fast = parsePackEntriesPass(pack, inflateEntry);
  } catch {
    fast = null;
  }
  if (fast !== null) {
    const trailerStart = pack.length - 20;
    const verified = fast.endOffset === trailerStart
      && createHash('sha1').update(pack.subarray(0, trailerStart)).digest().equals(pack.subarray(trailerStart));
    if (verified) return fast.entries;
  }
  return parsePackEntriesPass(pack, inflateEntryProbed).entries;
}

/** Apply a git delta buffer to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos]!;
      pos += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[pos]!; pos += 1; }
      if (op & 0x02) { copyOffset |= delta[pos]! << 8; pos += 1; }
      if (op & 0x04) { copyOffset |= delta[pos]! << 16; pos += 1; }
      if (op & 0x08) { copyOffset |= delta[pos]! << 24; pos += 1; }
      if (op & 0x10) { copySize = delta[pos]!; pos += 1; }
      if (op & 0x20) { copySize |= delta[pos]! << 8; pos += 1; }
      if (op & 0x40) { copySize |= delta[pos]! << 16; pos += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Ingest a pack into the store, resolving deltas against pack-mates and (for thin packs) objects
 * already in the store. Returns the number of objects the pack carried.
 */
export function ingestPack(store: ObjectStore, pack: Buffer): number {
  const entries = parsePackEntries(pack);
  // Packs without deltas (the common case: every push the suite makes) need no resolution
  // machinery — hash each entry and store it directly.
  if (!entries.some((entry) => entry.type === 'ofs-delta' || entry.type === 'ref-delta')) {
    for (const entry of entries) {
      store.putWithId(objectId(entry.type as GitObjectType, entry.data), entry.type as GitObjectType, entry.data);
    }
    return entries.length;
  }
  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.entryOffset, entry);
  // Non-delta entries by oid, for ref-delta bases inside the pack; built lazily on first use so
  // packs without ref-deltas never pay for the hashing.
  let byOid: Map<string, PackEntry> | null = null;
  const findInPack = (oid: string): PackEntry | undefined => {
    if (byOid === null) {
      byOid = new Map();
      for (const entry of entries) {
        if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') byOid.set(objectId(entry.type, entry.data), entry);
      }
    }
    return byOid.get(oid);
  };
  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();

  const resolve = (entry: PackEntry, depth: number): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.entryOffset);
    if (cached !== undefined) return cached;
    if (depth > 512) throw new Error('delta chain too deep');
    let out: { type: GitObjectType; data: Buffer; oid: string };
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: { type: GitObjectType; data: Buffer };
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing from pack');
        base = resolve(baseEntry, depth + 1);
      } else {
        const baseOid = entry.baseOid!;
        const inPack = findInPack(baseOid);
        if (inPack !== undefined) {
          base = resolve(inPack, depth + 1);
        } else {
          const existing = store.get(baseOid);
          if (existing === undefined) throw new Error(`ref-delta base ${baseOid} is unknown`);
          base = existing;
        }
      }
      const data = applyDelta(base.data, entry.data);
      out = { type: base.type, data, oid: objectId(base.type, data) };
    } else {
      out = { type: entry.type, data: entry.data, oid: objectId(entry.type, entry.data) };
    }
    resolved.set(entry.entryOffset, out);
    return out;
  };

  for (const entry of entries) {
    const obj = resolve(entry, 0);
    store.putWithId(obj.oid, obj.type, obj.data);
  }
  return entries.length;
}

// -------------------------------------------------------------------------------------------------
// Pack writing (plain objects, no deltas — always self-contained, thin-pack safe)
// -------------------------------------------------------------------------------------------------

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: readonly { type: GitObjectType; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------------
// Commits and trees
// -------------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** Parse an identity line "Name <email> 1700000000 +0000" into parts (best effort). */
export function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (match === null) return { name: line.trim(), email: '', date: new Date(0).toISOString() };
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.subarray(pos, space).toString('latin1');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> blob entry. Missing trees flatten to nothing. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Rebuild nested trees from a flat path map; returns the root tree oid (empty tree when no files). */
export function buildTreeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, blob] of flat) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i]!;
      let next = dir.dirs.get(name);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push({ mode: blob.mode, name: parts[parts.length - 1]!, oid: blob.oid });
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [...dir.files];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

/** The tag's target oid and type, for peeling. */
export function parseTag(data: Buffer): { target: string; type: string } {
  const text = data.toString('utf8');
  let target = ZERO_OID;
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) target = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { target, type };
}

/** Peel an oid through tag objects to the first non-tag object; returns null if anything is missing. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = store.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).target;
      continue;
    }
    return null;
  }
  return null;
}

/** Peel one tag level for ls-refs ^{} lines: the oid a tag points at (through nested tags to any object). */
export function peelTagOnce(store: ObjectStore, oid: string): string | null {
  const obj = store.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  return parseTag(obj.data).target;
}

// -------------------------------------------------------------------------------------------------
// Graph walks
// -------------------------------------------------------------------------------------------------

export function commitParents(store: ObjectStore, oid: string): string[] {
  const obj = store.get(oid);
  if (obj === undefined || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

/** True when `ancestor` is reachable from `descendant` through commit parents (inclusive). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const parent of commitParents(store, current)) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** All commits reachable from the given tips (full ancestry), as a set. */
export function reachableCommits(store: ObjectStore, tips: readonly string[], stopAt?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (store.get(tip)?.type === 'commit' && !out.has(tip)) {
      out.add(tip);
      queue.push(tip);
    }
  }
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (stopAt !== undefined && stopAt.has(current) && !tips.includes(current)) continue;
    for (const parent of commitParents(store, current)) {
      if (!out.has(parent) && store.get(parent)?.type === 'commit') {
        out.add(parent);
        queue.push(parent);
      }
    }
  }
  return out;
}

/** A merge base of two commits: a common ancestor minimizing summed BFS distance, or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const distA = new Map<string, number>([[a, 0]]);
  const distB = new Map<string, number>([[b, 0]]);
  const bfs = (dist: Map<string, number>): void => {
    const queue = [...dist.keys()];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const d = dist.get(current)!;
      for (const parent of commitParents(store, current)) {
        if (!dist.has(parent) && store.get(parent)?.type === 'commit') {
          dist.set(parent, d + 1);
          queue.push(parent);
        }
      }
    }
  };
  bfs(distA);
  bfs(distB);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, da] of distA) {
    const db = distB.get(oid);
    if (db !== undefined && da + db < bestScore) {
      bestScore = da + db;
      best = oid;
    }
  }
  return best;
}

/**
 * Collect the objects a fetch must send: everything reachable from `wants`, minus everything
 * reachable from `haveTips` (whose ancestry stops at `shallowBoundary` commits, which the client
 * holds without their parents). When `depth` is set, commits deeper than `depth` generations from
 * a want are cut; the commits exactly at the boundary are returned in `shallowOut`, and previously
 * shallow commits whose parents are now included come back in `unshallowOut`.
 */
export function collectFetchObjects(
  store: ObjectStore,
  wants: readonly string[],
  haveTips: readonly string[],
  shallowBoundary: readonly string[],
  depth: number | null,
  deepenRelative = false,
): { objects: { type: GitObjectType; data: Buffer; oid: string }[]; shallowOut: string[]; unshallowOut: string[] } {
  const boundary = new Set(shallowBoundary);
  // What the client already has: full ancestry of have tips, but not past its shallow boundary.
  const haveCommits = new Set<string>();
  {
    const queue: string[] = [];
    for (const tip of haveTips) {
      if (store.get(tip)?.type === 'commit' && !haveCommits.has(tip)) {
        haveCommits.add(tip);
        queue.push(tip);
      }
    }
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (boundary.has(current)) continue; // the client holds this commit but none of its parents
      for (const parent of commitParents(store, current)) {
        if (!haveCommits.has(parent) && store.get(parent)?.type === 'commit') {
          haveCommits.add(parent);
          queue.push(parent);
        }
      }
    }
  }
  const haveObjects = new Set<string>();
  for (const commit of haveCommits) collectTreeObjects(store, commit, haveObjects, true);

  // BFS from wants with generation distances (want tips are generation 1).
  const distance = new Map<string, number>();
  const queue: string[] = [];
  const include = new Set<string>();
  const shallowOut = new Set<string>();
  if (depth !== null && deepenRelative) {
    // Relative deepen (real git's `deepen-relative`): the cut sits `depth` generations below the
    // client's current shallow boundary, not at an absolute depth from the wants. Track, per
    // commit, how many edges the best path has travelled since its last boundary commit.
    const below = new Map<string, number | null>();
    for (const want of wants) {
      const commit = peelToCommit(store, want);
      if (commit !== null && !distance.has(commit)) {
        distance.set(commit, 1);
        below.set(commit, boundary.has(commit) ? 0 : null);
        queue.push(commit);
      }
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      include.add(current);
      const currentBelow = below.get(current) ?? null;
      const parents = commitParents(store, current);
      for (const parent of parents) {
        if (store.get(parent)?.type !== 'commit') continue;
        let parentBelow: number | null;
        if (boundary.has(parent)) parentBelow = 0;
        else if (currentBelow !== null) parentBelow = currentBelow + 1;
        else parentBelow = null;
        if (parentBelow !== null && parentBelow > depth) {
          // The parent is past the deepened frontier: the current commit is the new boundary.
          shallowOut.add(current);
          continue;
        }
        const known = distance.get(parent);
        if (known === undefined) {
          distance.set(parent, distance.get(current)! + 1);
          below.set(parent, parentBelow);
          queue.push(parent);
        }
      }
    }
  } else {
    for (const want of wants) {
      const commit = peelToCommit(store, want);
      if (commit !== null && !distance.has(commit)) {
        distance.set(commit, 1);
        queue.push(commit);
      }
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      const d = distance.get(current)!;
      include.add(current);
      const parents = commitParents(store, current);
      if (depth !== null && d >= depth) {
        if (parents.length > 0) shallowOut.add(current);
        continue;
      }
      for (const parent of parents) {
        if (!distance.has(parent) && store.get(parent)?.type === 'commit') {
          distance.set(parent, d + 1);
          queue.push(parent);
        }
      }
    }
  }
  // Previously-shallow commits that are included and no longer at the cut boundary are unshallowed.
  const unshallowOut: string[] = [];
  for (const oid of boundary) {
    if (include.has(oid) && !shallowOut.has(oid)) unshallowOut.push(oid);
  }

  const send = new Map<string, { type: GitObjectType; data: Buffer; oid: string }>();
  const addObject = (oid: string): void => {
    if (send.has(oid) || haveObjects.has(oid)) return;
    const obj = store.get(oid);
    if (obj === undefined) return;
    send.set(oid, { type: obj.type, data: obj.data, oid });
  };
  // Tag objects named directly by wants/refs travel too.
  for (const want of wants) {
    const obj = store.get(want);
    if (obj !== undefined && obj.type === 'tag') addObject(want);
  }
  for (const commit of include) {
    if (haveCommits.has(commit)) continue; // already the client's; its trees are in haveObjects
    addObject(commit);
    const treeOid = parseCommit(store.get(commit)!.data).tree;
    const treeObjects = new Set<string>();
    collectTreeObjects(store, treeOid, treeObjects, false);
    for (const oid of treeObjects) addObject(oid);
  }
  return { objects: [...send.values()], shallowOut: [...shallowOut], unshallowOut };
}

/** Add a tree and everything under it to `out` (when `oid` is a commit, its tree is used). */
function collectTreeObjects(store: ObjectStore, oid: string, out: Set<string>, oidIsCommit: boolean): void {
  let treeOid = oid;
  if (oidIsCommit) {
    const commit = store.get(oid);
    if (commit === undefined || commit.type !== 'commit') return;
    treeOid = parseCommit(commit.data).tree;
  }
  const stack = [treeOid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (out.has(current)) continue;
    const obj = store.get(current);
    if (obj === undefined) continue;
    out.add(current);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
}
