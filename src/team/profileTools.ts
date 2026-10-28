import type { ProfileConfig } from './types.js';

export const PLAN_TOOL_GROUP = ['enter_plan_mode', 'exit_plan_mode'];
export const WRITE_TOOL_GROUP = ['write_file', 'edit_file'];

export function normalizeProfileTools(config: ProfileConfig): Pick<ProfileConfig, 'capabilities' | 'optionalCapabilities'> {
  const tools = new Set(config.capabilities.tools);
  if (tools.has('edit_notebook')) WRITE_TOOL_GROUP.forEach(name => tools.add(name));
  for (const group of [PLAN_TOOL_GROUP, WRITE_TOOL_GROUP]) {
    if (group.some(name => tools.has(name))) group.forEach(name => tools.add(name));
  }
  const writes = WRITE_TOOL_GROUP.some(name => tools.has(name));
  if (writes) tools.add('read_file');
  const optionalCapabilities = config.optionalCapabilities.filter(cap => cap.kind !== 'tool' || (tools.has(cap.name) && !(writes && cap.name === 'read_file')));
  for (const group of [PLAN_TOOL_GROUP, WRITE_TOOL_GROUP]) {
    if (group.every(name => optionalCapabilities.some(cap => cap.kind === 'tool' && cap.name === name))) continue;
    for (let i = optionalCapabilities.length - 1; i >= 0; i--) {
      if (optionalCapabilities[i]!.kind === 'tool' && group.includes(optionalCapabilities[i]!.name)) optionalCapabilities.splice(i, 1);
    }
  }
  return { capabilities: { ...config.capabilities, tools: [...tools] }, optionalCapabilities };
}
