import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tool } from './types.js';
import { AG_DIR } from './constants.js';
import { scanSkill, scanTool } from './guardrails.js';

export interface SkillMeta {
  name: string;
  description: string;
  hasTools: boolean;
  always: boolean;
  content: string;
  dir: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string | boolean>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string | boolean> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (raw === 'true') meta[key] = true;
    else if (raw === 'false') meta[key] = false;
    else meta[key] = raw;
  }
  return { meta, body: match[2].trim() };
}

function loadSkillsFromDir(dir: string): SkillMeta[] {
  if (!existsSync(dir)) return [];
  const skills: SkillMeta[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const raw = readFileSync(skillFile, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      if (!meta.name || !meta.description || typeof meta.name !== 'string' || typeof meta.description !== 'string') continue;
      const skillObj: SkillMeta = {
        name: meta.name as string,
        description: meta.description as string,
        hasTools: meta.tools === true,
        always: meta.always === true,
        content: body,
        dir: skillDir,
      };
      const scan = scanSkill(skillObj);
      if (!scan.ok) {
        process.stderr.write(`Warning: skill ${entry.name} blocked by guardrails: ${scan.findings.filter(f => f.severity === 'block').map(f => f.message).join('; ')}\n`);
        continue;
      }
      for (const f of scan.findings) {
        process.stderr.write(`Warning: skill ${entry.name}: ${f.message}\n`);
      }
      skills.push(skillObj);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`Warning: skill ${entry.name} failed to load: ${msg}\n`);
    }
  }
  return skills;
}

export function discoverSkills(cwd: string): SkillMeta[] {
  const globalSkills = loadSkillsFromDir(join(AG_DIR, 'skills'));
  const localSkills = loadSkillsFromDir(join(cwd, '.ag', 'skills'));
  // Local overrides global by name
  const byName = new Map<string, SkillMeta>();
  for (const s of globalSkills) byName.set(s.name, s);
  for (const s of localSkills) byName.set(s.name, s);
  return Array.from(byName.values());
}

export function buildSkillCatalog(skills: SkillMeta[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map(s => `- ${s.name}: ${s.description}`);
  return `<available-skills>\n${lines.join('\n')}\n</available-skills>`;
}

export function getAlwaysOnContent(skills: SkillMeta[]): string {
  const always = skills.filter(s => s.always);
  if (always.length === 0) return '';
  return always.map(s => `<skill name="${s.name}">\n${s.content}\n</skill>`).join('\n\n');
}

export async function loadSkillTools(skillDir: string): Promise<Tool[]> {
  const toolsFile = join(skillDir, 'tools.mjs');
  if (!existsSync(toolsFile)) return [];
  try {
    const mod = await import(pathToFileURL(toolsFile).href);
    const exported = mod.default;
    // Support single tool or array of tools
    const items = Array.isArray(exported) ? exported : [exported];
    const valid = items.filter(
      (t: unknown) => {
        const tool = t as Record<string, unknown>;
        return tool?.type === 'function' && (tool?.function as Record<string, unknown>)?.name && typeof tool?.execute === 'function';
      }
    ) as Tool[];
    const safe: Tool[] = [];
    for (const t of valid) {
      const scan = scanTool(t);
      if (!scan.ok) {
        process.stderr.write(`Warning: skill tool "${t.function.name}" blocked by guardrails: ${scan.findings.filter(f => f.severity === 'block').map(f => f.message).join('; ')}\n`);
        continue;
      }
      for (const f of scan.findings) {
        process.stderr.write(`Warning: skill tool "${t.function.name}": ${f.message}\n`);
      }
      safe.push(t);
    }
    return safe;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Warning: skill tools failed to load from ${skillDir}: ${msg}\n`);
    return [];
  }
}
