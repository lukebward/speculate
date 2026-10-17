/** Deterministic SDK-backed upstream used only by the repeated-workflow benchmark. */
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { REPEATED_WORKFLOW_IDS, generateRepeatedWorkflow, } from './repeatedWorkflows.js';
const workflow = process.env['SPECULATE_REPEAT_WORKFLOW'];
const seed = Number(process.env['SPECULATE_REPEAT_SEED']);
const session = Number(process.env['SPECULATE_REPEAT_SESSION']);
const trainSessions = Number(process.env['SPECULATE_REPEAT_TRAIN']);
const latencyMs = Number(process.env['SPECULATE_REPEAT_LATENCY']);
const callLog = process.env['SPECULATE_REPEAT_CALL_LOG'];
const fixture = generateRepeatedWorkflow(workflow, seed, session, trainSessions);
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
function shapeFor(steps) {
    const shape = {};
    for (const step of steps) {
        for (const [key, value] of Object.entries(step.args)) {
            shape[key] ??=
                typeof value === 'string'
                    ? z.string()
                    : typeof value === 'number'
                        ? z.number()
                        : typeof value === 'boolean'
                            ? z.boolean()
                            : z.unknown();
        }
    }
    return shape;
}
function result(payload) {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload !== null && typeof payload === 'object'
            ? payload
            : undefined,
    };
}
const byTool = new Map();
for (const current of fixture.steps) {
    const list = byTool.get(current.tool) ?? [];
    list.push(current);
    byTool.set(current.tool, list);
}
// Advertise one stable catalog across sessions. A conditional branch that is
// absent from today's requested trace can still be a legitimate speculative
// candidate learned yesterday.
const catalogByTool = new Map();
for (const id of REPEATED_WORKFLOW_IDS) {
    for (let sample = 0; sample < 8; sample++) {
        for (const current of generateRepeatedWorkflow(id, 0, sample, 4).steps) {
            const list = catalogByTool.get(current.tool) ?? [];
            list.push(current);
            catalogByTool.set(current.tool, list);
        }
    }
}
const server = new McpServer({ name: 'repeated-workflow-fixture', version: '1.0.0' });
for (const [tool, schemaSteps] of catalogByTool) {
    const expectedSteps = byTool.get(tool) ?? [];
    server.registerTool(tool, {
        description: 'Deterministic read-only benchmark fixture operation.',
        inputSchema: shapeFor(schemaSteps),
        annotations: { readOnlyHint: true },
    }, async (args) => {
        const cleanArgs = args;
        if (callLog) {
            appendFileSync(callLog, `${JSON.stringify({ workflow, seed, session, tool, args: cleanArgs, at: Date.now() })}\n`);
        }
        await new Promise((done) => setTimeout(done, Math.max(0, latencyMs)));
        const expected = expectedSteps.find((candidate) => stable(candidate.args) === stable(cleanArgs));
        return result(expected?.result ?? { tool, args: cleanArgs, fixtureMiss: true });
    });
}
await server.connect(new StdioServerTransport());
