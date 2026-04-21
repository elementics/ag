/**
 * System prompt assembly — environment detection, read-only rules, request building
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Message, Tool } from './types.js';
import { resolveMessagesForAPI } from './content.js';

// ── Environment context ─────────────────────────────────────────────────────

export function getEnvironmentContext(cwd: string): string {
  const lines: string[] = ['# Environment'];
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`OS: ${process.platform}`);
  lines.push(`CWD: ${cwd}`);

  // Git info
  if (existsSync(join(cwd, '.git'))) {
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      lines.push(`Git branch: ${branch}`);
      const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (dirty) {
        const count = dirty.split('\n').length;
        lines.push(`Git status: ${count} changed file(s)`);
      }
    } catch { /* not a git repo or git not installed */ }
  }

  // Detect stack from config files
  const detectedStack: string[] = [];
  const stackHints: Array<[string, string]> = [
    ['package.json', 'Node.js'],
    ['tsconfig.json', 'TypeScript'],
    ['Cargo.toml', 'Rust'],
    ['go.mod', 'Go'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['Gemfile', 'Ruby'],
    ['pom.xml', 'Java/Maven'],
    ['build.gradle', 'Java/Gradle'],
  ];
  for (const [file, stack] of stackHints) {
    if (existsSync(join(cwd, file))) detectedStack.push(stack);
  }
  if (detectedStack.length > 0) lines.push(`Stack: ${detectedStack.join(', ')}`);

  return lines.join('\n');
}

// ── Read-only tool rules ────────────────────────────────────────────────────

/** Tool actions that are read-only and never need confirmation */
const READ_ONLY_CALLS: Record<string, Set<string> | true> = {
  grep: true,                                          // all grep actions are read-only
  memory: true,                                        // saving memory is safe
  plan: true,                                          // managing plans is safe
  skill: true,                                         // activating skills is safe
  file: new Set(['read', 'list']),                     // only read/list are safe
  git: new Set(['status']),                             // only status is safe
  web: true,                                           // built-in web operations are read-only
  task: true,                                          // all task actions are safe (internal state)
  agent: true,                                         // sub-agent spawning is safe (internal orchestration)
  content: true,                                        // all content actions are read-only
  result: true,                                         // all result actions are read-only
  history: true,                                        // all history actions are read-only
};

export function isReadOnlyToolCall(toolName: string, args: Record<string, unknown>, tool?: Tool): boolean {
  const rule = READ_ONLY_CALLS[toolName];
  if (rule === true) return true;
  if (rule instanceof Set) return rule.has(args.action as string);
  // Custom tool self-declaration
  if (tool?.readOnly === true) return true;
  if (Array.isArray(tool?.readOnly)) return tool.readOnly.includes(args.action as string);
  return false;
}

// ── Project listing ─────────────────────────────────────────────────────────

const MAX_ENTRIES = 30;
const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', '__pycache__']);

export function getProjectListing(cwd: string): string {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    const lines: string[] = [];
    for (const e of entries) {
      if (lines.length >= MAX_ENTRIES) { lines.push(`  ... (${entries.length - MAX_ENTRIES} more)`); break; }
      if (IGNORE.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      if (e.isDirectory()) {
        lines.push(`  [dir] ${e.name}/`);
      } else {
        try {
          const s = statSync(join(cwd, e.name));
          const kb = (s.size / 1024).toFixed(1);
          lines.push(`  ${e.name} (${kb}KB)`);
        } catch { lines.push(`  ${e.name}`); }
      }
    }
    return lines.length > 0 ? `Project files (${cwd}):\n${lines.join('\n')}` : '';
  } catch { return ''; }
}

// ── Request body building ───────────────────────────────────────────────────

export interface RequestBodyOptions {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  stream: boolean;
  currentTurn?: number;
}

/** Ensure message content is a valid type for the API (string, array, or null with tool_calls) */
function sanitizeMessages(msgs: Message[]): Message[] {
  return msgs.filter(m => {
    // Drop assistant messages with null/empty content and no tool_calls (invalid)
    if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) return false;
    return true;
  }).map(m => {
    // Ensure content is string or array — convert null to '' for non-tool-call messages
    if (m.content === null || m.content === undefined) {
      if (m.tool_calls?.length) return m; // null content OK with tool_calls
      return { ...m, content: '' };
    }
    // If content is a plain object (not array, not string), stringify it
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
      return { ...m, content: JSON.stringify(m.content) };
    }
    return m;
  });
}

export function buildRequestBody(options: RequestBodyOptions): Record<string, unknown> {
  const { model, systemPrompt, messages, tools, stream, currentTurn } = options;
  const resolved = currentTurn !== undefined ? resolveMessagesForAPI(messages, currentTurn) : messages;
  const sanitized = sanitizeMessages(resolved);
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...sanitized],
    tools,
    tool_choice: 'auto',
  };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  // Enable prompt caching for Anthropic models (top-level cache_control)
  if (model.startsWith('anthropic/') || model.includes('claude')) {
    body.cache_control = { type: 'ephemeral' };
  }

  return body;
}
