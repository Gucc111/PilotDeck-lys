// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const gateway = vi.hoisted(() => ({ teamCommand: vi.fn(), closeSession: vi.fn(), closeProjectSessions: vi.fn(), listProjects: vi.fn() }));
vi.mock('./pilotdeck-bridge.js', () => ({
  getPilotDeckGateway: vi.fn(async () => gateway),
  beginSessionDeletion: vi.fn(() => () => {}),
  beginProjectDeletion: vi.fn(() => () => {}),
  isGatewayUnavailableError: () => false,
  withPilotDeckGatewayReadRetry: vi.fn(async (operation) => operation(gateway)),
}));
vi.mock('./database/db.js', () => ({ applyCustomSessionNames: vi.fn() }));
import { deleteSession, deleteProject } from './projects.js';
import { createProjectId, sanitizeSessionIdForPath } from './utils/pilotPaths.js';
import { TeamStore } from '../../src/team/store.js';

describe('Saved Team configuration project protection', () => {
  let pilotHome;
  let previousHome;
  let project;
  let projectDir;
  let transcript;
  const sessionKey = 'web:ordinary';
  beforeEach(async () => {
    previousHome = process.env.PILOT_HOME;
    pilotHome = await fs.mkdtemp(path.join(tmpdir(), 'pilotdeck-team-delete-'));
    process.env.PILOT_HOME = pilotHome;
    project = path.join(pilotHome, 'workspace');
    projectDir = path.join(pilotHome, 'projects', createProjectId(project));
    await fs.mkdir(path.join(projectDir, 'chats'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.cwd'), project);
    transcript = path.join(projectDir, 'chats', `${sanitizeSessionIdForPath(sessionKey)}.jsonl`);
    await fs.writeFile(transcript, JSON.stringify({ type: 'session_metadata', metadata: { title: 'Ordinary conversation' } }) + '\n');
    gateway.teamCommand.mockReset().mockResolvedValue({ referenced: false });
    gateway.closeSession.mockReset().mockResolvedValue(undefined);
    gateway.closeProjectSessions.mockReset().mockResolvedValue({ sessionKeys: [] });
  });
  afterEach(async () => {
    if (previousHome === undefined) delete process.env.PILOT_HOME; else process.env.PILOT_HOME = previousHome;
    await fs.rm(pilotHome, { recursive: true, force: true });
  });

  it('blocks forced project deletion when a saved profile or Team references it', async () => {
    gateway.teamCommand.mockResolvedValue({ referenced: true });
    await expect(deleteProject(project, true)).rejects.toMatchObject({ code: 'TEAM_PROTECTED' });
    expect(gateway.teamCommand).toHaveBeenCalledWith({ action: 'project_references', projectKey: project });
    expect(gateway.closeProjectSessions).not.toHaveBeenCalled();
    await expect(fs.stat(projectDir)).resolves.toBeDefined();
  });

  it('does not convert damaged Team storage or a disconnected gateway into deletion permission', async () => {
    gateway.teamCommand.mockRejectedValue(Object.assign(new Error('Team store cannot be read'), { code: 'TEAM_STORE_CORRUPT' }));
    await expect(deleteProject(project, true)).rejects.toMatchObject({ code: 'TEAM_STORE_CORRUPT' });
    expect(gateway.closeSession).not.toHaveBeenCalled();
    expect(gateway.closeProjectSessions).not.toHaveBeenCalled();
  });

  it('ordinary session deletion does not depend on the Team library', async () => {
    gateway.teamCommand.mockRejectedValue(Object.assign(new Error('Team store cannot be read'), { code: 'TEAM_STORE_CORRUPT' }));
    await expect(deleteSession(project, sessionKey)).resolves.toBe(true);
    expect(gateway.teamCommand).not.toHaveBeenCalled();
    expect(gateway.closeSession).toHaveBeenCalledOnce();
    await expect(fs.stat(transcript)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes project deletion with Team configuration writes and checks references after waiting', async () => {
    let release;
    let entered;
    const enter = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const writing = new TeamStore(pilotHome).locked(async () => { entered(); await held; });
    await enter;
    const deleting = deleteProject(project, true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(gateway.teamCommand).not.toHaveBeenCalled();
    expect(gateway.closeProjectSessions).not.toHaveBeenCalled();
    gateway.teamCommand.mockResolvedValue({ referenced: true });
    release();
    await writing;
    await expect(deleting).rejects.toMatchObject({ code: 'TEAM_PROTECTED' });
    await expect(fs.stat(projectDir)).resolves.toBeDefined();
  });
});
