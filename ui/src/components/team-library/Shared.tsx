import { cloneElement, isValidElement, useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Project } from '../../types/app';
import { workspaceKey } from './api';
import { useTeamText } from './text';

export function Dialog({ title, children, footer, onClose, busy = false }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; busy?: boolean }) {
  const titleId = useId(); const ref = useRef<HTMLDivElement>(null); const t = useTeamText();
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; ref.current?.focus(); return () => previous?.focus(); }, []);
  return createPortal(<div className="team-overlay" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const focusables = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || []);
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="team-dialog">
    <div className="team-dialog-head"><h2 id={titleId}>{title}</h2><button type="button" className="team-button" onClick={onClose} disabled={busy} aria-label={t('close')}><X size={16}/></button></div>
    <div className="team-dialog-body">{children}</div>{footer && <div className="team-dialog-foot">{footer}</div>}
  </div></div>, document.body);
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { const id = useId(); return <div className="team-field"><label htmlFor={id}>{label}</label>{isValidElement(children) ? cloneElement(children as ReactElement<Record<string, unknown>>, { id, "aria-describedby": hint ? `${id}-hint` : undefined }) : children}{hint && <span id={`${id}-hint`} className="team-muted">{hint}</span>}</div>; }
export function ErrorBox({ error }: { error: string | null }) { return error ? <div className="team-notice team-error" role="alert">{error}</div> : null; }
export function ProjectOptions({ projects, selected }: { projects: Project[]; selected?: string | null }) {
  const t = useTeamText();
  return <>{selected && !projects.some(p => workspaceKey(p) === selected) && <option value={selected}>{selected} ({t('unavailable')})</option>}{projects.map(project => <option key={project.name} value={workspaceKey(project)}>{project.displayName || project.name} · {workspaceKey(project)}</option>)}</>;
}
export function projectLabel(projects: Project[], key: string) { const project = projects.find(p => workspaceKey(p) === key); return project ? project.displayName || project.name : key; }
