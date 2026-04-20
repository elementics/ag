import { readdirSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { CompletionEngine, CompletionCandidate } from './types.js';
import { CONFIG_KEYS, CONFIG_KEY_ALIASES } from '../../core/config.js';
import type { Agent } from '../../core/agent.js';

// ── Slash command definitions ──────────────────────────────────────────────

const SLASH_COMMANDS = [
  'help', 'model', 'memory', 'plan', 'checkpoint', 'rewind',
  'context', 'config', 'tools', 'skill', 'content', 'permissions',
  'perms', 'exit', 'quit',
];

const SUBCOMMANDS: Record<string, string[]> = {
  model: ['search'],
  memory: ['global', 'project', 'clear'],
  plan: ['list', 'use'],
  checkpoint: ['create'],
  context: ['compact'],
  config: ['set', 'unset'],
  skill: ['search', 'add', 'remove'],
  content: ['add', 'list', 'paste', 'screenshot', 'clear'],
  permissions: ['allow', 'deny', 'save', 'clear', 'remove'],
  perms: ['allow', 'deny', 'save', 'clear', 'remove'],
};

// ── Helpers ────────────────────────────────────────────────────────────────

function prefixMatch(candidates: string[], prefix: string): CompletionCandidate[] {
  const lower = prefix.toLowerCase();
  return candidates
    .filter(c => c.toLowerCase().startsWith(lower))
    .map(c => ({ text: c, display: c }));
}

function commonPrefix(items: string[]): string {
  if (items.length === 0) return '';
  let prefix = items[0];
  for (let i = 1; i < items.length; i++) {
    let j = 0;
    while (j < prefix.length && j < items[i].length && prefix[j] === items[i][j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix;
}

// ── File path completion ───────────────────────────────────────────────────

function completeFilePath(token: string): CompletionCandidate[] {
  let expanded = token;
  if (expanded.startsWith('~')) {
    expanded = join(homedir(), expanded.slice(1));
  }

  let dir: string;
  let partial: string;

  if (expanded.endsWith('/')) {
    dir = resolve(expanded);
    partial = '';
  } else {
    dir = resolve(dirname(expanded));
    partial = basename(expanded);
  }

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const matches = entries
      .filter(e => e.name.startsWith(partial) && !e.name.startsWith('.'))
      .slice(0, 50)
      .map(e => {
        const isDir = e.isDirectory();
        const name = e.name + (isDir ? '/' : '');
        // Build the completion text relative to the original token
        const prefix = token.endsWith('/') ? token : token.slice(0, token.lastIndexOf('/') + 1);
        return { text: prefix + name, display: name };
      });
    return matches;
  } catch {
    return [];
  }
}

// ── Engine ─────────────────────────────────────────────────────────────────

export function createCompletionEngine(agent: Agent): CompletionEngine {
  let modelCache: CompletionCandidate[] | null = null;
  let modelFetchPromise: Promise<void> | null = null;

  const allConfigKeys = [
    ...CONFIG_KEYS,
    ...Object.keys(CONFIG_KEY_ALIASES),
  ];

  function complete(textBeforeCursor: string): CompletionCandidate[] {
    // 1. Slash commands: /partial at start of input
    const slashMatch = textBeforeCursor.match(/^\/(\w*)$/);
    if (slashMatch) {
      return prefixMatch(SLASH_COMMANDS, slashMatch[1]).map(c => ({
        text: '/' + c.text,
        display: '/' + c.display,
      }));
    }

    // 2. Subcommands: /command partial
    const subMatch = textBeforeCursor.match(/^\/(\w+)\s+(\w*)$/);
    if (subMatch) {
      const cmd = subMatch[1].toLowerCase();
      const partial = subMatch[2];
      const subs = SUBCOMMANDS[cmd];
      if (subs) {
        const matches = prefixMatch(subs, partial);
        if (matches.length > 0) return matches;
        // Fall through to model/other providers if no subcommand matches
      }
    }

    // 3. Config keys: /config set|unset partial
    const configMatch = textBeforeCursor.match(/^\/config\s+(set|unset)\s+(\w*)$/i);
    if (configMatch) {
      return prefixMatch(allConfigKeys, configMatch[2]);
    }

    // 4. Model names: /model <not-search> partial
    const modelMatch = textBeforeCursor.match(/^\/model\s+(?!search\b)(\S*)$/i);
    if (modelMatch) {
      // Trigger background fetch if cache is empty
      if (!modelCache && !modelFetchPromise) {
        const p = agent.fetchModels().then(models => {
          modelCache = models.map(m => ({ text: m.id, display: m.id }));
        }).catch(() => {
          // Fetch failed — will retry on next tab
        }).finally(() => {
          modelFetchPromise = null;
        });
        modelFetchPromise = p;
      }
      if (modelCache) {
        const partial = modelMatch[1].toLowerCase();
        return modelCache.filter(c => c.text.toLowerCase().includes(partial));
      }
      return []; // cache not ready yet
    }

    // 5. File paths: when token looks path-like
    const tokenMatch = textBeforeCursor.match(/(\S+)$/);
    if (tokenMatch) {
      const token = tokenMatch[1];
      if (token.includes('/') || token.includes('.') || token.startsWith('~') || token.startsWith('"') || token.startsWith("'")) {
        const cleanToken = token.replace(/^["']/, '');
        if (cleanToken.includes('/') || cleanToken.startsWith('~') || cleanToken.startsWith('.')) {
          return completeFilePath(cleanToken);
        }
      }
    }

    return [];
  }

  return {
    complete,
    invalidateModelCache() {
      modelCache = null;
      modelFetchPromise = null;
    },
    /** Await the in-flight model fetch (for tests). */
    _waitForModelFetch(): Promise<void> {
      return modelFetchPromise ?? Promise.resolve();
    },
  };
}

export { commonPrefix };
