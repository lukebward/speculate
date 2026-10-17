import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { isDeepStrictEqual } from 'node:util';
import { PromptOccurrenceCorrelator, promptNativeId } from './promptOccurrence.js';
import { HookBoundaryTracker, modelToolName, observeHookToolBoundary } from '../hookBoundaries.js';
import { codexSubcommand, resolveCodexBin } from '../codexClient.js';
import { isStdioEntry, wrapLaunchEntry } from '../hostConfig.js';
import { mergeObserverHooks, observerEnvironment, observerHookCommand } from './observerLaunch.js';
import { MAX_OBSERVATION_BYTES, observationSchema, sessionContextSchema, } from '../observerTypes.js';
const MAX_STREAM_ARGUMENT_BYTES = 64 * 1024;
const MAX_REQUEST_TOOLS = 512;
const MAX_ACTIVE_RESPONSES = 64;
const MAX_COMPLETED_RESPONSES = 64;
const MAX_RESPONSE_CALLS = 256;
const MAX_CONNECTION_ANALYSIS_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_NAME_BYTES = 512;
const RETAINED_ENTRY_BYTES = 192;
const RETAINED_TRACKER_BYTES = 512;
const GLOBAL_ADAPTER_ANALYSIS_BYTES = 8 * 1024 * 1024;
class RetainedBudget {
    shared;
    used = 0;
    constructor(shared) {
        this.shared = shared;
    }
    reserve(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_CONNECTION_ANALYSIS_BYTES - this.used)
            return false;
        if (bytes > 0 && this.shared && !this.shared.reserve(bytes))
            return false;
        this.used += bytes;
        return true;
    }
    release(bytes) {
        const released = Math.min(this.used, Math.max(0, bytes));
        this.used -= released;
        this.shared?.release(released);
    }
}
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function header(headers, name) {
    const value = headers[name] ?? headers[Object.keys(headers).find((key) => key.toLowerCase() === name) ?? ''];
    return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
function inspectableEncoding(headers) {
    const encoding = header(headers, 'content-encoding');
    return encoding === null || encoding.trim().toLowerCase() === 'identity';
}
function requestPath(path) {
    if (!path.startsWith('/') || path.startsWith('//'))
        return null;
    return path.split('?', 1)[0] ?? null;
}
function responsesPath(path) {
    return path === '/responses' || path === '/v1/responses';
}
function boundedId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512 && Buffer.byteLength(value, 'utf8') <= 512;
}
function boundedToolName(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOOL_NAME_BYTES &&
        Buffer.byteLength(value, 'utf8') <= MAX_TOOL_NAME_BYTES;
}
function retainedStringBytes(value) {
    return RETAINED_ENTRY_BYTES + value.length * 2;
}
function retainedRouteBytes(name, route) {
    let serialized;
    try {
        serialized = JSON.stringify(route);
    }
    catch {
        return MAX_CONNECTION_ANALYSIS_BYTES + 1;
    }
    return RETAINED_ENTRY_BYTES + retainedStringBytes(name) + retainedStringBytes(serialized);
}
function retainedContextBytes(responseId, context) {
    let bytes = RETAINED_ENTRY_BYTES + retainedStringBytes(responseId);
    for (const [name, route] of context.routesByName)
        bytes += retainedRouteBytes(name, route);
    return bytes;
}
function terminalState(event) {
    if (event.type === 'response.completed') {
        return object(event.response) && event.response.status !== undefined && event.response.status !== 'completed'
            ? 'failed'
            : 'completed';
    }
    if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'response.cancelled' ||
        event.type === 'response.canceled' || event.type === 'response.error' || event.type === 'response.aborted')
        return 'failed';
    if (event.type === 'error' && (boundedId(event.response_id) || boundedId(event.stream_id) ||
        (object(event.response) && boundedId(event.response.id))))
        return 'failed';
    return null;
}
function inputText(value) {
    if (typeof value === 'string')
        return value || null;
    if (!Array.isArray(value))
        return null;
    for (let index = value.length - 1; index >= 0; index--) {
        const item = value[index];
        if (!object(item))
            return null;
        if (item.type === 'function_call_output')
            continue;
        if (item.role === 'user') {
            if (typeof item.content === 'string')
                return item.content || null;
            if (!Array.isArray(item.content))
                return null;
            const text = item.content.flatMap((part) => object(part) && (part.type === 'input_text' || part.type === 'text') && typeof part.text === 'string'
                ? [part.text]
                : []).join('\n');
            return text || null;
        }
        if (item.type === 'input_text' && typeof item.text === 'string')
            return item.text || null;
        return null;
    }
    return null;
}
class CodexConnection {
    environment;
    promptOccurrences;
    requests = new Set();
    sockets = new Set();
    completed = new Map();
    retainedBudget;
    closed = false;
    constructor(environment, promptOccurrences, initiallyClosed = false) {
        this.environment = environment;
        this.promptOccurrences = promptOccurrences;
        this.retainedBudget = new RetainedBudget(environment.analysisBudget);
        if (initiallyClosed)
            this.closed = true;
    }
    startRequest(request) {
        if (this.closed || request.transport !== 'http' || request.method.toUpperCase() !== 'POST' ||
            !responsesPath(requestPath(request.path) ?? ''))
            return null;
        const context = this.context(request.headers);
        if (!context)
            return null;
        let observer;
        observer = new CodexRequestObserver(context, request, this.environment, this.promptOccurrences, this.retainedBudget, (responseId, responseContext) => this.remember(responseId, responseContext), (responseId) => this.completed.get(responseId)?.context ?? null, () => this.requests.delete(observer));
        this.requests.add(observer);
        return observer;
    }
    startWebSocket(request) {
        if (this.closed || request.transport !== 'websocket' || request.method.toUpperCase() !== 'GET' ||
            !responsesPath(requestPath(request.path) ?? ''))
            return null;
        const context = this.context(request.headers);
        if (!context)
            return null;
        let observer;
        observer = new CodexWebSocketObserver(context, this.environment, this.promptOccurrences, this.retainedBudget, (responseId, responseContext) => this.remember(responseId, responseContext), (responseId) => this.completed.get(responseId)?.context ?? null, () => this.sockets.delete(observer));
        this.sockets.add(observer);
        return observer;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const request of this.requests)
            request.abort();
        for (const socket of this.sockets)
            socket.abort();
        this.requests.clear();
        this.sockets.clear();
        for (const entry of this.completed.values())
            this.retainedBudget.release(entry.retainedBytes);
        this.completed.clear();
    }
    context(headers) {
        const conversationId = header(headers, 'thread-id') ?? header(headers, 'session-id');
        if (!boundedId(conversationId))
            return null;
        try {
            const parsed = sessionContextSchema.safeParse(this.environment.contextForConversation(conversationId));
            return parsed.success && parsed.data.agent === 'codex' && parsed.data.conversationId === conversationId
                ? parsed.data
                : null;
        }
        catch {
            return null;
        }
    }
    remember(responseId, responseContext) {
        if (this.closed || !boundedId(responseId) || !responseContext.complete)
            return;
        const retainedBytes = retainedContextBytes(responseId, responseContext);
        const existing = this.completed.get(responseId);
        if (existing) {
            this.completed.delete(responseId);
            this.retainedBudget.release(existing.retainedBytes);
        }
        while (this.completed.size >= MAX_COMPLETED_RESPONSES) {
            const oldest = this.completed.keys().next().value;
            if (oldest === undefined)
                break;
            const entry = this.completed.get(oldest);
            this.completed.delete(oldest);
            if (entry)
                this.retainedBudget.release(entry.retainedBytes);
        }
        let reserved = this.retainedBudget.reserve(retainedBytes);
        while (!reserved && this.completed.size > 0) {
            const oldest = this.completed.keys().next().value;
            if (oldest === undefined)
                break;
            const entry = this.completed.get(oldest);
            this.completed.delete(oldest);
            if (entry)
                this.retainedBudget.release(entry.retainedBytes);
            reserved = this.retainedBudget.reserve(retainedBytes);
        }
        if (!reserved)
            return;
        this.completed.set(responseId, {
            context: {
                complete: true,
                routesByName: new Map(responseContext.routesByName),
            },
            retainedBytes,
        });
    }
}
class ResponseTracker {
    context;
    environment;
    promptOccurrences;
    retainedBudget;
    remember;
    previous;
    responseContext = { complete: false, routesByName: new Map() };
    responseId = null;
    calls = new Map();
    emitted = new Set();
    retainedBytes = 0;
    stopped = false;
    boundaryAt = null;
    opaqueExec = false;
    constructor(context, environment, promptOccurrences, retainedBudget, remember, previous) {
        this.context = context;
        this.environment = environment;
        this.promptOccurrences = promptOccurrences;
        this.retainedBudget = retainedBudget;
        this.remember = remember;
        this.previous = previous;
        if (!this.retain(RETAINED_TRACKER_BYTES))
            this.stopped = true;
    }
    get isStopped() {
        return this.stopped;
    }
    retainLane(lane) {
        return this.retain(RETAINED_ENTRY_BYTES + retainedStringBytes(lane));
    }
    readRequest(value, bytes, observedAt) {
        this.boundaryAt = observedAt ?? this.now();
        if (this.stopped)
            return [];
        const hasTools = Object.prototype.hasOwnProperty.call(value, 'tools');
        if (hasTools) {
            this.responseContext.complete = true;
            this.captureRoutes(value.tools);
        }
        else if (boundedId(value.previous_response_id)) {
            try {
                this.environment.onExecutionWindow?.({
                    source: 'model', phase: 'closed', context: this.context,
                    windowId: value.previous_response_id, observedAt: this.boundaryAt,
                });
            }
            catch { }
            const prior = this.previous(value.previous_response_id);
            if (prior?.complete) {
                this.responseContext.complete = true;
                this.captureContext(prior);
            }
        }
        else {
            this.responseContext.complete = true;
        }
        if (this.stopped || !this.responseContext.complete)
            return [];
        const text = inputText(value.input);
        if (text === null)
            return [];
        const stableId = createHash('sha256').update(this.context.conversationId).update('\0').update(Buffer.from(bytes)).digest('base64url');
        const nativeId = promptNativeId({ previousResponseId: value.previous_response_id ?? null, input: value.input });
        return this.observation({
            kind: 'prompt',
            context: this.context,
            eventId: this.eventId('prompt', stableId),
            observedAt: this.boundaryAt,
            occurrenceId: this.promptOccurrences.identify(this.context.conversationId, text, 'proxy', nativeId),
            text,
        });
    }
    readEvent(event, observedAt) {
        this.boundaryAt = observedAt ?? this.now();
        if (this.stopped)
            return [];
        if (terminalState(event) === 'failed') {
            try {
                this.environment.onTrackingLoss?.(this.boundaryAt);
            }
            catch { }
            this.abort();
            return [];
        }
        if (event.type === 'response.created' && object(event.response) && boundedId(event.response.id)) {
            this.setResponseId(event.response.id);
            return [];
        }
        if (event.type === 'response.output_item.added' && object(event.item)) {
            this.captureCall(event.item);
            return [];
        }
        if (event.type === 'response.function_call_arguments.delta' && boundedId(event.item_id) && typeof event.delta === 'string') {
            const call = this.calls.get(event.item_id);
            if (call) {
                if (Buffer.byteLength(call.arguments, 'utf8') + Buffer.byteLength(event.delta, 'utf8') > MAX_STREAM_ARGUMENT_BYTES) {
                    this.dropCall(event.item_id, call);
                }
                else {
                    const retainedBytes = event.delta.length * 2;
                    if (!this.retain(retainedBytes))
                        this.abort();
                    else {
                        call.arguments += event.delta;
                        call.retainedBytes += retainedBytes;
                    }
                }
            }
            return [];
        }
        if (event.type === 'response.function_call_arguments.done' && boundedId(event.item_id) && typeof event.arguments === 'string') {
            const call = this.calls.get(event.item_id);
            if (call) {
                if (Buffer.byteLength(event.arguments, 'utf8') > MAX_STREAM_ARGUMENT_BYTES)
                    this.dropCall(event.item_id, call);
                else
                    this.replaceArguments(call, event.arguments);
            }
            return [];
        }
        if (event.type === 'response.output_item.done' && object(event.item)) {
            const observations = this.completedItem(event.item);
            if (boundedId(event.item.id)) {
                const call = this.calls.get(event.item.id);
                if (call)
                    this.dropCall(event.item.id, call);
            }
            return observations;
        }
        if (event.type === 'response.completed' && object(event.response)) {
            if (boundedId(event.response.id))
                this.setResponseId(event.response.id);
            const observations = Array.isArray(event.response.output)
                ? event.response.output.flatMap((item) => object(item) ? this.completedItem(item) : [])
                : [];
            this.openOpaqueWindow();
            this.complete();
            return observations;
        }
        return [];
    }
    readJsonResponse(value, observedAt) {
        this.boundaryAt = observedAt ?? this.now();
        if (!object(value))
            return [];
        if (boundedId(value.id))
            this.setResponseId(value.id);
        if (value.status !== 'completed') {
            this.abort();
            return [];
        }
        const observations = Array.isArray(value.output)
            ? value.output.flatMap((item) => object(item) ? this.completedItem(item) : [])
            : [];
        this.openOpaqueWindow();
        this.complete();
        return observations;
    }
    complete() {
        if (!this.stopped && this.responseId)
            this.remember(this.responseId, this.responseContext);
    }
    abort() {
        if (this.stopped && this.retainedBytes === 0)
            return;
        this.stopped = true;
        this.calls.clear();
        this.emitted.clear();
        this.responseContext.routesByName.clear();
        this.responseId = null;
        this.retainedBudget.release(this.retainedBytes);
        this.retainedBytes = 0;
    }
    captureRoutes(value) {
        if (!Array.isArray(value) || value.length > MAX_REQUEST_TOOLS)
            return;
        const definitions = new Map();
        for (const item of value) {
            if (!object(item) || item.type !== 'function' || !boundedToolName(item.name) ||
                !object(item.parameters) || item.defer_loading === true)
                continue;
            const list = definitions.get(item.name) ?? [];
            list.push(item.parameters);
            definitions.set(item.name, list);
        }
        for (const [name, schemas] of definitions) {
            if (schemas.length !== 1)
                continue;
            const matches = this.environment.routes().filter((route) => route.hostClient === 'codex' && modelToolName(route) === name && isDeepStrictEqual(route.inputSchema, schemas[0]));
            if (matches.length === 1) {
                const route = matches[0];
                if (!this.retain(retainedRouteBytes(name, route))) {
                    this.abort();
                    return;
                }
                this.responseContext.routesByName.set(name, route);
            }
        }
    }
    captureContext(context) {
        for (const [name, route] of context.routesByName) {
            if (!this.retain(retainedRouteBytes(name, route))) {
                this.abort();
                return;
            }
            this.responseContext.routesByName.set(name, route);
        }
    }
    captureCall(item) {
        if (item.type !== 'function_call' || !boundedId(item.id) || !boundedId(item.call_id) || !boundedToolName(item.name))
            return;
        if (this.calls.has(item.id))
            return;
        if (!this.calls.has(item.id) && this.calls.size >= MAX_RESPONSE_CALLS)
            return;
        const args = typeof item.arguments === 'string' ? item.arguments : '';
        if (Buffer.byteLength(args, 'utf8') > MAX_STREAM_ARGUMENT_BYTES)
            return;
        const retainedBytes = RETAINED_ENTRY_BYTES + retainedStringBytes(item.id) + retainedStringBytes(item.call_id) +
            retainedStringBytes(item.name) + retainedStringBytes(args);
        if (!this.retain(retainedBytes)) {
            this.abort();
            return;
        }
        this.calls.set(item.id, {
            callId: item.call_id,
            name: item.name,
            arguments: args,
            retainedBytes,
        });
    }
    completedItem(item) {
        if (item.type === 'custom_tool_call' && item.name === 'exec' &&
            (boundedId(item.call_id) || boundedId(item.id))) {
            this.opaqueExec = true;
            return [];
        }
        if (item.type !== 'function_call')
            return [];
        const active = boundedId(item.id) ? this.calls.get(item.id) : undefined;
        const callId = boundedId(item.call_id) ? item.call_id : active?.callId;
        const name = typeof item.name === 'string' ? item.name : active?.name;
        const argsText = typeof item.arguments === 'string' ? item.arguments : active?.arguments;
        if (!boundedId(callId) || !boundedToolName(name) || typeof argsText !== 'string' ||
            Buffer.byteLength(argsText, 'utf8') > MAX_STREAM_ARGUMENT_BYTES || this.emitted.has(callId) ||
            this.emitted.size >= MAX_RESPONSE_CALLS)
            return [];
        let args;
        try {
            args = JSON.parse(argsText);
        }
        catch {
            return [];
        }
        if (!object(args))
            return [];
        const route = this.responseContext.routesByName.get(name);
        if (!route)
            return [];
        if (!this.retain(RETAINED_ENTRY_BYTES + retainedStringBytes(callId))) {
            this.abort();
            return [];
        }
        this.emitted.add(callId);
        const observedAt = this.boundaryAt ?? this.now();
        try {
            this.environment.onToolCallMarker?.({
                source: 'model', phase: 'selected', context: this.context,
                routeId: route.routeId, generation: route.generation, callId, args, observedAt,
            });
        }
        catch { }
        return this.observation({
            kind: 'stream-call',
            context: this.context,
            eventId: this.eventId('stream-call', callId),
            observedAt,
            routeId: route.routeId,
            callId,
            args,
        });
    }
    replaceArguments(call, value) {
        const difference = value.length * 2 - call.arguments.length * 2;
        if (difference > 0 && !this.retain(difference)) {
            this.abort();
            return;
        }
        if (difference < 0)
            this.releaseRetained(-difference);
        call.arguments = value;
        call.retainedBytes += difference;
    }
    dropCall(itemId, call) {
        this.calls.delete(itemId);
        this.releaseRetained(call.retainedBytes);
    }
    setResponseId(responseId) {
        if (this.responseId === responseId)
            return;
        const priorBytes = this.responseId === null ? 0 : RETAINED_ENTRY_BYTES + retainedStringBytes(this.responseId);
        if (priorBytes > 0)
            this.releaseRetained(priorBytes);
        const nextBytes = RETAINED_ENTRY_BYTES + retainedStringBytes(responseId);
        if (!this.retain(nextBytes)) {
            this.abort();
            return;
        }
        this.responseId = responseId;
    }
    retain(bytes) {
        if (this.stopped || !this.retainedBudget.reserve(bytes))
            return false;
        this.retainedBytes += bytes;
        return true;
    }
    releaseRetained(bytes) {
        const released = Math.min(bytes, this.retainedBytes);
        this.retainedBytes -= released;
        this.retainedBudget.release(released);
    }
    observation(value) {
        const parsed = observationSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
    }
    now() {
        return this.environment.now?.() ?? Date.now();
    }
    eventId(kind, stableId) {
        return this.environment.eventId?.(kind, stableId) ?? `codex:${kind}:${stableId || randomUUID()}`;
    }
    openOpaqueWindow() {
        if (!this.opaqueExec || !this.responseId)
            return;
        try {
            this.environment.onExecutionWindow?.({
                source: 'model', phase: 'opened', context: this.context,
                windowId: this.responseId, observedAt: this.boundaryAt ?? this.now(),
            });
        }
        catch { }
    }
}
class CodexRequestObserver {
    request;
    retainedBudget;
    release;
    decoder = new StringDecoder('utf8');
    tracker;
    responseMode = 'none';
    responseText = '';
    responseBytes = 0;
    requestReady = false;
    stopped = false;
    released = false;
    retainedResponseBytes = 0;
    constructor(context, request, environment, promptOccurrences, retainedBudget, remember, previous, release) {
        this.request = request;
        this.retainedBudget = retainedBudget;
        this.release = release;
        this.tracker = new ResponseTracker(context, environment, promptOccurrences, retainedBudget, remember, previous);
    }
    observeRequestBody(body, observedAt) {
        if (this.stopped || body.byteLength > MAX_OBSERVATION_BYTES || !inspectableEncoding(this.request.headers)) {
            this.abort();
            return [];
        }
        let parsed;
        try {
            parsed = JSON.parse(Buffer.from(body).toString('utf8'));
        }
        catch {
            this.abort();
            return [];
        }
        if (!object(parsed)) {
            this.abort();
            return [];
        }
        this.requestReady = true;
        const observations = this.tracker.readRequest(parsed, body, observedAt);
        if (this.tracker.isStopped)
            this.abort();
        return observations;
    }
    observeResponseStart(response, _observedAt) {
        if (this.stopped || !this.requestReady || response.status < 200 || response.status >= 300 || !inspectableEncoding(response.headers)) {
            this.abort();
            return [];
        }
        const contentType = header(response.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (contentType === 'text/event-stream')
            this.responseMode = 'sse';
        else if (contentType === 'application/json')
            this.responseMode = 'json';
        else
            this.abort();
        if (this.responseMode !== 'none' && !this.replaceResponseText(''))
            this.abort();
        return [];
    }
    observeResponseChunk(chunk, observedAt) {
        if (this.stopped || this.responseMode === 'none')
            return [];
        this.responseBytes += chunk.byteLength;
        if (this.responseBytes > MAX_OBSERVATION_BYTES) {
            this.abort();
            return [];
        }
        if (!this.replaceResponseText(this.responseText + this.decoder.write(Buffer.from(chunk)))) {
            this.abort();
            return [];
        }
        const observations = this.responseMode === 'sse' ? this.readSse(false, observedAt) : [];
        if (this.tracker.isStopped)
            this.abort();
        return observations;
    }
    observeResponseEnd(observedAt) {
        if (this.stopped || this.responseMode === 'none')
            return [];
        if (!this.replaceResponseText(this.responseText + this.decoder.end())) {
            this.abort();
            return [];
        }
        let observations;
        if (this.responseMode === 'sse')
            observations = this.readSse(true, observedAt);
        else {
            let parsed;
            try {
                parsed = JSON.parse(this.responseText);
            }
            catch {
                parsed = null;
            }
            observations = this.tracker.readJsonResponse(parsed, observedAt);
        }
        this.finish();
        return observations;
    }
    abort() {
        if (this.stopped)
            return;
        this.tracker.abort();
        this.finish();
    }
    readSse(ended, observedAt) {
        const out = [];
        for (;;) {
            const match = /\r?\n\r?\n/.exec(this.responseText);
            if (!match)
                break;
            const block = this.responseText.slice(0, match.index);
            this.replaceResponseText(this.responseText.slice(match.index + match[0].length));
            out.push(...this.readSseBlock(block, observedAt));
        }
        if (ended && this.responseText.trim())
            out.push(...this.readSseBlock(this.responseText, observedAt));
        if (ended)
            this.replaceResponseText('');
        return out;
    }
    readSseBlock(block, observedAt) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data || data === '[DONE]')
            return [];
        let event;
        try {
            event = JSON.parse(data);
        }
        catch {
            return [];
        }
        return object(event) ? this.tracker.readEvent(event, observedAt) : [];
    }
    finish() {
        if (this.stopped)
            return;
        this.tracker.abort();
        this.stopped = true;
        this.responseMode = 'none';
        this.responseText = '';
        this.retainedBudget.release(this.retainedResponseBytes);
        this.retainedResponseBytes = 0;
        if (!this.released) {
            this.released = true;
            this.release();
        }
    }
    replaceResponseText(value) {
        const nextBytes = 256 + value.length * 4;
        if (nextBytes > this.retainedResponseBytes && !this.retainedBudget.reserve(nextBytes - this.retainedResponseBytes)) {
            return false;
        }
        if (nextBytes < this.retainedResponseBytes)
            this.retainedBudget.release(this.retainedResponseBytes - nextBytes);
        this.retainedResponseBytes = nextBytes;
        this.responseText = value;
        return true;
    }
}
class CodexWebSocketObserver {
    context;
    environment;
    promptOccurrences;
    retainedBudget;
    remember;
    previous;
    release;
    pendingByLane = new Map();
    activeByResponse = new Map();
    activeByLane = new Map();
    trackers = new Set();
    ready = false;
    stopped = false;
    constructor(context, environment, promptOccurrences, retainedBudget, remember, previous, release) {
        this.context = context;
        this.environment = environment;
        this.promptOccurrences = promptOccurrences;
        this.retainedBudget = retainedBudget;
        this.remember = remember;
        this.previous = previous;
        this.release = release;
    }
    observeResponseStart(response, _observedAt) {
        if (this.stopped || response.status !== 101) {
            this.abort();
            return [];
        }
        this.ready = true;
        return [];
    }
    observeClientMessage(message, observedAt) {
        if (!this.ready || this.stopped || message.binary || message.data.byteLength > MAX_OBSERVATION_BYTES)
            return [];
        const parsed = this.parse(message.data);
        if (!parsed || parsed.type !== 'response.create' || this.trackers.size >= MAX_ACTIVE_RESPONSES)
            return [];
        const tracker = new ResponseTracker(this.context, this.environment, this.promptOccurrences, this.retainedBudget, this.remember, this.previous);
        const lane = boundedId(parsed.stream_id) ? parsed.stream_id : '';
        if (tracker.isStopped || !tracker.retainLane(lane)) {
            tracker.abort();
            return [];
        }
        this.trackers.add(tracker);
        const pending = this.pendingByLane.get(lane) ?? [];
        pending.push(tracker);
        this.pendingByLane.set(lane, pending);
        const observations = tracker.readRequest(parsed, message.data, observedAt);
        if (tracker.isStopped)
            this.releaseTracker(tracker);
        return observations;
    }
    observeServerMessage(message, observedAt) {
        if (!this.ready || this.stopped || message.binary || message.data.byteLength > MAX_OBSERVATION_BYTES)
            return [];
        const event = this.parse(message.data);
        if (!event)
            return [];
        if (event.type === 'response.created') {
            const responseId = object(event.response) && boundedId(event.response.id) ? event.response.id : null;
            if (!responseId)
                return [];
            const lane = boundedId(event.stream_id) ? event.stream_id : null;
            const tracker = this.takePending(lane);
            if (!tracker)
                return [];
            tracker.readEvent(event, observedAt);
            if (tracker.isStopped) {
                this.releaseTracker(tracker);
                return [];
            }
            const response = { lane: lane ?? '', tracker };
            if (this.activeByResponse.has(responseId)) {
                this.releaseTracker(tracker);
                return [];
            }
            this.activeByResponse.set(responseId, response);
            this.activeByLane.set(response.lane, response);
            return [];
        }
        const terminal = terminalState(event);
        const response = this.responseFor(event);
        if (!response) {
            if (terminal !== null) {
                const lane = boundedId(event.stream_id) ? event.stream_id : null;
                const pending = this.takePending(lane);
                if (pending)
                    this.releaseTracker(pending);
            }
            return [];
        }
        if (terminal === 'failed') {
            try {
                this.environment.onTrackingLoss?.(observedAt ?? Date.now());
            }
            catch { }
        }
        const observations = terminal === 'failed' ? [] : response.tracker.readEvent(event, observedAt);
        if (terminal !== null || response.tracker.isStopped)
            this.releaseResponse(response);
        return observations;
    }
    abort() {
        if (this.stopped)
            return;
        this.stopped = true;
        for (const tracker of this.trackers)
            tracker.abort();
        this.trackers.clear();
        this.pendingByLane.clear();
        this.activeByResponse.clear();
        this.activeByLane.clear();
        this.release();
    }
    parse(data) {
        let parsed;
        try {
            parsed = JSON.parse(Buffer.from(data).toString('utf8'));
        }
        catch {
            return null;
        }
        return object(parsed) ? parsed : null;
    }
    takePending(lane) {
        if (lane !== null) {
            const pending = this.pendingByLane.get(lane);
            const tracker = pending?.shift() ?? null;
            if (pending?.length === 0)
                this.pendingByLane.delete(lane);
            return tracker;
        }
        const entries = [...this.pendingByLane].filter(([, items]) => items.length > 0);
        if (entries.length !== 1)
            return null;
        const [key, pending] = entries[0];
        const tracker = pending.shift() ?? null;
        if (pending.length === 0)
            this.pendingByLane.delete(key);
        return tracker;
    }
    responseFor(event) {
        const responseId = boundedId(event.response_id)
            ? event.response_id
            : object(event.response) && boundedId(event.response.id) ? event.response.id : null;
        if (responseId)
            return this.activeByResponse.get(responseId) ?? null;
        const lane = boundedId(event.stream_id) ? event.stream_id : null;
        if (lane !== null)
            return this.activeByLane.get(lane) ?? null;
        return this.activeByResponse.size === 1 ? this.activeByResponse.values().next().value ?? null : null;
    }
    releaseResponse(response) {
        this.releaseTracker(response.tracker);
    }
    releaseTracker(tracker) {
        for (const [lane, pending] of this.pendingByLane) {
            const remaining = pending.filter((item) => item !== tracker);
            if (remaining.length === 0)
                this.pendingByLane.delete(lane);
            else if (remaining.length !== pending.length)
                this.pendingByLane.set(lane, remaining);
        }
        for (const [responseId, response] of this.activeByResponse) {
            if (response.tracker === tracker)
                this.activeByResponse.delete(responseId);
        }
        for (const [lane, response] of this.activeByLane) {
            if (response.tracker === tracker)
                this.activeByLane.delete(lane);
        }
        this.trackers.delete(tracker);
        tracker.abort();
    }
}
export function codexAdapter(environment) {
    const promptOccurrences = new PromptOccurrenceCorrelator(() => environment.now?.() ?? Date.now());
    const hookBoundaries = new HookBoundaryTracker();
    const retainedGlobalAnalysis = environment.analysisBudget?.reserve(GLOBAL_ADAPTER_ANALYSIS_BYTES)
        ? GLOBAL_ADAPTER_ANALYSIS_BYTES
        : environment.analysisBudget ? 0 : GLOBAL_ADAPTER_ANALYSIS_BYTES;
    let closed = retainedGlobalAnalysis === 0;
    return {
        agent: 'codex',
        createConnection: () => new CodexConnection(environment, promptOccurrences, closed),
        normalizeHook(payload, boundaryAt) {
            if (closed)
                return [];
            if (!record(payload))
                return [];
            const conversationId = boundedId(payload.thread_id)
                ? payload.thread_id
                : boundedId(payload.session_id) ? payload.session_id : null;
            if (!conversationId)
                return [];
            let context = null;
            try {
                const parsed = sessionContextSchema.safeParse(environment.contextForConversation(conversationId, typeof payload.cwd === 'string' ? payload.cwd : undefined));
                if (parsed.success && parsed.data.agent === 'codex' && parsed.data.conversationId === conversationId)
                    context = parsed.data;
            }
            catch { }
            if (!context)
                return [];
            const event = typeof payload.type === 'string'
                ? payload.type
                : typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '';
            const observedAt = boundaryAt ?? environment.now?.() ?? Date.now();
            if (event === 'session-end' || event === 'SessionEnd') {
                if (hookBoundaries.endSession(context)) {
                    try {
                        environment.onTrackingLoss?.(observedAt);
                    }
                    catch { }
                }
                return [];
            }
            const phase = event === 'before-tool-use' || event === 'PreToolUse'
                ? 'started'
                : event === 'after-tool-use' || event === 'tool-use-error' || event === 'PostToolUse' || event === 'PostToolUseFailure'
                    ? 'settled'
                    : null;
            const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
            const callId = boundedId(payload.tool_use_id) ? payload.tool_use_id : null;
            const args = record(payload.arguments) ? payload.arguments : record(payload.tool_input) ? payload.tool_input : null;
            if (phase && toolName && callId && args) {
                return observeHookToolBoundary(hookBoundaries, environment, {
                    context,
                    phase,
                    toolName,
                    callId,
                    args,
                    observedAt,
                    ...(boundedId(payload.agent_id) ? { actorId: payload.agent_id } : {}),
                    ...(boundedId(payload.turn_id) ? { turnId: payload.turn_id } : {}),
                });
            }
            if ((event !== 'user-prompt-submit' && event !== 'UserPromptSubmit') || typeof payload.prompt !== 'string' ||
                Buffer.byteLength(payload.prompt, 'utf8') > MAX_OBSERVATION_BYTES)
                return [];
            const stableId = createHash('sha256').update(conversationId).update('\0').update(payload.prompt).digest('base64url');
            return [{
                    kind: 'prompt', context,
                    eventId: environment.eventId?.('prompt', `hook:${stableId}`) ?? `codex:prompt:hook:${randomUUID()}`,
                    observedAt,
                    occurrenceId: promptOccurrences.identify(conversationId, payload.prompt, 'hook'),
                    text: payload.prompt,
                }];
        },
        close() {
            if (closed)
                return;
            closed = true;
            environment.analysisBudget?.release(retainedGlobalAnalysis);
        },
    };
}
export function codexObserverHookCommand() {
    return observerHookCommand();
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function toml(value) {
    if (typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    if (Array.isArray(value))
        return `[${value.map(toml).join(', ')}]`;
    if (record(value)) {
        return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(', ')} }`;
    }
    throw new Error('unsupported Codex launch override value');
}
function override(path, value) {
    return ['-c', `${path}=${toml(value)}`];
}
function nativeKeySegment(value) {
    return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}
function codexHookConfig(existing) {
    const handler = { type: 'command', command: codexObserverHookCommand(), async: true, timeout: 1 };
    return mergeObserverHooks(existing, handler);
}
function configOverrideTouches(args, root) {
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const value = arg === '-c' || arg === '--config'
            ? args[++index]
            : arg.startsWith('--config=') ? arg.slice('--config='.length) : null;
        if (!value)
            continue;
        const equalsAt = value.indexOf('=');
        const key = value.slice(0, equalsAt < 0 ? value.length : equalsAt).trim();
        const quotedRoot = JSON.stringify(root);
        if (key === root || key.startsWith(`${root}.`) || key === quotedRoot || key.startsWith(`${quotedRoot}.`))
            return true;
    }
    return false;
}
function configOverrideAffectsOwnedTransport(args, alias) {
    const root = `mcp_servers.${alias}`;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const value = arg === '-c' || arg === '--config'
            ? args[++index]
            : arg.startsWith('--config=') ? arg.slice('--config='.length) : null;
        if (!value)
            continue;
        const equalsAt = value.indexOf('=');
        const key = value.slice(0, equalsAt < 0 ? value.length : equalsAt).trim();
        if (key === 'mcp_servers')
            return true;
        if (key !== root && !key.startsWith(`${root}.`))
            continue;
        if (key === root)
            return true;
        const field = key.slice(root.length + 1).split('.', 1)[0].replace(/^"|"$/g, '');
        if (field === 'command' || field === 'args' || field === 'env' || field === 'cwd' || field === 'type' || field === 'url') {
            return true;
        }
    }
    return false;
}
function supportsFinalOverridePlacement(args) {
    return codexSubcommand(args) === 'exec';
}
function placeGeneratedOverrides(generated, clientArgs) {
    if (!supportsFinalOverridePlacement(clientArgs))
        return [...generated, ...clientArgs];
    const sentinel = clientArgs.indexOf('--');
    if (sentinel < 0)
        return [...clientArgs, ...generated];
    return [...clientArgs.slice(0, sentinel), ...generated, ...clientArgs.slice(sentinel)];
}
export function codexProxyOverrideIsVerifiable(config, nativeGlobalArgs, clientArgs = []) {
    const provider = typeof config.model_provider === 'string' ? config.model_provider : 'openai';
    if (provider !== 'openai' && nativeKeySegment(provider) === null)
        return false;
    if (supportsFinalOverridePlacement(clientArgs))
        return true;
    return provider === 'openai'
        ? !configOverrideTouches(nativeGlobalArgs, 'openai_base_url')
        : !configOverrideTouches(nativeGlobalArgs, 'model_providers');
}
export async function buildLaunchPlan(context) {
    const effective = context.nativeConfig.config;
    const generated = [];
    const disabledCapabilities = [];
    const modelProvider = typeof effective.model_provider === 'string' ? effective.model_provider : 'openai';
    if (context.observe === 'proxy' && context.relayBaseUrl &&
        !codexProxyOverrideIsVerifiable(effective, context.nativeGlobalArgs ?? [], context.clientArgs)) {
        throw new Error('Codex provider override would bypass proxy observation');
    }
    let upstreamBaseUrl;
    if (modelProvider === 'openai') {
        upstreamBaseUrl = typeof effective.openai_base_url === 'string'
            ? effective.openai_base_url
            : context.nativeUpstreamBaseUrl ?? '';
        if (!upstreamBaseUrl && context.observe === 'proxy') {
            throw new Error('Codex account route could not be verified for proxy observation');
        }
        if (!upstreamBaseUrl)
            upstreamBaseUrl = 'https://invalid.invalid';
        if (context.observe === 'proxy' && context.relayBaseUrl)
            generated.push(...override('openai_base_url', context.relayBaseUrl));
    }
    else {
        const providers = effective.model_providers;
        const selected = record(providers) ? providers[modelProvider] : null;
        if (!record(selected) || typeof selected.base_url !== 'string') {
            if (context.observe === 'proxy')
                throw new Error('selected Codex provider endpoint could not be verified');
            upstreamBaseUrl = 'https://invalid.invalid';
        }
        else {
            upstreamBaseUrl = selected.base_url;
        }
        if (context.observe === 'proxy' && context.relayBaseUrl) {
            const providerSegment = nativeKeySegment(modelProvider);
            if (!providerSegment)
                throw new Error('selected Codex provider could not be redirected safely');
            generated.push(...override(`model_providers.${providerSegment}.base_url`, context.relayBaseUrl));
        }
    }
    const servers = record(effective.mcp_servers) ? effective.mcp_servers : {};
    const finalOverrides = supportsFinalOverridePlacement(context.clientArgs);
    for (const [alias, raw] of Object.entries(servers)) {
        if (!record(raw) || raw.enabled === false || !isStdioEntry(raw))
            continue;
        const aliasSegment = nativeKeySegment(alias);
        if (!aliasSegment) {
            disabledCapabilities.push('owned-mcp:unsupported-alias');
            continue;
        }
        if (!finalOverrides && configOverrideAffectsOwnedTransport(context.nativeGlobalArgs ?? [], aliasSegment)) {
            disabledCapabilities.push('owned-mcp:config-override-precedence');
            continue;
        }
        const wrapped = wrapLaunchEntry(alias, raw, context.self, {
            hostClient: 'codex',
            socketPath: context.session.socketPath,
            capability: context.session.capability,
            launchId: context.session.launchId,
        });
        if (!('entry' in wrapped)) {
            disabledCapabilities.push(`owned-mcp:${wrapped.reason}`);
            continue;
        }
        const entryOverrides = [];
        try {
            for (const key of ['command', 'args', 'env', 'cwd']) {
                const value = wrapped.entry[key];
                if (value !== undefined)
                    entryOverrides.push(...override(`mcp_servers.${aliasSegment}.${key}`, value));
            }
        }
        catch {
            disabledCapabilities.push('owned-mcp:unsupported-entry');
            continue;
        }
        generated.push(...entryOverrides);
    }
    if (context.observe !== 'off') {
        const hooks = codexHookConfig(effective.hooks);
        const features = record(effective.features) ? effective.features : {};
        const hooksRemainNative = !finalOverrides && configOverrideTouches(context.nativeGlobalArgs ?? [], 'hooks');
        if (hooksRemainNative) {
            disabledCapabilities.push('hook-observation:config-override-precedence');
        }
        else if (hooks && features.hooks !== false && features.codex_hooks !== false && effective.allow_managed_hooks_only !== true) {
            try {
                generated.push(...override('hooks', hooks));
            }
            catch {
                disabledCapabilities.push('hook-observation:unsupported-settings');
            }
        }
        else {
            disabledCapabilities.push('hook-observation:settings-policy');
        }
    }
    const env = context.observe === 'off'
        ? { ...context.env }
        : observerEnvironment(context.env, context.hook, 'codex');
    return {
        command: context.clientBin ?? resolveCodexBin(context.env.SPECULATE_CODEX_BIN ?? 'codex', {
            env: context.env,
            cwd: context.cwd,
        }),
        args: placeGeneratedOverrides(generated, context.clientArgs),
        env,
        upstreamBaseUrl,
        transport: 'responses',
        disabledCapabilities,
        async cleanup() { },
    };
}
