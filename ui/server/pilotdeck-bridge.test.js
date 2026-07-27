import { describe, expect, it } from 'vitest';

import {
    gatewayEventToFrames,
    isGatewayUnavailableError,
    resolvePermissionMode,
} from './pilotdeck-bridge.js';

describe('Team permission selection', () => {
    it('treats Team default as an explicit whole-Team permission policy', () => {
        expect(resolvePermissionMode({
            runMode: 'team',
            permissionMode: 'default',
        })).toBe('default');
        expect(resolvePermissionMode({
            runMode: 'team',
            permissionMode: 'bypassPermissions',
        })).toBe('bypassPermissions');
    });
});

describe('gatewayEventToFrames agent status errors', () => {
    it('maps durable Team messages into Leader chat activity', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'team_message',
            detail: {
                messageId: 'message-1',
                teammateId: 'reviewer',
                message: 'The API contract needs a product decision.',
                kind: 'explicit',
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            id: 'team_message_message-1',
            kind: 'agent_activity',
            phase: 'team',
            state: 'completed',
            title: 'Message from reviewer',
            detail: 'The API contract needs a product decision.',
            teammateId: 'reviewer',
        });
    });

    it('maps tool result detail availability to a mergeable tool_result frame', () => {
        const frames = gatewayEventToFrames({
            type: 'tool_result_detail_available',
            toolCallId: 'call-large',
            resultPath: '/tmp/pilotdeck/tool-result.txt',
            fullText: 'x'.repeat(100000),
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'tool_result',
            toolId: 'call-large',
            content: 'Full tool result persisted at /tmp/pilotdeck/tool-result.txt',
            resultPath: '/tmp/pilotdeck/tool-result.txt',
        });
        expect(frames[0].fullText).toBeUndefined();
    });

    it('bounds live tool result previews before they reach React state', () => {
        const frames = gatewayEventToFrames({
            type: 'tool_call_finished',
            toolCallId: 'call-large',
            ok: true,
            resultPreview: `head\n${'x'.repeat(50000)}\ntail`,
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0].kind).toBe('tool_result');
        expect(frames[0].content.length).toBeLessThan(22000);
        expect(frames[0].content).toContain('UI preview truncated');
        expect(frames[0].content).toContain('head');
        expect(frames[0].content).toContain('tail');
    });

    it('uses detail.userHint for model_empty_response_exhausted', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'model_empty_response_exhausted',
            detail: {
                message: 'The model returned empty content repeatedly.',
                userHint: 'Increase max output tokens.',
                visible: true,
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'The model returned empty content repeatedly.',
            code: 'model_empty_response_exhausted',
            userHint: 'Increase max output tokens.',
        });
    });

    it('renders new semantic status events as error frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'model_request_failed',
            detail: {
                message: 'Provider rejected the request.',
                messageI18n: { key: 'chat:agentStatus.modelRequestFailed.message', params: { providerMessage: 'Provider rejected the request.' } },
                userHint: 'Check provider settings.',
                userHintI18n: { key: 'chat:agentStatus.modelRequestFailed.actions.settingsDefault' },
                visible: true,
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'Provider rejected the request.',
            contentI18n: { key: 'chat:agentStatus.modelRequestFailed.message', params: { providerMessage: 'Provider rejected the request.' } },
            code: 'model_request_failed',
            userHint: 'Check provider settings.',
            userHintI18n: { key: 'chat:agentStatus.modelRequestFailed.actions.settingsDefault' },
        });
    });

    it('renders bridge visible failure status events as error frames', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'gateway_bridge_error',
            detail: {
                message: 'Bridge crashed while streaming.',
                code: 'gateway_bridge_error',
                severity: 'error',
                visible: true,
                userHint: 'Check UI server logs.',
                scope: 'turn',
                source: 'web_bridge',
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'Bridge crashed while streaming.',
            code: 'gateway_bridge_error',
            userHint: 'Check UI server logs.',
        });
    });

    it('renders gateway unavailable preflight status as an error frame', () => {
        const frames = gatewayEventToFrames({
            type: 'agent_status',
            event: 'gateway_unavailable',
            detail: {
                message: 'PilotDeck gateway is unavailable.',
                code: 'gateway_unavailable',
                severity: 'error',
                visible: true,
                userHint: 'Start or restart the PilotDeck gateway, then retry this message.',
                scope: 'preflight',
                source: 'web_bridge',
            },
        }, 'web:s_test', 'pilotdeck');

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            kind: 'error',
            content: 'PilotDeck gateway is unavailable.',
            code: 'gateway_unavailable',
            userHint: 'Start or restart the PilotDeck gateway, then retry this message.',
        });
    });
});

describe('gatewayEventToFrames permission origins', () => {
    it('preserves Team metadata on permission requests without changing tool input', () => {
        const metadata = {
            originSessionKey: 'web:s_leader',
            teammateId: 'implementer',
            controlRequestId: 'control-1',
            extra: { source: 'team' },
        };
        const payload = { command: 'npm test' };
        const [frame] = gatewayEventToFrames({
            type: 'permission_request',
            requestId: 'permission-1',
            toolName: 'bash',
            payload,
            metadata,
        }, 'web:s_leader', 'pilotdeck');

        expect(frame).toMatchObject({
            kind: 'permission_request',
            requestId: 'permission-1',
            input: payload,
            metadata,
            context: {
                provider: 'pilotdeck',
                originSessionKey: 'web:s_leader',
                teammateId: 'implementer',
                controlRequestId: 'control-1',
                metadata,
            },
        });
        expect(frame.input).toBe(payload);
    });

    it('fully forwards Team metadata for exit plan elicitation', () => {
        const metadata = {
            plan: '# Plan\n\nRun the implementation.',
            planFilePath: '/tmp/plan.md',
            originSessionKey: 'web:s_leader',
            teammateId: 'planner',
            controlRequestId: 'control-plan',
            custom: 'preserved',
        };
        const [frame] = gatewayEventToFrames({
            type: 'elicitation_request',
            requestId: 'elicitation-1',
            toolCallId: 'tool-1',
            toolName: 'exit_plan_mode',
            questions: [{ question: 'What should happen next?', options: [] }],
            metadata,
        }, 'web:s_leader', 'pilotdeck');

        expect(frame).toMatchObject({
            toolName: 'ExitPlanModeV2',
            isElicitation: true,
            metadata,
            input: {
                plan: metadata.plan,
                planFilePath: metadata.planFilePath,
                metadata,
            },
            context: {
                provider: 'pilotdeck',
                originalToolName: 'exit_plan_mode',
                originSessionKey: 'web:s_leader',
                teammateId: 'planner',
                controlRequestId: 'control-plan',
                metadata,
            },
        });
    });
});

describe('isGatewayUnavailableError', () => {
    it('detects cached gateway websocket disconnects', () => {
        expect(isGatewayUnavailableError(new Error('Gateway WebSocket is not connected.'))).toBe(true);
        expect(isGatewayUnavailableError(new Error('Gateway WebSocket closed.'))).toBe(true);
        expect(isGatewayUnavailableError(new Error('Gateway closed during hello: auth_failed'))).toBe(true);
        expect(isGatewayUnavailableError(new Error('[pilotdeck-bridge] gateway connect failed after 60000ms'))).toBe(true);
    });

    it('does not classify generic bridge failures as gateway unavailable', () => {
        expect(isGatewayUnavailableError(new Error('Unexpected frame payload'))).toBe(false);
    });
});
