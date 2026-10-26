import { getWorkspaceFileIdentity } from '../../utils/workspaceFileMention';

// Presentation filtering does not change persisted artifacts.
export function isInternalReviewPath(path: string, workspaceRoot = ''): boolean {
  return getWorkspaceFileIdentity(path, workspaceRoot).split('/').includes('.pilotdeck');
}

export function visibleReviewFiles<T extends { path: string }>(files: readonly T[], workspaceRoot = ''): T[] {
  return files.filter(file => !isInternalReviewPath(file.path, workspaceRoot));
}
