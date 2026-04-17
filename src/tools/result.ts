/**
 * Result tool — retrieve or inspect previously cached tool results.
 * Mirrors the content tool pattern for ContentRef.
 */

import type { Tool } from '../core/types.js';
import { getResultRef, markResultRequested } from '../core/results.js';

function doGet(ref?: number): string {
  if (ref === undefined || ref === null) return 'Error: ref is required for action=get.';
  const entry = getResultRef(ref);
  if (!entry) return `Error: result #${ref} not found. Use result(action=info) with a known ref ID.`;

  markResultRequested(entry.id);

  return [
    `[result #${entry.id}]: ${entry.tool_name} output`,
    `Size: ${entry.size_chars} chars`,
    `Summary: ${entry.summary}`,
    // Note: the full result content is injected into the next API call
    // when the model requests it via this tool.
  ].join('\n');
}

function doInfo(ref?: number): string {
  if (ref === undefined || ref === null) return 'Error: ref is required for action=info.';
  const entry = getResultRef(ref);
  if (!entry) return `Error: result #${ref} not found.`;

  return [
    `Result #${entry.id}`,
    `Tool: ${entry.tool_name}`,
    `Size: ${entry.size_chars} chars`,
    `Turn introduced: ${entry.introduced_turn}`,
    `Summary: ${entry.summary}`,
  ].join('\n');
}

export function resultTool(_cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'result',
      description: 'Result operations. Actions: get (retrieve the full output of a previous tool result — use when a result summary references [result #N] and you need the complete content), info (get metadata about a cached result: tool name, size, and turn it was produced).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'info'], description: 'The result operation.' },
          ref: { type: 'number', description: 'Result reference number (e.g. 3 for [result #3]).' },
        },
        required: ['action', 'ref'],
      },
    },
    execute: async ({ action, ref }: { action: string; ref?: number }): Promise<string> => {
      switch (action) {
        case 'get': return doGet(ref);
        case 'info': return doInfo(ref);
        default: return `Unknown action "${action}". Use: get, info.`;
      }
    },
  };
}
