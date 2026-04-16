import { Tool } from '../core/types.js';

export interface SkillHost {
  activateSkill(name: string): Promise<string>;
}

export function skillTool(host: SkillHost): Tool {
  return {
    type: 'function',
    function: {
      name: 'skill',
      description: 'Activate a skill by name to load its full instructions into context. Check <available-skills> in your system prompt for what is available.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name to activate (from the available-skills catalog).' }
        },
        required: ['name']
      }
    },
    execute: async ({ name }: { name: string }): Promise<string> => {
      return host.activateSkill(name);
    }
  };
}
