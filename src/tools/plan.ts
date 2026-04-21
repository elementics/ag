import { Tool } from '../core/types.js';
import { savePlan, listPlans, loadPlanByName, appendPlan, setActivePlan, getActivePlanName } from '../memory/memory.js';

export function planTool(cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'plan',
      description: 'Manage task plans. Save a new plan, append to the active plan, switch the active plan, list all plans, or read a specific plan by name. Only the explicitly activated plan is loaded as context.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'list', 'read', 'append', 'switch'], description: '"save" to create a new plan, "append" to add content to the latest plan, "switch" to activate a different plan by name, "list" to see all plans, "read" to view a specific plan.' },
          content: { type: 'string', description: 'Plan content (required for action=save).' },
          name: { type: 'string', description: 'Plan name for save (e.g. "refactor-cli") or read (e.g. "2026-04-13T12-31-22-refactor-cli").' }
        },
        required: ['action']
      }
    },
    execute: ({ action, content, name }: { action: string; content?: string; name?: string }): string => {
      switch (action) {
        case 'save': {
          if (!content) return 'Error: content is required for action=save.';
          const filePath = savePlan(content, name, cwd);
          return `Plan saved: ${filePath}`;
        }
        case 'append': {
          if (!content) return 'Error: content is required for action=append.';
          const filePath = appendPlan(content, cwd);
          return `Appended to plan: ${filePath}`;
        }
        case 'switch': {
          if (!name) return 'Error: name is required for action=switch. Use action=list to see available plans.';
          const plans = listPlans(cwd);
          const match = plans.find(p => p.name.includes(name));
          if (!match) return `No plan matching "${name}". Use action=list to see available plans.`;
          setActivePlan(match.name, cwd);
          return `Switched to plan: ${match.name}`;
        }
        case 'list': {
          const plans = listPlans(cwd);
          if (plans.length === 0) return 'No plans saved yet.';
          const activeName = getActivePlanName(cwd);
          const header = activeName ? `Active plan: ${activeName}` : 'No active plan. Use action=switch to activate one.';
          const lines = plans.map(p => `${p.name === activeName ? '> ' : '  '}${p.name}  ${p.path}`);
          return `${header}\n${lines.join('\n')}`;
        }
        case 'read': {
          if (!name) return 'Error: name is required for action=read. Use action=list to see available plans.';
          const result = loadPlanByName(name, cwd);
          if (result) return result;
          // Fuzzy fallback: substring match (same as switch action)
          const plans = listPlans(cwd);
          const match = plans.find(p => p.name.includes(name));
          if (match) {
            const content = loadPlanByName(match.name, cwd);
            if (content) return content;
          }
          return `No plan found with name "${name}". Use action=list to see available plans.`;
        }
        default:
          return `Unknown action "${action}". Use "save", "append", "switch", "list", or "read".`;
      }
    }
  };
}
