import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { authenticatedFetch } from '../../utils/api';
import type { Project, ProjectSession } from '../../types/app';

export type ReviewTab = 'git';
export type ReviewOpenRequest = { tab: ReviewTab; sequence: number };
export type GitEntry = { path: string; originalPath?: string; indexStatus: string; worktreeStatus: string; staged: boolean; unstaged: boolean; untracked: boolean; conflicted: boolean };
export type GitStatus = { branch?: string; hasCommits?: boolean; isRepository?: boolean; code?: string; repositoryRoot?: string; indexTree?: string; entries?: GitEntry[]; error?: string };
type ContextValue = {
  project: Project | null; sessionId: string | null; running: boolean; readOnly: boolean;
  panelOpen: boolean; git: GitStatus | null; loading: boolean;
  bind: (project: Project | null, sessionId: string | null, running: boolean, readOnly: boolean) => void;
  open: (tab?: ReviewTab) => void; close: () => void; refreshGit: () => Promise<void>;
};
const Context = createContext<ContextValue | null>(null);
export async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || '请求失败，请重试。');
  return body as T;
}
export function ChatReviewProvider({ project: initialProject, session, openGit = false, openRequest, onOpen, children }: {
  project: Project | null; session: ProjectSession | null; openGit?: boolean; openRequest?: ReviewOpenRequest; onOpen: () => void; children: ReactNode;
}) {
  const [binding, setBinding] = useState({ project: initialProject, sessionId: session?.id ?? null, running: false, readOnly: false });
  const { project, sessionId, running, readOnly } = binding;
  const [panelOpen, setPanelOpen] = useState(false), [git, setGit] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0), handledOpenRequest = useRef<ReviewOpenRequest>();
  const bindingKey = `${project?.fullPath || project?.path || project?.name || ''}\0${sessionId || ''}`;
  const activeKey = useRef(bindingKey); activeKey.current = bindingKey;
  const bind = useCallback((nextProject: Project | null, id: string | null, active: boolean, immutable: boolean) => {
    setBinding(previous => previous.project === nextProject && previous.sessionId === id && previous.running === active && previous.readOnly === immutable ? previous : { project: nextProject, sessionId: id, running: active, readOnly: immutable });
  }, []);
  const refreshGit = useCallback(async () => {
    if (!project) return;
    const sequence = ++generation.current, key = bindingKey; setLoading(true);
    try {
      const response = await authenticatedFetch(`/api/git/status?project=${encodeURIComponent(project.name)}`, { suppressServerErrorToast: true });
      const status = await response.json() as GitStatus;
      if (sequence === generation.current && key === activeKey.current) setGit(status);
    } catch { if (sequence === generation.current && key === activeKey.current) setGit({ error: 'Git 状态读取失败，请刷新重试。' }); }
    finally { if (sequence === generation.current && key === activeKey.current) setLoading(false); }
  }, [project, bindingKey]);
  const open = useCallback(() => { onOpen(); setPanelOpen(true); }, [onOpen]);
  useEffect(() => { if (openGit) open(); }, [openGit, open]);
  useEffect(() => {
    if (!openRequest || handledOpenRequest.current === openRequest) return;
    handledOpenRequest.current = openRequest; open();
  }, [openRequest, open]);
  useEffect(() => { generation.current++; setGit(null); }, [bindingKey]);
  useEffect(() => { void refreshGit(); }, [refreshGit, running]);
  useEffect(() => {
    if (!panelOpen) return undefined;
    const timer = window.setInterval(() => { void refreshGit(); }, 5000);
    return () => window.clearInterval(timer);
  }, [panelOpen, refreshGit]);
  const value = useMemo<ContextValue>(() => ({ project, sessionId, running, readOnly, panelOpen, git, loading, bind, open, close: () => setPanelOpen(false), refreshGit }),
    [project, sessionId, running, readOnly, panelOpen, git, loading, bind, open, refreshGit]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useChatReview() { return useContext(Context); }
