import { afterAll, expect, it, vi } from 'vitest';
const mock = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const previousHome = process.env.PILOT_HOME;
    const home = mkdtempSync(join(tmpdir(), 'pilotdeck-sending-'));
    process.env.PILOT_HOME = home;
    return { gateway: null, home, previousHome };
});
vi.mock('./services/gatewayConnectionCache.js', () => ({ createGatewayConnectionCache: () => ({ get: async () => mock.gateway, invalidate: () => {} }) }));
import { decidePermissionViaGateway, elicitationRespondViaGateway, enqueueInputViaGateway, getInputQueueStateViaGateway, serializeQueuedInputForStorage, runChatViaGateway, createTeamTurnEventForwarder } from './pilotdeck-bridge.js';
import { rm } from 'node:fs/promises';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const item = id => ({ id, runId: id, command: 'fixture', displayText: id, options: { projectPath: '/tmp/sending-project' } });
afterAll(async () => {
    if (mock.previousHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = mock.previousHome;
    await rm(mock.home, { recursive: true, force: true });
});
it('shows idle input as sending, preserves concurrent input order, and removes each send only on acceptance', async () => {
    const acceptance = deferred(), completion = deferred(); const calls = [], frames = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.runId);
            if (calls.length === 1) await acceptance.promise;
            yield { type: 'input_accepted', runId: input.runId };
            if (calls.length === 1) await completion.promise;
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const sid = 'web:s_sending', writer = { send: frame => frames.push(structuredClone(frame)) };
    const first = await enqueueInputViaGateway(sid, item('first'), writer);
    expect(first.state.items[0].status).toBe('submitting');
    await vi.waitFor(() => expect(calls).toEqual(['first']));
    expect((await getInputQueueStateViaGateway(sid)).items[0].status).toBe('dispatching');
    const second = await enqueueInputViaGateway(sid, item('second'), writer);
    expect(second.state.items[1].status).toBe('queued');
    acceptance.resolve();
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items.map(x => x.id)).toEqual(['second']));
    expect(calls).toEqual(['first']);
    completion.resolve();
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items).toEqual([]));
    expect(calls).toEqual(['first', 'second']);
    expect(frames.filter(x => x.type === 'session-input-accepted').map(x => x.runId)).toEqual(['first', 'second']);
    expect(frames.filter(x => x.role === 'user').map(x => x.queueItemId)).toEqual(['first', 'second']);
});
it('converts a provisional send to a real queue item if the gateway discovers another active client', async () => {
    const snapshot = deferred();
    mock.gateway = { getActiveTurnSnapshot: () => snapshot.promise, submitTurn: vi.fn() };
    const sid = 'web:s_remote_busy';
    expect((await enqueueInputViaGateway(sid, item('remote'), { send() {} })).state.items[0].status).toBe('submitting');
    snapshot.resolve({ active: true, runId: 'other-client', events: [] });
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items[0].status).toBe('queued'));
    expect(mock.gateway.submitTurn).not.toHaveBeenCalled();
});
it('retains failed sends for recovery and treats only actually dispatched inputs as uncertain on restart', async () => {
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn() { yield { type: 'error', message: 'Rejected before acceptance' }; },
    };
    const sid = 'web:s_rejected';
    await enqueueInputViaGateway(sid, item('rejected'), { send() {} });
    await vi.waitFor(async () => expect(await getInputQueueStateViaGateway(sid)).toMatchObject({ paused: true, items: [{ id: 'rejected', status: 'failed' }] }));
    expect(serializeQueuedInputForStorage({ ...item('checking'), status: 'submitting' }).status).toBe('queued');
    expect(serializeQueuedInputForStorage({ ...item('sent'), status: 'dispatching' }).status).toBe('delivery_uncertain');
});

it.each([false, true])('acknowledges a retry after execution without dispatching again (restart=%s)', async restart => {
    const calls = [], frames = [];
    mock.gateway = {
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input.runId);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const sid = `web:s_retry_${restart}`, writer = {send: frame => frames.push(frame)};
    const first = item(`accepted-${restart}`);
    await enqueueInputViaGateway(sid, first, writer);
    await vi.waitFor(() => expect(frames.some(frame => frame.kind === 'complete')).toBe(true));
    let enqueue = enqueueInputViaGateway;
    if (restart) {
        vi.resetModules();
        enqueue = (await import('./pilotdeck-bridge.js')).enqueueInputViaGateway;
    }
    const retry = await enqueue(sid, first, writer);
    expect(retry).toMatchObject({ok: true, state: {items: []}});
    expect(calls).toEqual([first.id]);
    await enqueue(sid, {...first, id: first.id + '-new', runId: first.id + '-new'}, writer);
    await vi.waitFor(() => expect(calls).toEqual([first.id, first.id + '-new']));
});


it('assigns a real ID before startup failure without acknowledging the input', async () => {
    const frames = [];
    const result = await runChatViaGateway('fixture', { projectPath: '/tmp/sending-project', runId: 'failed-start' },
        { send: frame => frames.push(frame) }, 'pilotdeck', {
            getGateway: async () => { throw new Error('Gateway unavailable'); },
        });
    expect(frames.find(frame => frame.kind === 'session_created')?.newSessionId).toBe(result.sessionKey);
    expect(frames.some(frame => frame.kind === 'error' && frame.terminal === true && frame.sessionId === result.sessionKey)).toBe(true);
    expect(frames.some(frame => frame.type === 'session-input-accepted')).toBe(false);
});

it('freezes Team selection through queued execution and rejects a changed retry after completion', async () => {
    const calls = [], frames = [];
    mock.gateway = {
        describeServer: async () => ({ serverInstanceId: 'gateway-one' }),
        teamCommand: async () => ({ activation: { id: 'activation-original', stopVersion: 0, status: 'active' } }),
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const sid = 'web:s_team_queue', first = item('team-queued');
    first.options.teamActivationId = 'activation-original';
    first.options.teamStopVersion = 0;
    first.options.modelSelection = { mode: 'model', provider: 'test', model: 'solo-model' };
    await enqueueInputViaGateway(sid, first, { send: frame => frames.push(frame) });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items).toHaveLength(0));
    expect(calls[0].teamActivationId).toBe('activation-original');
    expect(calls[0].teamStopVersion).toBe(0);
    expect(frames.some(frame => frame.type === 'model-selection-saved')).toBe(false);
    expect(await enqueueInputViaGateway(sid, { ...first, options: { ...first.options, teamActivationId: 'activation-other' } })).toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
    vi.resetModules();
    const restored = await import('./pilotdeck-bridge.js');
    expect(await restored.enqueueInputViaGateway(sid, { ...first, command: 'changed' })).toMatchObject({ ok: false });
});

it('forwards Gateway-owned Leader output and human approval requests to the same conversation', () => {
    const frames = [];
    const forward = createTeamTurnEventForwarder((sessionId, frame) => frames.push({ sessionId, frame }));
    const payload = { sessionKey: 'web:s_background_team', projectKey: '/tmp/sending-project' };
    for (const event of [
        { type: 'turn_started', runId: 'continuation' },
        { type: 'assistant_text_delta', text: 'Collected teammate result.', runId: 'continuation' },
        { type: 'permission_request', requestId: 'member-approval', toolName: 'bash', payload: { command: 'test' } },
        { type: 'input_accepted', modelSelection: { mode: 'model', provider: 'test', model: 'leader' } },
        { type: 'turn_completed', runId: 'continuation', finishReason: 'completed', usage: {} },
    ]) forward('team_runtime_event', { ...payload, event });
    expect(frames.every(item => item.sessionId === payload.sessionKey)).toBe(true);
    expect(frames.some(({ frame }) => frame.kind === 'permission_request' && frame.requestId === 'member-approval')).toBe(true);
    expect(frames.some(({ frame }) => frame.kind === 'complete')).toBe(true);
    expect(frames.some(({ frame }) => frame.type === 'model-selection-saved')).toBe(false);
    expect(frames.some(({ frame }) => frame.kind === 'session_created')).toBe(false);
});

it('forwards Teammate human interactions as dedicated Team frames instead of Leader permission cards', () => {
    const frames = [];
    const forward = createTeamTurnEventForwarder((sessionId, frame) => frames.push({ sessionId, frame }));
    const payload = { sessionKey: 'web:s_background_team_interaction', projectKey: '/tmp/sending-project' };
    const interaction = {
        id: 'interaction-1', requestId: 'request-1', activationId: 'activation-1',
        sessionKey: payload.sessionKey, stopVersion: 0,
        participantId: 'teammate-1', participantDisplayName: 'Reviewer',
        kind: 'tool_permission', toolName: 'write_file', request: { path: 'out/report.md' }, status: 'pending',
    };
    forward('team_runtime_event', { ...payload, event: { type: 'team_interaction', interaction } });
    expect(frames).toHaveLength(1);
    expect(frames[0].sessionId).toBe(payload.sessionKey);
    expect(frames[0].frame).toMatchObject({ type: 'team-interaction', sessionId: payload.sessionKey, interaction });
    expect(frames[0].frame.kind).not.toBe('permission_request');
});

it('forwards Team interaction updates without losing handled status', () => {
    const frames = [];
    const forward = createTeamTurnEventForwarder((sessionId, frame) => frames.push({ sessionId, frame }));
    const payload = { sessionKey: 'web:s_background_team_interaction_update', projectKey: '/tmp/sending-project' };
    const interaction = {
        id: 'interaction-2', requestId: 'request-2', activationId: 'activation-2',
        sessionKey: payload.sessionKey, stopVersion: 1,
        participantId: 'teammate-2', participantDisplayName: 'Tester',
        kind: 'user_question', request: { questions: [{ question: 'Use staging?' }] }, status: 'answered',
        resolvedAt: '2026-10-27T00:00:00.000Z', resolution: { staging: true },
    };
    forward('team_runtime_event', { ...payload, event: { type: 'team_interaction_updated', interaction, delivered: true } });
    expect(frames).toHaveLength(1);
    expect(frames[0].frame).toMatchObject({ type: 'team-interaction-updated', sessionId: payload.sessionKey, interaction, delivered: true });
});

it('keeps member stream blocks on a dedicated frame, including the final durable reload', () => {
    const frames = [];
    const forward = createTeamTurnEventForwarder((sessionId, frame) => frames.push({ sessionId, frame }));
    const owner = { activationId: 'activation', stopVersion: 2, participantId: 'member', streamEpoch: 'process' };
    const messages = [{ id: 'turn:block', role: 'assistant', content: [{ type: 'text', text: 'partial' }], isStreaming: true }];
    forward('team_runtime_event', { sessionKey: 'web:member-stream', event: { type: 'team_participant_message', ...owner, revision: 7, messages, streaming: true } });
    forward('team_runtime_event', { sessionKey: 'web:member-stream', event: { type: 'team_participant_message', ...owner, revision: 8, messages: [], streaming: false, reload: true } });
    expect(frames).toHaveLength(2);
    expect(frames.every(({ sessionId, frame }) => sessionId === 'web:member-stream' && frame.type === 'team-participant-message' && !frame.kind)).toBe(true);
    expect(frames[0].frame).toMatchObject({ ...owner, revision: 7, messages, streaming: true });
    expect(frames[1].frame).toMatchObject({ ...owner, revision: 8, streaming: false, reload: true });
});

it('invalidates Team inputs on Abort without changing ordinary queued inputs and fences stale Abort', async () => {
    const bridge = await import('./pilotdeck-bridge.js');
    mock.gateway = {
        describeServer: async () => ({ serverInstanceId: 'queue-gateway' }),
        teamCommand: async () => ({ activation: { id: 'activation', stopVersion: 2, status: 'active' } }),
        getActiveTurnSnapshot: async () => ({ active: true, runId: 'busy', events: [] }),
        submitTurn: vi.fn(),
    };
    const sid = 'web:s_epoch_abort';
    const team = { ...item('old-team'), options: { ...item('').options, teamActivationId: 'activation', teamStopVersion: 2, uploadedAttachments: [{ uploadId: 'upload', attachmentIds: ['file'] }] } };
    await bridge.enqueueInputViaGateway(sid, team, { send() {} });
    await vi.waitFor(async () => expect((await bridge.getInputQueueStateViaGateway(sid)).items[0].status).toBe('queued'));
    await bridge.enqueueInputViaGateway(sid, item('ordinary'), { send() {} });
    bridge.invalidateTeamSessionInputs(sid, 'abort', { activationId: 'activation', stopVersion: 1 });
    expect((await bridge.getInputQueueStateViaGateway(sid)).items[0].status).toBe('queued');
    bridge.invalidateTeamSessionInputs(sid, 'abort', { activationId: 'activation', stopVersion: 2 });
    expect((await bridge.getInputQueueStateViaGateway(sid)).items).toMatchObject([
        { id: 'old-team', status: 'invalidated', recovery: { command: 'fixture', uploadedAttachments: [{ uploadId: 'upload', attachmentIds: ['file'] }] } },
        { id: 'ordinary', status: 'queued' },
    ]);
    expect(await bridge.enqueueInputViaGateway(sid, team)).toMatchObject({ ok: false });
    expect(bridge.moveQueuedInputToFrontViaGateway(sid, team.id)).toMatchObject({ ok: false });
    expect(await bridge.steerQueuedInputViaGateway(sid, team.id)).toMatchObject({ ok: false });
    expect(mock.gateway.submitTurn).not.toHaveBeenCalled();
});

it.each(['gateway', 'bridge'])('invalidates unbound Team draft input after %s restart without losing attachments', async restart => {
    let instanceId = 'first-process';
    mock.gateway = {
        describeServer: async () => ({ serverInstanceId: instanceId }),
        teamCommand: async () => ({ activation: null }),
        getActiveTurnSnapshot: async () => ({ active: true, runId: 'busy', events: [] }),
        submitTurn: vi.fn(),
    };
    let bridge = await import('./pilotdeck-bridge.js');
    const sid = `web:s_draft_restart_${restart}`;
    const draft = { ...item(`draft-${restart}`), options: { ...item('').options, teamSelection: { team: { id: 'team', revision: 1 }, requestToken: 'choice' }, uploadedAttachments: [{ uploadId: 'original', attachmentIds: ['image'] }] } };
    await bridge.enqueueInputViaGateway(sid, draft, { send() {} });
    await vi.waitFor(async () => expect((await bridge.getInputQueueStateViaGateway(sid)).items[0].status).toBe('queued'));
    // A transport reconnection to the same Gateway must not invalidate work.
    expect((await bridge.getInputQueueStateViaGateway(sid)).items[0].status).toBe('queued');
    if (restart === 'gateway') instanceId = 'second-process';
    else { vi.resetModules(); bridge = await import('./pilotdeck-bridge.js'); }
    expect((await bridge.getInputQueueStateViaGateway(sid, { projectPath: '/tmp/sending-project' })).items[0]).toMatchObject({ status: 'invalidated', recovery: { uploadedAttachments: draft.options.uploadedAttachments } });
    expect(await bridge.resumeInputQueueViaGateway(sid, { send() {} })).toMatchObject({ ok: false });
    expect(await bridge.enqueueInputViaGateway(sid, draft)).toMatchObject({ ok: false });
    expect(mock.gateway.submitTurn).not.toHaveBeenCalled();
});

it('never renders internal Team steer events as user messages', async () => {
    const { gatewayEventToFrames } = await import('./pilotdeck-bridge.js');
    for (const event of [
        { type: 'steer_applied', purpose: 'team_runtime', itemId: 'internal', message: { content: [{ type: 'text', text: 'teammate message' }] } },
        { type: 'steer_applied', itemId: 'internal', message: { metadata: { purpose: 'team_runtime' }, content: [{ type: 'text', text: 'teammate message' }] } },
    ]) expect(gatewayEventToFrames(event, 'session', 'pilotdeck')).toEqual([]);
});

it('renders actual Team dispatches as stable system markers without private message text', async () => {
    const { gatewayEventToFrames } = await import('./pilotdeck-bridge.js');
    const [row] = gatewayEventToFrames({ type: 'steer_applied', runId: 'turn-2', purpose: 'team_runtime', itemId: 'batch-1', message: {
        metadata: { purpose: 'team_runtime', teamConsumed: true, teamRequestId: 'request-1', teamInjectionMode: 'start', teamEventIds: ['message-1'] },
        content: [{ type: 'text', text: 'private member message' }],
    } }, 'session', 'pilotdeck');
    expect(row).toMatchObject({ id: 'team:request-1', kind: 'team_message', turnId: 'turn-2', content: '', teamInjectionMode: 'start', teamMessageIds: ['message-1'] });
    expect(JSON.stringify(row)).not.toContain('private member message');
    const [humanTurn] = gatewayEventToFrames({ type: 'steer_applied', runId: 'turn-2', itemId: 'batch-2', message: {
        metadata: { purpose: 'team_runtime', teamConsumed: true, teamRequestId: 'request-human', teamInjectionMode: 'start', teamTurnOrigin: 'human', teamEventIds: ['message-2'] }, content: [],
    } }, 'session', 'pilotdeck');
    expect(humanTurn.teamInjectionMode).toBe('during');
});

it('invalidates a queued bound input when Gateway advances its generation without waiting for a push event', async () => {
    let version = 4;
    const bridge = await import('./pilotdeck-bridge.js');
    mock.gateway = {
        describeServer: async () => ({ serverInstanceId: 'epoch-process' }),
        teamCommand: async () => ({ activation: { id: 'epoch-team', stopVersion: version, status: 'stopped' } }),
        getActiveTurnSnapshot: async () => ({ active: true, runId: 'busy', events: [] }),
        submitTurn: vi.fn(),
    };
    const sid = 'web:s_epoch_changed', input = { ...item('epoch-input'), options: { ...item('').options, teamActivationId: 'epoch-team', teamStopVersion: 4 } };
    await bridge.enqueueInputViaGateway(sid, input, { send() {} });
    await vi.waitFor(async () => expect((await bridge.getInputQueueStateViaGateway(sid)).items[0].status).toBe('queued'));
    version += 1;
    expect((await bridge.getInputQueueStateViaGateway(sid)).items[0]).toMatchObject({ status: 'invalidated', invalidationReason: 'run_invalidated' });
    expect(await bridge.resumeInputQueueViaGateway(sid, { send() {} })).toMatchObject({ ok: false });
    expect(mock.gateway.submitTurn).not.toHaveBeenCalled();
});

it('does not acknowledge completed Abort while draft execution or Team cleanup is still active', async () => {
    const bridge = await import('./pilotdeck-bridge.js');
    const abortTurn = vi.fn(async () => {});
    mock.gateway = { abortTurn, getActiveTurnSnapshot: async () => ({ active: true, runId: 'draft-run' }) };
    expect(await bridge.abortViaGateway('web:s_draft_stop', 'pilotdeck', { runId: 'draft-run' })).toBe(false);
    mock.gateway.getActiveTurnSnapshot = async () => ({ active: false });
    mock.gateway.teamCommand = async () => ({ activation: { status: 'stopping' } });
    expect(await bridge.abortViaGateway('web:s_draft_stop', 'pilotdeck', { runId: 'draft-run' })).toBe(false);
    mock.gateway.teamCommand = async () => ({ activation: { status: 'stopped' } });
    expect(await bridge.abortViaGateway('web:s_draft_stop', 'pilotdeck', { runId: 'draft-run' })).toBe(true);
    expect(abortTurn).toHaveBeenLastCalledWith({ sessionKey: 'web:s_draft_stop', runId: 'draft-run' });
});

it('invalidates same-selection draft followups when Abort arrives before activation is created', async () => {
    const bridge = await import('./pilotdeck-bridge.js');
    const finish = deferred();
    mock.gateway = {
        describeServer: async () => ({ serverInstanceId: 'preflight-process' }),
        teamCommand: async () => ({ activation: null }),
        getActiveTurnSnapshot: async () => ({ active: true, runId: 'draft-first' }),
        abortTurn: async () => { finish.resolve(); },
        async *submitTurn() { await finish.promise; yield { type: 'turn_completed', runId: 'draft-first', finishReason: 'aborted', usage: {} }; },
    };
    const sid = 'web:s_draft_preflight', selection = { team: { id: 'test-team', revision: 1 }, requestToken: 'same-choice' };
    const run = bridge.runChatViaGateway('first', { projectPath: '/tmp/sending-project', sessionId: sid, runId: 'draft-first', teamSelection: selection }, { send() {} });
    const queued = { ...item('draft-second'), options: { ...item('').options, teamSelection: selection } };
    await bridge.enqueueInputViaGateway(sid, queued, { send() {} });
    expect((await bridge.getInputQueueStateViaGateway(sid)).items[0].status).toBe('queued');
    await bridge.abortViaGateway(sid, 'pilotdeck', { runId: 'draft-first' });
    await run;
    expect((await bridge.getInputQueueStateViaGateway(sid)).items[0]).toMatchObject({ status: 'invalidated', invalidationReason: 'abort' });
});


it('ordinary human responses require the owning session and never search other sessions', async () => {
    mock.gateway = { permissionDecide: vi.fn(async () => ({ delivered: true })), respondElicitation: vi.fn(async () => ({ delivered: true })) };
    await expect(decidePermissionViaGateway('same-request', 'allow')).rejects.toThrow('sessionId');
    await expect(elicitationRespondViaGateway('same-request', { type: 'cancelled' })).rejects.toThrow('sessionId');
    expect(mock.gateway.permissionDecide).not.toHaveBeenCalled();
    expect(mock.gateway.respondElicitation).not.toHaveBeenCalled();
    await expect(decidePermissionViaGateway('same-request', 'allow', { sessionId: 'web:owner' })).resolves.toBe(true);
    await expect(elicitationRespondViaGateway('same-request', { type: 'cancelled' }, 'web:owner')).resolves.toBe(true);
    expect(mock.gateway.permissionDecide).toHaveBeenCalledExactlyOnceWith({ sessionKey: 'web:owner', requestId: 'same-request', decision: 'allow', remember: undefined, reason: undefined });
    expect(mock.gateway.respondElicitation).toHaveBeenCalledExactlyOnceWith({ sessionKey: 'web:owner', requestId: 'same-request', answer: { type: 'cancelled' } });
});
