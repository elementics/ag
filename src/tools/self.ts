import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Tool } from '../core/types.js';
import { AG_DIR } from '../core/constants.js';
import { removeSkill } from '../core/registry.js';

const BUILTIN_TOOLS = new Set([
  'bash', 'file', 'memory', 'plan', 'git', 'grep', 'web',
  'task', 'content', 'result', 'history', 'agent', 'skill', 'self',
]);

type ItemType = 'tool' | 'skill' | 'extension';
type Scope = 'global' | 'project';

function agMdPath(): string {
  return join(AG_DIR, 'ag.md');
}

function extractTemplate(type: ItemType): string | null {
  const path = agMdPath();
  if (!existsSync(path)) return null;
  const src = readFileSync(path, 'utf8');
  const open = `<!-- template:${type} -->`;
  const close = `<!-- /template:${type} -->`;
  const start = src.indexOf(open);
  const end = src.indexOf(close);
  if (start === -1 || end === -1) return null;
  const block = src.slice(start + open.length, end).trim();
  // strip the fenced code block markers
  return block.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
}

function interpolate(template: string, name: string, description: string): string {
  return template.replaceAll('{{name}}', name).replaceAll('{{description}}', description);
}

function itemDir(type: ItemType, scope: Scope, cwd: string): string {
  const base = scope === 'global' ? AG_DIR : join(cwd, '.ag');
  return join(base, type === 'tool' ? 'tools' : type === 'skill' ? 'skills' : 'extensions');
}

function itemPath(type: ItemType, name: string, scope: Scope, cwd: string): string {
  const dir = itemDir(type, scope, cwd);
  if (type === 'tool') return join(dir, `${name}.mjs`);
  if (type === 'skill') return join(dir, name, 'SKILL.md');
  return join(dir, `${name}.mjs`);
}

function listItems(type: ItemType, scope: Scope, cwd: string): { name: string; enabled: boolean }[] {
  const dir = itemDir(type, scope, cwd);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const items: { name: string; enabled: boolean }[] = [];

  if (type === 'skill') {
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name.replace(/\.disabled$/, '');
      items.push({ name, enabled: !e.name.endsWith('.disabled') });
    }
  } else {
    for (const e of entries) {
      if (!e.isFile()) continue;
      const f = e.name;
      if (f.endsWith('.mjs')) items.push({ name: f.slice(0, -4), enabled: true });
      else if (f.endsWith('.mjs.disabled')) items.push({ name: f.slice(0, -13), enabled: false });
    }
  }
  return items;
}

export function selfTool(cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'self',
      description: "Manage Ag's own tools, skills, and extensions. Use when the user asks how to create/add, list, edit, remove, disable, or enable a custom tool, skill, or extension. Scaffolds new ones from ag.md templates. Built-in tools/skills/extensions are read-only and cannot be modified or removed.",
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'create', 'edit', 'remove', 'disable', 'enable'],
            description: 'list: show all. create: scaffold new. edit: return path to edit. remove: delete. disable: rename to *.disabled. enable: restore from *.disabled.',
          },
          type: {
            type: 'string',
            enum: ['tool', 'skill', 'extension'],
            description: 'Item type (required except for list)',
          },
          name: {
            type: 'string',
            description: 'Item name without extension (required except for list)',
          },
          description: {
            type: 'string',
            description: 'Short description interpolated into the scaffold template (for create)',
          },
          scope: {
            type: 'string',
            enum: ['global', 'project'],
            description: 'global: ~/.ag/  project: .ag/  (default: project)',
          },
        },
        required: ['action'],
      },
    },
    execute: ({ action, type, name, description: desc, scope }: {
      action: string;
      type?: string;
      name?: string;
      description?: string;
      scope?: string;
    }): string => {
      const resolvedScope = (scope === 'global' ? 'global' : 'project') as Scope;

      switch (action) {
        case 'list': {
          const lines: string[] = [];
          const types: ItemType[] = type ? [type as ItemType] : ['tool', 'skill', 'extension'];

          for (const t of types) {
            const scopes: Scope[] = ['project', 'global'];
            const allItems: { name: string; enabled: boolean; scope: Scope }[] = [];
            for (const s of scopes) {
              for (const item of listItems(t, s, cwd)) {
                allItems.push({ ...item, scope: s });
              }
            }

            if (t === 'tool') {
              const builtins = Array.from(BUILTIN_TOOLS).map(n => `  ${n} [built-in]`).join('\n');
              lines.push(`Tools:\n${builtins}`);
              if (allItems.length > 0) {
                const custom = allItems.map(i =>
                  `  ${i.name} [${i.enabled ? 'enabled' : 'disabled'}] (${i.scope})`
                ).join('\n');
                lines[lines.length - 1] += `\n${custom}`;
              }
            } else {
              const header = `${t.charAt(0).toUpperCase() + t.slice(1)}s:`;
              if (allItems.length === 0) {
                lines.push(`${header}\n  (none)`);
              } else {
                const entries = allItems.map(i =>
                  `  ${i.name} [${i.enabled ? 'enabled' : 'disabled'}] (${i.scope})`
                ).join('\n');
                lines.push(`${header}\n${entries}`);
              }
            }
          }
          return lines.join('\n\n');
        }

        case 'create': {
          if (!type) return 'Error: type is required for create';
          if (!name) return 'Error: name is required for create';
          const t = type as ItemType;

          if (t === 'tool' && BUILTIN_TOOLS.has(name)) {
            return `Error: "${name}" is a built-in tool and cannot be overridden`;
          }

          for (const s of ['project', 'global'] as Scope[]) {
            const path = itemPath(t, name, s, cwd);
            if (existsSync(path)) return `Error: already exists at ${path}`;
            const disabledPath = t === 'skill'
              ? join(itemDir(t, s, cwd), `${name}.disabled`)
              : `${path}.disabled`;
            if (existsSync(disabledPath)) {
              return `Error: a disabled version already exists at ${disabledPath}; enable or remove it first`;
            }
          }

          const template = extractTemplate(t);
          if (!template) {
            return `Error: could not read template from ag.md (${agMdPath()}). Ensure the file exists and has a <!-- template:${t} --> section.`;
          }

          const content = interpolate(template, name, desc || `${name} ${t}`);
          const targetPath = itemPath(t, name, resolvedScope, cwd);
          mkdirSync(join(targetPath, '..'), { recursive: true });
          writeFileSync(targetPath, content, 'utf8');

          return `Created at ${targetPath}\n\n${content}`;
        }

        case 'edit': {
          if (!type) return 'Error: type is required for edit';
          if (!name) return 'Error: name is required for edit';
          const t = type as ItemType;

          if (t === 'tool' && BUILTIN_TOOLS.has(name)) {
            return `Error: "${name}" is a built-in tool and cannot be edited`;
          }

          for (const s of ['project', 'global'] as Scope[]) {
            const path = itemPath(t, name, s, cwd);
            if (existsSync(path)) return `Edit: ${path}`;
          }
          return `Error: ${type} "${name}" not found in project or global scope`;
        }

        case 'remove': {
          if (!type) return 'Error: type is required for remove';
          if (!name) return 'Error: name is required for remove';
          const t = type as ItemType;

          if (t === 'tool' && BUILTIN_TOOLS.has(name)) {
            return `Error: "${name}" is a built-in tool and cannot be removed`;
          }

          if (t === 'skill') {
            return removeSkill(name, cwd);
          }

          for (const s of [resolvedScope, resolvedScope === 'project' ? 'global' : 'project'] as Scope[]) {
            const path = itemPath(t, name, s, cwd);
            if (existsSync(path)) { rmSync(path); return `Removed: ${path}`; }
            const disabledPath = `${path}.disabled`;
            if (existsSync(disabledPath)) { rmSync(disabledPath); return `Removed: ${disabledPath}`; }
          }
          return `Error: ${type} "${name}" not found`;
        }

        case 'disable': {
          if (!type) return 'Error: type is required for disable';
          if (!name) return 'Error: name is required for disable';
          const t = type as ItemType;

          if (t === 'skill') {
            return 'Skills cannot be disabled — they are directories. Use `remove` to delete, or move the folder manually.';
          }
          if (t === 'tool' && BUILTIN_TOOLS.has(name)) {
            return `Error: "${name}" is a built-in tool and cannot be disabled`;
          }

          for (const s of [resolvedScope, resolvedScope === 'project' ? 'global' : 'project'] as Scope[]) {
            const path = itemPath(t, name, s, cwd);
            if (existsSync(path)) {
              renameSync(path, `${path}.disabled`);
              return `Disabled: ${path}.disabled`;
            }
          }
          return `Error: ${type} "${name}" not found (or already disabled)`;
        }

        case 'enable': {
          if (!type) return 'Error: type is required for enable';
          if (!name) return 'Error: name is required for enable';
          const t = type as ItemType;

          if (t === 'skill') {
            return 'Skills cannot be enabled/disabled — they are directories. Use `self create` or move the folder manually.';
          }
          if (t === 'tool' && BUILTIN_TOOLS.has(name)) {
            return `Error: "${name}" is a built-in tool and cannot be enabled (it is always on)`;
          }

          for (const s of [resolvedScope, resolvedScope === 'project' ? 'global' : 'project'] as Scope[]) {
            const path = itemPath(t, name, s, cwd);
            const disabledPath = `${path}.disabled`;
            if (existsSync(disabledPath)) {
              renameSync(disabledPath, path);
              return `Enabled: ${path}`;
            }
          }
          return `Error: disabled ${type} "${name}" not found`;
        }

        default:
          return `Error: unknown action "${action}". Use: list, create, edit, remove, disable, enable`;
      }
    },
  };
}
