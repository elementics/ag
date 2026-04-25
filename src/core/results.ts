/**
 * Result store — cache, ref, and summarize large tool results.
 * Send-once pattern: full content sent on introduction turn, summary pointers on subsequent turns.
 * Mirrors the ContentRef pattern in content.ts.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AG_DIR } from './constants.js';
import type { ResultRef } from './types.js';

// ── Project-scoped results cache dir ───────────────────────────────────────

function projectId(cwd: string): string {
  return createHash('md5').update(cwd).digest('hex').slice(0, 12);
}

function resultsCacheDir(cwd: string): string {
  return join(AG_DIR, 'projects', projectId(cwd), 'results');
}

function resultIndexPath(cwd: string): string {
  return join(AG_DIR, 'projects', projectId(cwd), 'results', 'index.json');
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Tool results larger than this (in chars) are cached and replaced with a ResultRef */
export const RESULT_REF_THRESHOLD = 2048;

// ── Session-scoped store ───────────────────────────────────────────────────

let nextResultId = 1;
const resultRefs = new Map<number, ResultRef>();
const requestedResults = new Set<number>();

export function resetResultStore(): void {
  nextResultId = 1;
  resultRefs.clear();
  requestedResults.clear();
}

export function markResultRequested(id: number): void {
  requestedResults.add(id);
}

export function consumeRequestedResults(): Set<number> {
  const result = new Set(requestedResults);
  requestedResults.clear();
  return result;
}

export function getResultRef(id: number): ResultRef | undefined {
  return resultRefs.get(id);
}

export function getAllResultRefs(): ResultRef[] {
  return [...resultRefs.values()];
}

// ── Locking (same pattern as withTasks in memory.ts) ───────────────────────

const LOCK_TIMEOUT = 5000;
const LOCK_POLL = 10;

function acquireLock(lockDir: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT;
  while (true) {
    try {
      mkdirSync(lockDir);
      return;
    } catch {
      if (Date.now() > deadline) {
        try { rmdirSync(lockDir); } catch { /* ignore */ }
        try { mkdirSync(lockDir); return; } catch { /* fall through */ }
        throw new Error('Result index lock timeout — another process may be updating');
      }
      const wait = Math.min(LOCK_POLL, deadline - Date.now());
      if (wait > 0) { const end = Date.now() + wait; while (Date.now() < end) { /* spin */ } }
    }
  }
}

// ── Cache operations ───────────────────────────────────────────────────────

/**
 * Cache a large tool result to disk and return a ResultRef pointer.
 * The full content is written to results/{id}.txt and a ref is stored in memory.
 */
export function cacheResult(
  toolName: string,
  result: string,
  turn: number,
  cwd: string,
  args?: Record<string, unknown>,
): ResultRef {
  const dir = resultsCacheDir(cwd);
  mkdirSync(dir, { recursive: true });

  const id = nextResultId++;
  const cachePath = join(dir, `${id}.txt`);
  writeFileSync(cachePath, result);

  const ref: ResultRef = {
    type: 'result_ref',
    id,
    tool_name: toolName,
    summary: generateResultSummary(toolName, result, args),
    size_chars: result.length,
    cache_path: cachePath,
    introduced_turn: turn,
  };

  resultRefs.set(id, ref);
  return ref;
}

/** Read full result content from disk cache */
export function resolveResult(ref: ResultRef): string {
  if (!existsSync(ref.cache_path)) {
    return `Error: cached result #${ref.id} not found at ${ref.cache_path}`;
  }
  return readFileSync(ref.cache_path, 'utf-8');
}

// ── Summary generation (inline heuristics, no LLM) ────────────────────────

/** Generate a concise summary of a tool result for use as a pointer */
export function generateResultSummary(
  toolName: string,
  result: string,
  args?: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'file': return summarizeFileResult(result, args);
    case 'bash': return summarizeBashResult(result);
    case 'grep': return summarizeGrepResult(result);
    default: return summarizeDefault(result);
  }
}

function summarizeFileResult(result: string, args?: Record<string, unknown>): string {
  const action = args?.action as string | undefined;
  const path = args?.path as string | undefined;

  if (action === 'write' || action === 'edit') {
    const preview = result.split('\n').slice(0, 8).join('\n');
    return path
      ? truncLine(`Wrote/edited ${path}\n${preview}`, 600)
      : truncLine(`File written\n${preview}`, 600);
  }

  // action=read or default
  const lines = result.split('\n');
  const lineCount = lines.length;
  const ext = path?.split('.').pop() || '';
  const lang = ext ? ` (${ext})` : '';
  return path
    ? `Read ${path} — ${lineCount} lines${lang}`
    : `Read file — ${lineCount} lines${lang}`;
}

function summarizeBashResult(result: string): string {
  const lines = result.split('\n').filter(l => l.trim());
  if (lines.length === 0) return '(empty output)';

  // Check for exit code pattern at either edge. bash returns failures as "EXIT N\n..."
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  const exitMatch = firstLine.match(/^EXIT (\d+)/) ?? lastLine.match(/^EXIT (\d+)/);
  const exitSuffix = exitMatch ? ` [exit ${exitMatch[1]}]` : '';

  const contentLines = firstLine.match(/^EXIT \d+/) ? lines.slice(1)
    : lastLine.match(/^EXIT \d+/) ? lines.slice(0, -1)
    : lines;
  if (contentLines.length === 0) return `(no output)${exitSuffix}`;
  if (contentLines.length <= 4) return truncLine(contentLines.join('\n'), 300) + exitSuffix;

  const first = truncLine(contentLines[0], 100);
  const last3 = contentLines.slice(-3).map(l => truncLine(l, 100)).join('\n');
  return `${first}\n... (${contentLines.length} lines)\n${last3}${exitSuffix}`;
}

/** Truncate a single line/string to maxLen chars */
function truncLine(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '...';
}

function summarizeGrepResult(result: string): string {
  const lines = result.split('\n').filter(l => l.trim());
  if (lines.length === 0) return 'No matches found';

  // Count unique files (lines often start with "path/to/file:line:content")
  const files = new Set<string>();
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) files.add(line.slice(0, colonIdx));
  }

  const matchCount = lines.length;
  const fileCount = files.size || 1;
  const preview = lines.slice(0, 3).map(l => truncLine(l, 120)).join('\n');
  const more = matchCount > 3 ? `\n... (${matchCount} matches across ${fileCount} file(s))` : '';
  return `${preview}${more}`;
}

function summarizeDefault(result: string): string {
  if (result.length <= 200) return result;
  return `${result.slice(0, 200)}... [${result.length} chars total]`;
}

// ── Index persistence ──────────────────────────────────────────────────────

/** Save the in-memory result ref map to disk (with file locking) */
export function saveResultIndex(cwd: string): void {
  const dir = resultsCacheDir(cwd);
  mkdirSync(dir, { recursive: true });
  const indexPath = resultIndexPath(cwd);
  const lockDir = `${indexPath}.lock`;
  acquireLock(lockDir);
  try {
    const data = { nextId: nextResultId, refs: [...resultRefs.values()] };
    writeFileSync(indexPath, JSON.stringify(data, null, 2) + '\n');
  } finally {
    try { rmdirSync(lockDir); } catch { /* ignore */ }
  }
}

/** Restore result refs from the persisted index */
export function restoreResultIndex(cwd: string): void {
  const indexPath = resultIndexPath(cwd);
  if (!existsSync(indexPath)) return;
  try {
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
    if (Array.isArray(data.refs)) {
      for (const ref of data.refs as ResultRef[]) {
        if (existsSync(ref.cache_path)) {
          resultRefs.set(ref.id, ref);
        }
      }
    }
    if (typeof data.nextId === 'number' && data.nextId > nextResultId) {
      nextResultId = data.nextId;
    }
  } catch { /* corrupt index — start fresh */ }
}

/** Delete all cached results, the index, and reset the in-memory store */
export function clearResultCache(cwd: string): void {
  const dir = resultsCacheDir(cwd);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  resetResultStore();
}
