/**
 * In-memory fixture data for the mock GitHub MCP server (mock/mock-github.ts).
 *
 * One known repository: acme/api. Anything else is "not found".
 * State is module-level and mutable — writes go through the mutators below.
 * Integration tests restore pristine state with resetFixtures().
 */

export type IssueState = 'open' | 'closed';
export type PullRequestState = 'open' | 'closed' | 'merged';
/** State filter accepted by the list_* accessors ('all' returns everything). */
export type StateFilter = 'open' | 'closed' | 'all';

export interface Issue {
  number: number;
  title: string;
  state: IssueState;
  body: string;
  labels: string[];
  comments_count: number;
}

export interface IssueComment {
  id: number;
  user: string;
  body: string;
}

export interface PullRequest {
  number: number;
  title: string;
  state: PullRequestState;
  head_ref: string;
  base_ref: string;
  body: string;
  changed_files: number;
}

export const FIXTURE_OWNER = 'acme';
export const FIXTURE_REPO = 'api';

export function isKnownRepo(owner: string, repo: string): boolean {
  return owner === FIXTURE_OWNER && repo === FIXTURE_REPO;
}

// ---------------------------------------------------------------------------
// File and diff blobs
// ---------------------------------------------------------------------------

const LIMITER_TS = `/** Token-bucket rate limiter used by the API gateway. */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillIntervalMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.lastRefillMs;
    const refilled = Math.floor(elapsedMs / this.refillIntervalMs) - 1;
    if (refilled > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refilled);
      this.lastRefillMs = nowMs;
    }
  }

  tryAcquire(nowMs: number = Date.now()): boolean {
    this.refill(nowMs);
    if (this.tokens === 0) return false;
    this.tokens -= 1;
    return true;
  }
}
`;

const README_MD = `# acme/api

Acme's internal HTTP API. Rate limiting, retries, and auth live here.

## Development

Run npm install, then npm test.
`;

const PR_5_DIFF = `diff --git a/src/middleware/retry.ts b/src/middleware/retry.ts
new file mode 100644
index 0000000..7f3a2b1
--- /dev/null
+++ b/src/middleware/retry.ts
@@ -0,0 +1,8 @@
+export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
+  let lastError: unknown;
+  for (let attempt = 0; attempt < attempts; attempt++) {
+    try { return await fn(); } catch (error) { lastError = error; }
+    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100));
+  }
+  throw lastError;
+}
`;

const PR_7_DIFF = `diff --git a/src/limiter.ts b/src/limiter.ts
index 4c8b1de..a9f31c2 100644
--- a/src/limiter.ts
+++ b/src/limiter.ts
@@ -14,10 +14,10 @@ export class TokenBucket {
   private refill(nowMs: number): void {
     const elapsedMs = nowMs - this.lastRefillMs;
-    const refilled = Math.floor(elapsedMs / this.refillIntervalMs) - 1;
+    const refilled = Math.floor(elapsedMs / this.refillIntervalMs);
     if (refilled > 0) {
       this.tokens = Math.min(this.capacity, this.tokens + refilled);
-      this.lastRefillMs = nowMs;
+      this.lastRefillMs += refilled * this.refillIntervalMs;
     }
   }
`;

const PR_8_DIFF = `diff --git a/package.json b/package.json
index 91c0f2e..b04d3aa 100644
--- a/package.json
+++ b/package.json
@@ -12,8 +12,8 @@
   "dependencies": {
-    "express": "^4.18.2",
-    "pino": "^8.16.0",
+    "express": "^4.19.2",
+    "pino": "^9.3.1",
     "zod": "^3.23.8"
   },
`;

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------

interface FixtureState {
  issues: Issue[];
  commentsByIssue: Map<number, IssueComment[]>;
  pullRequests: PullRequest[];
  diffsByPull: Map<number, string>;
  filesByPath: Map<string, string>;
  nextCommentId: number;
}

function pristineState(): FixtureState {
  return {
    issues: [
      {
        number: 41,
        title: 'Login flow flaky on Safari',
        state: 'open',
        body:
          'Login intermittently fails on Safari 16/17: the auth request times out ' +
          'after ~10s and the session is never established. A retry usually succeeds.',
        labels: ['bug'],
        comments_count: 1,
      },
      {
        number: 42,
        title: 'Rate limiter drops burst traffic',
        state: 'open',
        body: 'Token bucket refill is off by one; see PR #7.',
        labels: ['bug', 'p1'],
        comments_count: 2,
      },
      {
        number: 43,
        title: 'Docs typo',
        state: 'closed',
        body: 'README says "rate limitting" in the intro.',
        labels: ['docs'],
        comments_count: 0,
      },
    ],
    commentsByIssue: new Map<number, IssueComment[]>([
      [
        41,
        [
          {
            id: 3101,
            user: 'quinn',
            body:
              'Seeing this too on Safari 17.4 — the /auth/session request ' +
              'intermittently times out after ~10s; a retry succeeds.',
          },
        ],
      ],
      [
        42,
        [
          { id: 3201, user: 'mara', body: 'Repro: 100 rps for 10s, ~3% dropped' },
          { id: 3202, user: 'devon', body: 'Fix in flight on fix/rate-limiter' },
        ],
      ],
      [43, []],
    ]),
    pullRequests: [
      {
        number: 5,
        title: 'Add retry middleware',
        state: 'merged',
        head_ref: 'feat/retry',
        base_ref: 'main',
        body: 'Adds withRetry() with exponential backoff and wires it into outbound HTTP calls.',
        changed_files: 2,
      },
      {
        number: 7,
        title: 'Fix token bucket refill',
        state: 'open',
        head_ref: 'fix/rate-limiter',
        base_ref: 'main',
        body: 'Closes #42. Off-by-one in refill window.',
        changed_files: 3,
      },
      {
        number: 8,
        title: 'Bump dependencies',
        state: 'open',
        head_ref: 'chore/deps',
        base_ref: 'main',
        body: 'Routine dependency bumps; no code changes.',
        changed_files: 12,
      },
    ],
    diffsByPull: new Map<number, string>([
      [5, PR_5_DIFF],
      [7, PR_7_DIFF],
      [8, PR_8_DIFF],
    ]),
    filesByPath: new Map<string, string>([
      ['src/limiter.ts', LIMITER_TS],
      ['README.md', README_MD],
    ]),
    nextCommentId: 5001,
  };
}

let db: FixtureState = pristineState();

/** Restore pristine fixture state. Integration tests rely on this. */
export function resetFixtures(): void {
  db = pristineState();
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getIssue(issueNumber: number): Issue | undefined {
  return db.issues.find((issue) => issue.number === issueNumber);
}

export function listIssues(state: StateFilter = 'open'): Issue[] {
  if (state === 'all') return [...db.issues];
  return db.issues.filter((issue) => issue.state === state);
}

/** Returns undefined when the issue itself is unknown; [] when it has no comments. */
export function getIssueComments(issueNumber: number): IssueComment[] | undefined {
  const comments = db.commentsByIssue.get(issueNumber);
  return comments === undefined ? undefined : [...comments];
}

export function listPullRequests(state: StateFilter = 'open'): PullRequest[] {
  if (state === 'all') return [...db.pullRequests];
  if (state === 'closed') {
    // GitHub reports merged PRs as closed.
    return db.pullRequests.filter((pr) => pr.state === 'closed' || pr.state === 'merged');
  }
  return db.pullRequests.filter((pr) => pr.state === 'open');
}

export function getPullRequest(pullNumber: number): PullRequest | undefined {
  return db.pullRequests.find((pr) => pr.number === pullNumber);
}

export function getPullRequestDiff(pullNumber: number): string | undefined {
  return db.diffsByPull.get(pullNumber);
}

export function getFileContents(path: string): string | undefined {
  return db.filesByPath.get(path);
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

/** Issues and PRs share one number space, like GitHub. */
function nextNumber(): number {
  const used = [
    ...db.issues.map((issue) => issue.number),
    ...db.pullRequests.map((pr) => pr.number),
  ];
  return Math.max(...used) + 1;
}

export function createIssue(title: string, body?: string): Issue {
  const issue: Issue = {
    number: nextNumber(),
    title,
    state: 'open',
    body: body ?? '',
    labels: [],
    comments_count: 0,
  };
  db.issues.push(issue);
  db.commentsByIssue.set(issue.number, []);
  return issue;
}

/** Returns undefined when the issue is unknown. */
export function addIssueComment(issueNumber: number, body: string): IssueComment | undefined {
  const issue = getIssue(issueNumber);
  if (!issue) return undefined;
  const comment: IssueComment = { id: db.nextCommentId++, user: 'mock-user', body };
  const comments = db.commentsByIssue.get(issueNumber);
  if (comments) {
    comments.push(comment);
  } else {
    db.commentsByIssue.set(issueNumber, [comment]);
  }
  issue.comments_count += 1;
  return comment;
}

/** Returns undefined when the PR is unknown; otherwise flips state to 'merged'. */
export function mergePullRequest(pullNumber: number): PullRequest | undefined {
  const pr = getPullRequest(pullNumber);
  if (!pr) return undefined;
  pr.state = 'merged';
  return pr;
}
