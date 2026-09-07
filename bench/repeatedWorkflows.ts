export const REPEATED_WORKFLOW_IDS = [
  'ci-investigation',
  'pr-review',
  'issue-triage',
  'renamed-transfer',
  'negative-control',
] as const;

export type RepeatedWorkflowId = (typeof REPEATED_WORKFLOW_IDS)[number];

export interface RepeatedStep {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  thinkMs: number;
}

export interface RepeatedWorkflowSession {
  id: RepeatedWorkflowId;
  version: number;
  seed: number;
  session: number;
  phase: 'train' | 'holdout';
  fixtureIds: string[];
  orderToken: string;
  steps: RepeatedStep[];
}

function assertCoordinate(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function randomFor(seed: number, session: number, salt: number): () => number {
  let state = (seed ^ Math.imul(session + 1, 0x9e3779b1) ^ salt) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function ordered<T>(values: readonly T[], reverse: boolean): T[] {
  return reverse ? [...values].reverse() : [...values];
}

function step(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  thinkMs: number,
): RepeatedStep {
  return { tool, args, result, thinkMs };
}

export function generateRepeatedWorkflow(
  id: RepeatedWorkflowId,
  seed: number,
  session: number,
  trainSessions: number,
): RepeatedWorkflowSession {
  assertCoordinate(seed, 'seed');
  assertCoordinate(session, 'session');
  assertCoordinate(trainSessions, 'trainSessions');
  const phase = session < trainSessions ? 'train' : 'holdout';
  const reverse = (seed + session) % 2 === 0;
  const flag = (seed * 3 + session) % 2 === 0;
  const prefix = `${phase === 'train' ? 'tr' : 'ho'}-${seed}-${session}`;
  const repo = `acme/service-${seed % 3}`;
  let fixtureIds: string[];
  let steps: RepeatedStep[];

  if (id === 'ci-investigation') {
    const runIds = [`run-${prefix}-a`, `run-${prefix}-b`];
    const runs = ordered(runIds, reverse);
    const runId = runs[0]!;
    const jobId = `job-${prefix}-${flag ? 'x' : 'y'}`;
    fixtureIds = [...runIds, jobId];
    steps = [
      step(
        'list_workflow_runs',
        { repository: repo, branch: `feature/${seed}-${session}`, status: 'failure' },
        { runs: runs.map((value, index) => ({ id: value, failed: index === 0 ? flag : !flag })) },
        150,
      ),
      step(
        'get_workflow_run',
        { repository: repo, runId },
        { id: runId, failed: flag, conclusion: flag ? 'failure' : 'cancelled', jobs: [{ id: jobId }] },
        45,
      ),
      step(
        'list_workflow_jobs',
        { repository: repo, runId },
        { jobs: [{ id: jobId, failed: flag }] },
        flag ? 135 : 55,
      ),
      ...(flag
        ? [step('get_workflow_job', { repository: repo, jobId }, { id: jobId, step: 'test' }, 80)]
        : [step('list_workflow_artifacts', { repository: repo, runId }, { artifacts: [] }, 80)]),
      step(
        'get_workflow_logs',
        { repository: repo, runId },
        { runId, lines: [`failure in ${jobId}`] },
        0,
      ),
    ];
  } else if (id === 'pr-review') {
    const pullIds = [`pr-${prefix}-17`, `pr-${prefix}-23`];
    const pulls = ordered(pullIds, reverse);
    const pullNumber = pulls[0]!;
    const checkId = `check-${prefix}-${flag ? 'lint' : 'test'}`;
    const headRef = `review/${seed}/${session}/${flag ? 'draft' : 'ready'}`;
    fixtureIds = [...pullIds, checkId];
    steps = [
      step(
        'list_pull_requests',
        { repository: repo, state: 'open', sort: reverse ? 'oldest' : 'newest' },
        { pulls: pulls.map((number, index) => ({ number, headRef: `${headRef}-${index}` })) },
        150,
      ),
      step(
        'get_pull_request',
        { repository: repo, pullNumber },
        { number: pullNumber, draft: flag, headRef, checkIds: [checkId] },
        45,
      ),
      step(
        'list_pull_checks',
        { repository: repo, ref: headRef },
        { checks: [{ id: checkId, required: !flag }] },
        flag ? 55 : 135,
      ),
      ...(flag
        ? [step('get_pull_check', { repository: repo, checkId }, { id: checkId, status: 'failed' }, 80)]
        : [step('list_pull_comments', { repository: repo, pullNumber }, { comments: [] }, 80)]),
      step(
        'get_pull_files',
        { repository: repo, pullNumber },
        { pullNumber, files: [`src/change-${session}.ts`] },
        0,
      ),
    ];
  } else if (id === 'issue-triage') {
    const issueIds = [`issue-${prefix}-a`, `issue-${prefix}-b`];
    const issues = ordered(issueIds, reverse);
    const issueId = issues[0]!;
    const userId = `user-${prefix}-${flag ? 'lead' : 'owner'}`;
    fixtureIds = [...issueIds, userId];
    steps = [
      step(
        'list_issues',
        { team: `team-${seed % 2}`, state: 'open', order: reverse ? 'priority' : 'updated' },
        { issues: issues.map((value, index) => ({ id: value, urgent: index === 0 ? flag : !flag })) },
        150,
      ),
      step(
        'get_issue',
        { issueId },
        { id: issueId, urgent: flag, assigneeId: userId, title: `Issue ${session}` },
        45,
      ),
      step('get_user', { userId }, { id: userId, name: `Owner ${session}` }, flag ? 55 : 135),
      ...(flag
        ? [step('list_team_members', { team: `team-${seed % 2}` }, { members: [{ id: userId }] }, 80)]
        : [step('get_team', { team: `team-${seed % 2}` }, { key: `team-${seed % 2}` }, 80)]),
      step(
        flag ? 'list_issue_comments' : 'list_issue_relations',
        { issueId },
        flag ? { issueId, comments: [] } : { issueId, relations: [] },
        0,
      ),
    ];
  } else if (id === 'renamed-transfer') {
    const cardIds = [`card-${prefix}-q`, `card-${prefix}-z`];
    const cards = ordered(cardIds, reverse);
    const cardKey = cards[0]!;
    const laneKey = `lane-${prefix}-${flag ? 'north' : 'south'}`;
    fixtureIds = [...cardIds, laneKey];
    steps = [
      step(
        'scan_atlas',
        { scope: `scope-${seed % 3}`, order: reverse ? 'up' : 'down' },
        { cards: cards.map((key, index) => ({ key, active: index === 0 ? flag : !flag })) },
        150,
      ),
      step('probe_card', { cardKey }, { key: cardKey, active: flag, laneKey }, 45),
      step('survey_lane', { laneKey }, { key: laneKey, occupants: [cardKey] }, flag ? 55 : 135),
      ...(flag
        ? [step('echo_lane', { laneKey }, { key: laneKey, echo: true }, 80)]
        : [step('fold_lane', { laneKey }, { key: laneKey, folded: true }, 80)]),
      step(
        flag ? 'render_card' : 'archive_card_view',
        { cardKey },
        { key: cardKey, rendered: true },
        0,
      ),
    ];
  } else {
    const random = randomFor(seed, session, 0x6e656761);
    const names = ['lookup_alpha', 'lookup_beta', 'lookup_gamma', 'lookup_delta'];
    steps = Array.from({ length: 8 }, (_, index) => {
      const nonce = `nonce-${seed}-${session}-${index}-${Math.floor(random() * 0x1_0000_0000)}`;
      return step(
        names[Math.floor(random() * names.length)]!,
        { nonce, value: Math.floor(random() * 1_000_000_000) },
        { nonce, accepted: false },
        index === 7 ? 0 : 30 + Math.floor(random() * 71),
      );
    });
    fixtureIds = steps.map((value) => String(value.args['nonce']));
  }

  return {
    id,
    version: 1,
    seed,
    session,
    phase,
    fixtureIds,
    orderToken: `${reverse ? 'reverse' : 'forward'}:${flag ? 'true' : 'false'}`,
    steps,
  };
}
