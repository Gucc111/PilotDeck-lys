import type { ProfileConfig } from './types.js';

export const PLAN_TOOL_GROUP = ['enter_plan_mode', 'exit_plan_mode'];
export const WRITE_TOOL_GROUP = ['write_file', 'edit_file'];

export function normalizeProfileTools(config: ProfileConfig): Pick<ProfileConfig, 'capabilities'> {
  const tools = new Set(config.capabilities.tools);
  if (tools.has('edit_notebook')) WRITE_TOOL_GROUP.forEach(name => tools.add(name));
  for (const group of [PLAN_TOOL_GROUP, WRITE_TOOL_GROUP]) {
    if (group.some(name => tools.has(name))) group.forEach(name => tools.add(name));
  }
  if (WRITE_TOOL_GROUP.some(name => tools.has(name))) tools.add('read_file');
  if (PLAN_TOOL_GROUP.some(name => tools.has(name))) tools.add('todo_write');
  return { capabilities: { ...config.capabilities, tools: [...tools] } };
}
