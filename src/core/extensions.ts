import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { C } from './colors.js';
import type { Agent } from './agent.js';

export interface ExtensionMeta {
  name: string;
  description: string;
}

/** Discover extension files in .ag/extensions/ (project) and ~/.ag/extensions/ (global) */
export function discoverExtensions(cwd: string, globalDir?: string): string[] {
  const dirs = [
    join(cwd, '.ag', 'extensions'),
    join(globalDir || join(process.env.HOME || '', '.ag'), 'extensions'),
  ];

  const files: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs') || entry.name.endsWith('.js'))) {
          files.push(join(dir, entry.name));
        } else if (entry.isDirectory()) {
          const index = join(dir, entry.name, 'index.ts');
          const indexMjs = join(dir, entry.name, 'index.mjs');
          const indexJs = join(dir, entry.name, 'index.js');
          if (existsSync(index)) files.push(index);
          else if (existsSync(indexMjs)) files.push(indexMjs);
          else if (existsSync(indexJs)) files.push(indexJs);
        }
      }
    } catch { /* dir not readable */ }
  }
  return files;
}

/** Extract a short name from an extension path (e.g. "/home/.ag/extensions/my-ext.ts" → "my-ext") */
function nameFromPath(path: string): string {
  const base = path.split('/').pop() || path;
  return base.replace(/\.(ts|mjs|js)$/, '').replace(/^index$/, path.split('/').slice(-2, -1)[0] || 'unknown');
}

/** Load and execute extension files, passing the agent instance. Returns metadata for successfully loaded extensions. */
export async function loadExtensions(agent: Agent, paths: string[]): Promise<ExtensionMeta[]> {
  const loaded: ExtensionMeta[] = [];
  for (const path of paths) {
    const fallbackName = nameFromPath(path);
    try {
      const mod = await import(pathToFileURL(path).href);
      const init = mod.default;
      if (typeof init !== 'function') {
        process.stderr.write(`${C.yellow}Warning: extension "${fallbackName}" has no default export function — skipping${C.reset}\n`);
        continue;
      }
      await init(agent);
      loaded.push({
        name: typeof mod.name === 'string' ? mod.name : fallbackName,
        description: typeof mod.description === 'string' ? mod.description : '',
      });
    } catch (error) {
      process.stderr.write(`${C.yellow}Warning: extension "${fallbackName}" failed to load: ${error}${C.reset}\n`);
    }
  }
  return loaded;
}
