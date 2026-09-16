import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { resolveCodexBin } from './codexClient.js';
import { resolveClaudeBin } from './manage.js';
import { runAgent, type RunAgentArgs } from './runAgent.js';

type NativeAgent = RunAgentArgs['agent'];

export interface OnboardingDependencies {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  home?: string;
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  isInteractive?: () => boolean;
  prompt?: (question: string) => Promise<string | null>;
  write?: (text: string) => void;
  launch?: (args: RunAgentArgs) => Promise<number>;
}

function usableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    const mode = /\.[cm]?js$/i.test(path)
      ? constants.R_OK
      : platform === 'win32' ? constants.F_OK : constants.X_OK;
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function resolvedFile(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
): string | null {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const path = isAbsolute(command) ? command : resolve(cwd, command);
    return usableFile(path, platform) ? path : null;
  }
  const extensions = platform === 'win32' && !/\.(?:exe|cmd|bat|[cm]?js)$/i.test(command)
    ? ['.exe', '.cmd', '.bat', '']
    : [''];
  for (const rawDirectory of (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    for (const extension of extensions) {
      const path = resolve(cwd, directory, `${command}${extension}`);
      if (usableFile(path, platform)) return path;
    }
  }
  return null;
}

function availableAgents(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
  home: string,
): NativeAgent[] {
  const available: NativeAgent[] = [];
  const claudeCommand = resolveClaudeBin(env.SPECULATE_CLAUDE_BIN ?? 'claude', {
    platform,
    pathEnv: env.PATH,
    home,
  });
  if (resolvedFile(claudeCommand, env, platform, cwd)) available.push('claude');
  try {
    const codexCommand = resolveCodexBin(env.SPECULATE_CODEX_BIN ?? 'codex', {
      platform,
      pathEnv: env.PATH,
      home,
      cwd,
      env,
    });
    if (resolvedFile(codexCommand, env, platform, cwd)) available.push('codex');
  } catch {}
  return available;
}

async function terminalPrompt(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  question: string,
): Promise<string | null> {
  const readline = createInterface({ input, output });
  return await new Promise((resolveAnswer) => {
    let settled = false;
    const settle = (answer: string | null) => {
      if (settled) return;
      settled = true;
      readline.close();
      resolveAnswer(answer);
    };
    readline.once('close', () => settle(null));
    readline.once('SIGINT', () => settle(null));
    void readline.question(question).then((answer) => settle(answer), () => settle(null));
  });
}

function chosenAgent(answer: string | null): NativeAgent | null {
  const normalized = answer?.trim().toLowerCase();
  if (normalized === '1' || normalized === 'claude') return 'claude';
  if (normalized === '2' || normalized === 'codex') return 'codex';
  return null;
}

const EXPLICIT_GUIDANCE =
  'Choose a client explicitly:\n  speculate run claude\n  speculate run codex\n';

export async function runOnboarding(dependencies: OnboardingDependencies = {}): Promise<number> {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const cwd = dependencies.cwd ?? process.cwd();
  const home = dependencies.home ?? homedir();
  const input = dependencies.stdin ?? process.stdin;
  const output = dependencies.stderr ?? process.stderr;
  const write = dependencies.write ?? ((text: string) => output.write(text));
  const launch = dependencies.launch ?? runAgent;
  const agents = availableAgents(env, platform, cwd, home);

  if (agents.length === 0) {
    write(
      'No supported native client was found.\n' +
      'Install either client:\n' +
      '  Claude Code: https://code.claude.com/docs/en/quickstart\n' +
      '  Codex: https://developers.openai.com/codex/quickstart\n' +
      'After installing, rerun `speculate` and follow the native client sign-in prompt.\n' +
      'Already installed? Set SPECULATE_CLAUDE_BIN or SPECULATE_CODEX_BIN to its executable.\n' +
      EXPLICIT_GUIDANCE,
    );
    return 2;
  }

  let agent = agents[0]!;
  if (agents.length > 1) {
    const interactive = dependencies.isInteractive?.() ?? (input.isTTY === true && output.isTTY === true);
    if (!interactive) {
      write(`Both Claude Code and Codex are installed.\n${EXPLICIT_GUIDANCE}`);
      return 2;
    }
    const prompt = dependencies.prompt ?? ((question: string) => terminalPrompt(input, output, question));
    const choice = chosenAgent(await prompt('Launch with (1) Claude Code or (2) Codex? '));
    if (!choice) {
      write(`No client selected.\n${EXPLICIT_GUIDANCE}`);
      return 2;
    }
    agent = choice;
  }

  return launch({ agent, observe: 'proxy', clientArgs: [], jsonReport: null });
}
