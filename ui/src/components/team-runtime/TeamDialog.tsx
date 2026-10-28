import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

// Only the topmost Team dialog handles Escape/Tab. Capture Escape before the
// ordinary question renderer, where it normally means "skip this question".
const dialogStack: symbol[] = [];
export function TeamDialog({ title, onClose, children, side = false, className = '', closeDisabled = false }: {
  title: string; onClose: () => void; children: React.ReactNode; side?: boolean; className?: string; closeDisabled?: boolean;
}) {
  const { t } = useTranslation('chat');
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const disabledRef = useRef(closeDisabled); disabledRef.current = closeDisabled;
  useEffect(() => {
    const token = Symbol('team-dialog');
    dialogStack.push(token);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const listener = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== token) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!disabledRef.current) closeRef.current();
      }
      if (event.key === 'Tab') {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],[tabindex="0"]') || [])
          .filter(item => !item.matches(':disabled') && !item.closest('[hidden],[inert]') && item.getAttribute('aria-hidden') !== 'true');
        if (!items.length) { event.preventDefault(); ref.current?.focus(); return; }
        const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', listener, true);
    return () => {
      dialogStack.splice(dialogStack.indexOf(token), 1);
      document.removeEventListener('keydown', listener, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div className={`team-mode-overlay ${side ? 'team-mode-side' : ''}`} data-modal-overlay onMouseDown={event => { if (event.target === event.currentTarget && !closeDisabled) onClose(); }}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`team-mode-dialog ${className}`}>
      <div className="team-mode-header"><h2>{title}</h2><button type="button" onClick={onClose} disabled={closeDisabled} aria-label={t('teamMode.close')}><X size={18}/></button></div>{children}
    </div>
  </div>, document.body);
}
