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
import { enqueueInputViaGateway, getInputQueueStateViaGateway, serializeQueuedInputForStorage, runChatViaGateway, createTeamTurnEventForwarder } from './pilotdeck-bridge.js';
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
        getActiveTurnSnapshot: async () => ({ active: false, events: [] }),
        async *submitTurn(input) {
            calls.push(input);
            yield { type: 'input_accepted', runId: input.runId };
            yield { type: 'turn_completed', runId: input.runId, finishReason: 'completed', usage: {} };
        },
    };
    const sid = 'web:s_team_queue', first = item('team-queued');
    first.options.teamActivationId = 'activation-original';
    first.options.modelSelection = { mode: 'model', provider: 'test', model: 'solo-model' };
    await enqueueInputViaGateway(sid, first, { send: frame => frames.push(frame) });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(async () => expect((await getInputQueueStateViaGateway(sid)).items).toHaveLength(0));
    expect(calls[0].teamActivationId).toBe('activation-original');
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
