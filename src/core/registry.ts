import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { scanContent } from './guardrails.js';

const SKILLS_DIR = join(homedir(), '.ag', 'skills');
const SEARCH_API = 'https://skills.sh/api/search';

export interface RegistrySkill {
  skillId: string;
  name: string;
  source: string;
  installs: number;
}

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'ag',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

interface SkillLocation {
  branch: string;
  dirPath: string;
  files: string[];
}

async function findSkillInTree(
  repo: string,
  skillName: string,
  headers: Record<string, string>,
): Promise<SkillLocation> {
  const branches = ['main', 'master'];
  const suffix = `${skillName}/SKILL.md`;

  for (const branch of branches) {
    const url = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
    let data: { tree?: TreeEntry[] };
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      data = await res.json() as { tree?: TreeEntry[] };
    } catch { continue; }

    const tree = data.tree;
    if (!tree) continue;

    // Find the SKILL.md entry matching this skill name
    const skillMdEntry = tree.find(e => e.type === 'blob' && (e.path === suffix || e.path.endsWith(`/${suffix}`)));
    if (!skillMdEntry) continue;

    // Extract the skill directory path (everything before /SKILL.md)
    const dirPath = skillMdEntry.path.slice(0, -(('/SKILL.md').length));
    const dirPrefix = dirPath + '/';

    // Collect all blob entries within this directory
    const files = tree
      .filter(e => e.type === 'blob' && e.path.startsWith(dirPrefix))
      .map(e => e.path);

    return { branch, dirPath, files };
  }

  throw new Error(`Could not find skill directory for "${skillName}" in ${repo}`);
}

export async function searchRegistry(query: string): Promise<RegistrySkill[]> {
  const res = await fetch(`${SEARCH_API}?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`skills.sh search failed: ${res.status}`);
  const data = await res.json() as { skills: RegistrySkill[]; count: number };
  return data.skills || [];
}

export async function installSkill(source: string): Promise<string> {
  // Parse "owner/repo@skill-name"
  const atIdx = source.lastIndexOf('@');
  if (atIdx === -1) throw new Error('Format: owner/repo@skill-name');
  const repo = source.slice(0, atIdx);
  const skillName = source.slice(atIdx + 1);

  const headers = githubHeaders();

  // Phase 1: Find the skill directory in the repo tree
  const { branch, dirPath, files } = await findSkillInTree(repo, skillName, headers);

  // Phase 2: Download and save all files
  const skillDir = join(SKILLS_DIR, skillName);
  if (existsSync(skillDir)) rmSync(skillDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });

  const errors: string[] = [];
  for (const filePath of files) {
    const relativePath = filePath.slice(dirPath.length + 1);
    const destPath = join(skillDir, relativePath);
    const destDir = dirname(destPath);

    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${filePath}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        errors.push(`Failed to download ${relativePath}: HTTP ${res.status}`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (relativePath.endsWith('.md') || relativePath.endsWith('.mjs')) {
        const text = buffer.toString('utf-8');
        const scan = scanContent(text, `installed file "${relativePath}" from ${repo}`);
        if (!scan.ok) {
          const reasons = scan.findings.filter(f => f.severity === 'block').map(f => f.message).join('; ');
          errors.push(`Blocked ${relativePath}: ${reasons}`);
          if (relativePath === 'SKILL.md') {
            // Core skill file is compromised — abort entire installation
            if (existsSync(skillDir)) rmSync(skillDir, { recursive: true });
            throw new Error(`Skill "${skillName}" blocked by guardrails: ${reasons}`);
          }
          continue;
        }
      }
      writeFileSync(destPath, buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Error downloading ${relativePath}: ${msg}`);
    }
  }

  let message = `Installed "${skillName}" (${files.length} file${files.length === 1 ? '' : 's'}) to ${skillDir}`;
  if (errors.length > 0) {
    message += `\nWarnings:\n${errors.map(e => `  - ${e}`).join('\n')}`;
  }
  return message;
}

export function removeSkill(name: string): string {
  const skillDir = join(SKILLS_DIR, name);
  if (!existsSync(skillDir)) return `Skill "${name}" not found.`;
  rmSync(skillDir, { recursive: true });
  return `Removed "${name}".`;
}

export function formatInstalls(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
