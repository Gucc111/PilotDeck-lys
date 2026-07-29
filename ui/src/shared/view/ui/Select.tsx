import { cn } from '../../../lib/utils';

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export function Select({
  value,
  onChange,
  options,
  className,
}: {
  value: string | undefined;
  onChange: (next: string) => void;
  options: SelectOption[];
  className?: string;
}) {
  const selectedOption = options.find((opt) => opt.value === value);
  const selectedLabel = selectedOption?.label ?? '';
  return (
    <div className={cn('relative min-w-0', className)}>
      <div className={cn(
        'pointer-events-none flex w-full min-w-0 items-center rounded-lg border border-border bg-background px-3 py-1.5 pr-8 text-sm leading-5',
        selectedOption?.disabled ? 'text-muted-foreground' : 'text-foreground',
      )}>
        <span className="block min-w-0 truncate" title={selectedLabel}>{selectedLabel}</span>
      </div>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">▾</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label={selectedLabel}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}
