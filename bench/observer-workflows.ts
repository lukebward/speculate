export type ObserverArm = 'A' | 'B' | 'C' | 'D' | 'E';
export type ThermalState = 'cold' | 'warm';
export type WorkloadSet = 'tool-heavy' | 'mixed';
export type ObserverClient = 'claude' | 'codex';
export type ObserverPhase = 'training' | 'holdout';

export const OBSERVER_WORKFLOW_IDS = [
  'pr-review-checks',
  'pr-review-comments',
  'issue-to-code',
  'ci-failure-log',
  'ci-artifact-branch',
  'local-symbol-trace',
  'dependency-navigation',
  'issue-owner-context',
  'pr-to-ci-parallel',
  'resumed-review',
  'renamed-alias-transfer',
  'early-stream-call',
  'cold-pr-first-touch',
  'unpredictable-lookups',
  'mutation-invalidation',
  'permission-denied',
  'approval-required',
  'expired-before-demand',
  'retry-dedup',
  'cancelled-mixed-task',
] as const;

export type ObserverWorkflowId = typeof OBSERVER_WORKFLOW_IDS[number];

export interface ObserverSignals {
  intent: boolean;
  transition: boolean;
  stream: boolean;
}

export type ObserverStep =
  | { kind: 'model'; fixture: string; chunks: readonly { afterMs: number; bytes: string }[] }
  | { kind: 'hook'; fixture: string }
  | { kind: 'tool'; alias: string; tool: string; argsRef: string; thinkMs: number }
  | { kind: 'parallel'; steps: readonly Extract<ObserverStep, { kind: 'tool' }>[] }
  | { kind: 'invalidate'; alias: string; reason: string }
  | { kind: 'cancel-model'; fixture: string; afterChunks: number };

export interface ObserverWorkflow {
  id: ObserverWorkflowId;
  version: 1;
  set: WorkloadSet;
  thermalState: ThermalState;
  transports: { claude: 'messages-sse' | 'messages-json'; codex: 'responses-sse' | 'responses-websocket' };
  trainingEpisodes: number;
  steps: readonly ObserverStep[];
  expected: {
    requestedCalls: number;
    mutationCalls: number;
    permissionDecisions: readonly ('allowed' | 'denied' | 'approval-required')[];
  };
}

export interface MaterializedToolStep {
  kind: 'tool';
  alias: string;
  tool: string;
  args: Record<string, unknown>;
  thinkMs: number;
}

export interface MaterializedObserverWorkflow extends Omit<ObserverWorkflow, 'steps'> {
  phase: ObserverPhase;
  seed: number;
  repetition: number;
  steps: readonly MaterializedToolStep[];
}

type ToolSpec = readonly [alias: string, tool: string];

const specifications: Record<ObserverWorkflowId, {
  thermal: ThermalState;
  set: WorkloadSet;
  tools: readonly ToolSpec[];
  permission?: 'denied' | 'approval-required';
}> = {
  'pr-review-checks': { thermal: 'warm', set: 'tool-heavy', tools: [['github', 'list_pull_requests'], ['github', 'get_pull_request'], ['ci', 'list_checks'], ['ci', 'get_check_log'], ['workspace', 'read_file']] },
  'pr-review-comments': { thermal: 'warm', set: 'tool-heavy', tools: [['github', 'list_pull_requests'], ['github', 'get_pull_request'], ['github', 'list_pull_comments'], ['workspace', 'search_files'], ['workspace', 'read_file']] },
  'issue-to-code': { thermal: 'warm', set: 'tool-heavy', tools: [['issues', 'get_issue'], ['workspace', 'search_files'], ['workspace', 'read_file'], ['github', 'list_pull_requests']] },
  'ci-failure-log': { thermal: 'warm', set: 'tool-heavy', tools: [['ci', 'list_runs'], ['ci', 'get_run'], ['ci', 'list_jobs'], ['ci', 'get_job_log']] },
  'ci-artifact-branch': { thermal: 'warm', set: 'tool-heavy', tools: [['ci', 'list_runs'], ['ci', 'get_run'], ['ci', 'list_artifacts'], ['ci', 'get_artifact']] },
  'local-symbol-trace': { thermal: 'warm', set: 'tool-heavy', tools: [['workspace', 'search_files'], ['workspace', 'read_file'], ['workspace', 'search_symbol'], ['workspace', 'read_file']] },
  'dependency-navigation': { thermal: 'warm', set: 'tool-heavy', tools: [['workspace', 'read_file'], ['registry', 'get_package'], ['workspace', 'search_files'], ['workspace', 'read_file']] },
  'issue-owner-context': { thermal: 'warm', set: 'tool-heavy', tools: [['issues', 'get_issue'], ['directory', 'get_user'], ['chat', 'get_channel_history'], ['chat', 'get_thread']] },
  'pr-to-ci-parallel': { thermal: 'warm', set: 'tool-heavy', tools: [['github', 'get_pull_request'], ['ci', 'list_checks'], ['workspace', 'read_file'], ['ci', 'get_check_log']] },
  'resumed-review': { thermal: 'warm', set: 'tool-heavy', tools: [['github', 'get_pull_request'], ['workspace', 'read_file'], ['github', 'get_pull_request_diff']] },
  'renamed-alias-transfer': { thermal: 'warm', set: 'tool-heavy', tools: [['tracker', 'probe_card'], ['files', 'survey_lane'], ['files', 'render_card']] },
  'early-stream-call': { thermal: 'cold', set: 'tool-heavy', tools: [['workspace', 'read_file']] },
  'cold-pr-first-touch': { thermal: 'cold', set: 'mixed', tools: [['github', 'get_pull_request'], ['github', 'get_pull_request_diff']] },
  'unpredictable-lookups': { thermal: 'cold', set: 'mixed', tools: [['nonce', 'lookup_alpha'], ['nonce', 'lookup_beta'], ['nonce', 'lookup_gamma'], ['nonce', 'lookup_delta']] },
  'mutation-invalidation': { thermal: 'warm', set: 'mixed', tools: [['workspace', 'read_file'], ['workspace', 'write_file'], ['workspace', 'read_file']] },
  'permission-denied': { thermal: 'cold', set: 'mixed', tools: [['workspace', 'read_file']], permission: 'denied' },
  'approval-required': { thermal: 'cold', set: 'mixed', tools: [['workspace', 'read_file']], permission: 'approval-required' },
  'expired-before-demand': { thermal: 'warm', set: 'mixed', tools: [['workspace', 'read_file']] },
  'retry-dedup': { thermal: 'warm', set: 'mixed', tools: [['workspace', 'list_directory']] },
  'cancelled-mixed-task': { thermal: 'cold', set: 'mixed', tools: [['nonce', 'lookup_alpha'], ['workspace', 'write_file']] },
};

export const OBSERVER_WORKFLOWS: readonly ObserverWorkflow[] = OBSERVER_WORKFLOW_IDS.map((id) => {
  const spec = specifications[id];
  const mutationCalls = spec.tools.filter(([, tool]) => tool === 'write_file').length;
  return {
    id,
    version: 1,
    set: spec.set,
    thermalState: spec.thermal,
    transports: { claude: 'messages-sse', codex: id === 'retry-dedup' ? 'responses-websocket' : 'responses-sse' },
    trainingEpisodes: spec.thermal === 'warm' ? 4 : 0,
    steps: spec.tools.map(([alias, tool], index) => ({
      kind: 'tool', alias, tool, argsRef: `step-${index}`,
      thinkMs: id === 'expired-before-demand' ? 30_010 : 12,
    })),
    expected: {
      requestedCalls: spec.permission ? 0 : spec.tools.length,
      mutationCalls,
      permissionDecisions: spec.tools.map(() => spec.permission ?? 'allowed'),
    },
  };
});

export function materializeObserverWorkflow(
  id: ObserverWorkflowId,
  seed: number,
  repetition: number,
  phase: ObserverPhase = 'holdout',
): MaterializedObserverWorkflow {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('seed must be a non-negative safe integer');
  if (!Number.isSafeInteger(repetition) || repetition < 0) throw new Error('repetition must be a non-negative safe integer');
  const workflow = OBSERVER_WORKFLOWS.find((item) => item.id === id);
  if (!workflow) throw new Error(`unknown observer workflow: ${id}`);
  const steps = workflow.steps.flatMap((step, index): MaterializedToolStep[] => {
    if (step.kind === 'parallel') {
      return step.steps.map((toolStep, parallelIndex) => materializeTool(toolStep, phase, seed, repetition, index * 10 + parallelIndex));
    }
    return step.kind === 'tool' ? [materializeTool(step, phase, seed, repetition, index)] : [];
  });
  return { ...workflow, phase, seed, repetition, steps };
}

function materializeTool(
  step: Extract<ObserverStep, { kind: 'tool' }>,
  phase: ObserverPhase,
  seed: number,
  repetition: number,
  index: number,
): MaterializedToolStep {
  return {
    kind: 'tool',
    alias: step.alias,
    tool: step.tool,
    args: step.tool === 'list_directory'
      ? { path: `/fixture/${phase}-${seed}-${repetition}-${index}-${step.argsRef}` }
      : { key: `${phase}-${seed}-${repetition}-${index}-${step.argsRef}` },
    thinkMs: step.thinkMs,
  };
}
