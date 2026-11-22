/**
 * The hosted MCP servers and workloads `bench/live.ts` measures against.
 *
 * Every server here needs no credential, so anyone can repeat a run, and
 * annotates the tools the workloads call `readOnlyHint: true`. The runner
 * checks that annotation before a session starts and refuses otherwise.
 *
 * Two are hosted services. The third is the repository's own mock GitHub
 * server with a delay injected into every call: the hosted ones answer in
 * well under a second, and this is the only way here to see a server that
 * takes seconds. It is a mock, and a result on it says so.
 *
 * Three workloads per server, from most to least favourable to prediction:
 *
 *   scripted  the prompt dictates each call and its arguments, one at a time.
 *             Every session makes identical calls. This is the repeated
 *             script the 0.x `bench:remote` ran, now through a real model.
 *   repeat    one ordinary question, the same every session. The model picks
 *             the calls, their arguments, and what to run in parallel.
 *   varied    an ordinary question on a different subject every session.
 *             Nothing can be recalled; only a learned shape can help.
 *
 * Fixtures only. Production learning never sees a name from this file.
 */

import { fileURLToPath } from 'node:url';

export type WorkloadKey = 'scripted' | 'repeat' | 'varied';
export const WORKLOADS: readonly WorkloadKey[] = ['scripted', 'repeat', 'varied'];

/** What a direct call to the server returned, as far as planning reads it. */
export interface DirectResult {
  content?: unknown;
  isError?: unknown;
}

/** Calls the server directly (no Claude Code) to turn a query into real arguments. */
export type CallDirect = (name: string, args: Record<string, unknown>) => Promise<DirectResult>;

/** Whatever `plan` hands the prompts; recorded in the result file. */
export type ScenarioContext = Record<string, unknown>;

/** How a session reaches the server: a hosted address, or a local process. */
export type ServerSpec =
  | { readonly url: string }
  | { readonly command: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>> };

/** The server in one line, for a header or a result file. */
export function describeServer(server: ServerSpec): string {
  return 'url' in server ? server.url : `${server.command} ${server.args.join(' ')}`;
}

export interface Scenario {
  /** Also the server's name in the session: tools are `mcp__<key>__<tool>`. */
  readonly key: string;
  readonly label: string;
  readonly server: ServerSpec;
  /** Every tool the scripted workload names. All must be read-only. */
  readonly needTools: readonly string[];
  /**
   * What the tools answer in. From JSON the learner can read the next
   * call's argument out of a result; from Markdown it can only recall.
   */
  readonly results: 'json' | 'markdown';
  /** Fetches real identifiers for the scripted workload. */
  readonly plan: (call: CallDirect) => Promise<ScenarioContext>;
  /** The session's one prompt. `pair` is 1-based and the same for both arms. */
  readonly prompt: (workload: WorkloadKey, ctx: ScenarioContext, pair: number) => string;
}

interface Step {
  tool: string;
  args: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** The text blocks of a tool result, joined. */
export function resultText(result: DirectResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map(block => (isRecord(block) && typeof block['text'] === 'string' ? block['text'] : ''))
    .join('\n');
}

/** A prompt that leaves the model no choice of call, argument, or order. */
export function scriptedPrompt(server: string, steps: readonly Step[]): string {
  return [
    `Use the ${server} MCP tools. Make exactly these calls, one at a time, in this order, with exactly these arguments, and make no other calls:`,
    ...steps.map((step, i) => `${i + 1}. ${step.tool} with arguments ${JSON.stringify(step.args)}`),
    'Wait for each result before the next call. Then reply with the single word: done.',
  ].join('\n');
}

const pick = <T>(items: readonly T[], pair: number): T => items[(pair - 1) % items.length]!;

/** The start of what a server answered, for an error that has to explain itself. */
const said = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 160);

/** `results[].contentUrl` out of the docs search envelope. */
export function extractContentUrls(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !Array.isArray(parsed['results'])) return [];
    return (parsed['results'] as unknown[])
      .map(r => (isRecord(r) && typeof r['contentUrl'] === 'string' ? r['contentUrl'] : null))
      .filter((u): u is string => u !== null);
  } catch {
    return [];
  }
}

const MSLEARN_TOPICS = [
  'Azure Blob Storage lifecycle management',
  'Azure Cosmos DB partition keys',
  'Azure Container Apps scaling rules',
  'Bicep modules',
  'Azure Service Bus topics and subscriptions',
  'Azure Key Vault secret rotation',
  'Azure Kubernetes Service node pools',
  'Azure Event Grid event subscriptions',
  'Azure SQL Database elastic pools',
  'Microsoft Entra application registration',
  'Azure Front Door routing rules',
  'Azure Monitor alert rules',
];

/**
 * Microsoft Learn: search the docs, then fetch two of the hits. It answers in
 * JSON, so a fetch's `url` can be read out of the search that preceded it.
 */
const mslearn: Scenario = {
  key: 'mslearn',
  label: 'Microsoft Learn',
  server: { url: 'https://learn.microsoft.com/api/mcp' },
  needTools: ['microsoft_docs_search', 'microsoft_docs_fetch'],
  results: 'json',
  async plan(call) {
    const queries = ['azure functions python', 'azure storage lifecycle'];
    const picked: string[][] = [];
    for (const query of queries) {
      const text = resultText(await call('microsoft_docs_search', { query }));
      // Several hits can be sections of one page: two fetches of one url are one read.
      const urls = [...new Set(extractContentUrls(text))];
      if (urls.length < 2) {
        throw new Error(`microsoft_docs_search("${query}") returned ${urls.length} distinct urls, need 2: ${said(text)}`);
      }
      picked.push(urls.slice(0, 2));
    }
    return { queries, picked };
  },
  prompt(workload, ctx, pair) {
    if (workload === 'scripted') {
      const queries = ctx['queries'] as string[];
      const picked = ctx['picked'] as string[][];
      return scriptedPrompt(
        'mslearn',
        queries.flatMap((query, i) => [
          { tool: 'microsoft_docs_search', args: { query } },
          ...picked[i]!.map(url => ({ tool: 'microsoft_docs_fetch', args: { url } })),
        ]),
      );
    }
    const topic = workload === 'repeat' ? 'running Python code in Azure Functions' : pick(MSLEARN_TOPICS, pair);
    return (
      `Use the mslearn MCP tools to find the Microsoft Learn documentation on ${topic}. ` +
      'Search the docs, read the two most relevant pages in full, and give me three bullet points.'
    );
  },
};

/** `### owner/name` headings out of the Hub's Markdown search results. */
export function extractRepoIds(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^###\s+(\S+\/\S+)\s*$/.exec(line.trim());
    if (m) out.push(m[1]!);
  }
  return out;
}

const HUB_TASKS = [
  'summarization',
  'translation',
  'question answering',
  'image classification',
  'automatic speech recognition',
  'token classification',
  'sentence similarity',
  'object detection',
  'zero-shot classification',
  'text to image',
  'fill mask',
  'feature extraction',
];

/** The Hugging Face Hub: search for models, then read two of them. Markdown results. */
const huggingface: Scenario = {
  key: 'huggingface',
  label: 'Hugging Face Hub',
  server: { url: 'https://huggingface.co/mcp' },
  needTools: ['hub_repo_search', 'hub_repo_details'],
  results: 'markdown',
  async plan(call) {
    const queries = ['text classification', 'summarization'];
    const picked: string[][] = [];
    for (const query of queries) {
      const text = resultText(await call('hub_repo_search', { query, repo_types: ['model'], limit: 5 }));
      const ids = [...new Set(extractRepoIds(text))].slice(0, 2);
      if (ids.length < 2) {
        throw new Error(`hub_repo_search("${query}") returned ${ids.length} usable repo ids, need 2: ${said(text)}`);
      }
      picked.push(ids);
    }
    return { queries, picked };
  },
  prompt(workload, ctx, pair) {
    if (workload === 'scripted') {
      const queries = ctx['queries'] as string[];
      const picked = ctx['picked'] as string[][];
      return scriptedPrompt(
        'huggingface',
        queries.flatMap((query, i) => [
          { tool: 'hub_repo_search', args: { query, repo_types: ['model'], limit: 5 } },
          ...picked[i]!.map(id => ({ tool: 'hub_repo_details', args: { repo_ids: [id], repo_type: 'model' } })),
        ]),
      );
    }
    const task = workload === 'repeat' ? 'text classification' : pick(HUB_TASKS, pair);
    return (
      `Use the huggingface MCP tools to find models for ${task}. ` +
      'Search the Hub, look up the details of the top two results, and tell me the license of each.'
    );
  },
};

/** `Context7-compatible library ID: /org/lib` out of the resolver's Markdown. */
export function extractLibraryIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/Context7-compatible library ID:\s*(\S+)/g)) out.push(m[1]!);
  return out;
}

const LIBRARIES = [
  'Express',
  'Django',
  'Vue',
  'Svelte',
  'Flask',
  'Tailwind CSS',
  'Prisma',
  'Playwright',
  'Vite',
  'Astro',
  'Pydantic',
  'Zod',
];

/** Context7: resolve a library name to an id, then query its docs. Markdown results. */
const context7: Scenario = {
  key: 'context7',
  label: 'Context7',
  server: { url: 'https://mcp.context7.com/mcp' },
  needTools: ['resolve-library-id', 'query-docs'],
  results: 'markdown',
  async plan(call) {
    const libs = ['react', 'fastapi'];
    const ids: string[] = [];
    for (const libraryName of libs) {
      const text = resultText(await call('resolve-library-id', { libraryName, query: 'getting started' }));
      const found = extractLibraryIds(text);
      if (found.length === 0) throw new Error(`resolve-library-id("${libraryName}") returned no id: ${said(text)}`);
      ids.push(found[0]!);
    }
    return { libs, ids };
  },
  prompt(workload, ctx, pair) {
    if (workload === 'scripted') {
      const libs = ctx['libs'] as string[];
      const ids = ctx['ids'] as string[];
      return scriptedPrompt(
        'context7',
        libs.flatMap((lib, i) => [
          { tool: 'resolve-library-id', args: { libraryName: lib, query: 'getting started' } },
          { tool: 'query-docs', args: { libraryId: ids[i]!, query: 'getting started' } },
          { tool: 'query-docs', args: { libraryId: ids[i]!, query: 'configuration' } },
        ]),
      );
    }
    const library = workload === 'repeat' ? 'React' : pick(LIBRARIES, pair);
    return (
      `Use the context7 MCP tools to answer: how do I get started with ${library}, and how do I configure it? ` +
      'Resolve the library, read its documentation, and give me three bullet points.'
    );
  },
};

const MOCK_LATENCY_MS = process.env['SPECULATE_BENCH_MOCK_LATENCY_MS'] ?? '1500';
const MOCK_ISSUES = [41, 42, 43];
const MOCK_PULLS = [5, 7, 8];

/**
 * The bundled mock GitHub server (mock/mock-github.ts) over stdio, with every
 * call delayed by 1.5 s: an issue-and-pull-request session against a slow
 * server. Fixture repository acme/api; results are JSON in one text block.
 */
const mockgithub: Scenario = {
  key: 'mockgithub',
  label: `Mock GitHub, ${MOCK_LATENCY_MS} ms injected per call`,
  server: {
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('../mock/mock-github.ts', import.meta.url)),
    ],
    env: { SPECULATE_MOCK_LATENCY_MS: MOCK_LATENCY_MS },
  },
  needTools: ['list_issues', 'get_issue', 'get_issue_comments', 'list_pull_requests', 'get_pull_request', 'get_pull_request_diff'],
  results: 'json',
  async plan() {
    return { owner: 'acme', repo: 'api', issues: MOCK_ISSUES.slice(0, 2), pull: MOCK_PULLS[0]!, latencyMs: Number(MOCK_LATENCY_MS) };
  },
  prompt(workload, ctx, pair) {
    const repo = { owner: 'acme', repo: 'api' };
    if (workload === 'scripted') {
      const issues = ctx['issues'] as number[];
      const pull = ctx['pull'] as number;
      return scriptedPrompt('mockgithub', [
        { tool: 'list_issues', args: { ...repo, state: 'open' } },
        ...issues.flatMap(issue_number => [
          { tool: 'get_issue', args: { ...repo, issue_number } },
          { tool: 'get_issue_comments', args: { ...repo, issue_number } },
        ]),
        { tool: 'list_pull_requests', args: { ...repo, state: 'open' } },
        { tool: 'get_pull_request', args: { ...repo, pull_number: pull } },
        { tool: 'get_pull_request_diff', args: { ...repo, pull_number: pull } },
      ]);
    }
    if (workload === 'repeat') {
      return (
        'Use the mockgithub MCP tools on the repository acme/api. List the open issues, read the two with the ' +
        'lowest numbers together with their comments, and tell me in two sentences which is more urgent.'
      );
    }
    // An issue, then a pull request, and so on: no two sessions running share a kind of subject.
    const subjects = MOCK_ISSUES.flatMap((issue, i) => [
      `issue ${issue} and its comments`,
      `pull request ${MOCK_PULLS[i]!} and its diff`,
    ]);
    return (
      `Use the mockgithub MCP tools on the repository acme/api. Read ${pick(subjects, pair)}, ` +
      'and summarise it in two sentences.'
    );
  },
};

export const SCENARIOS: Readonly<Record<string, Scenario>> = { mslearn, huggingface, context7, mockgithub };
