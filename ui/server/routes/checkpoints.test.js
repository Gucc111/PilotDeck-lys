// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createCheckpointHandler } from './checkpoints.js';
import { parseGitStatus, gitStatusError } from '../utils/gitStatus.js';

describe('removed checkpoint HTTP boundary', () => {
  it.each(['list', 'diff', 'preview', 'restore', 'undo', 'git', undefined])('rejects %s with a stable removed response', async action => {
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await createCheckpointHandler()({ body: { action } }, res);
    expect(res.statusCode).toBe(410); expect(res.body.code).toBe('CHECKPOINTS_REMOVED');
  });
});

it('parses staged and unstaged sides, renames, conflicts and unusual filenames without trimming', () => {
  const entries = parseGitStatus('MM normal.txt\0R  new name.txt\0old\nname.txt\0??  leading.txt\0UU conflict.txt\0');
  expect(entries[0]).toMatchObject({ path: 'normal.txt', staged: true, unstaged: true });
  expect(entries[1]).toMatchObject({ path: 'new name.txt', originalPath: 'old\nname.txt', staged: true });
  expect(entries[2]).toMatchObject({ path: ' leading.txt', untracked: true, staged: false });
  expect(entries[3]).toMatchObject({ conflicted: true, staged: false });
});

it('reports an ordinary folder even when Git repository errors start with a capital letter', () => {
  expect(gitStatusError(new Error('Not a git repository. This directory does not contain a .git folder.'))).toMatchObject({ isRepository: false, code: 'NOT_GIT_REPOSITORY' });
});
