import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tool, ToolLoadFailure } from './types.js';
import { AG_DIR } from './constants.js';
import { scanTool } from './guardrails.js';

interface LoadResult {
  tools: Tool[];
  failures: ToolLoadFailure[];
}

async function loadToolsFromDir(dir: string): Promise<LoadResult> {
  if (!existsSync(dir)) return { tools: [], failures: [] };
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs'));
  const tools: Tool[] = [];
  const failures: ToolLoadFailure[] = [];
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, file)).href);
      const tool = mod.default;
      if (tool?.type === 'function' && tool?.function?.name && typeof tool?.execute === 'function') {
        if (tool.permissionKey && typeof tool.permissionKey?.qualifier !== 'string') {
          tool.permissionKey = undefined;
        }
        const scan = scanTool(tool);
        if (!scan.ok) {
          const reasons = scan.findings.filter(f => f.severity === 'block').map(f => f.message).join('; ');
          failures.push({ file, name: tool.function.name, reason: reasons });
          continue;
        }
        tools.push(tool);
      } else {
        failures.push({ file, reason: 'invalid tool format' });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ file, reason: msg });
    }
  }
  return { tools, failures };
}

export interface LoadUserToolsResult {
  tools: Tool[];
  failures: ToolLoadFailure[];
}

export async function loadUserTools(cwd: string): Promise<LoadUserToolsResult> {
  const global = await loadToolsFromDir(join(AG_DIR, 'tools'));
  const local = await loadToolsFromDir(join(cwd, '.ag', 'tools'));

  // Local tools override global if same name
  const byName = new Map<string, Tool>();
  for (const t of global.tools) byName.set(t.function.name, t);
  for (const t of local.tools) byName.set(t.function.name, t);
  return {
    tools: Array.from(byName.values()),
    failures: [...global.failures, ...local.failures],
  };
}
