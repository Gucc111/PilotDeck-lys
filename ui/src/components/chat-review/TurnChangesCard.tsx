import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Download, Eye, Files, MessageSquarePlus } from 'lucide-react';
import type { ChatFileArtifact } from '../chat/types/types';
import type { Project } from '../../types/app';
import { FileTypeIcon } from '../file-tree/components/FileTypeIcon';
import { useWorkspaceFileActions } from '../chat-v2/useWorkspaceFileActions';
import FileActionsMenu from './FileActionsMenu';
import { useChatReview } from './ChatReviewContext';
import { formatFileSize, isPreviewFile, mergeTurnFiles, type TurnFile } from './turnFiles';

const EMPTY_ARTIFACTS: ChatFileArtifact[] = [];

function TurnFileRow({ file, project, onBrowse }: {
  file: TurnFile; project: Project | null; onBrowse?: (path: string) => void;
}) {
  const previewFile = isPreviewFile(file.path);
  const actions = useWorkspaceFileActions({ name: file.name, path: file.path, sha256: file.artifact?.sha256 }, project, onBrowse);
  const browse = actions.canBrowse;
  const workspaceActions = actions.canUseWorkspaceActions;
  const primary = browse ? () => { void actions.browse(); } : undefined;
  const operation = file.artifact?.operation;
  const operationLabel = operation === 'created' ? '新增' : operation === 'updated' ? '修改' : '';
  const meta = previewFile ? [file.path.split('.').pop()?.toUpperCase(), formatFileSize(file.artifact?.size)].filter(Boolean).join(' · ') : null;
  return <div className="group/turn-file relative flex min-w-0 items-center gap-2.5 px-4 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-900" data-file-artifact={file.artifact?.path} data-turn-file={file.path}>
    <button type="button" onClick={primary} disabled={!primary} aria-label={file.path} title={file.path} className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default">
      <span className={`flex shrink-0 items-center justify-center ${previewFile ? 'h-9 w-9 rounded-lg bg-blue-50 dark:bg-blue-500/10' : 'h-6 w-6'}`}><FileTypeIcon filename={file.name} mimeType={file.artifact?.mimeType} className={previewFile ? 'h-5 w-5' : 'h-4 w-4'} assetClassName={previewFile ? 'h-6 w-6' : 'h-4 w-4'} /></span>
      <span className="min-w-0 flex-1"><span className={`block truncate text-[13px] text-neutral-700 dark:text-neutral-200 ${previewFile ? 'font-medium' : ''}`}>{file.directory && <span className="text-neutral-400 dark:text-neutral-500">{file.directory}/</span>}{file.name}</span>{meta && <span className="mt-0.5 block text-[11px] text-neutral-400">{meta}</span>}</span>
    </button>
    <span className="shrink-0 text-[11px] text-neutral-400">{operationLabel}</span>
    {(browse || workspaceActions) && <FileActionsMenu label={`${file.name} 的文件操作`} items={[
      ...(browse ? [{ label: '预览当前文件', icon: Eye, onSelect: () => { void actions.browse(); } }] : []),
      ...(workspaceActions ? [{ label: '下载当前文件', icon: Download, onSelect: actions.download }, { label: '在对话中引用', icon: MessageSquarePlus, onSelect: actions.reference }] : []),
    ]} />}
  </div>;
}

export default function TurnFileResults({ turnId, artifacts = EMPTY_ARTIFACTS, project: selectedProject, onBrowse, streaming = false }: {
  turnId?: string | null; artifacts?: ChatFileArtifact[]; project?: Project | null; onBrowse?: (path: string) => void; streaming?: boolean;
}) {
  const review = useChatReview();
  const project = selectedProject ?? review?.project ?? null;
  const files = useMemo(() => mergeTurnFiles(artifacts, project), [artifacts, project]);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [turnId]);
  if (!files.length) return null;
  return <section className="mt-4 rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950" data-testid="turn-changes-card" aria-label="本轮文件">
    <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-neutral-800"><Files className="h-5 w-5" strokeWidth={1.75} /></span>
      <div className="min-w-0 flex-1"><div className="text-[13px] font-medium">{streaming ? '正在处理文件' : `本轮文件 · ${files.length}`}</div></div>
    </div>
    <div className="border-t border-neutral-100 py-1.5 dark:border-neutral-800">
      {(expanded ? files : files.slice(0, 3)).map(file => <TurnFileRow key={file.key} file={file} project={project} onBrowse={onBrowse} />)}
      {files.length > 3 && <button type="button" onClick={() => setExpanded(previous => !previous)} aria-expanded={expanded} className="flex items-center gap-1.5 rounded px-4 py-2 text-xs text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">{expanded ? '收起文件列表' : `展开其余 ${files.length - 3} 个文件`}<ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} /></button>}
    </div>
  </section>;
}
