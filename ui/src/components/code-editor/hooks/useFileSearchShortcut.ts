import { useEffect, type RefObject } from 'react';

type UseFileSearchShortcutOptions = {
  containerRef: RefObject<HTMLElement>;
  enabled?: boolean;
  onOpen: () => void;
};

export function useFileSearchShortcut({
  containerRef,
  enabled = true,
  onOpen,
}: UseFileSearchShortcutOptions) {
  useEffect(() => {
    if (!enabled) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isFindShortcut = (event.ctrlKey || event.metaKey)
        && event.key.toLowerCase() === 'f';
      if (!isFindShortcut) return;

      const container = containerRef.current;
      const target = event.target as Node | null;
      if (!container || !target || !container.contains(target)) return;

      event.preventDefault();
      event.stopPropagation();
      onOpen();
      window.requestAnimationFrame(() => {
        const input = container.querySelector<HTMLInputElement>('[data-file-search-input]');
        input?.focus();
        input?.select();
      });
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [containerRef, enabled, onOpen]);
}
