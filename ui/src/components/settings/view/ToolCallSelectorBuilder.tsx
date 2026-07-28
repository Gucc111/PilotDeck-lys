import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import type {
  ToolCallCondition,
  ToolCallOperator,
  ToolCallSelector,
  ToolCallSubject,
} from '../../../../../src/permission/protocol/types';
import { Button, Input } from '../../../shared/view/ui';
import { TOOL_SELECTOR_DESCRIPTORS } from './toolCallSelectorMetadata';

export type ToolCallSelectorBuilderLabels = {
  effect: string;
  tool: string;
  subject: string;
  entireTool: string;
  operator: string;
  add: string;
  emptyTools: string;
  pathPlaceholder: string;
  argvPlaceholder: string;
  executablePlaceholder: string;
  workspaceHint: string;
  commandHint: string;
  operatorLabel: (operator: ToolCallOperator) => string;
};

const SELECT_CLASS =
  'h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

export function ToolCallSelectorBuilder({
  availableTools,
  effects,
  labels,
  allowEntireTool = false,
  onAdd,
}: {
  availableTools: string[];
  effects: Array<{ value: string; label: string }>;
  labels: ToolCallSelectorBuilderLabels;
  allowEntireTool?: boolean;
  onAdd: (effect: string, selector: ToolCallSelector) => void;
}) {
  const supportedTools = useMemo(
    () => TOOL_SELECTOR_DESCRIPTORS.filter((tool) => availableTools.includes(tool.name)),
    [availableTools],
  );
  const [effect, setEffect] = useState(effects[0]?.value ?? '');
  const [toolName, setToolName] = useState(supportedTools[0]?.name ?? '');
  const selectedTool = supportedTools.find((tool) => tool.name === toolName)
    ?? supportedTools[0];
  const [subject, setSubject] = useState<ToolCallSubject | ''>(
    selectedTool?.subjects[0]?.value ?? '',
  );
  const selectedSubject = selectedTool?.subjects.find((item) => item.value === subject);
  const [operator, setOperator] = useState<ToolCallOperator>(
    selectedSubject?.operators[0] ?? 'pathEquals',
  );
  const [value, setValue] = useState('');

  useEffect(() => {
    if (selectedTool && selectedTool.name === toolName) return;
    const nextTool = supportedTools[0];
    const nextSubject = nextTool?.subjects[0];
    setToolName(nextTool?.name ?? '');
    setSubject(nextSubject?.value ?? '');
    setOperator(nextSubject?.operators[0] ?? 'pathEquals');
    setValue('');
  }, [selectedTool, supportedTools, toolName]);

  if (!selectedTool) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
        {labels.emptyTools}
      </div>
    );
  }

  const changeTool = (nextToolName: string) => {
    const nextTool = supportedTools.find((tool) => tool.name === nextToolName)
      ?? supportedTools[0];
    const nextSubject = nextTool?.subjects[0];
    setToolName(nextTool?.name ?? '');
    setSubject(nextSubject?.value ?? '');
    setOperator(nextSubject?.operators[0] ?? 'pathEquals');
    setValue('');
  };

  const changeSubject = (nextSubjectValue: string) => {
    const nextSubject = selectedTool.subjects.find((item) => item.value === nextSubjectValue);
    setSubject(nextSubject?.value ?? '');
    setOperator(nextSubject?.operators[0] ?? 'pathEquals');
    setValue('');
  };

  const add = () => {
    if (subject && !value.trim()) return;
    let condition: ToolCallCondition | undefined;
    if (subject) {
      condition = operator === 'argvPrefix'
        ? {
            subject: 'bash.command',
            operator: 'argvPrefix',
            value: value.trim().split(/\s+/).filter(Boolean),
          }
        : {
            subject,
            operator,
            value: value.trim(),
          } as ToolCallCondition;
    }
    onAdd(effect, {
      version: 2,
      toolName: selectedTool.name,
      ...(condition ? { conditions: [condition] } : {}),
    });
    setValue('');
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <BuilderSelect label={labels.effect} value={effect} onChange={setEffect}>
          {effects.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </BuilderSelect>
        <BuilderSelect label={labels.tool} value={selectedTool.name} onChange={changeTool}>
          {supportedTools.map((tool) => (
            <option key={tool.name} value={tool.name}>{tool.name}</option>
          ))}
        </BuilderSelect>
        <BuilderSelect label={labels.subject} value={subject} onChange={changeSubject}>
          {allowEntireTool && <option value="">{labels.entireTool}</option>}
          {selectedTool.subjects.map((item) => (
            <option key={item.value} value={item.value}>{item.value}</option>
          ))}
        </BuilderSelect>
        <BuilderSelect
          label={labels.operator}
          value={operator}
          disabled={!selectedSubject}
          onChange={(next) => setOperator(next as ToolCallOperator)}
        >
          {(selectedSubject?.operators ?? []).map((item) => (
            <option key={item} value={item}>{labels.operatorLabel(item)}</option>
          ))}
        </BuilderSelect>
      </div>
      {subject ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="h-10 flex-1 font-mono"
            placeholder={selectedSubject?.kind === 'path'
              ? labels.pathPlaceholder
              : operator === 'argvPrefix'
                ? labels.argvPlaceholder
                : labels.executablePlaceholder}
          />
          <Button size="sm" className="h-10 px-4" disabled={!value.trim()} onClick={add}>
            <Plus className="mr-1.5 h-4 w-4" />
            {labels.add}
          </Button>
        </div>
      ) : (
        <Button size="sm" className="h-10" onClick={add}>
          <Plus className="mr-1.5 h-4 w-4" />
          {labels.add}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {selectedSubject?.kind === 'path' ? labels.workspaceHint : labels.commandHint}
      </p>
    </div>
  );
}

function BuilderSelect({
  label,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="space-y-1 text-xs font-medium">
      <span>{label}</span>
      <select
        className={`${SELECT_CLASS} w-full`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

