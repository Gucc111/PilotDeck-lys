import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';

export function MultiSelect({
  selected,
  options,
  onChange,
  placeholder,
}: {
  selected: string[];
  options: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [manualInput, setManualInput] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedSet = new Set(selected);
  const filtered = options.filter(
    (opt) => !selectedSet.has(opt) && opt.toLowerCase().includes(search.toLowerCase()),
  );
  const hasOptions = options.length > 0;

  const addValue = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || selectedSet.has(trimmed)) return;
    onChange([...selected, trimmed]);
  };

  const removeValue = (value: string) => {
    onChange(selected.filter((v) => v !== value));
  };

  const handleManualAdd = () => {
    const trimmed = manualInput.trim();
    if (trimmed) {
      addValue(trimmed);
      setManualInput('');
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div
        className={cn(
          'flex min-h-[36px] w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm transition-colors',
          'focus-within:border-ring focus-within:ring-1 focus-within:ring-ring',
        )}
        onClick={() => {
          if (hasOptions) {
            setOpen(true);
            inputRef.current?.focus();
          }
        }}
      >
        {selected.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
          >
            {value}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeValue(value);
              }}
              className="rounded-full p-0.5 hover:bg-primary/20"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {hasOptions ? (
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder={selected.length === 0 ? (placeholder ?? 'Select...') : ''}
            className="min-w-[80px] flex-1 border-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        ) : (
          <input
            type="text"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleManualAdd();
              }
            }}
            placeholder={selected.length === 0 ? (placeholder ?? 'Type and press Enter...') : 'Type and press Enter...'}
            className="min-w-[80px] flex-1 border-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        )}
      </div>

      {open && hasOptions && (
        <div className="absolute z-50 mt-1 max-h-[200px] w-full overflow-auto rounded-lg border border-border bg-background shadow-lg">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {search ? 'No matching options' : 'All options selected'}
            </div>
          ) : (
            filtered.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  addValue(opt);
                  setSearch('');
                  inputRef.current?.focus();
                }}
                className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
              >
                {opt}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
