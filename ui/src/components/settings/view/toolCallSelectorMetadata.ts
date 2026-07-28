import type {
  ToolCallOperator,
  ToolCallSelector,
  ToolCallSubject,
} from '../../../../../src/permission/protocol/types';

export type ToolSelectorDescriptor = {
  name: string;
  subjects: Array<{
    value: ToolCallSubject;
    kind: 'command' | 'path';
    operators: ToolCallOperator[];
  }>;
};

export const TOOL_SELECTOR_DESCRIPTORS: ToolSelectorDescriptor[] = [
  {
    name: 'bash',
    subjects: [{
      value: 'bash.command',
      kind: 'command',
      operators: ['executableEquals', 'argvPrefix'],
    }],
  },
  {
    name: 'read_file',
    subjects: [{
      value: 'read_file.file_path',
      kind: 'path',
      operators: ['pathEquals', 'pathWithin'],
    }],
  },
  {
    name: 'send_attachment',
    subjects: [{
      value: 'send_attachment.file_path',
      kind: 'path',
      operators: ['pathEquals', 'pathWithin'],
    }],
  },
  {
    name: 'write_file',
    subjects: [{
      value: 'write_file.file_path',
      kind: 'path',
      operators: ['pathEquals', 'pathWithin'],
    }],
  },
  {
    name: 'edit_file',
    subjects: [{
      value: 'edit_file.file_path',
      kind: 'path',
      operators: ['pathEquals', 'pathWithin'],
    }],
  },
  {
    name: 'edit_notebook',
    subjects: [{
      value: 'edit_notebook.notebook_path',
      kind: 'path',
      operators: ['pathEquals', 'pathWithin'],
    }],
  },
  {
    name: 'glob',
    subjects: [{
      value: 'glob.search_root',
      kind: 'path',
      operators: ['pathEquals', 'pathWithin'],
    }],
  },
  {
    name: 'grep',
    subjects: [
      {
        value: 'grep.path',
        kind: 'path',
        operators: ['pathEquals', 'pathWithin'],
      },
      {
        value: 'grep.search_root',
        kind: 'path',
        operators: ['pathEquals', 'pathWithin'],
      },
    ],
  },
  { name: 'agent', subjects: [] },
  { name: 'web_fetch', subjects: [] },
  { name: 'web_search', subjects: [] },
];

export function toolCallSelectorSummary(selector: ToolCallSelector): string {
  const conditions = selector.conditions ?? [];
  if (conditions.length === 0) return selector.toolName;
  return conditions.map((condition) => {
    const value = Array.isArray(condition.value)
      ? condition.value.join(' ')
      : condition.value;
    return `${condition.subject} · ${condition.operator} · ${value}`;
  }).join(' + ');
}
