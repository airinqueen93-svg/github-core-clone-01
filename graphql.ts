// graphql.ts — a small GraphQL engine for the forge: a lexer/parser for the document subset the
// GitHub v4 API surface needs (operations, variables, aliases, arguments with input objects and
// enums, inline and named fragments), and an executor over the forge state with GitHub-shaped
// types, Relay node ids, connections with cursor pagination, mutations, and partial introspection.

import type { Forge, RepoRec, IssueRec, PullRec } from './store.ts';
import { pullFiles, pullMergeable, mergePull } from './store.ts';

// -------------------------------------------------------------------------------------------------
// Lexer / parser
// -------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&='.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const value = source.slice(i + 3, end === -1 ? source.length : end);
        tokens.push({ kind: 'string', value });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      const text = source.slice(i, j);
      tokens.push(text.includes('.') || text.includes('e') || text.includes('E') ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { $enum: string }
  | { $var: string };

export interface FieldNode {
  name: string;
  alias?: string;
  args: Record<string, GqlValue>;
  selection?: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().kind === 'punct') this.skipVariableDefinitionsAndDirectives();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition "${keyword}"`);
      }
    }
    return { operations, fragments };
  }

  private skipVariableDefinitionsAndDirectives(): void {
    if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '(') {
      let depth = 0;
      do {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        else if (token.kind === 'punct' && token.value === ')') depth -= 1;
      } while (depth > 0 && this.peek().kind !== 'eof');
    }
    this.skipDirectives();
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '(') this.skipVariableDefinitionsAndDirectives();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'spread') {
        this.next();
        const nameToken = this.peek();
        if (nameToken.kind === 'name' && nameToken.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.expectName() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '(') {
      this.next();
      for (;;) {
        if (this.skipPunct(')')) break;
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    this.skipDirectives();
    let selection: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { name, alias, args, selection };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    switch (token.kind) {
      case 'string':
        return token.value;
      case 'int':
      case 'float':
        return token.value;
      case 'name':
        if (token.value === 'true') return true;
        if (token.value === 'false') return false;
        if (token.value === 'null') return null;
        return { $enum: token.value };
      case 'punct':
        if (token.value === '$') return { $var: this.expectName() };
        if (token.value === '[') {
          const items: GqlValue[] = [];
          for (;;) {
            if (this.skipPunct(']')) return items;
            items.push(this.parseValue());
          }
        }
        if (token.value === '{') {
          const obj: Record<string, GqlValue> = {};
          for (;;) {
            if (this.skipPunct('}')) return obj;
            const key = this.expectName();
            this.expectPunct(':');
            obj[key] = this.parseValue();
          }
        }
        throw new Error(`unexpected "${token.value}" in value`);
      default:
        throw new Error('unexpected token in value');
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Values, ids, connections
// -------------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(value: GqlValue, variables: Variables): unknown {
  if (value !== null && typeof value === 'object') {
    if ('$var' in value) return variables[(value as { $var: string }).$var];
    if ('$enum' in value) return (value as { $enum: string }).$enum;
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = resolveValue(inner, variables);
    return out;
  }
  return value;
}

export function nodeId(type: string, dbId: number): string {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64');
}

export function decodeNodeId(id: string): { type: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1]!, dbId: Number(match[2]) };
  } catch {
    return null;
  }
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

interface ConnectionArgs {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

function paginate<T>(items: readonly T[], args: ConnectionArgs): { page: T[]; startIndex: number; hasNextPage: boolean; hasPreviousPage: boolean } {
  let start = 0;
  if (args.after !== undefined) start = indexFromCursor(args.after) + 1;
  let end = items.length;
  if (args.before !== undefined) {
    const idx = indexFromCursor(args.before);
    if (idx >= 0) end = idx;
  }
  let slice = items.slice(start, end);
  let hasNextPage = false;
  let hasPreviousPage = start > 0;
  if (args.first !== undefined && slice.length > args.first) {
    slice = slice.slice(0, args.first);
    hasNextPage = true;
  }
  if (args.last !== undefined && slice.length > args.last) {
    slice = slice.slice(slice.length - args.last);
    hasPreviousPage = true;
  }
  return { page: slice, startIndex: start, hasNextPage, hasPreviousPage };
}

// -------------------------------------------------------------------------------------------------
// Introspection data
// -------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'user', 'organization', 'rateLimit', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository', '__typename'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', 'bio', 'company', 'location', 'createdAt', 'updatedAt', '__typename'],
  Organization: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', 'createdAt', 'updatedAt', '__typename'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'isPrivate', 'isFork', 'isArchived', 'isTemplate', 'description', 'homepageUrl', 'url', 'sshUrl', 'createdAt', 'updatedAt', 'pushedAt', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'hasWikiEnabled', 'hasProjectsEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'label', 'refs', 'ref', 'object', 'branchProtectionRules', 'assignableUsers', 'mentionableUsers', 'stargazerCount', 'forkCount', 'watchers', 'primaryLanguage', 'licenseInfo', 'languages', 'milestone', 'milestones', 'repositoryTopics', '__typename'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'closed', 'locked', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'editor', 'labels', 'assignees', 'comments', 'participants', 'repository', 'milestone', 'reactionGroups', 'viewerDidAuthor', 'viewerCanReact', 'viewerCanUpdate', 'viewerSubscription', '__typename'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'merged', 'mergedAt', 'closed', 'locked', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'editor', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'headRepository', 'baseRepository', 'mergeable', 'mergeStateStatus', 'mergeCommit', 'potentialMergeCommit', 'files', 'commits', 'comments', 'reviews', 'labels', 'assignees', 'participants', 'repository', 'additions', 'deletions', 'changedFiles', 'isDraft', 'viewerDidAuthor', '__typename'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType', '__typename'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt', 'author', 'editor', '__typename'],
  Label: ['id', 'name', 'color', 'description', 'url', '__typename'],
  Ref: ['id', 'name', 'prefix', 'target', '__typename'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'authoredDate', 'tree', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  Permission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  FileChangeType: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// -------------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------------

interface GqlError {
  message: string;
}

interface Ctx {
  forge: Forge;
  variables: Variables;
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
  errors: GqlError[];
}

interface Obj {
  __type: string;
  [key: string]: unknown;
}

function userObj(forge: Forge, login: string): Obj {
  const user = forge.user(login);
  return {
    __type: user?.type ?? 'User',
    id: nodeId(user?.type ?? 'User', user?.id ?? 0),
    databaseId: user?.id ?? 0,
    login: user?.login ?? login,
    name: user?.name ?? login,
    email: user?.email ?? '',
    avatarUrl: '',
    url: `https://github.com/${user?.login ?? login}`,
    bio: null,
    company: null,
    location: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function repoObj(forge: Forge, repo: RepoRec): Obj {
  return {
    __type: 'Repository',
    id: nodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    ownerLogin: repo.owner,
    isPrivate: repo.isPrivate,
    isFork: false,
    isArchived: false,
    isTemplate: false,
    description: repo.description,
    homepageUrl: null,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    sshUrl: `git@github.com:${repo.owner}/${repo.name}.git`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    pushedAt: repo.updatedAt,
    viewerPermission: repo.owner === forge.viewerLogin ? 'ADMIN' : 'READ',
    hasIssuesEnabled: true,
    hasPullRequestsEnabled: true,
    hasWikiEnabled: true,
    hasProjectsEnabled: true,
    stargazerCount: 0,
    forkCount: 0,
    _repo: repo,
  };
}

function issueObj(repo: RepoRec, issue: IssueRec): Obj {
  return {
    __type: 'Issue',
    id: nodeId('Issue', issue.nodeDbId),
    databaseId: issue.nodeDbId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    bodyText: issue.body ?? '',
    state: issue.state.toUpperCase(),
    closed: issue.state === 'closed',
    locked: false,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.state === 'closed' ? issue.updatedAt : null,
    authorLogin: issue.authorLogin,
    _repo: repo,
    _issue: issue,
  };
}

function pullObj(forge: Forge, repo: RepoRec, pull: PullRec): Obj {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const files = pullFiles(repo, pull);
  return {
    __type: 'PullRequest',
    id: nodeId('PullRequest', pull.nodeDbId),
    databaseId: pull.nodeDbId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    bodyText: pull.body ?? '',
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    closed: pull.state === 'closed',
    locked: false,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.state === 'closed' ? pull.updatedAt : null,
    authorLogin: pull.authorLogin,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: headTip ?? null,
    baseRefOid: baseTip ?? null,
    mergeable: pull.merged ? 'MERGEABLE' : pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    mergeStateStatus: pull.merged ? 'CLEAN' : pullMergeable(repo, pull) ? 'CLEAN' : 'DIRTY',
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    changedFiles: files.length,
    isDraft: false,
    viewerDidAuthor: pull.authorLogin === forge.viewerLogin,
    _repo: repo,
    _pull: pull,
  };
}

function commentObj(repo: RepoRec, comment: { id: number; body: string; authorLogin: string; createdAt: string; updatedAt: string }): Obj {
  return {
    __type: 'IssueComment',
    id: nodeId('IssueComment', comment.id),
    databaseId: comment.id,
    body: comment.body,
    bodyText: comment.body,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${comment.id}`,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    authorLogin: comment.authorLogin,
  };
}

function connection(items: Obj[], args: Record<string, unknown>): Obj {
  const { page, startIndex, hasNextPage, hasPreviousPage } = paginate(items, {
    first: typeof args.first === 'number' ? args.first : undefined,
    after: typeof args.after === 'string' ? args.after : undefined,
    last: typeof args.last === 'number' ? args.last : undefined,
    before: typeof args.before === 'string' ? args.before : undefined,
  });
  return {
    __type: 'Connection',
    _nodes: page,
    _edges: page.map((node, i) => ({ __type: 'Edge', node, cursor: cursorFor(startIndex + i) })),
    _pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage,
      startCursor: page.length > 0 ? cursorFor(startIndex) : null,
      endCursor: page.length > 0 ? cursorFor(startIndex + page.length - 1) : null,
    },
    totalCount: items.length,
  };
}

function typeObj(name: string): Obj | null {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  return {
    __type: '__Type',
    name,
    kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
    _fields: (fields ?? []).map((fieldName) => ({ __type: '__Field', name: fieldName, description: null, isDeprecated: false, deprecationReason: null })),
    _enumValues: (enumValues ?? []).map((valueName) => ({ __type: '__EnumValue', name: valueName, description: null, isDeprecated: false, deprecationReason: null })),
  };
}

type Resolver = (ctx: Ctx, source: Obj | null, args: Record<string, unknown>) => unknown;

const resolvers: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => userObj(ctx.forge, ctx.forge.viewerLogin),
    repository: (ctx, _s, args) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = ctx.forge.repo(owner, name);
      return repo === undefined ? null : repoObj(ctx.forge, repo);
    },
    user: (ctx, _s, args) => {
      const login = String(args.login ?? '');
      return ctx.forge.user(login) === undefined ? null : userObj(ctx.forge, login);
    },
    organization: (ctx, _s, args) => {
      const login = String(args.login ?? '');
      const user = ctx.forge.user(login);
      return user !== undefined && user.type === 'Organization' ? userObj(ctx.forge, login) : null;
    },
    node: (ctx, _s, args) => {
      const decoded = decodeNodeId(String(args.id ?? ''));
      if (decoded === null) return null;
      return nodeById(ctx, decoded.type, decoded.dbId);
    },
    nodes: (ctx, _s, args) => {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      return ids.map((id) => {
        const decoded = decodeNodeId(String(id ?? ''));
        return decoded === null ? null : nodeById(ctx, decoded.type, decoded.dbId);
      });
    },
    __type: (_ctx, _s, args) => typeObj(String(args.name ?? '')),
    __schema: () => ({
      __type: '__Schema',
      queryType: { __type: '__Type', name: 'Query' },
      mutationType: { __type: '__Type', name: 'Mutation' },
      subscriptionType: null,
      _types: Object.keys(TYPE_FIELDS).map((name) => typeObj(name)),
    }),
    rateLimit: () => ({ __type: 'RateLimit', limit: 5000, remaining: 4999, used: 1, resetAt: '2027-01-01T00:00:00Z', cost: 1 }),
  },
  Mutation: {
    createIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeNodeId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoByDbId(ctx.forge, decoded.dbId) : undefined;
      if (repo === undefined) throw new Error('createIssue: repository not found');
      const stamp = ctx.forge.now();
      const issue: IssueRec = {
        nodeDbId: ctx.forge.allocNodeDbId(),
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: input.body === undefined || input.body === null ? null : String(input.body),
        state: 'open',
        labels: [],
        authorLogin: ctx.forge.viewerLogin,
        createdAt: stamp,
        updatedAt: stamp,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { __type: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByNodeId(ctx, String(input.issueId ?? ''));
      if (found === undefined) throw new Error('closeIssue: issue not found');
      found.issue.state = 'closed';
      found.issue.updatedAt = ctx.forge.now();
      return { __type: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    },
    reopenIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByNodeId(ctx, String(input.issueId ?? ''));
      if (found === undefined) throw new Error('reopenIssue: issue not found');
      found.issue.state = 'open';
      found.issue.updatedAt = ctx.forge.now();
      return { __type: 'ReopenIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeNodeId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoByDbId(ctx.forge, decoded.dbId) : undefined;
      if (repo === undefined) throw new Error('createPullRequest: repository not found');
      const headRefName = String(input.headRefName ?? '');
      const baseRefName = String(input.baseRefName ?? '');
      if (repo.refs.get(`refs/heads/${headRefName}`) === undefined) throw new Error(`createPullRequest: head ref ${headRefName} does not exist`);
      if (repo.refs.get(`refs/heads/${baseRefName}`) === undefined) throw new Error(`createPullRequest: base ref ${baseRefName} does not exist`);
      const stamp = ctx.forge.now();
      const pull: PullRec = {
        nodeDbId: ctx.forge.allocNodeDbId(),
        number: repo.nextNumber,
        title: input.title === undefined || input.title === null ? `Pull request from ${headRefName}` : String(input.title),
        body: input.body === undefined || input.body === null ? null : String(input.body),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: headRefName,
        baseRef: baseRefName,
        authorLogin: ctx.forge.viewerLogin,
        createdAt: stamp,
        updatedAt: stamp,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(ctx.forge, repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullByNodeId(ctx, String(input.pullRequestId ?? ''));
      if (found === undefined) throw new Error('mergePullRequest: pull request not found');
      const { repo, pull } = found;
      if (!pull.merged) {
        const method = String(input.mergeMethod ?? 'MERGE') === 'SQUASH' ? 'squash' : 'merge';
        const sha = mergePull(ctx.forge, repo, pull, method);
        if (sha === null) throw new Error('mergePullRequest: pull request is not mergeable');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = ctx.forge.now();
        pull.mergeCommitSha = sha;
        pull.updatedAt = pull.mergedAt;
      }
      return { __type: 'MergePullRequestPayload', pullRequest: pullObj(ctx.forge, repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = String(input.subjectId ?? '');
      const body = String(input.body ?? '');
      const stamp = ctx.forge.now();
      const comment = { id: ctx.forge.allocCommentId(), body, authorLogin: ctx.forge.viewerLogin, createdAt: stamp, updatedAt: stamp };
      const issueFound = findIssueByNodeId(ctx, subjectId);
      if (issueFound !== undefined) {
        issueFound.issue.comments.push(comment);
        const node = commentObj(issueFound.repo, comment);
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'Edge', node, cursor: cursorFor(0) }, clientMutationId: input.clientMutationId ?? null };
      }
      const pullFound = findPullByNodeId(ctx, subjectId);
      if (pullFound !== undefined) {
        pullFound.pull.comments.push(comment);
        const node = commentObj(pullFound.repo, comment);
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'Edge', node, cursor: cursorFor(0) }, clientMutationId: input.clientMutationId ?? null };
      }
      throw new Error('addComment: subject not found');
    },
  },
  Repository: {
    owner: (ctx, source) => userObj(ctx.forge, String(source!.ownerLogin)),
    defaultBranchRef: (ctx, source) => {
      const repo = source!._repo as RepoRec;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return {
        __type: 'Ref',
        id: nodeId('Ref', repo.id),
        name: repo.defaultBranch,
        prefix: 'refs/heads/',
        target: tip === undefined ? null : { __type: 'Commit', id: tip, oid: tip },
        _repo: repo,
      };
    },
    issue: (ctx, source, args) => {
      const repo = source!._repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (ctx, source, args) => {
      const repo = source!._repo as RepoRec;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      if (states !== undefined) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      const direction = orderBy.direction === 'ASC' ? 1 : -1;
      issues.sort((a, b) => {
        const byTime = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        if (byTime !== 0) return byTime * direction;
        return (a.number - b.number) * direction;
      });
      return connection(issues.map((issue) => issueObj(repo, issue)), args);
    },
    pullRequest: (ctx, source, args) => {
      const repo = source!._repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullObj(ctx.forge, repo, pull);
    },
    pullRequests: (ctx, source, args) => {
      const repo = source!._repo as RepoRec;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      if (states !== undefined) {
        pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      pulls.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.number - a.number));
      return connection(pulls.map((pull) => pullObj(ctx.forge, repo, pull)), args);
    },
    labels: (ctx, source, args) => {
      const repo = source!._repo as RepoRec;
      const labels = [...repo.labels.values()].map((label) => ({
        __type: 'Label',
        id: nodeId('Label', label.id),
        name: label.name,
        color: label.color,
        description: label.description,
        url: '',
      }));
      return connection(labels, args);
    },
  },
  Issue: {
    author: (ctx, source) => userObj(ctx.forge, String(source!.authorLogin)),
    editor: (ctx, source) => userObj(ctx.forge, String(source!.authorLogin)),
    repository: (ctx, source) => repoObj(ctx.forge, source!._repo as RepoRec),
    labels: (ctx, source, args) => {
      const repo = source!._repo as RepoRec;
      const issue = source!._issue as IssueRec;
      const labels = issue.labels
        .map((name) => repo.labels.get(name))
        .filter((label) => label !== undefined)
        .map((label) => ({ __type: 'Label', id: nodeId('Label', label!.id), name: label!.name, color: label!.color, description: label!.description, url: '' }));
      return connection(labels, args);
    },
    comments: (ctx, source, args) => {
      const repo = source!._repo as RepoRec;
      const issue = source!._issue as IssueRec;
      return connection(issue.comments.map((comment) => commentObj(repo, comment)), args);
    },
    assignees: (_ctx, _s, args) => connection([], args),
    participants: (_ctx, _s, args) => connection([], args),
  },
  PullRequest: {
    author: (ctx, source) => userObj(ctx.forge, String(source!.authorLogin)),
    editor: (ctx, source) => userObj(ctx.forge, String(source!.authorLogin)),
    repository: (ctx, source) => repoObj(ctx.forge, source!._repo as RepoRec),
    files: (ctx, source, args) => {
      const repo = source!._repo as RepoRec;
      const pull = source!._pull as PullRec;
      const files = pullFiles(repo, pull).map((file) => ({
        __type: 'PullRequestFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status.toUpperCase(),
      }));
      return connection(files, args);
    },
    comments: (ctx, source, args) => {
      const repo = source!._repo as RepoRec;
      const pull = source!._pull as PullRec;
      return connection(pull.comments.map((comment) => commentObj(repo, comment)), args);
    },
    labels: (ctx, source, args) => connection([], args),
    assignees: (_ctx, _s, args) => connection([], args),
    participants: (_ctx, _s, args) => connection([], args),
    mergeCommit: (ctx, source) => {
      const pull = source!._pull as PullRec;
      return pull.mergeCommitSha === null ? null : { __type: 'Commit', id: pull.mergeCommitSha, oid: pull.mergeCommitSha };
    },
    potentialMergeCommit: () => null,
    headRef: (ctx, source) => refObj(ctx, source!, 'headRefName'),
    baseRef: (ctx, source) => refObj(ctx, source!, 'baseRefName'),
  },
  Ref: {
    target: (_ctx, source) => source!.target ?? null,
  },
  Connection: {
    nodes: (_ctx, source) => source!._nodes,
    edges: (_ctx, source) => source!._edges,
    pageInfo: (_ctx, source) => source!._pageInfo,
    totalCount: (_ctx, source) => source!.totalCount,
  },
  __Type: {
    fields: (_ctx, source) => source!._fields ?? [],
    enumValues: (_ctx, source) => source!._enumValues ?? [],
    possibleTypes: () => [],
    inputFields: () => [],
    interfaces: () => [],
    ofType: () => null,
  },
  __Schema: {
    types: (_ctx, source) => source!._types ?? [],
    directives: () => [],
  },
  CreateIssuePayload: {},
  CloseIssuePayload: {},
  ReopenIssuePayload: {},
  CreatePullRequestPayload: {},
  MergePullRequestPayload: {},
  AddCommentPayload: {},
};

function refObj(ctx: Ctx, pullSource: Obj, which: 'headRefName' | 'baseRefName'): Obj | null {
  const repo = pullSource._repo as RepoRec;
  const name = String(pullSource[which]);
  const tip = repo.refs.get(`refs/heads/${name}`);
  if (tip === undefined) return null;
  return {
    __type: 'Ref',
    id: nodeId('Ref', repo.id),
    name,
    prefix: 'refs/heads/',
    target: { __type: 'Commit', id: tip, oid: tip },
    _repo: repo,
  };
}

function findRepoByDbId(forge: Forge, dbId: number): RepoRec | undefined {
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}

function findIssueByNodeId(ctx: Ctx, id: string): { repo: RepoRec; issue: IssueRec } | undefined {
  const decoded = decodeNodeId(id);
  if (decoded === null || decoded.type !== 'Issue') return undefined;
  for (const repo of ctx.forge.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.nodeDbId === decoded.dbId) return { repo, issue };
  }
  return undefined;
}

function findPullByNodeId(ctx: Ctx, id: string): { repo: RepoRec; pull: PullRec } | undefined {
  const decoded = decodeNodeId(id);
  if (decoded === null || decoded.type !== 'PullRequest') return undefined;
  for (const repo of ctx.forge.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.nodeDbId === decoded.dbId) return { repo, pull };
  }
  return undefined;
}

function nodeById(ctx: Ctx, type: string, dbId: number): Obj | null {
  if (type === 'Repository') {
    const repo = findRepoByDbId(ctx.forge, dbId);
    return repo === undefined ? null : repoObj(ctx.forge, repo);
  }
  if (type === 'Issue') {
    const found = findIssueByNodeId(ctx, nodeId('Issue', dbId));
    return found === undefined ? null : issueObj(found.repo, found.issue);
  }
  if (type === 'PullRequest') {
    const found = findPullByNodeId(ctx, nodeId('PullRequest', dbId));
    return found === undefined ? null : pullObj(ctx.forge, found.repo, found.pull);
  }
  if (type === 'User' || type === 'Organization') {
    for (const user of ctx.forge.users.values()) if (user.id === dbId) return userObj(ctx.forge, user.login);
    return null;
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// Selection execution
// -------------------------------------------------------------------------------------------------

function executeSelection(ctx: Ctx, source: Obj | null, typeName: string, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (source !== null && source.__type === selection.typeCondition) {
        Object.assign(out, executeSelection(ctx, source, selection.typeCondition, selection.selection));
      } else if (source === null && typeName === selection.typeCondition) {
        Object.assign(out, executeSelection(ctx, source, selection.typeCondition, selection.selection));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (source === null || source.__type === fragment.typeCondition)) {
        Object.assign(out, executeSelection(ctx, source, fragment.typeCondition, fragment.selection));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    out[key] = executeField(ctx, source, typeName, field);
  }
  return out;
}

function executeField(ctx: Ctx, source: Obj | null, typeName: string, field: FieldNode): unknown {
  if (field.name === '__typename') return source?.__type ?? typeName;
  const args: Record<string, unknown> = {};
  for (const [argName, argValue] of Object.entries(field.args)) args[argName] = resolveValue(argValue, ctx.variables);
  const typeResolvers = resolvers[typeName] ?? {};
  const resolver = typeResolvers[field.name];
  let value: unknown;
  if (resolver !== undefined) {
    try {
      value = resolver(ctx, source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  } else if (source !== null && field.name in source && !field.name.startsWith('_')) {
    value = source[field.name];
  } else {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  return completeValue(ctx, value, field);
}

function completeValue(ctx: Ctx, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, field));
  if (typeof value === 'object') {
    const obj = value as Obj;
    if (field.selection !== undefined) return executeSelection(ctx, obj, obj.__type, field.selection);
    return value;
  }
  return value;
}

export interface GqlResponse {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
}

/** Execute one GraphQL document (one operation) against the forge. */
export function executeGraphql(forge: Forge, query: string, variables: Variables, operationName?: string): GqlResponse {
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operationName !== undefined
    ? document.operations.find((op) => op.name === operationName) ?? document.operations[0]
    : document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, { __type: rootType }, rootType, operation.selection);
  const response: GqlResponse = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}
