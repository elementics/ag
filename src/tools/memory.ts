import { Tool } from '../core/types.js';
import { appendGlobalMemory, appendProjectMemory } from '../memory/memory.js';

export function memoryTool(cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'memory',
      description: 'Memory operations. Actions: save (persist a fact, decision, or pattern for future sessions).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save'], description: 'The memory operation to perform.' },
          tier: { type: 'string', enum: ['global', 'project'], description: '"global" for preferences, coding style, patterns that apply everywhere. "project" for architecture decisions, current ticket, PR templates, gotchas specific to this codebase.' },
          content: { type: 'string', description: 'The fact, decision, or pattern to remember.' }
        },
        required: ['action', 'tier', 'content']
      }
    },
    execute: ({ action, tier, content }: { action: string; tier: string; content: string }): string => {
      switch (action) {
        case 'save': {
          if (tier === 'global') {
            appendGlobalMemory(content, cwd);
            return 'Saved to global memory.';
          }
          appendProjectMemory(content, cwd);
          return 'Saved to project memory.';
        }
        default: return `Unknown action "${action}". Use: save.`;
      }
    }
  };
}
