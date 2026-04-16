/**
 * File tool — read files and list directories
 * Prevents the model from falling back to bash for cat/head/tail/ls.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { Tool } from '../core/types.js';
import { AG_DIR, DEFAULT_IGNORE, isBinary } from '../core/constants.js';
import { ingestContent, describeContent } from '../core/content.js';

const MAX_READ_BYTES = 100 * 1024; // 100 KB text cap
const MAX_LIST_ENTRIES = 200;
const MAX_LIST_DEPTH = 3;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function doRead(cwd: string, path: string, offset?: number, limit?: number): string {
  const resolved = resolve(cwd, path);
  const cwdResolved = resolve(cwd);
  const agDirResolved = resolve(AG_DIR);
  if (!resolved.startsWith(cwdResolved + '/') && resolved !== cwdResolved
      && !resolved.startsWith(agDirResolved + '/') && resolved !== agDirResolved) {
    return `Error: path "${path}" is outside the project directory. Access is restricted to ${cwdResolved} and ~/.ag`;
  }

  let stat;
  try { stat = statSync(resolved); } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return `Error: file not found — ${path}. Use grep(action=find) or file(action=list) to discover the correct filename.`;
    if (err.code === 'EACCES') return `Error: permission denied — ${path}`;
    return `Error: ${err.message ?? String(e)}`;
  }

  if (stat.isDirectory()) return `Error: "${path}" is a directory. Use action=list instead.`;

  // Check for content-ingestible files (images, PDFs) before binary rejection
  const CONTENT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);
  const ext = extname(resolved).toLowerCase();
  if (CONTENT_EXTS.has(ext)) {
    try {
      const ref = ingestContent(resolved, cwd);
      return `Ingested as [content #${ref.id}] — ${describeContent(ref)}`;
    } catch (e: unknown) {
      return `Error ingesting content: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (isBinary(resolved)) {
    return `Binary file (${formatSize(stat.size)} ${ext || 'unknown type'}). Use bash with an appropriate tool (e.g. pdftotext, xxd, strings) to inspect.`;
  }

  let content: string;
  try { content = readFileSync(resolved, 'utf-8'); } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const lines = content.split('\n');
  const start = Math.max(0, (offset ?? 1) - 1);
  const count = limit ?? lines.length;
  const slice = lines.slice(start, start + count);

  // Check if we need to truncate by byte size
  let totalBytes = 0;
  let truncIdx = slice.length;
  for (let i = 0; i < slice.length; i++) {
    totalBytes += slice[i].length + 1;
    if (totalBytes > MAX_READ_BYTES) { truncIdx = i; break; }
  }
  const output = slice.slice(0, truncIdx);
  const numbered = output.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`);

  let result = numbered.join('\n');
  if (truncIdx < slice.length) {
    result += `\n... (truncated at 100KB — showing lines ${start + 1}-${start + truncIdx} of ${lines.length} total)`;
  } else if (start + count < lines.length && !limit) {
    // no truncation needed
  }
  return result;
}

function doList(cwd: string, path: string, maxDepth: number): string {
  const resolved = resolve(cwd, path);
  const cwdResolved = resolve(cwd);
  const agDirResolved = resolve(AG_DIR);
  if (!resolved.startsWith(cwdResolved + '/') && resolved !== cwdResolved
      && !resolved.startsWith(agDirResolved + '/') && resolved !== agDirResolved) {
    return `Error: path "${path}" is outside the project directory. Access is restricted to ${cwdResolved} and ~/.ag`;
  }
  const entries: string[] = [];
  let count = 0;

  function walk(dir: string, depth: number, prefix: string): void {
    if (depth > maxDepth || count >= MAX_LIST_ENTRIES) return;
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    // Sort: dirs first, then files
    items.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const item of items) {
      if (count >= MAX_LIST_ENTRIES) break;
      if (DEFAULT_IGNORE.has(item.name)) continue;
      if (item.name.startsWith('.') && item.name !== '.') continue;

      const full = resolve(dir, item.name);
      if (item.isDirectory()) {
        entries.push(`${prefix}[dir] ${item.name}/`);
        count++;
        if (depth < maxDepth) walk(full, depth + 1, prefix + '  ');
      } else if (item.isFile()) {
        try {
          const s = statSync(full);
          entries.push(`${prefix}${item.name} (${formatSize(s.size)})`);
        } catch {
          entries.push(`${prefix}${item.name}`);
        }
        count++;
      }
    }
  }

  walk(resolved, 1, '');
  if (entries.length === 0) return 'Empty directory.';
  let result = entries.join('\n');
  if (count >= MAX_LIST_ENTRIES) result += `\n... (${MAX_LIST_ENTRIES} entries shown. Narrow with path.)`;
  return result;
}

function validatePath(cwd: string, path: string): { resolved: string; error?: string } {
  const resolved = resolve(cwd, path);
  const cwdResolved = resolve(cwd);
  if (!resolved.startsWith(cwdResolved + '/') && resolved !== cwdResolved) {
    return { resolved, error: `Error: path "${path}" is outside the project directory. Access is restricted to ${cwdResolved}` };
  }
  return { resolved };
}

function doWrite(cwd: string, path: string, content: string): string {
  const { resolved, error } = validatePath(cwd, path);
  if (error) return error;

  try {
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, content);
    const lines = content.split('\n').length;
    const bytes = Buffer.byteLength(content);
    return `Wrote ${path} (${lines} lines, ${formatSize(bytes)})`;
  } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function doEdit(cwd: string, path: string, oldString: string, newString: string): string {
  const { resolved, error } = validatePath(cwd, path);
  if (error) return error;

  let content: string;
  try { content = readFileSync(resolved, 'utf-8'); } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return `Error: file not found — ${path}`;
    return `Error: ${err.message ?? String(e)}`;
  }

  if (isBinary(resolved)) return `Error: cannot edit binary file — ${path}`;

  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) return `Error: old_string not found in ${path}. Read the file first to verify exact content.`;
  if (occurrences > 1) return `Error: old_string matches ${occurrences} times in ${path}. Provide more surrounding context to make it unique.`;

  const updated = content.replace(oldString, newString);
  writeFileSync(resolved, updated);
  return `Edited ${path} — replaced ${oldString.split('\n').length} line(s)`;
}

export function fileTool(cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'file',
      description: 'Read, list, write, and edit files. Prefer this over bash for ALL file operations. Actions: read (view with line numbers — always read before editing), list (directory tree), write (create/overwrite file), edit (find-and-replace in existing file — old_string must match exactly once).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'list', 'write', 'edit'], description: 'read = view file, list = directory listing, write = create/overwrite file, edit = replace a string in an existing file.' },
          path: { type: 'string', description: 'File or directory path (relative to project root, or absolute).' },
          content: { type: 'string', description: 'File content to write (write action only).' },
          old_string: { type: 'string', description: 'Exact string to find and replace (edit action only). Must match exactly once.' },
          new_string: { type: 'string', description: 'Replacement string (edit action only).' },
          offset: { type: 'number', description: 'Line number to start reading from (read only, default: 1).' },
          limit: { type: 'number', description: 'Max lines to return (read only). Omit to read entire file.' },
          depth: { type: 'number', description: 'Directory depth for list (default: 2, max: 3).' },
        },
        required: ['action', 'path']
      }
    },
    execute: async ({ action, path, content, old_string, new_string, offset, limit, depth }: {
      action: string; path: string; content?: string; old_string?: string; new_string?: string; offset?: number; limit?: number; depth?: number;
    }): Promise<string> => {
      if (!path) return 'Error: path is required.';
      switch (action) {
        case 'read': return doRead(cwd, path, offset, limit);
        case 'list': return doList(cwd, path, Math.min(depth ?? 2, MAX_LIST_DEPTH));
        case 'write':
          if (content === undefined) return 'Error: content is required for write action.';
          return doWrite(cwd, path, content);
        case 'edit':
          if (!old_string) return 'Error: old_string is required for edit action.';
          if (new_string === undefined) return 'Error: new_string is required for edit action.';
          return doEdit(cwd, path, old_string, new_string);
        default: return `Unknown action "${action}". Use: read, list, write, edit.`;
      }
    }
  };
}
