/**
 * Turn summarization — generate structured summaries of completed agent turns.
 * Three layers: result refs (per-result, inline), turn summaries (per-turn, LLM), compaction (whole conversation, LLM).
 * This module handles the middle layer.
 */

import type { Message } from './types.js';
import type { CompactionConfig } from './compaction.js';
import { formatMessagesForCompaction } from './compaction.js';
import { startSpinner, fetchWithRetry } from './utils.js';
import { C } from './colors.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Only summarize turns with this many tool calls or more */
export const TURN_SUMMARY_THRESHOLD = 3;

export const TURN_SUMMARY_PROMPT = `Summarize this agent work turn. Produce exactly this structure:

## Goal
One sentence: what was attempted.

## Outcome
Success / partial / failed. One sentence.

## Files
- Read: [full paths, or "none"]
- Modified: [full paths, or "none"]

## Key Findings
Bullet points. Preserve exact file paths, function names, error messages.

## Remaining Work
What's left, if anything. "None" if complete.

Be concise. Never drop file paths or error details.`;

// ── Types ──────────────────────────────────────────────────────────────────

export interface TurnSummary {
  turnNumber: number;
  summary: string;
  readFiles: string[];
  modifiedFiles: string[];
  messageStartIndex: number;
  messageEndIndex: number;
  toolCallCount: number;
}

// ── File operation extraction ──────────────────────────────────────────────

/** Extract file paths from tool calls in a message sequence */
export function extractFileOps(messages: Message[]): { read: string[]; modified: string[] } {
  const read = new Set<string>();
  const modified = new Set<string>();

  for (const m of messages) {
    if (!m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      let args: Record<string, unknown>;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { continue; }

      const toolName = tc.function.name;
      const action = args.action as string | undefined;
      const path = (args.path || args.file_path) as string | undefined;

      if (toolName === 'file' && path) {
        if (action === 'read' || action === 'list') {
          read.add(path);
        } else if (action === 'write' || action === 'edit') {
          modified.add(path);
        }
      }
    }
  }

  return { read: [...read], modified: [...modified] };
}

// ── Turn summarization ─────────────────────────────────────────────────────

/**
 * Generate a structured summary of a completed agent turn.
 * Uses a cheap LLM call to produce the summary.
 */
export async function summarizeTurn(
  turnMessages: Message[],
  turnNumber: number,
  config: CompactionConfig,
  messageStartIndex = 0,
  silent = false,
): Promise<TurnSummary> {
  const fileOps = extractFileOps(turnMessages);
  const toolCallCount = turnMessages.reduce(
    (sum, m) => sum + (m.tool_calls?.length ?? 0), 0
  );

  const formatted = formatMessagesForCompaction(turnMessages);

  const stopSpinner = silent ? (() => {}) : startSpinner('summarizing turn');
  let stopped = false;
  let summary: string;

  try {
    const res = await fetchWithRetry(`${config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: TURN_SUMMARY_PROMPT },
          { role: 'user', content: formatted.join('\n\n') },
        ],
      }),
    });

    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const body = await res.json();
    summary = body.choices?.[0]?.message?.content;
    if (!summary) throw new Error('No summary returned');
    stopSpinner(); stopped = true;
  } catch (e) {
    if (!stopped) stopSpinner();
    // Fallback: build a basic summary from file ops
    const lines = [
      '## Goal\nAgent work turn (summary unavailable)',
      `## Files\n- Read: ${fileOps.read.join(', ') || 'none'}\n- Modified: ${fileOps.modified.join(', ') || 'none'}`,
    ];
    summary = lines.join('\n\n');
    process.stderr.write(`  ${C.dim}Turn summary failed: ${e} — using fallback${C.reset}\n`);
  }

  return {
    turnNumber,
    summary,
    readFiles: fileOps.read,
    modifiedFiles: fileOps.modified,
    messageStartIndex,
    messageEndIndex: messageStartIndex + turnMessages.length - 1,
    toolCallCount,
  };
}
