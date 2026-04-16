/**
 * Context compaction — summarize older messages to free context window space
 */

import type { Message, ContentRef } from './types.js';
import { C } from './colors.js';
import { startSpinner, fetchWithRetry } from './utils.js';
import { getTextContent, describeContent } from './content.js';

// ── Constants ───────────────────────────────────────────────────────────────

export const COMPACT_THRESHOLD = 0.9;
export const COMPACT_HEAD_KEEP = 2;
export const COMPACT_TAIL_KEEP = 10;
export const COMPACT_MSG_CHARS = 500;
export const COMPACT_TOTAL_CHARS = 50000;

export const COMPACTION_PROMPT = `Summarize this conversation between a user and a coding assistant. Extract essential context needed to continue working.

You MUST preserve exactly:
- All file paths that were read, edited, or created (full paths, not abbreviated)
- All error messages and their causes
- Decisions made and their rationale
- Current task: what was asked, what's done, what remains
- Any user preferences or constraints mentioned

Format as structured bullet points. Be concise but never drop paths, error details, or decision rationale — these are critical for the assistant to continue without re-reading files or re-discovering errors.`;

// ── Formatting ──────────────────────────────────────────────────────────────

/** Format middle messages for summarization, capping total size */
export function formatMessagesForCompaction(messages: Message[]): string[] {
  let totalChars = 0;
  const formatted: string[] = [];
  for (const m of messages) {
    let line: string;
    if (m.tool_calls?.length) {
      const names = m.tool_calls.map(tc => tc.function.name).join(', ');
      line = `[assistant]: (tool call: ${names})`;
    } else if (m.role === 'tool') {
      line = `[tool result]: ${getTextContent(m).slice(0, COMPACT_MSG_CHARS)}`;
    } else {
      let text = getTextContent(m);
      // Append content ref descriptions so they survive compaction
      if (Array.isArray(m.content)) {
        const contentDescs = m.content
          .filter((b): b is ContentRef => b.type === 'content_ref')
          .map(ref => `[content #${ref.id}: ${describeContent(ref)}]`);
        if (contentDescs.length) text += ' ' + contentDescs.join(' ');
      }
      line = `[${m.role}]: ${text.slice(0, COMPACT_MSG_CHARS)}`;
    }
    if (totalChars + line.length > COMPACT_TOTAL_CHARS) break;
    totalChars += line.length;
    formatted.push(line);
  }
  return formatted;
}

// ── Compaction ──────────────────────────────────────────────────────────────

export interface CompactionConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * Compact a conversation by summarizing middle messages.
 * Returns the new messages array and the summary message (for history append).
 * If customSummary is provided, skips the LLM call.
 */
export async function compactMessages(
  messages: Message[],
  config: CompactionConfig,
  customSummary?: string,
): Promise<{ messages: Message[]; summaryMsg: Message } | null> {
  const minMessages = COMPACT_HEAD_KEEP + COMPACT_TAIL_KEEP + 4;
  if (messages.length <= minMessages) return null;

  const head = messages.slice(0, COMPACT_HEAD_KEEP);
  const middle = messages.slice(COMPACT_HEAD_KEEP, -COMPACT_TAIL_KEEP);
  const tail = messages.slice(-COMPACT_TAIL_KEEP);

  let summary: string;

  if (customSummary) {
    summary = customSummary;
  } else {
    const formatted = formatMessagesForCompaction(middle);

    const stopSpinner = startSpinner('compacting context');
    let stopped = false;
    try {
      const res = await fetchWithRetry(`${config.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: COMPACTION_PROMPT },
            { role: 'user', content: formatted.join('\n\n') }
          ]
        })
      });

      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      const body = await res.json();
      summary = body.choices?.[0]?.message?.content;
      if (!summary) throw new Error('No summary returned');
      stopSpinner(); stopped = true;
    } finally {
      if (!stopped) stopSpinner();
    }
  }

  const summaryMsg: Message = {
    role: 'user',
    content: `[Conversation compacted — summary of ${middle.length} earlier messages]\n\n${summary}`
  };

  process.stderr.write(`  ${C.yellow}Context compacted: ${middle.length} messages → summary${C.reset}\n`);

  return {
    messages: [...head, summaryMsg, ...tail],
    summaryMsg,
  };
}
