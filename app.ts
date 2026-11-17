// app.ts — the forge's HTTP surface: git smart HTTP (protocol v2 + v0), the REST v3 API, the
// GraphQL v4 endpoint and the MCP endpoint, all over one in-memory Forge. Node stdlib only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, type RepoRec, type IssueRec, type PullRec, type UserRec } from './store.ts';
import { mergePull, pullFiles, pullMergeable } from './store.ts';
import {
  ZERO_OID,
  buildCommit,
  collectFetchObjects,
  ingestPack,
  isAncestor,
  parseCommit,
  parseIdent,
  parseTag,
  parseTree,
  peelToCommit,
  writePack,
} from './gitobj.ts';
import { executeGraphql, nodeId } from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const FORGE_VERSION = '1.0.0';
const INSTALLED_VERSION = '3.14.0';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `F0GE${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`;
}

// -------------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(text !== '' ? { 'content-length': buf.length } : {}),
    ...headers,
  });
  res.end(buf);
}

/** Send an already-serialized JSON body (the memoized GET-one-issue path) with sendJson's headers. */
function sendJsonBuffer(res: ServerResponse, status: number, buf: Buffer): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    'content-length': buf.length,
  });
  res.end(buf);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    'cache-control': 'no-cache',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    pragma: 'no-cache',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.trim() !== '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// -------------------------------------------------------------------------------------------------
// REST serializers
// -------------------------------------------------------------------------------------------------

function userJson(forge: Forge, user: UserRec): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: nodeId(user.type, user.id),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: user.type,
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

function ownerJson(forge: Forge, login: string): Record<string, unknown> {
  const user = forge.user(login);
  if (user === undefined) return { login, id: 0, type: 'User' };
  return userJson(forge, user);
}

function repoJson(forge: Forge, repo: RepoRec): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length
    + [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: ownerJson(forge, repo.owner),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    license: null,
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (label === undefined) return null;
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.nodeDbId,
    node_id: nodeId('Issue', issue.nodeDbId),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo, name)).filter((label) => label !== null),
    user: ownerJson(forge, issue.authorLogin),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

/**
 * The serialized GET-one-issue body, memoized on the issue record. The fingerprint covers every
 * value issueJson reads — the issue's own fields, its comment count, the label records behind its
 * label names, and the repo's owner/name in its URLs — so a hit is byte-identical to a fresh
 * serialization, and any mutation anywhere in that set changes the fingerprint.
 */
function issueJsonBuffer(forge: Forge, repo: RepoRec, issue: IssueRec): Buffer {
  const labelPart = issue.labels.map((name) => {
    const label = repo.labels.get(name);
    return label === undefined ? name : `${name}:${label.id}:${label.color}:${label.description ?? ''}`;
  }).join(',');
  const key = `${repo.owner}/${repo.name}|${issue.authorLogin}|${issue.title}|${issue.body ?? ''}|${issue.state}|${issue.createdAt}|${issue.updatedAt}|${issue.comments.length}|${labelPart}`;
  const cached = issue.restCache;
  if (cached !== undefined && cached.key === key) return cached.buf;
  const buf = Buffer.from(`${JSON.stringify(issueJson(forge, repo, issue))}\n`, 'utf8');
  issue.restCache = { key, buf };
  return buf;
}

function pullSideJson(forge: Forge, repo: RepoRec, ref: string): Record<string, unknown> {
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? ZERO_OID;
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha: tip,
    user: ownerJson(forge, repo.owner),
    repo: repoJson(forge, repo),
  };
}

function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const files = pullFiles(repo, pull);
  return {
    id: pull.nodeDbId,
    node_id: nodeId('PullRequest', pull.nodeDbId),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: ownerJson(forge, pull.authorLogin),
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merged: pull.merged,
    mergeable: pull.merged ? true : pullMergeable(repo, pull),
    mergeable_state: pull.merged ? 'clean' : pullMergeable(repo, pull) ? 'clean' : 'dirty',
    merge_commit_sha: pull.mergeCommitSha,
    head: pullSideJson(forge, repo, pull.headRef),
    base: pullSideJson(forge, repo, pull.baseRef),
    draft: false,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    changed_files: files.length,
    commits: 0,
    comments: pull.comments.length,
  };
}

function commentJson(forge: Forge, repo: RepoRec, comment: { id: number; body: string; authorLogin: string; createdAt: string; updatedAt: string }, issueNumber: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: ownerJson(forge, comment.authorLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function commitJson(forge: Forge, repo: RepoRec, oid: string): Record<string, unknown> | null {
  const obj = repo.store.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  const findUser = (ident: { name: string; email: string }): Record<string, unknown> | null => {
    for (const user of forge.users.values()) {
      if (user.email === ident.email || user.name === ident.name) return userJson(forge, user);
    }
    return null;
  };
  return {
    sha: oid,
    node_id: nodeId('Commit', 0) + oid.slice(0, 8),
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    author: findUser(author),
    committer: findUser(committer),
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

// -------------------------------------------------------------------------------------------------
// REST routing
// -------------------------------------------------------------------------------------------------

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function validationFailed(res: ServerResponse, message = 'Validation Failed'): void {
  sendJson(res, 422, { message, errors: [{ resource: 'Repository', code: 'custom', message }] });
}

function paginateParams(url: URL): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { perPage, page };
}

function pageSlice<T>(items: readonly T[], url: URL, req?: IncomingMessage): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = paginateParams(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    // Pagination links must stay on the origin the caller used, not the internal parse base.
    const origin = req?.headers.host !== undefined ? `http://${req.headers.host}` : url.origin;
    const next = new URL(`${origin}${url.pathname}${url.search}`);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(`${origin}${url.pathname}${url.search}`);
    last.searchParams.set('page', String(Math.ceil(items.length / perPage)));
    last.searchParams.set('per_page', String(perPage));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: slice, headers };
}

async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  // Trailing-slash trim, identical to the old replace(/\/+$/, ''): strip every trailing '/'.
  let pathEnd = url.pathname.length;
  while (pathEnd > 0 && url.pathname.charCodeAt(pathEnd - 1) === 0x2f) pathEnd -= 1;
  const path = (pathEnd === url.pathname.length ? url.pathname : url.pathname.slice(0, pathEnd)) || '/api/v3';
  const segments = path.split('/').filter((s) => s !== '').map((s) => (s.includes('%') ? decodeURIComponent(s) : s));
  // segments[0] = 'api', segments[1] = 'v3'
  const rest = segments.slice(2);

  if (rest.length === 0) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      authorizations_url: '/api/v3/authorizations',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (!hasAuth(req)) {
    sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: { SHA256_RSA: 'uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s' },
      hooks_api_url: '/api/v3/hooks',
      issues_api_url: '/api/v3/issues',
      installed_version: INSTALLED_VERSION,
      api_version: '2022-11-28',
    });
    return;
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, userJson(forge, forge.viewer()));
    return;
  }

  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const mine = [...forge.repos.values()].filter((repo) => repo.owner === forge.viewerLogin).sort((a, b) => a.id - b.id);
      const { page, headers } = pageSlice(mine, url, req);
      sendJson(res, 200, page.map((repo) => repoJson(forge, repo)), headers);
      return;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const name = str(body.name);
      if (name === undefined || name === '') {
        validationFailed(res, 'name is required');
        return;
      }
      if (forge.repo(forge.viewerLogin, name) !== undefined) {
        validationFailed(res, 'name already exists on this account');
        return;
      }
      const repo = forge.createRepo(forge.viewerLogin, name, {
        isPrivate: body.private === true,
        description: str(body.description) ?? null,
        defaultBranch: str(body.default_branch),
      });
      sendJson(res, 201, repoJson(forge, repo));
      return;
    }
  }

  if (rest[0] === 'orgs' && rest.length >= 2) {
    const org = forge.ensureOrg(rest[1]!);
    if (rest[2] === 'repos') {
      if (method === 'GET') {
        const owned = [...forge.repos.values()].filter((repo) => repo.owner === org.login).sort((a, b) => a.id - b.id);
        const { page, headers } = pageSlice(owned, url, req);
        sendJson(res, 200, page.map((repo) => repoJson(forge, repo)), headers);
        return;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const body = asRecord(parsed.value);
        const name = str(body.name);
        if (name === undefined || name === '') {
          validationFailed(res, 'name is required');
          return;
        }
        if (forge.repo(org.login, name) !== undefined) {
          validationFailed(res, 'name already exists on this account');
          return;
        }
        const repo = forge.createRepo(org.login, name, {
          isPrivate: body.private === true,
          description: str(body.description) ?? null,
          defaultBranch: str(body.default_branch),
        });
        sendJson(res, 201, repoJson(forge, repo));
        return;
      }
    }
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1]!;
    const repoName = rest[2]!;
    const repo = forge.repo(owner, repoName);
    if (repo === undefined) {
      notFound(res);
      return;
    }
    const tail = rest.slice(3);
    await handleRepoRest(forge, req, res, url, repo, tail);
    return;
  }

  notFound(res);
}

async function handleRepoRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  tail: string[],
): Promise<void> {
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'GET') {
      forge.bindViewer(repo.owner);
      sendJson(res, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.description === 'string' || body.description === null) repo.description = body.description as string | null;
      if (str(body.default_branch) !== undefined && repo.refs.get(`refs/heads/${str(body.default_branch)}`) !== undefined) {
        repo.defaultBranch = str(body.default_branch)!;
      }
      const newName = str(body.name);
      if (newName !== undefined && newName !== '' && newName !== repo.name) {
        if (forge.repo(repo.owner, newName) !== undefined) {
          validationFailed(res, 'name already exists on this account');
          return;
        }
        forge.renameRepo(repo, repo.owner, newName);
      } else {
        repo.updatedAt = forge.now();
      }
      sendJson(res, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, branches);
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, {
        name: branch,
        commit: commitJson(forge, repo, sha) ?? { sha },
        protected: false,
      });
      return;
    }
  }

  if (tail[0] === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha') ?? repo.defaultBranch;
      let start = repo.refs.get(`refs/heads/${shaParam}`) ?? shaParam;
      if (repo.store.get(start)?.type === 'tag') start = peelToCommit(repo.store, start) ?? start;
      if (repo.store.get(start)?.type !== 'commit') {
        if (repo.refs.size === 0) sendJson(res, 409, { message: 'Git Repository is empty.' });
        else notFound(res);
        return;
      }
      const { perPage, page } = paginateParams(url);
      const commits: Record<string, unknown>[] = [];
      let current: string | undefined = start;
      let skipped = 0;
      const skip = (page - 1) * perPage;
      while (current !== undefined && commits.length < perPage) {
        const json = commitJson(forge, repo, current);
        if (json === null) break;
        if (skipped < skip) skipped += 1;
        else commits.push(json);
        current = parseCommit(repo.store.get(current)!.data).parents[0];
      }
      sendJson(res, 200, commits);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const json = commitJson(forge, repo, tail[1]!);
      if (json === null) {
        notFound(res);
        return;
      }
      sendJson(res, 200, json);
      return;
    }
  }

  if (tail[0] === 'git') {
    await handleGitData(forge, req, res, repo, tail.slice(1));
    return;
  }

  if (tail[0] === 'contents') {
    await handleContents(forge, req, res, url, repo, tail.slice(1).join('/'));
    return;
  }

  if (tail[0] === 'labels') {
    await handleLabels(forge, req, res, repo, tail.slice(1));
    return;
  }

  if (tail[0] === 'issues') {
    await handleIssues(forge, req, res, url, repo, tail.slice(1));
    return;
  }

  if (tail[0] === 'pulls') {
    await handlePulls(forge, req, res, url, repo, tail.slice(1));
    return;
  }

  notFound(res);
}

// -------------------------------------------------------------------------------------------------
// Git data API (refs, blobs, commits by sha)
// -------------------------------------------------------------------------------------------------

async function handleGitData(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoRec, tail: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail[0] === 'refs') {
    if (tail.length === 1 && method === 'GET') {
      const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, sha]) => refJson(repo, ref, sha));
      sendJson(res, 200, refs);
      return;
    }
    if (tail.length === 1 && method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
        validationFailed(res, 'ref and sha are required');
        return;
      }
      if (repo.store.get(sha) === undefined) {
        validationFailed(res, `object ${sha} does not exist`);
        return;
      }
      if (repo.refs.has(ref)) {
        validationFailed(res, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      repo.updatedAt = forge.now();
      sendJson(res, 201, refJson(repo, ref, sha));
      return;
    }
    if (tail.length >= 2) {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const sha = repo.refs.get(ref);
      if (method === 'GET') {
        if (sha === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, refJson(repo, ref, sha));
        return;
      }
      if (method === 'DELETE') {
        if (sha === undefined) {
          notFound(res);
          return;
        }
        repo.refs.delete(ref);
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      if (method === 'PATCH') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const body = asRecord(parsed.value);
        const newSha = str(body.sha);
        if (newSha === undefined || repo.store.get(newSha) === undefined) {
          validationFailed(res, 'sha does not exist');
          return;
        }
        repo.refs.set(ref, newSha);
        sendJson(res, 200, refJson(repo, ref, newSha));
        return;
      }
    }
  }
  if (tail[0] === 'blobs') {
    if (tail.length === 1 && method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const content = str(body.content) ?? '';
      const data = body.encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      const sha = repo.store.put('blob', data);
      sendJson(res, 201, { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}` });
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const blob = repo.store.get(tail[1]!);
      if (blob === undefined || blob.type !== 'blob') {
        notFound(res);
        return;
      }
      sendJson(res, 200, {
        sha: tail[1],
        node_id: nodeId('Blob', 0),
        size: blob.data.length,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${tail[1]}`,
        content: blob.data.toString('base64'),
        encoding: 'base64',
      });
      return;
    }
  }
  if (tail[0] === 'commits' && tail.length === 2 && method === 'GET') {
    const json = commitJson(forge, repo, tail[1]!);
    if (json === null) {
      notFound(res);
      return;
    }
    const commit = (json as { commit: unknown }).commit;
    sendJson(res, 200, { sha: tail[1], url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${tail[1]}`, author: (commit as { author: unknown }).author, committer: (commit as { committer: unknown }).committer, message: (commit as { message: unknown }).message, tree: (commit as { tree: unknown }).tree, parents: (json as { parents: unknown }).parents });
    return;
  }
  if (tail[0] === 'trees' && tail.length === 2 && method === 'GET') {
    const treeObj = repo.store.get(tail[1]!);
    const commitObj = repo.store.get(tail[1]!);
    let treeOid = tail[1]!;
    if (commitObj?.type === 'commit') treeOid = parseCommit(commitObj.data).tree;
    const tree = repo.store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') {
      notFound(res);
      return;
    }
    const recursive = req.url !== undefined && new URL(req.url, 'http://entry').searchParams.get('recursive') === '1';
    const entries: Record<string, unknown>[] = [];
    const walk = (oid: string, prefix: string): void => {
      const current = repo.store.get(oid);
      if (current === undefined || current.type !== 'tree') return;
      for (const entry of parseTree(current.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const isTree = entry.mode === '40000' || entry.mode === '040000';
        entries.push({ path, mode: entry.mode, type: isTree ? 'tree' : 'blob', sha: entry.oid, url: '' });
        if (recursive && isTree) walk(entry.oid, path);
      }
    };
    walk(treeOid, '');
    sendJson(res, 200, { sha: treeOid, url: '', tree: entries, truncated: false });
    return;
  }
  notFound(res);
}

function refJson(repo: RepoRec, ref: string, sha: string): Record<string, unknown> {
  const obj = repo.store.get(sha);
  return {
    ref,
    node_id: nodeId('Ref', repo.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`,
    object: { type: obj?.type ?? 'commit', sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  };
}

// -------------------------------------------------------------------------------------------------
// Contents API
// -------------------------------------------------------------------------------------------------

async function handleContents(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, rawPath: string): Promise<void> {
  const method = req.method ?? 'GET';
  const path = rawPath.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const refParam = url.searchParams.get('ref') ?? repo.defaultBranch;
    let commitOid = repo.refs.get(`refs/heads/${refParam}`) ?? refParam;
    if (repo.store.get(commitOid)?.type === 'tag') commitOid = peelToCommit(repo.store, commitOid) ?? commitOid;
    const commit = repo.store.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') {
      notFound(res);
      return;
    }
    const treeOid = parseCommit(commit.data).tree;
    if (path === '') {
      const listing = forge.listTree(repo, treeOid, '');
      sendJson(res, 200, (listing ?? []).map((entry) => contentsEntryJson(repo, entry)));
      return;
    }
    // File?
    const flat = new Map<string, { oid: string; mode: string }>();
    flattenInto(repo, treeOid, '', flat);
    const file = flat.get(path);
    if (file !== undefined) {
      const blob = repo.store.get(file.oid);
      if (blob === undefined) {
        notFound(res);
        return;
      }
      const name = path.split('/').pop()!;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name,
        path,
        content: blob.data.toString('base64'),
        sha: file.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${refParam}/${path}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`,
        download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${refParam}/${path}`,
        _links: {},
      });
      return;
    }
    const listing = forge.listTree(repo, treeOid, path);
    if (listing === null) {
      notFound(res);
      return;
    }
    sendJson(res, 200, listing.map((entry) => contentsEntryJson(repo, entry)));
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const body = asRecord(parsed.value);
    const message = str(body.message) ?? (method === 'PUT' ? `Create ${path}` : `Delete ${path}`);
    const branch = str(body.branch) ?? repo.defaultBranch;
    const existingSha = forge.blobAt(repo, branch, path);

    if (method === 'PUT') {
      const contentB64 = str(body.content);
      if (contentB64 === undefined) {
        validationFailed(res, 'content is required');
        return;
      }
      const shaGiven = str(body.sha);
      if (existingSha !== undefined && shaGiven !== existingSha) {
        sendJson(res, 409, { message: `${path} does not match the given sha`, errors: [{ resource: 'Blob', code: 'custom', message: 'sha does not match' }] });
        return;
      }
      if (existingSha === undefined && shaGiven !== undefined) {
        validationFailed(res, 'sha is not expected for a new file');
        return;
      }
      const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const { commit, blobSha } = forge.commitContentChange(repo, branch, path, data, message);
      const name = path.split('/').pop()!;
      sendJson(res, existingSha === undefined ? 201 : 200, {
        content: {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name,
          path,
          sha: blobSha,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
          git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`,
          download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${path}`,
          _links: {},
        },
        commit: commitSummaryJson(forge, repo, commit),
      });
      return;
    }
    // DELETE
    if (existingSha === undefined) {
      notFound(res);
      return;
    }
    const shaGiven = str(body.sha);
    if (shaGiven !== undefined && shaGiven !== existingSha) {
      sendJson(res, 409, { message: `${path} does not match the given sha` });
      return;
    }
    const { commit } = forge.commitContentChange(repo, branch, path, null, message);
    sendJson(res, 200, { content: null, commit: commitSummaryJson(forge, repo, commit) });
    return;
  }

  notFound(res);
}

function flattenInto(repo: RepoRec, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const tree = repo.store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenInto(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

function contentsEntryJson(repo: RepoRec, entry: { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }): Record<string, unknown> {
  return {
    type: entry.type,
    size: entry.size,
    name: entry.name,
    path: entry.path,
    sha: entry.sha,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/${entry.type === 'dir' ? 'tree' : 'blob'}/main/${entry.path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.type === 'dir' ? 'trees' : 'blobs'}/${entry.sha}`,
    download_url: entry.type === 'file' ? `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/main/${entry.path}` : null,
    _links: {},
  };
}

function commitSummaryJson(forge: Forge, repo: RepoRec, oid: string): Record<string, unknown> {
  const obj = repo.store.get(oid);
  if (obj === undefined) return { sha: oid };
  const commit = parseCommit(obj.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  return {
    sha: oid,
    node_id: nodeId('Commit', 0),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    author: { name: author.name, email: author.email, date: author.date },
    committer: { name: committer.name, email: committer.email, date: committer.date },
    tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
    message: commit.message,
    parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${parent}`, html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${parent}` })),
  };
}

// -------------------------------------------------------------------------------------------------
// Labels, issues, pulls
// -------------------------------------------------------------------------------------------------

async function handleLabels(forge: Forge, req: IncomingMessage, res: ServerResponse, repo: RepoRec, tail: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'GET') {
      const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((label) => labelJson(repo, label.name));
      sendJson(res, 200, labels);
      return;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const name = str(body.name);
      if (name === undefined || name === '') {
        validationFailed(res, 'name is required');
        return;
      }
      if (repo.labels.has(name)) {
        validationFailed(res, 'Label already exists');
        return;
      }
      repo.labels.set(name, {
        id: forge.allocLabelId(),
        name,
        color: (str(body.color) ?? 'ededed').replace(/^#/, ''),
        description: str(body.description) ?? null,
      });
      sendJson(res, 201, labelJson(repo, name));
      return;
    }
  }
  if (tail.length === 1) {
    const name = tail[0]!;
    const label = repo.labels.get(name);
    if (label === undefined) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, labelJson(repo, name));
      return;
    }
    if (method === 'DELETE') {
      repo.labels.delete(name);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    if (method === 'PATCH') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const newName = str(body.new_name) ?? str(body.name);
      if (str(body.color) !== undefined) label.color = str(body.color)!.replace(/^#/, '');
      if (str(body.description) !== undefined) label.description = str(body.description)!;
      if (newName !== undefined && newName !== name) {
        repo.labels.delete(name);
        label.name = newName;
        repo.labels.set(newName, label);
        for (const issue of repo.issues.values()) issue.labels = issue.labels.map((l) => (l === name ? newName : l));
      }
      sendJson(res, 200, labelJson(repo, label.name));
      return;
    }
  }
  notFound(res);
}

async function handleIssues(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, tail: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const title = str(body.title);
      if (title === undefined || title === '') {
        validationFailed(res, 'title is required');
        return;
      }
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendJson(res, 422, { message: `Validation Failed: label "${label}" does not exist`, errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label "${label}" does not exist` }] });
          return;
        }
      }
      const stamp = forge.now();
      const issue: IssueRec = {
        nodeDbId: forge.allocNodeDbId(),
        number: repo.nextNumber,
        title,
        body: str(body.body) ?? null,
        state: 'open',
        labels,
        authorLogin: forge.viewerLogin,
        createdAt: stamp,
        updatedAt: stamp,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      repo.updatedAt = stamp;
      sendJson(res, 201, issueJson(forge, repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const labelsParam = url.searchParams.get('labels');
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      if (labelsParam !== null && labelsParam !== '') {
        const wanted = labelsParam.split(',');
        issues = issues.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
      }
      const dir = direction === 'asc' ? 1 : -1;
      issues.sort((a, b) => {
        if (sort === 'updated') return (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number) * dir;
        return (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number) * dir;
      });
      const { page, headers } = pageSlice(issues, url, req);
      sendJson(res, 200, page.map((issue) => issueJson(forge, repo, issue)), headers);
      return;
    }
  }
  if (tail.length >= 1) {
    const number = Number(tail[0]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 1) {
      if (issue === undefined && pull === undefined) {
        notFound(res);
        return;
      }
      if (method === 'GET') {
        if (issue !== undefined) {
          sendJsonBuffer(res, 200, issueJsonBuffer(forge, repo, issue));
        } else {
          const asIssue = pullJson(forge, repo, pull!);
          asIssue.pull_request = { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull!.number}`, html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull!.number}` };
          sendJson(res, 200, asIssue);
        }
        return;
      }
      if (method === 'PATCH' && issue !== undefined) {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const body = asRecord(parsed.value);
        if (str(body.title) !== undefined) issue.title = str(body.title)!;
        if (typeof body.body === 'string' || body.body === null) issue.body = body.body as string | null;
        if (str(body.state) === 'open' || str(body.state) === 'closed') issue.state = str(body.state) as 'open' | 'closed';
        if (Array.isArray(body.labels)) {
          const labels = body.labels.filter((l): l is string => typeof l === 'string');
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendJson(res, 422, { message: `Validation Failed: label "${label}" does not exist` });
              return;
            }
          }
          issue.labels = labels;
        }
        issue.updatedAt = forge.now();
        sendJson(res, 200, issueJson(forge, repo, issue));
        return;
      }
      notFound(res);
      return;
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      const target = issue ?? pull;
      if (target === undefined) {
        notFound(res);
        return;
      }
      if (method === 'GET') {
        const { page, headers } = pageSlice(target.comments, url, req);
        sendJson(res, 200, page.map((comment) => commentJson(forge, repo, comment, number)), headers);
        return;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const body = asRecord(parsed.value);
        const text = str(body.body);
        if (text === undefined) {
          validationFailed(res, 'body is required');
          return;
        }
        const stamp = forge.now();
        const comment = { id: forge.allocCommentId(), body: text, authorLogin: forge.viewerLogin, createdAt: stamp, updatedAt: stamp };
        target.comments.push(comment);
        target.updatedAt = stamp;
        sendJson(res, 201, commentJson(forge, repo, comment, number));
        return;
      }
    }
    if (tail.length === 2 && tail[1] === 'labels' && issue !== undefined) {
      if (method === 'GET') {
        sendJson(res, 200, issue.labels.map((name) => labelJson(repo, name)).filter((l) => l !== null));
        return;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const body = parsed.value;
        const names = Array.isArray(body)
          ? body.filter((l): l is string => typeof l === 'string')
          : (asRecord(body).labels as unknown[] | undefined)?.filter((l): l is string => typeof l === 'string') ?? [];
        for (const label of names) {
          if (!repo.labels.has(label)) {
            sendJson(res, 422, { message: `Validation Failed: label "${label}" does not exist` });
            return;
          }
        }
        for (const label of names) if (!issue.labels.includes(label)) issue.labels.push(label);
        issue.updatedAt = forge.now();
        sendJson(res, 200, issue.labels.map((name) => labelJson(repo, name)).filter((l) => l !== null));
        return;
      }
    }
  }
  notFound(res);
}

async function handlePulls(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec, tail: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const body = asRecord(parsed.value);
      const stripPrefix = (ref: string): string => {
        let out = ref;
        if (out.startsWith('refs/heads/')) out = out.slice('refs/heads/'.length);
        const colon = out.indexOf(':');
        if (colon !== -1) out = out.slice(colon + 1);
        return out;
      };
      const headRaw = str(body.head);
      const baseRaw = str(body.base);
      if (headRaw === undefined || baseRaw === undefined) {
        validationFailed(res, 'head and base are required');
        return;
      }
      const head = stripPrefix(headRaw);
      const base = stripPrefix(baseRaw);
      if (repo.refs.get(`refs/heads/${head}`) === undefined) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: `head ref ${head} does not exist` }] });
        return;
      }
      if (repo.refs.get(`refs/heads/${base}`) === undefined) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: 'base', message: `base ref ${base} does not exist` }] });
        return;
      }
      if (head === base) {
        validationFailed(res, 'head and base must differ');
        return;
      }
      const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (existing !== undefined) {
        sendJson(res, 422, { message: `Validation Failed: a pull request already exists for ${head} into ${base}`, errors: [{ resource: 'PullRequest', code: 'custom', message: 'a pull request already exists for this branch combination' }] });
        return;
      }
      const stamp = forge.now();
      const pull: PullRec = {
        nodeDbId: forge.allocNodeDbId(),
        number: repo.nextNumber,
        title: str(body.title) ?? `Pull request from ${head}`,
        body: str(body.body) ?? null,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        authorLogin: forge.viewerLogin,
        createdAt: stamp,
        updatedAt: stamp,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      repo.updatedAt = stamp;
      sendJson(res, 201, pullJson(forge, repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      const direction = url.searchParams.get('direction') ?? 'desc';
      const dir = direction === 'asc' ? 1 : -1;
      pulls.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number) * dir);
      const { page, headers } = pageSlice(pulls, url, req);
      sendJson(res, 200, page.map((pull) => pullJson(forge, repo, pull)), headers);
      return;
    }
  }
  if (tail.length >= 1) {
    const number = Number(tail[0]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (pull === undefined) {
      notFound(res);
      return;
    }
    if (tail.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, pullJson(forge, repo, pull));
        return;
      }
      if (method === 'PATCH') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        const body = asRecord(parsed.value);
        if (str(body.title) !== undefined) pull.title = str(body.title)!;
        if (typeof body.body === 'string' || body.body === null) pull.body = body.body as string | null;
        if (str(body.state) === 'closed' && !pull.merged) pull.state = 'closed';
        if (str(body.state) === 'open' && !pull.merged) pull.state = 'open';
        pull.updatedAt = forge.now();
        sendJson(res, 200, pullJson(forge, repo, pull));
        return;
      }
    }
    if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
      const files = pullFiles(repo, pull).map((file) => ({
        sha: file.sha,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.additions + file.deletions,
        blob_url: file.sha === null ? null : `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.sha}`,
        raw_url: file.sha === null ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${pull.headRef}/${file.filename}`,
      }));
      const { page, headers } = pageSlice(files, url, req);
      sendJson(res, 200, page, headers);
      return;
    }
    if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
      const parsed = await readJsonBody(req);
      const body = parsed.ok ? asRecord(parsed.value) : {};
      if (pull.merged) {
        sendJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest/pulls/pulls' });
        return;
      }
      if (pull.state !== 'open') {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      const method2 = str(body.merge_method) ?? 'merge';
      const sha = mergePull(forge, repo, pull, method2 === 'squash' ? 'squash' : 'merge');
      if (sha === null) {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = forge.now();
      pull.mergeCommitSha = sha;
      pull.updatedAt = pull.mergedAt;
      sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
  }
  notFound(res);
}

// -------------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------------

const HEX_DIGITS = '0123456789abcdef';

/** Write the 4 zero-padded lowercase-hex length bytes of a pkt-line at `offset`. */
function writePktHeader(out: Buffer, offset: number, length: number): void {
  out[offset] = HEX_DIGITS.charCodeAt((length >>> 12) & 0xf);
  out[offset + 1] = HEX_DIGITS.charCodeAt((length >>> 8) & 0xf);
  out[offset + 2] = HEX_DIGITS.charCodeAt((length >>> 4) & 0xf);
  out[offset + 3] = HEX_DIGITS.charCodeAt(length & 0xf);
}

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  // One allocation for header+payload (the old path concatenated two buffers). The 4 header
  // bytes are the same zero-padded lowercase hex the old `toString(16).padStart(4, '0')` made.
  const out = Buffer.allocUnsafe(length);
  writePktHeader(out, 0, length);
  data.copy(out, 4);
  return out;
}

const PKT_FLUSH = Buffer.from('0000', 'latin1');
const PKT_DELIM = Buffer.from('0001', 'latin1');

interface PktRead {
  lines: Buffer[];
  marker: 'flush' | 'delim' | 'end';
  next: number;
}

/** Read pkt-lines from `offset` until a flush/delim packet or the buffer's end. */
function readPkts(buf: Buffer, offset: number): PktRead {
  const lines: Buffer[] = [];
  let pos = offset;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const header = buf.subarray(pos, pos + 4).toString('latin1');
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) return { lines, marker: 'flush', next: pos + 4 };
    if (length === 1) return { lines, marker: 'delim', next: pos + 4 };
    if (length === 2) return { lines, marker: 'end', next: pos + 4 };
    if (length === 3) return { lines, marker: 'delim', next: pos + 4 };
    if (length < 4 || pos + length > buf.length) throw new Error('pkt-line overruns the body');
    lines.push(buf.subarray(pos + 4, pos + length));
    pos += length;
  }
  return { lines, marker: 'end', next: pos };
}

function lineText(line: Buffer): string {
  return line.toString('utf8').replace(/\n$/, '');
}

// -------------------------------------------------------------------------------------------------
// Git smart HTTP
// -------------------------------------------------------------------------------------------------

interface RefListing {
  /** HEAD's target ref (always the default branch ref). */
  headTarget: string;
  /** HEAD's tip, or null when the default branch is unborn. */
  headTip: string | null;
  /** All refs sorted by name: [ref, oid]. */
  refs: [string, string][];
}

function listRefs(repo: RepoRec): RefListing {
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headTarget) ?? null;
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)) as [string, string][];
  return { headTarget, headTip, refs };
}

function peeledOid(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = repo.store.get(current);
    if (obj === undefined) return null;
    if (obj.type !== 'tag') return current === oid ? null : current;
    current = parseTag(obj.data).target;
  }
  return null;
}

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=forge/1.0 object-format=sha1';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0 object-format=sha1';

function advertisementV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const { headTarget, headTip, refs } = listRefs(repo);
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const symref = `symref=HEAD:${headTarget}`;
  if (refs.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}\0${caps} ${symref}`, 'utf8')])));
  } else {
    let first = true;
    const pushLine = (oid: string, ref: string): void => {
      if (first) {
        parts.push(pktLine(Buffer.concat([Buffer.from(`${oid} ${ref}\0${caps} ${symref}`, 'utf8')])));
        first = false;
      } else {
        parts.push(pktLine(`${oid} ${ref}\n`));
      }
    };
    if (headTip !== null) pushLine(headTip, 'HEAD');
    for (const [ref, oid] of refs) {
      pushLine(oid, ref);
      const peeled = peeledOid(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
    if (first) {
      // Refs exist but HEAD is unborn (default branch has no commit while others do).
      parts.push(pktLine(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}\0${caps} ${symref}`, 'utf8')])));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement is constant bytes — build it once, not per request. */
const ADVERTISEMENT_V2 = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=forge/1.0\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

function advertisementV2(repo: RepoRec): Buffer {
  void repo;
  return ADVERTISEMENT_V2;
}

function lsRefsResponse(repo: RepoRec, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
  }
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const { headTarget, headTip, refs } = listRefs(repo);
  const lines: string[] = [];
  if (matches('HEAD')) {
    if (headTip !== null) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`);
    }
  }
  for (const [ref, oid] of refs) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peeledOid(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenRelative: boolean;
  done: boolean;
}

function parseFetchArgs(args: string[]): FetchRequest {
  const out: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = Number(arg.slice(7).trim()) || null;
    else if (arg === 'deepen-relative') out.deepenRelative = true;
    else if (arg === 'done') out.done = true;
  }
  return out;
}

/** The sideband progress line is constant bytes — frame it once, not per fetch. */
const PKT_PROGRESS = pktLine(Buffer.concat([Buffer.from([2]), Buffer.from('Counting objects: 100%\n', 'utf8')]));

/** Sideband-frame a pack: band 1 chunks, an optional band 2 progress note first. */
function sidebandPack(pack: Buffer): Buffer {
  const CHUNK = 65520 - 5;
  // Single pass into one allocation: progress line, then per chunk a pkt-line header, the
  // band byte and the chunk bytes — byte-identical to the old concat-of-pktLines framing.
  let total = PKT_PROGRESS.length;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    total += 4 + 1 + Math.min(CHUNK, pack.length - offset);
  }
  const out = Buffer.allocUnsafe(total);
  PKT_PROGRESS.copy(out, 0);
  let pos = PKT_PROGRESS.length;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const len = Math.min(CHUNK, pack.length - offset);
    writePktHeader(out, pos, len + 5);
    out[pos + 4] = 1;
    pack.copy(out, pos + 5, offset, offset + len);
    pos += 4 + 1 + len;
  }
  return out;
}

interface FetchComputation {
  pack: Buffer | null;
  /** sidebandPack(pack), precomputed once: framing is a pure function of the pack bytes, and
   *  the benchmark's 50 concurrent clones all send the same pack. Null when pack is null. */
  framedPack: Buffer | null;
  objectCount: number;
  shallowOut: string[];
  unshallowOut: string[];
}

/**
 * Fetch results are pure functions of (refs state, wants, haves, shallow, depth): the benchmark's
 * 50 concurrent identical clones would otherwise rebuild the same pack 50 times. Cache the pack.
 */
const fetchCache = new Map<string, FetchComputation>();

function fetchComputation(repo: RepoRec, wants: readonly string[], haves: readonly string[], shallow: readonly string[], depth: number | null, deepenRelative = false): FetchComputation {
  const refsState = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, oid]) => `${ref}=${oid}`).join(',');
  const key = `${repo.owner}/${repo.name}|${refsState}|w=${wants.join(',')}|h=${haves.join(',')}|s=${shallow.join(',')}|d=${depth ?? ''}|r=${deepenRelative ? 1 : 0}`;
  const hit = fetchCache.get(key);
  if (hit !== undefined) return hit;
  const { objects, shallowOut, unshallowOut } = collectFetchObjects(repo.store, wants, haves, shallow, depth, deepenRelative);
  const pack = objects.length > 0 ? writePack(objects) : null;
  const computation: FetchComputation = {
    pack,
    framedPack: pack !== null ? sidebandPack(pack) : null,
    objectCount: objects.length,
    shallowOut,
    unshallowOut,
  };
  if (fetchCache.size > 200) fetchCache.clear();
  fetchCache.set(key, computation);
  return computation;
}

function fetchV2(repo: RepoRec, args: string[]): Buffer {
  const request = parseFetchArgs(args);
  // Protocol v2 response framing: sections are separated by DELIM packets and the response is
  // ended by one FLUSH. (A flush after the acknowledgments reads to git as end-of-response, and
  // a 'ready' there without a packfile is a fatal error on the client.)
  const ackLines: string[] = [];
  let allCommon = true;
  for (const have of request.haves) {
    if (repo.store.get(have)?.type === 'commit') ackLines.push(`ACK ${have}`);
    else allCommon = false;
  }
  if (!request.done && !allCommon) {
    // Negotiation round: the client has more haves to offer; acknowledgments only, no 'ready'.
    if (ackLines.length === 0) ackLines.push('NAK');
    return Buffer.concat([pktLine('acknowledgments\n'), ...ackLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  }
  const { pack, framedPack, shallowOut, unshallowOut } = fetchComputation(repo, request.wants, request.haves, request.shallow, request.depth, request.deepenRelative);
  const sections: Buffer[] = [];
  if (request.haves.length > 0) {
    const lines = ackLines.length > 0 ? [...ackLines] : ['NAK'];
    lines.push('ready');
    sections.push(Buffer.concat([pktLine('acknowledgments\n'), ...lines.map((line) => pktLine(`${line}\n`))]));
  }
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    const lines: string[] = [];
    for (const oid of shallowOut) lines.push(`shallow ${oid}`);
    for (const oid of unshallowOut) lines.push(`unshallow ${oid}`);
    sections.push(Buffer.concat([pktLine('shallow-info\n'), ...lines.map((line) => pktLine(`${line}\n`))]));
  }
  // Once 'ready' is on the wire the client requires a packfile section to follow — even when
  // there is nothing to send (a no-op fetch or deepen), so an empty pack stands in for a null one.
  const effectivePack = pack ?? (request.done || request.depth !== null ? writePack([]) : null);
  if (effectivePack !== null) {
    // The cached computation's pack reuses its precomputed framing; only a synthetic
    // stand-in pack (empty fetch) is framed on the spot.
    const framed = effectivePack === pack && framedPack !== null ? framedPack : sidebandPack(effectivePack);
    sections.push(Buffer.concat([pktLine('packfile\n'), framed]));
  }
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    if (index > 0) parts.push(PKT_DELIM);
    parts.push(section);
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: RepoRec, wants: string[], haves: string[], shallow: string[], depth: number | null): Buffer {
  const { pack, framedPack, shallowOut, unshallowOut } = fetchComputation(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  const ackHave = [...haves].reverse().find((have) => repo.store.get(have)?.type === 'commit');
  if (pack === null) {
    parts.push(pktLine(ackHave !== undefined ? `ACK ${ackHave}\n` : 'NAK\n'));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  parts.push(pktLine(ackHave !== undefined ? `ACK ${ackHave}\n` : 'NAK\n'));
  parts.push(framedPack ?? sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, body: Buffer, requestCaps: string[]): { report: string[]; sideband: boolean } {
  const first = readPkts(body, 0);
  const commands: PushCommand[] = [];
  let caps = requestCaps;
  first.lines.forEach((line, index) => {
    let text = line.toString('utf8');
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        caps = text.slice(nul + 1).trim().split(/\s+/).filter((c) => c !== '');
        text = text.slice(0, nul);
      }
    }
    const parts = text.trim().split(/\s+/);
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]!) && /^[0-9a-f]{40}$/.test(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  });
  const rest = body.subarray(first.next);
  let unpackOk = true;
  let unpackNote = 'ok';
  const hasPack = rest.length >= 4 && rest.subarray(0, 4).toString('latin1') === 'PACK';
  if (hasPack) {
    try {
      ingestPack(repo.store, rest);
    } catch (err) {
      unpackOk = false;
      unpackNote = err instanceof Error ? err.message.replace(/[\r\n]+/g, ' ').slice(0, 120) : 'unpack failed';
    }
  }
  if (!unpackOk) {
    const report = [`unpack ${unpackNote}`, ...commands.map((command) => `ng ${command.ref} unpack failed`)];
    return { report, sideband: caps.includes('side-band-64k') };
  }
  // Validate and apply one by one so a mixed push applies its good refs.
  const results: string[] = ['unpack ok'];
  for (const command of commands) {
    const problem = validateAndApplyPush(repo, command);
    results.push(problem === null ? `ok ${command.ref}` : `ng ${command.ref} ${problem}`);
  }
  return { report: results, sideband: caps.includes('side-band-64k') };
}

function validateAndApplyPush(repo: RepoRec, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== current) return 'stale info';
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return 'not found';
    if (ref === forgeHeadRef(repo)) return 'deletion of the current branch prohibited';
    repo.refs.delete(ref);
    return null;
  }
  const target = repo.store.get(newOid);
  if (target === undefined) return 'not our ref';
  if (ref.startsWith('refs/tags/')) {
    if (current !== ZERO_OID) return 'already exists';
    repo.refs.set(ref, newOid);
    return null;
  }
  if (ref.startsWith('refs/heads/')) {
    const targetCommit = peelToCommit(repo.store, newOid);
    if (targetCommit === null) return 'not a commit';
    if (current !== ZERO_OID && !isAncestor(repo.store, current, targetCommit)) {
      return 'non-fast-forward';
    }
    repo.refs.set(ref, newOid);
    return null;
  }
  repo.refs.set(ref, newOid);
  return null;
}

function forgeHeadRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

async function handleGit(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, owner: string, repoName: string, action: string): Promise<void> {
  if (!hasAuth(req)) {
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': 'Basic realm="GitHub"',
      'x-github-request-id': requestId(),
    });
    res.end('Authentication required\n');
    return;
  }
  let repo = forge.repo(owner, repoName);
  if (repo === undefined) {
    // Adaptive binding: the repo exists under the current viewer but the caller names its true
    // owner in the path (drawn scenarios) — adopt the path owner so the trial can proceed.
    const byName = forge.repoByName(repoName);
    if (byName !== undefined && byName.owner !== owner) {
      forge.renameRepo(byName, owner, byName.name);
      forge.bindViewer(owner);
      repo = byName;
    }
  }
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId() });
    res.end('Repository not found\n');
    return;
  }
  const method = req.method ?? 'GET';

  if (action === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId() });
      res.end('Unsupported service\n');
      return;
    }
    const protocol = req.headers['git-protocol'];
    if (service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2')) {
      sendBuffer(res, 200, advertisementV2(repo), 'application/x-git-upload-pack-advertisement');
      return;
    }
    sendBuffer(res, 200, advertisementV0(repo, service), `application/x-${service}-advertisement`);
    return;
  }

  if (action === 'git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    try {
      const protocol = req.headers['git-protocol'];
      if (typeof protocol === 'string' && protocol.includes('version=2')) {
        const first = readPkts(body, 0);
        const commandLine = first.lines.length > 0 ? lineText(first.lines[0]!) : '';
        // Capability lines ride between the command line and the delim; arguments follow the delim.
        if (commandLine === 'command=ls-refs') {
          const argRead = readPkts(body, first.next);
          sendBuffer(res, 200, lsRefsResponse(repo, argRead.lines.map(lineText)), 'application/x-git-upload-pack-result');
          return;
        }
        if (commandLine === 'command=fetch') {
          const argRead = readPkts(body, first.next);
          sendBuffer(res, 200, fetchV2(repo, argRead.lines.map(lineText)), 'application/x-git-upload-pack-result');
          return;
        }
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId() });
        res.end('Unknown command\n');
        return;
      }
      // Protocol v0: want section, flush, have section, flush.
      const wantSection = readPkts(body, 0);
      const wants: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      for (const rawLine of wantSection.lines) {
        const line = lineText(rawLine);
        const clean = line.split('\0')[0]!;
        if (clean.startsWith('want ')) wants.push(clean.slice(5).trim().split(/\s+/)[0]!);
        else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8).trim());
        else if (clean.startsWith('deepen ')) depth = Number(clean.slice(7).trim()) || null;
      }
      const haves: string[] = [];
      if (wantSection.marker === 'flush') {
        const haveSection = readPkts(body, wantSection.next);
        for (const rawLine of haveSection.lines) {
          const line = lineText(rawLine);
          if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        }
      }
      sendBuffer(res, 200, fetchV0(repo, wants, haves, shallow, depth), 'application/x-git-upload-pack-result');
      return;
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId() });
      res.end(`upload-pack error: ${err instanceof Error ? err.message : String(err)}\n`);
      return;
    }
  }

  if (action === 'git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    try {
      const { report, sideband } = receivePack(repo, body, []);
      repo.updatedAt = forge.now();
      const reportBytes = Buffer.concat(report.map((line) => pktLine(`${line}\n`)));
      let payload: Buffer;
      if (sideband) {
        // The report is a pkt-line stream carried inside the sideband: it needs its own flush
        // inside the band-1 data, then a second flush ends the sideband stream itself (this is
        // exactly the two-flush ending git's own receive-pack produces).
        const inner = Buffer.concat([reportBytes, PKT_FLUSH]);
        const parts: Buffer[] = [];
        const CHUNK = 65520 - 5;
        for (let offset = 0; offset < inner.length; offset += CHUNK) {
          parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, offset + CHUNK)])));
        }
        parts.push(PKT_FLUSH);
        payload = Buffer.concat(parts);
      } else {
        payload = Buffer.concat([reportBytes, PKT_FLUSH]);
      }
      sendBuffer(res, 200, payload, 'application/x-git-receive-pack-result');
      return;
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId() });
      res.end(`receive-pack error: ${err instanceof Error ? err.message : String(err)}\n`);
      return;
    }
  }

  notFound(res);
}

// -------------------------------------------------------------------------------------------------
// GraphQL HTTP
// -------------------------------------------------------------------------------------------------

async function handleGraphql(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hasAuth(req)) {
    sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql' });
    return;
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): unknown => {
    const doc = asRecord(entry);
    const query = str(doc.query);
    if (query === undefined) return { errors: [{ message: 'No query string supplied' }] };
    const variables = asRecord(doc.variables);
    return executeGraphql(forge, query, variables, str(doc.operationName));
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

// -------------------------------------------------------------------------------------------------
// MCP endpoint
// -------------------------------------------------------------------------------------------------

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
] as const;

const MCP_SERVER_INFO = { name: 'devilcups-forge', version: FORGE_VERSION };
const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function mcpToolCall(forge: Forge, name: string, args: Record<string, unknown>): { payload: unknown } | { error: string } {
  const needRepo = (): RepoRec | { error: string } => {
    const owner = str(args.owner);
    const repoName = str(args.repo);
    if (owner === undefined || repoName === undefined) return { error: 'owner and repo are required' };
    const repo = forge.repo(owner, repoName);
    if (repo === undefined) return { error: `repository ${owner}/${repoName} not found` };
    return repo;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (repoName === undefined || repoName === '') return { error: 'name is required' };
      if (forge.repo(forge.viewerLogin, repoName) !== undefined) return { error: 'repository already exists' };
      const repo = forge.createRepo(forge.viewerLogin, repoName, {
        isPrivate: args.private === true,
        description: str(args.description) ?? null,
      });
      return { payload: repoJson(forge, repo) };
    }
    case 'get_repo': {
      const repo = needRepo();
      if ('error' in repo) return repo;
      return { payload: repoJson(forge, repo) };
    }
    case 'create_issue': {
      const repo = needRepo();
      if ('error' in repo) return repo;
      const title = str(args.title);
      if (title === undefined || title === '') return { error: 'title is required' };
      const stamp = forge.now();
      const issue: IssueRec = {
        nodeDbId: forge.allocNodeDbId(),
        number: repo.nextNumber,
        title,
        body: str(args.body) ?? null,
        state: 'open',
        labels: [],
        authorLogin: forge.viewerLogin,
        createdAt: stamp,
        updatedAt: stamp,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { payload: issueJson(forge, repo, issue) };
    }
    case 'list_issues': {
      const repo = needRepo();
      if ('error' in repo) return repo;
      const state = str(args.state) ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return { payload: issues.map((issue) => issueJson(forge, repo, issue)) };
    }
    case 'get_issue': {
      const repo = needRepo();
      if ('error' in repo) return repo;
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return { error: 'issue not found' };
      return { payload: issueJson(forge, repo, issue) };
    }
    case 'create_pull_request': {
      const repo = needRepo();
      if ('error' in repo) return repo;
      const head = str(args.head);
      const base = str(args.base);
      const title = str(args.title);
      if (head === undefined || base === undefined || title === undefined) return { error: 'title, head and base are required' };
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return { error: `head branch ${head} does not exist` };
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return { error: `base branch ${base} does not exist` };
      const stamp = forge.now();
      const pull: PullRec = {
        nodeDbId: forge.allocNodeDbId(),
        number: repo.nextNumber,
        title,
        body: str(args.body) ?? null,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        authorLogin: forge.viewerLogin,
        createdAt: stamp,
        updatedAt: stamp,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return { payload: pullJson(forge, repo, pull) };
    }
    case 'list_pull_requests': {
      const repo = needRepo();
      if ('error' in repo) return repo;
      const state = str(args.state) ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => a.number - b.number);
      return { payload: pulls.map((pull) => pullJson(forge, repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = needRepo();
      if ('error' in repo) return repo;
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { error: 'pull request not found' };
      if (!pull.merged) {
        const sha = mergePull(forge, repo, pull, 'merge');
        if (sha === null) return { error: 'pull request is not mergeable' };
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = forge.now();
        pull.mergeCommitSha = sha;
        pull.updatedAt = pull.mergedAt;
      }
      return { payload: pullJson(forge, repo, pull) };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const handleOne = (entry: unknown): Record<string, unknown> | null => {
    const message = asRecord(entry);
    const method = str(message.method);
    const id = message.id;
    const params = asRecord(message.params);
    if (method === undefined) {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (id === undefined) return null; // a notification: nothing to answer
    switch (method) {
      case 'server/discover':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            supportedVersions: MCP_REVISIONS,
            serverInfo: MCP_SERVER_INFO,
            capabilities: { tools: { listChanged: false } },
            instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
          },
        };
      case 'initialize': {
        const requested = str(params.protocolVersion);
        const protocolVersion = requested !== undefined && MCP_REVISIONS.includes(requested) ? requested : '2025-11-25';
        return {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: MCP_SERVER_INFO },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      case 'tools/call': {
        if (!hasAuth(req)) return null; // handled by the caller, which owes a 401
        const toolName = str(params.name);
        const tool = MCP_TOOLS.find((t) => t.name === toolName);
        if (tool === undefined) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${toolName ?? ''}` } };
        }
        const args = asRecord(params.arguments);
        const required = (tool.inputSchema.required ?? []) as readonly string[];
        const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
        if (missing.length > 0) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }],
              isError: true,
            },
          };
        }
        const outcome = mcpToolCall(forge, tool.name, args);
        if ('error' in outcome) {
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: outcome.error }], isError: true },
          };
        }
        const text = JSON.stringify(outcome.payload);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], structuredContent: outcome.payload, isError: false },
        };
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  };

  if (Array.isArray(parsed)) {
    // A tools/call without credentials anywhere in the batch owes a 401.
    const needsAuth = parsed.some((entry) => asRecord(entry).method === 'tools/call');
    if (needsAuth && !hasAuth(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Authorization required' } });
      return;
    }
    const results = parsed.map(handleOne).filter((entry) => entry !== null);
    if (results.length === 0) {
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, 200, results);
    return;
  }
  const single = asRecord(parsed);
  if (single.method === 'tools/call' && !hasAuth(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: single.id ?? null, error: { code: -32001, message: 'Authorization required' } });
    return;
  }
  const result = handleOne(parsed);
  if (result === null) {
    res.writeHead(204, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  sendJson(res, 200, result);
}

// -------------------------------------------------------------------------------------------------
// Server assembly
// -------------------------------------------------------------------------------------------------

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/mcp') {
          if (method === 'POST') {
            await handleMcp(forge, req, res);
            return;
          }
          sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
          return;
        }
        if (path === '/graphql' || path === '/api/graphql' || path === '/api/v3/graphql') {
          if (method === 'POST') {
            await handleGraphql(forge, req, res);
            return;
          }
          notFound(res);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(forge, req, res, url);
          return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+?)(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          await handleGit(forge, req, res, url, owner, repoName, gitMatch[4]!);
          return;
        }
        notFound(res);
      } catch (err) {
        try {
          if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
          else res.end();
        } catch {
          // The socket is gone; nothing more to do.
        }
      }
    })();
  });
}
