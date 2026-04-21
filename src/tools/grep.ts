/**
 * Grep tool — code search and file finding
 * Primary: ripgrep (rg) via execFileSync
 * Fallback: native Node.js when rg is not installed
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { Tool } from '../core/types.js';
import { AG_DIR, DEFAULT_IGNORE, isBinary } from '../core/constants.js';

const MAX_SEARCH_LINES = 250;
const MAX_FIND_RESULTS = 100;
const MAX_FILE_SIZE = 1_048_576; // 1 MB

// ── Ripgrep helpers ──────────────────────────────────────────────────────

async function tryRg(args: string[], cwd: string): Promise<{ ok: boolean; out: string; notFound: boolean }> {
  try {
    const stdout = execFileSync('rg', args, {
      cwd, encoding: 'utf-8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, out: stdout.trim(), notFound: false };
  } catch (e: unknown) {
    const err = e as { code?: string | number; status?: number; stdout?: string; stderr?: string };
    if (err.code === 'ENOENT') return { ok: false, out: '', notFound: true };
    // rg exits 1 for no matches, 2 for errors
    const out = ((err.stdout ?? '') + (err.stderr ?? '')).trim();
    if (err.code === 1 || err.status === 1) return { ok: true, out: '', notFound: false }; // no matches
    return { ok: false, out, notFound: false };
  }
}

async function rgSearch(cwd: string, pattern: string, path?: string, glob?: string,
  caseInsensitive?: boolean, context?: number): Promise<string> {
  const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(MAX_SEARCH_LINES)];
  if (glob) args.push('--glob', glob);
  if (caseInsensitive) args.push('--ignore-case');
  if (context && context > 0) args.push('--context', String(context));
  args.push(pattern);
  if (path) args.push(path);

  const result = await tryRg(args, cwd);
  if (result.notFound) return ''; // signal to use fallback
  if (!result.ok) return `Error: ${result.out}`;
  return result.out;
}

async function rgFind(cwd: string, pattern: string, path?: string): Promise<string> {
  const args = ['--files', '--glob', pattern];
  if (path) args.push(path);

  const result = await tryRg(args, cwd);
  if (result.notFound) return ''; // signal to use fallback
  if (!result.ok) return `Error: ${result.out}`;
  if (!result.out) return '';

  const lines = result.out.split('\n');
  if (lines.length > MAX_FIND_RESULTS) {
    return lines.slice(0, MAX_FIND_RESULTS).join('\n')
      + `\n... (${MAX_FIND_RESULTS} of ${lines.length} files shown. Narrow with path.)`;
  }
  return result.out;
}

// ── Native fallback helpers ──────────────────────────────────────────────

function walkDir(root: string, maxDepth = 20): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (DEFAULT_IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (entry.isFile()) files.push(full);
    }
  }

  walk(root, 0);
  return files;
}

const MAX_GLOB_LENGTH = 200;

function matchesGlob(filepath: string, glob: string): boolean {
  // Protect against ReDoS from excessively complex patterns
  if (glob.length > MAX_GLOB_LENGTH) return false;

  // Convert glob to regex: * -> [^/]*, ** -> .*, ? -> ., {a,b} -> (a|b), escape dots
  const re = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    .replace(/\?/g, '.')
    .replace(/\{([^}]+)\}/g, (_m, group) => `(${group.replace(/,/g, '|')})`);
  // If pattern has no path separators, match against basename only
  if (!glob.includes('/')) {
    const basename = filepath.split('/').pop() || filepath;
    return new RegExp(`^${re}$`).test(basename);
  }
  return new RegExp(`^${re}$`).test(filepath) || new RegExp(`${re}$`).test(filepath);
}

function fallbackSearch(cwd: string, pattern: string, searchRoot: string,
  glob?: string, caseInsensitive?: boolean, context?: number): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
  } catch (e: unknown) {
    return `Error: invalid regex — ${e instanceof Error ? e.message : String(e)}`;
  }

  const ctx = context && context > 0 ? context : 0;
  const files = walkDir(searchRoot);
  const output: string[] = [];
  let matchCount = 0;
  let truncated = false;

  for (const file of files) {
    if (matchCount >= MAX_SEARCH_LINES) { truncated = true; break; }
    try {
      const stat = statSync(file);
      if (stat.size > MAX_FILE_SIZE) continue;
    } catch { continue; }
    if (isBinary(file)) continue;
    if (glob && !matchesGlob(relative(cwd, file), glob)) continue;

    let content: string;
    try { content = readFileSync(file, 'utf-8'); } catch { continue; }

    const lines = content.split('\n');
    const relPath = relative(cwd, file);
    const fileMatches: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const start = Math.max(0, i - ctx);
        const end = Math.min(lines.length - 1, i + ctx);
        for (let j = start; j <= end; j++) {
          fileMatches.push(`${relPath}:${j + 1}:${lines[j]}`);
          matchCount++;
          if (matchCount >= MAX_SEARCH_LINES) { truncated = true; break; }
        }
        if (truncated) break;
      }
    }

    if (fileMatches.length > 0) {
      if (output.length > 0) output.push('');
      output.push(...fileMatches);
    }
    if (truncated) break;
  }

  if (output.length === 0) return 'No matches found.';
  let result = output.join('\n');
  if (truncated) result += `\n... (${MAX_SEARCH_LINES} lines shown. Narrow with path or glob.)`;
  return result;
}

function fallbackFind(cwd: string, pattern: string, searchRoot: string): string {
  const files = walkDir(searchRoot);
  const matches: string[] = [];

  for (const file of files) {
    const relPath = relative(cwd, file);
    if (matchesGlob(relPath, pattern)) {
      matches.push(relPath);
      if (matches.length >= MAX_FIND_RESULTS) break;
    }
  }

  if (matches.length === 0) return 'No matches found.';
  let result = matches.join('\n');
  if (matches.length >= MAX_FIND_RESULTS) {
    result += `\n... (${MAX_FIND_RESULTS} files shown. Narrow with path.)`;
  }
  return result;
}

// ── Action handlers ──────────────────────────────────────────────────────

async function doSearch(cwd: string, pattern: string, path?: string, glob?: string,
  caseInsensitive?: boolean, context?: number): Promise<string> {
  const searchRoot = path ? resolve(cwd, path) : cwd;
  if (!searchRoot.startsWith(cwd) && !searchRoot.startsWith(AG_DIR)) {
    return 'Error: path must be within the project directory or ~/.ag.';
  }

  // Try ripgrep first
  const rgResult = await rgSearch(cwd, pattern, path, glob, caseInsensitive, context);
  if (rgResult !== '') return rgResult; // '' means rg not found

  // Fallback to native Node.js
  return fallbackSearch(cwd, pattern, searchRoot, glob, caseInsensitive, context);
}

async function doFind(cwd: string, pattern: string, path?: string): Promise<string> {
  const searchRoot = path ? resolve(cwd, path) : cwd;
  if (!searchRoot.startsWith(cwd) && !searchRoot.startsWith(AG_DIR)) {
    return 'Error: path must be within the project directory or ~/.ag.';
  }

  // Try ripgrep first
  const rgResult = await rgFind(cwd, pattern, path);
  if (rgResult !== '') return rgResult; // '' means rg not found

  // Fallback to native Node.js
  return fallbackFind(cwd, pattern, searchRoot);
}

// ── Exported tool ────────────────────────────────────────────────────────

export function grepTool(cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search code and find files. Actions: search (find pattern in file contents using regex), find (locate files by name/glob pattern).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'find'], description: 'search = content regex, find = file name glob.' },
          pattern: { type: 'string', description: 'Regex for search, glob for find (e.g. "*.ts", "TODO", "function\\s+\\w+").' },
          path: { type: 'string', description: 'Subdirectory to scope (relative to project root). Omit to search everywhere.' },
          glob: { type: 'string', description: 'File type filter for action=search (e.g. "*.ts", "*.py"). Not needed for find.' },
          case_insensitive: { type: 'boolean', description: 'Case-insensitive matching (search only). Default: false.' },
          context: { type: 'number', description: 'Lines of context before and after each match (search only). Default: 0.' }
        },
        required: ['action', 'pattern']
      }
    },
    execute: async ({ action, pattern, path, glob, case_insensitive, context }: {
      action: string; pattern?: string; path?: string; glob?: string;
      case_insensitive?: boolean; context?: number;
    }): Promise<string> => {
      if (!pattern) return 'Error: pattern is required.';
      switch (action) {
        case 'search': return doSearch(cwd, pattern, path, glob, case_insensitive, context);
        case 'find': return doFind(cwd, pattern, path);
        default: return `Unknown action "${action}". Use: search, find.`;
      }
    }
  };
}
