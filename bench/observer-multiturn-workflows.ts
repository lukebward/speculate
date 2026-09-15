export type MultiturnClient = 'claude' | 'codex';
export type MultiturnArm = 'A' | 'B' | 'C' | 'D' | 'E';
export type MultiturnWorkflowId = 'derivable-cross-server' | 'unpredictable-cold';
export type MultiturnPhase = 'training' | 'holdout';

export interface MultiturnStep {
  alias: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface MultiturnWorkflow {
  id: MultiturnWorkflowId;
  thermalState: 'warm' | 'cold';
  prompt: string;
  steps: readonly MultiturnStep[];
}

export const MULTITURN_PARAMETERS = Object.freeze({
  repetitions: 3,
  trainingEpisodes: 4,
  toolLatencyMs: 120,
  trainingToolLatencyMs: 120,
  modelLatencyMs: 80,
  dispatchLagMs: 8,
  experimentSeed: 0x6d756c74,
  orderSeed: 0x68656164,
});

export function materializeMultiturnWorkflow(
  id: MultiturnWorkflowId,
  phase: MultiturnPhase,
  seed: number,
  repetition: number,
): MultiturnWorkflow {
  const entity = `${phase}-${seed}-${repetition}`;
  if (id === 'derivable-cross-server') {
    const path = `/workspace/${entity}`;
    const manifest = path;
    const checks = path;
    return {
      id,
      thermalState: 'warm',
      prompt: `List ${path}`,
      steps: [
        { alias: 'workspace', tool: 'list_directory', args: { path } },
        { alias: 'registry', tool: 'get_package', args: { key: manifest } },
        { alias: 'ci', tool: 'list_checks', args: { key: checks } },
      ],
    };
  }
  return {
    id,
    thermalState: 'cold',
    prompt: 'Investigate the unrelated fixture values.',
    steps: [
      { alias: 'nonce-a', tool: 'lookup_alpha', args: { key: `${entity}-alpha` } },
      { alias: 'nonce-b', tool: 'lookup_beta', args: { key: `${entity}-beta` } },
    ],
  };
}

export function nextPayload(step: MultiturnStep): Record<string, unknown> {
  if (step.tool === 'list_directory') return { nextKey: String(step.args.path) };
  if (step.tool === 'get_package') return { nextKey: String(step.args.key) };
  return { value: `result:${String(step.args.key)}` };
}
