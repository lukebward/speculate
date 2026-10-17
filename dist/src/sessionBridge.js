import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { candidateSchema, observationSchema, sessionContextSchema, } from './observerTypes.js';
import { parseResult } from './predictor.js';
import { SessionPredictor } from './sessionPredictor.js';
const MAX_LINE_BYTES = 2 * 1024 * 1024 + 4096;
const MAX_CANDIDATES_PER_EVENT = 3;
const MAX_CANDIDATE_AGE_MS = 1_000;
const MAX_REPLAY_IDS = 4_096;
const MAX_SOURCE_EVENTS = 4_096;
const REPLAY_RETENTION_MS = 120_000;
const MAX_PENDING_OBSERVATIONS = 256;
const MAX_PENDING_OBSERVATION_BYTES = 8 * 1024 * 1024;
const MAX_CONVERSATIONS = 256;
const MAX_SOCKET_BUFFER_BYTES = 256 * 1024;
const MAX_UNAUTHENTICATED_SOCKETS = 32;
const HANDSHAKE_TIMEOUT_MS = 1_000;
const MAX_PENDING_AUTHORIZATIONS = 256;
const MAX_PENDING_AUTHORIZATION_BYTES = 8 * 1024 * 1024;
function secureEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}
function send(socket, value) {
    if (socket.destroyed || !socket.writable)
        return false;
    const payload = `${JSON.stringify(value)}\n`;
    if (socket.writableLength + Buffer.byteLength(payload, 'utf8') > MAX_SOCKET_BUFFER_BYTES)
        return false;
    socket.write(payload);
    return true;
}
function readLines(socket, onLine, onError) {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
        buffered += chunk;
        if (Buffer.byteLength(buffered, 'utf8') > MAX_LINE_BYTES) {
            onError(new Error('bridge message exceeds limit'));
            socket.destroy();
            return;
        }
        for (;;) {
            const at = buffered.indexOf('\n');
            if (at < 0)
                break;
            const line = buffered.slice(0, at);
            buffered = buffered.slice(at + 1);
            if (!line)
                continue;
            try {
                onLine(JSON.parse(line));
            }
            catch {
                onError(new Error('invalid bridge message'));
            }
        }
    });
}
function localAddress() {
    if (process.platform === 'win32') {
        return { socketPath: `\\\\.\\pipe\\speculate-${randomUUID()}`, directory: null };
    }
    const directory = mkdtempSync(join(tmpdir(), 'speculate-session-'));
    chmodSync(directory, 0o700);
    return { socketPath: join(directory, 'bridge.sock'), directory };
}
export class SessionBridge {
    context;
    server;
    directory;
    now;
    correlateCompletion;
    authorizeCandidate;
    onHook;
    startupPolicy;
    onLifecycle;
    coordinates;
    hookCoordinates;
    owners = new Map();
    sockets = new Set();
    conversations = new Map();
    listeners = new Set();
    replay = new Map();
    eventCounts = new Map();
    observationQueue = [];
    sessionPredictor;
    lastCompletionByConversation = new Map();
    observationQueueBytes = 0;
    observationScheduled = false;
    invalidationSequence = 0;
    closed = false;
    pendingAuthorizationBytes = 0;
    hookEvents = 0;
    trackingLost = false;
    pendingAuthorizations = new Map();
    constructor(context, server, directory, now, correlateCompletion, authorizeCandidate, onHook, startupPolicy, onLifecycle, coordinates, hookCoordinates) {
        this.context = context;
        this.server = server;
        this.directory = directory;
        this.now = now;
        this.correlateCompletion = correlateCompletion;
        this.authorizeCandidate = authorizeCandidate;
        this.onHook = onHook;
        this.startupPolicy = startupPolicy;
        this.onLifecycle = onLifecycle;
        this.coordinates = coordinates;
        this.hookCoordinates = hookCoordinates;
        this.conversations.set(context.conversationId, context);
        this.sessionPredictor = new SessionPredictor({ routes: () => this.listRoutes(), now });
    }
    static async start(context, opts = {}) {
        const parsedContext = sessionContextSchema.parse(context);
        const address = localAddress();
        const capability = randomBytes(32).toString('base64url');
        const hookCapability = randomBytes(32).toString('base64url');
        const server = createServer();
        const bridge = new SessionBridge(parsedContext, server, address.directory, opts.now ?? Date.now, opts.correlateCompletion ?? null, opts.authorizeCandidate ?? null, opts.onHook ?? null, opts.startupPolicy ?? null, opts.onLifecycle ?? null, {
            socketPath: address.socketPath,
            capability,
            launchId: context.launchId,
        }, { socketPath: address.socketPath, capability: hookCapability, launchId: context.launchId });
        server.on('connection', (socket) => bridge.accept(socket));
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            server.once('error', onError);
            server.listen(address.socketPath, () => {
                server.off('error', onError);
                resolve();
            });
        });
        if (process.platform !== 'win32')
            chmodSync(address.socketPath, 0o600);
        return bridge;
    }
    listRoutes() {
        return [...this.owners.values()].flatMap((owner) => owner.routes.map((route) => structuredClone(route)));
    }
    conversationContext(conversationId) {
        const context = this.conversations.get(conversationId);
        return context ? structuredClone(context) : null;
    }
    resolveObservedTool(hostServerAlias, exposedTool) {
        const matches = this.listRoutes().filter((route) => route.hostServerAlias === hostServerAlias && route.exposedTool === exposedTool);
        if (matches.length === 0)
            return 'unknown';
        if (matches.length > 1)
            return 'ambiguous';
        return matches[0];
    }
    registerConversation(context) {
        if (this.closed)
            return false;
        const parsed = sessionContextSchema.safeParse(context);
        if (!parsed.success)
            return false;
        context = parsed.data;
        if (context.launchId !== this.context.launchId ||
            context.agent !== this.context.agent)
            return false;
        const existing = this.conversations.get(context.conversationId);
        if (existing) {
            if (existing.cwd === context.cwd)
                return true;
            this.conversations.set(context.conversationId, context);
            this.lastCompletionByConversation.delete(context.conversationId);
            for (const target of this.owners.values()) {
                if (!send(target.socket, { type: 'permission-context', conversationId: context.conversationId, permissionContext: null })) {
                    target.socket.destroy();
                }
            }
            return true;
        }
        if (this.conversations.size >= MAX_CONVERSATIONS)
            return false;
        this.conversations.set(context.conversationId, context);
        return true;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    publishObservation(input) {
        if (this.closed)
            return false;
        const parsed = observationSchema.safeParse(input);
        if (!parsed.success || !this.acceptsContext(parsed.data.context))
            return false;
        const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
        if (parsed.data.kind === 'invalidate') {
            while (this.observationQueue.length >= MAX_PENDING_OBSERVATIONS ||
                this.observationQueueBytes + bytes > MAX_PENDING_OBSERVATION_BYTES) {
                let at = -1;
                for (let index = this.observationQueue.length - 1; index >= 0; index--) {
                    if (this.observationQueue[index].observation.kind !== 'invalidate') {
                        at = index;
                        break;
                    }
                }
                if (at < 0)
                    return false;
                this.observationQueueBytes -= this.observationQueue.splice(at, 1)[0].bytes;
            }
            const at = this.observationQueue.findIndex(({ observation }) => observation.kind !== 'invalidate');
            this.observationQueue.splice(at < 0 ? this.observationQueue.length : at, 0, { observation: parsed.data, bytes });
        }
        else {
            if (this.observationQueue.length >= MAX_PENDING_OBSERVATIONS ||
                this.observationQueueBytes + bytes > MAX_PENDING_OBSERVATION_BYTES)
                return false;
            this.observationQueue.push({ observation: parsed.data, bytes });
        }
        this.observationQueueBytes += bytes;
        if (!this.observationScheduled) {
            this.observationScheduled = true;
            setImmediate(() => this.drainObservations());
        }
        return true;
    }
    submit(input) {
        if (this.closed)
            return false;
        const parsed = candidateSchema.safeParse(input);
        if (!parsed.success)
            return false;
        const candidate = parsed.data;
        const candidateContext = this.conversations.get(candidate.conversationId);
        if (candidate.launchId !== this.context.launchId || !candidateContext)
            return false;
        const now = this.now();
        if (candidate.createdAt > now || now - candidate.createdAt > MAX_CANDIDATE_AGE_MS)
            return false;
        this.pruneReplay(now);
        const replayKey = `${candidate.conversationId}\0${candidate.candidateId}`;
        if (this.replay.has(replayKey))
            return false;
        const eventKey = `${candidate.conversationId}\0${candidate.sourceEventId}`;
        const count = this.eventCounts.get(eventKey)?.count ?? 0;
        if (count >= MAX_CANDIDATES_PER_EVENT)
            return false;
        const owner = [...this.owners.values()].find((item) => item.routes.some((route) => route.routeId === candidate.routeId && route.generation === candidate.generation));
        if (!owner)
            return false;
        const authorizationBytes = this.authorizeCandidate
            ? Buffer.byteLength(JSON.stringify({ candidate, context: candidateContext, route: owner.routes.find((route) => route.routeId === candidate.routeId && route.generation === candidate.generation) }), 'utf8')
            : 0;
        if (this.authorizeCandidate && (this.pendingAuthorizations.size >= MAX_PENDING_AUTHORIZATIONS ||
            this.pendingAuthorizationBytes + authorizationBytes > MAX_PENDING_AUTHORIZATION_BYTES))
            return false;
        this.replay.set(replayKey, now);
        this.eventCounts.set(eventKey, { count: count + 1, at: now });
        while (this.replay.size > MAX_REPLAY_IDS)
            this.replay.delete(this.replay.keys().next().value);
        while (this.eventCounts.size > MAX_SOURCE_EVENTS)
            this.eventCounts.delete(this.eventCounts.keys().next().value);
        if (this.authorizeCandidate) {
            this.pendingAuthorizations.set(replayKey, authorizationBytes);
            this.pendingAuthorizationBytes += authorizationBytes;
            void this.authorizeAndDeliver(candidate, candidateContext, owner, replayKey, now);
            return true;
        }
        const delivered = send(owner.socket, { type: 'candidates', candidates: [candidate] });
        if (!delivered)
            owner.socket.destroy();
        return delivered;
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.sessionPredictor.invalidate([]);
        for (const socket of this.sockets)
            socket.destroy();
        await new Promise((resolve) => this.server.close(() => resolve()));
        if (this.directory)
            rmSync(this.directory, { recursive: true, force: true });
        this.owners.clear();
        this.listeners.clear();
        this.observationQueue.length = 0;
        this.observationQueueBytes = 0;
        this.lastCompletionByConversation.clear();
        this.pendingAuthorizations.clear();
        this.pendingAuthorizationBytes = 0;
    }
    acceptsContext(context) {
        return context.launchId === this.context.launchId &&
            context.agent === this.context.agent &&
            this.conversations.get(context.conversationId)?.cwd === context.cwd;
    }
    async authorizeAndDeliver(candidate, context, owner, replayKey, reservedAt) {
        let result = { decision: 'unverifiable', permissionContext: null };
        const route = owner.routes.find((item) => item.routeId === candidate.routeId && item.generation === candidate.generation);
        try {
            if (route)
                result = await this.authorizeCandidate({ candidate, context, route });
        }
        catch { }
        const bytes = this.pendingAuthorizations.get(replayKey);
        if (bytes !== undefined) {
            this.pendingAuthorizations.delete(replayKey);
            this.pendingAuthorizationBytes -= bytes;
        }
        const currentOwner = this.owners.get(owner.ownerId);
        const currentContext = this.conversations.get(candidate.conversationId);
        const now = this.now();
        const currentRoute = currentOwner?.routes.find((item) => item.routeId === candidate.routeId && item.generation === candidate.generation);
        if (this.closed || !currentOwner || !currentRoute || !currentContext ||
            currentContext.cwd !== context.cwd || this.replay.get(replayKey) !== reservedAt ||
            candidate.createdAt > now || now - candidate.createdAt > MAX_CANDIDATE_AGE_MS)
            return;
        const permissionContext = result.decision === 'allowed' && validId(result.permissionContext)
            ? result.permissionContext
            : null;
        for (const target of this.owners.values()) {
            if (!send(target.socket, { type: 'permission-context', conversationId: candidate.conversationId, permissionContext })) {
                target.socket.destroy();
            }
        }
        if (!permissionContext)
            return;
        if (!send(currentOwner.socket, { type: 'candidates', candidates: [{ candidate, permissionContext }] })) {
            currentOwner.socket.destroy();
        }
    }
    pruneReplay(now) {
        for (const [key, at] of this.replay) {
            if (now - at > REPLAY_RETENTION_MS)
                this.replay.delete(key);
        }
        for (const [key, value] of this.eventCounts) {
            if (now - value.at > REPLAY_RETENTION_MS)
                this.eventCounts.delete(key);
        }
    }
    drainObservations() {
        this.observationScheduled = false;
        const queued = this.observationQueue.splice(0);
        this.observationQueueBytes = 0;
        for (const { observation } of queued) {
            if (observation.kind === 'invalidate' &&
                observation.routeIds.length === 0 &&
                observation.reason === 'observer-tracking-gap')
                this.revokeOwnersForTrackingLoss(observation.reason);
            else if (observation.kind === 'invalidate' &&
                observation.routeIds.length === 0 &&
                (observation.reason === 'native-mutation-start' || observation.reason === 'native-mutation-settle'))
                this.revokeOwnersForNativeMutation(observation.reason);
            for (const candidate of this.sessionPredictor.observe(observation))
                this.submit(candidate);
            for (const listener of this.listeners) {
                try {
                    listener(observation);
                }
                catch { }
            }
        }
    }
    revokeOwnersForTrackingLoss(reason) {
        this.trackingLost = true;
        for (const owner of this.owners.values()) {
            owner.routes = [];
            owner.generation++;
            if (!send(owner.socket, { type: 'invalidate', routeIds: [], reason }))
                owner.socket.destroy();
        }
    }
    revokeOwnersForNativeMutation(reason) {
        if (this.trackingLost)
            return;
        for (const owner of this.owners.values()) {
            owner.routes = [];
            owner.generation++;
            if (!send(owner.socket, { type: 'invalidate', routeIds: [], reason }))
                owner.socket.destroy();
        }
    }
    accept(socket) {
        if (this.sockets.size >= MAX_UNAUTHENTICATED_SOCKETS) {
            socket.destroy();
            return;
        }
        this.sockets.add(socket);
        let owner = null;
        const handshakeTimer = setTimeout(() => {
            if (!owner)
                socket.destroy();
        }, HANDSHAKE_TIMEOUT_MS);
        handshakeTimer.unref();
        socket.on('close', () => {
            clearTimeout(handshakeTimer);
            this.sockets.delete(socket);
            if (owner) {
                const routeIds = owner.routes.map((route) => route.routeId);
                this.owners.delete(owner.ownerId);
                if (!this.closed && routeIds.length > 0)
                    this.publishRouteInvalidation(owner, routeIds, 'disconnect');
            }
        });
        readLines(socket, (raw) => {
            if (raw === null || typeof raw !== 'object')
                return socket.destroy();
            const message = raw;
            if (!owner) {
                if (message.type === 'hook') {
                    clearTimeout(handshakeTimer);
                    if (typeof message.capability === 'string' &&
                        message.launchId === this.context.launchId &&
                        message.hostClient === this.context.agent &&
                        secureEqual(message.capability, this.hookCoordinates.capability) &&
                        this.hookEvents < MAX_SOURCE_EVENTS) {
                        this.hookEvents++;
                        try {
                            this.onHook?.(message.hostClient, message.payload, this.now());
                        }
                        catch { }
                    }
                    socket.end();
                    return;
                }
                if (message.type !== 'hello' ||
                    typeof message.requestId !== 'number' ||
                    typeof message.capability !== 'string' ||
                    message.launchId !== this.context.launchId ||
                    !secureEqual(message.capability, this.coordinates.capability) ||
                    (message.hostClient !== 'claude' && message.hostClient !== 'codex') ||
                    typeof message.hostServerAlias !== 'string' ||
                    message.hostServerAlias.length === 0 ||
                    message.hostServerAlias.length > 512) {
                    if (typeof message.requestId === 'number')
                        send(socket, { type: 'response', requestId: message.requestId, ok: false, error: 'authentication failed' });
                    return socket.end();
                }
                owner = {
                    ownerId: randomUUID(),
                    socket,
                    hostClient: message.hostClient,
                    hostServerAlias: message.hostServerAlias,
                    generation: 0,
                    routes: [],
                };
                this.owners.set(owner.ownerId, owner);
                clearTimeout(handshakeTimer);
                if (!send(socket, { type: 'response', requestId: message.requestId, ok: true, value: owner.ownerId }))
                    socket.destroy();
                return;
            }
            this.handleOwnerMessage(owner, message);
        }, () => socket.destroy());
    }
    handleOwnerMessage(owner, message) {
        const requestId = message.requestId;
        if (typeof requestId !== 'number')
            return;
        if (message.type === 'register' && Array.isArray(message.routes)) {
            if (message.routes.length > 512 || !message.routes.every(validLocalRoute)) {
                this.respond(owner, { type: 'response', requestId, ok: false, error: 'invalid route registration' });
                return;
            }
            if (this.trackingLost) {
                owner.routes = [];
                owner.generation++;
                this.respond(owner, { type: 'response', requestId, ok: true, value: [] });
                return;
            }
            const replacedRouteIds = owner.routes.map((route) => route.routeId);
            owner.routes = [];
            owner.generation++;
            owner.routes = message.routes.map((route) => ({
                ...route,
                routeId: randomUUID(),
                generation: owner.generation,
                instanceId: owner.ownerId,
                hostClient: owner.hostClient,
                hostServerAlias: owner.hostServerAlias,
            }));
            if (replacedRouteIds.length > 0)
                this.publishRouteInvalidation(owner, replacedRouteIds, 'routes-replaced');
            this.respond(owner, { type: 'response', requestId, ok: true, value: owner.routes });
            return;
        }
        if (message.type === 'invalidate') {
            const removedRouteIds = owner.routes
                .filter((route) => typeof message.upstreamServer !== 'string' || route.upstreamServer === message.upstreamServer)
                .map((route) => route.routeId);
            owner.routes = typeof message.upstreamServer === 'string'
                ? owner.routes.filter((route) => route.upstreamServer !== message.upstreamServer)
                : [];
            owner.generation++;
            this.publishRouteInvalidation(owner, removedRouteIds, typeof message.reason === 'string' && message.reason.length > 0 && message.reason.length <= 512
                ? message.reason
                : 'route-invalidated');
            this.respond(owner, { type: 'response', requestId, ok: true });
            return;
        }
        if (message.type === 'observation') {
            const accepted = message.observation?.kind !== 'tool-complete' &&
                this.publishObservation(message.observation);
            this.respond(owner, { type: 'response', requestId, ok: true, value: accepted });
            return;
        }
        if (message.type === 'completed') {
            const accepted = this.queueCompleted(owner, message.completion);
            this.respond(owner, { type: 'response', requestId, ok: true, value: accepted });
            return;
        }
        if (message.type === 'startup-policy' && this.startupPolicy) {
            void this.startupPolicy(owner.hostClient, owner.hostServerAlias).then((value) => this.respond(owner, { type: 'response', requestId, ok: true, value }), () => this.respond(owner, { type: 'response', requestId, ok: true, value: null }));
            return;
        }
        if (message.type === 'lifecycle' && validLifecycle(message.lifecycle)) {
            try {
                const pending = this.onLifecycle?.(message.lifecycle);
                void pending?.catch(() => { });
            }
            catch { }
            this.respond(owner, { type: 'response', requestId, ok: true, value: true });
            return;
        }
        this.respond(owner, { type: 'response', requestId, ok: false, error: 'unsupported bridge message' });
    }
    respond(owner, message) {
        if (!send(owner.socket, message))
            owner.socket.destroy();
    }
    publishRouteInvalidation(owner, routeIds, reason) {
        this.publishObservation({
            context: this.context,
            kind: 'invalidate',
            eventId: `invalidate:${owner.ownerId}:${++this.invalidationSequence}`,
            observedAt: this.now(),
            routeIds,
            reason,
        });
    }
    queueCompleted(owner, input) {
        if (!this.correlateCompletion || !validCompletion(input))
            return false;
        const event = input;
        const route = owner.routes.find((candidate) => candidate.routeId === event.routeId &&
            candidate.generation === event.generation &&
            candidate.exposedTool === event.exposedTool &&
            candidate.upstreamServer === event.upstreamServer &&
            candidate.upstreamTool === event.upstreamTool);
        if (!route ||
            event.launchId !== this.context.launchId ||
            event.hostClient !== owner.hostClient ||
            event.hostServerAlias !== owner.hostServerAlias)
            return false;
        void this.publishCompleted(owner, route, event);
        return true;
    }
    async publishCompleted(owner, route, event) {
        let correlation = null;
        try {
            correlation = await this.correlateCompletion(event);
        }
        catch { }
        const currentOwner = this.owners.get(owner.ownerId);
        const currentRoute = currentOwner?.routes.find((candidate) => candidate.routeId === event.routeId && candidate.generation === event.generation);
        if (!currentRoute)
            return;
        const conversation = correlation && validId(correlation.conversationId)
            ? this.conversations.get(correlation.conversationId)
            : null;
        if (!correlation || !conversation || (correlation.cwd !== undefined && correlation.cwd !== conversation.cwd)) {
            return;
        }
        const eventId = correlation.eventId ?? event.eventId;
        if (!validId(eventId))
            return;
        const previous = this.lastCompletionByConversation.get(correlation.conversationId);
        const ordered = correlation.ordered !== false && (previous === undefined ||
            (event.startedAt >= previous.completedAt && event.completedAt >= previous.completedAt));
        if (previous === undefined || event.completedAt >= previous.completedAt) {
            this.lastCompletionByConversation.set(correlation.conversationId, {
                startedAt: event.startedAt,
                completedAt: event.completedAt,
            });
        }
        const accepted = this.publishObservation({
            context: conversation,
            kind: 'tool-complete',
            eventId,
            observedAt: event.completedAt,
            routeId: route.routeId,
            args: event.args,
            parsed: parseResult(event.result),
            latencyMs: event.completedAt - event.startedAt,
            ordered,
        });
        if (!accepted)
            this.sessionPredictor.invalidate([]);
    }
}
function validId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512;
}
function validCompletion(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const event = value;
    return event.kind === 'tool-complete' &&
        validId(event.launchId) &&
        (event.hostClient === 'claude' || event.hostClient === 'codex') &&
        validId(event.hostServerAlias) &&
        (event.conversationId === null || validId(event.conversationId)) &&
        validId(event.eventId) &&
        validId(event.routeId) &&
        typeof event.generation === 'number' && Number.isInteger(event.generation) && event.generation > 0 &&
        validId(event.exposedTool) &&
        validId(event.upstreamServer) &&
        validId(event.upstreamTool) &&
        event.args !== null && typeof event.args === 'object' && !Array.isArray(event.args) &&
        event.result !== null && typeof event.result === 'object' && !Array.isArray(event.result) &&
        typeof event.latencyMs === 'number' && Number.isFinite(event.latencyMs) && event.latencyMs >= 0 &&
        typeof event.startedAt === 'number' && Number.isFinite(event.startedAt) && event.startedAt >= 0 &&
        typeof event.completedAt === 'number' && Number.isFinite(event.completedAt) &&
        event.completedAt >= event.startedAt;
}
function validLocalRoute(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const route = value;
    return Object.keys(route).every((key) => ['exposedTool', 'upstreamServer', 'upstreamTool', 'inputSchema', 'readOnly'].includes(key)) &&
        ['exposedTool', 'upstreamServer', 'upstreamTool'].every((key) => typeof route[key] === 'string' && route[key].length > 0 && route[key].length <= 512) &&
        (route.readOnly === undefined || typeof route.readOnly === 'boolean') &&
        route.inputSchema !== null && typeof route.inputSchema === 'object' && !Array.isArray(route.inputSchema);
}
function validLifecycle(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const event = value;
    return ['suppressed', 'speculated', 'hit', 'joined', 'expired', 'invalidated', 'abandoned', 'spec_error'].includes(event.type ?? '') &&
        typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) &&
        validId(event.ruleId) && event.observerAttribution !== undefined &&
        (event.observerAttribution.client === 'claude' || event.observerAttribution.client === 'codex') &&
        ['intent', 'transition', 'stream'].includes(event.observerAttribution.source) &&
        validId(event.observerAttribution.routeId) && Number.isInteger(event.observerAttribution.generation);
}
export class SessionBridgeOwner {
    socket;
    onCandidates;
    coordinates;
    ownerId;
    requestId = 1;
    closed = false;
    disconnectHandler = null;
    invalidationHandler = null;
    pending = new Map();
    permissionContexts = new Map();
    constructor(coordinates, ownerId, socket, onCandidates) {
        this.socket = socket;
        this.onCandidates = onCandidates;
        this.coordinates = coordinates;
        this.ownerId = ownerId;
    }
    static async connect(coordinates, options) {
        const socket = createConnection(coordinates.socketPath);
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        let instance = null;
        let helloResolve;
        let helloReject;
        const hello = new Promise((resolve, reject) => { helloResolve = resolve; helloReject = reject; });
        readLines(socket, (raw) => {
            if (raw === null || typeof raw !== 'object')
                return;
            const message = raw;
            if (message.type === 'candidates') {
                try {
                    instance?.onCandidates(message.candidates);
                }
                catch { }
                return;
            }
            if (message.type === 'permission-context') {
                if (message.permissionContext)
                    instance?.permissionContexts.set(message.conversationId, message.permissionContext);
                else
                    instance?.permissionContexts.delete(message.conversationId);
                return;
            }
            if (message.type === 'invalidate' &&
                Array.isArray(message.routeIds) &&
                message.routeIds.length <= 512 &&
                message.routeIds.every(validId) &&
                validId(message.reason)) {
                try {
                    instance?.invalidationHandler?.(message.routeIds, message.reason);
                }
                catch { }
                return;
            }
            if (message.type !== 'response')
                return;
            if (!instance && message.requestId === 0) {
                if (message.ok && typeof message.value === 'string')
                    helloResolve(message.value);
                else
                    helloReject(new Error(message.ok ? 'authentication failed' : message.error));
                return;
            }
            const request = instance?.pending.get(message.requestId);
            if (!request)
                return;
            instance.pending.delete(message.requestId);
            if (message.ok)
                request.resolve(message.value);
            else
                request.reject(new Error(message.error));
        }, (error) => {
            helloReject(error);
            instance?.failPending(error);
        });
        socket.on('close', () => {
            const error = new Error('session bridge connection closed');
            helloReject(error);
            instance?.failPending(error);
            if (instance && !instance.closed) {
                try {
                    instance.disconnectHandler?.();
                }
                catch { }
            }
        });
        send(socket, {
            type: 'hello',
            requestId: 0,
            capability: coordinates.capability,
            launchId: coordinates.launchId,
            hostClient: options.hostClient,
            hostServerAlias: options.hostServerAlias,
        });
        const ownerId = await hello;
        instance = new SessionBridgeOwner(coordinates, ownerId, socket, options.onCandidates);
        return instance;
    }
    async register(routes) {
        return await this.request({ type: 'register', routes: [...routes] });
    }
    replaceRoutes(routes) {
        return this.register(routes);
    }
    setCandidateHandler(handler) {
        this.onCandidates = handler;
    }
    currentPermissionContext(conversationId) {
        return this.permissionContexts.get(conversationId) ?? null;
    }
    async readStartupPolicy() {
        return await this.request({ type: 'startup-policy' }, 1_000);
    }
    setDisconnectHandler(handler) {
        this.disconnectHandler = handler;
    }
    setInvalidationHandler(handler) {
        this.invalidationHandler = handler;
    }
    async invalidate(upstreamServer, reason) {
        await this.request({ type: 'invalidate', upstreamServer, reason });
    }
    invalidateServer(upstreamServer, reason) {
        return this.invalidate(upstreamServer, reason);
    }
    async publishObservation(observation) {
        return await this.request({ type: 'observation', observation });
    }
    async publishCompleted(event) {
        return await this.request({ type: 'completed', completion: event });
    }
    async publishLifecycle(event) {
        return await this.request({ type: 'lifecycle', lifecycle: event });
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.permissionContexts.clear();
        await new Promise((resolve) => {
            if (this.socket.destroyed)
                return resolve();
            this.socket.once('close', () => resolve());
            this.socket.end();
        });
    }
    request(message, timeoutMs) {
        if (this.closed)
            return Promise.reject(new Error('session bridge owner is closed'));
        const requestId = this.requestId++;
        return new Promise((resolve, reject) => {
            let timer = null;
            const settle = (callback) => (value) => {
                if (timer)
                    clearTimeout(timer);
                callback(value);
            };
            this.pending.set(requestId, { resolve: settle(resolve), reject: settle(reject) });
            if (timeoutMs !== undefined) {
                timer = setTimeout(() => {
                    if (!this.pending.delete(requestId))
                        return;
                    reject(new Error('session bridge request timed out'));
                }, timeoutMs);
                timer.unref();
            }
            if (!send(this.socket, { ...message, requestId })) {
                this.pending.delete(requestId);
                if (timer)
                    clearTimeout(timer);
                reject(new Error('session bridge connection is unavailable'));
            }
        });
    }
    failPending(error) {
        for (const request of this.pending.values())
            request.reject(error);
        this.pending.clear();
    }
}
export function connectSessionBridgeOwner(coordinates, options) {
    return SessionBridgeOwner.connect(coordinates, options);
}
