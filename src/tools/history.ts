/**
 * History tool — search and browse conversation history.
 * Last resort when the LLM can't answer from current context.
 */

import { readFileSync, existsSync } from 'node:fs';
import type { Tool } from '../core/types.js';
import { paths } from '../memory/memory.js';
import { getTextContent } from '../core/content.js';

const MAX_SEARCH_RESULTS = 20;
const MAX_RECENT = 30;

interface HistoryEntry {
  role: string;
  content: unknown;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  ts?: string;
}

function loadRawHistory(cwd: string): HistoryEntry[] {
  const p = paths(cwd).history;
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip corrupt */ }
  }
  return entries;
}

/** Extract searchable text from a history entry */
function entryToText(entry: HistoryEntry): string {
  const parts: string[] = [];

  // Message content
  if (typeof entry.content === 'string') {
    parts.push(entry.content);
  } else if (Array.isArray(entry.content)) {
    // ContentBlock array — extract text blocks and result_ref summaries
    for (const block of entry.content as Array<{ type: string; text?: string; summary?: string }>) {
      if (block.type === 'text' && block.text) parts.push(block.text);
      if (block.type === 'result_ref' && block.summary) parts.push(block.summary);
    }
  }

  // Tool call names and arguments
  if (entry.tool_calls) {
    for (const tc of entry.tool_calls) {
      parts.push(`tool:${tc.function.name}`);
      try {
        const args = JSON.parse(tc.function.arguments);
        if (args.path) parts.push(args.path);
        if (args.query) parts.push(args.query);
        if (args.command) parts.push(String(args.command).slice(0, 200));
        if (args._summary) parts.push(args._summary);
      } catch { /* collapsed or malformed args */ }
    }
  }

  return parts.join(' ');
}

/** Format a history entry for display */
function formatEntry(entry: HistoryEntry, index: number): string {
  const ts = entry.ts ? new Date(entry.ts).toLocaleString() : '';
  const role = entry.role.toUpperCase();

  if (entry.role === 'user') {
    const text = typeof entry.content === 'string' ? entry.content : '[content blocks]';
    return `[${index}] ${ts} ${role}: ${text.slice(0, 300)}`;
  }

  if (entry.role === 'assistant') {
    const text = typeof entry.content === 'string' ? entry.content : '';
    const tools = entry.tool_calls?.map(tc => tc.function.name).join(', ');
    const toolPart = tools ? ` → tools: ${tools}` : '';
    return `[${index}] ${ts} ${role}: ${text.slice(0, 200)}${toolPart}`;
  }

  if (entry.role === 'tool') {
    const text = typeof entry.content === 'string'
      ? entry.content.slice(0, 150)
      : Array.isArray(entry.content)
        ? (entry.content as Array<{ type: string; summary?: string }>)
            .filter(b => b.type === 'result_ref')
            .map(b => `[result_ref: ${b.summary?.slice(0, 80)}]`)
            .join(', ') || '[content blocks]'
        : '[unknown]';
    return `[${index}] ${ts} TOOL: ${text}`;
  }

  return `[${index}] ${ts} ${role}: ...`;
}

function doSearch(cwd: string, query: string): string {
  if (!query) return 'Error: query is required for action=search.';

  const entries = loadRawHistory(cwd);
  if (entries.length === 0) return 'No conversation history found.';

  const queryLower = query.toLowerCase();
  const matches: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const text = entryToText(entries[i]);
    if (text.toLowerCase().includes(queryLower)) {
      matches.push(formatEntry(entries[i], i));
      if (matches.length >= MAX_SEARCH_RESULTS) break;
    }
  }

  if (matches.length === 0) return `No matches for "${query}" in conversation history.`;
  return `Found ${matches.length} match(es) for "${query}":\n\n${matches.join('\n\n')}`;
}

function doRecent(cwd: string, limit: number): string {
  const entries = loadRawHistory(cwd);
  if (entries.length === 0) return 'No conversation history found.';

  const count = Math.min(limit, MAX_RECENT, entries.length);
  const recent = entries.slice(-count);
  const startIdx = entries.length - count;

  const formatted = recent.map((e, i) => formatEntry(e, startIdx + i));
  return `Last ${count} history entries:\n\n${formatted.join('\n\n')}`;
}

export function historyTool(cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'history',
      description: 'Search or browse conversation history from previous turns and sessions. Use as a last resort when you cannot answer from current context. Actions: search (find past messages matching a keyword — searches user messages, assistant responses, tool names, file paths, and result summaries), recent (show the last N conversation entries).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'recent'], description: 'search = find messages by keyword, recent = show last N entries.' },
          query: { type: 'string', description: 'Search term (search action only).' },
          limit: { type: 'number', description: 'Number of recent entries to show (recent action only, default 10, max 30).' },
        },
        required: ['action'],
      },
    },
    execute: async ({ action, query, limit }: { action: string; query?: string; limit?: number }): Promise<string> => {
      switch (action) {
        case 'search': return doSearch(cwd, query || '');
        case 'recent': return doRecent(cwd, limit ?? 10);
        default: return `Unknown action "${action}". Use: search, recent.`;
      }
    },
  };
}
