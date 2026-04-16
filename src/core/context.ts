import { Usage } from './types.js';
import { C } from './colors.js';

const KNOWN_CONTEXT: Record<string, number> = {
  'anthropic/claude-sonnet-4.6': 200000,
  'anthropic/claude-sonnet-4': 200000,
  'anthropic/claude-opus-4': 200000,
  'anthropic/claude-haiku-3.5': 200000,
  'openai/gpt-4o': 128000,
  'openai/gpt-4o-mini': 128000,
  'openai/gpt-4-turbo': 128000,
  'google/gemini-2.0-flash': 1048576,
  'google/gemini-pro-1.5': 2097152,
  'meta-llama/llama-3.1-70b-instruct': 131072,
  'deepseek/deepseek-chat': 65536,
};

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1000000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}

export class ContextTracker {
  private contextLength: number | null;
  private lastUsage: Usage | null = null;
  private estimated = false;
  private estimatedTokens = 0;

  constructor(modelId: string) {
    // Try exact match, then prefix match for variants like model:beta
    this.contextLength = KNOWN_CONTEXT[modelId]
      ?? Object.entries(KNOWN_CONTEXT).find(([k]) => modelId.startsWith(k))?.[1]
      ?? null;
  }

  setContextLength(n: number): void { this.contextLength = n; }
  getContextLength(): number | null { return this.contextLength; }

  update(usage: Usage): void {
    this.lastUsage = usage;
    this.estimated = false;
  }

  estimateFromChars(chars: number): void {
    this.estimatedTokens = Math.ceil(chars / 4);
    this.estimated = true;
  }

  reset(): void {
    this.lastUsage = null;
    this.estimated = false;
    this.estimatedTokens = 0;
  }

  shouldCompact(threshold = 0.9): boolean {
    if (!this.contextLength) return false;
    const used = this.estimated ? this.estimatedTokens
      : this.lastUsage?.prompt_tokens ?? null;
    if (used === null) return false;
    return used / this.contextLength >= threshold;
  }

  getUsedTokens(): number | null {
    return this.lastUsage?.prompt_tokens ?? null;
  }

  format(): string {
    const max = this.contextLength;
    if (!max) return '';

    const used = this.lastUsage?.prompt_tokens ?? (this.estimated ? this.estimatedTokens : null);
    if (used === null) return '';

    const pct = Math.round((used / max) * 100);
    const color = pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.green;
    const prefix = this.estimated ? '~' : '';
    const BAR_WIDTH = 20;
    const filled = Math.round((pct / 100) * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);

    let line = `${C.dim}Context${C.reset} ${color}${bar}${C.reset} ${color}${pct}%${C.reset} ${C.dim}${prefix}${formatTokens(used)}/${formatTokens(max)}${C.reset}`;
    const cached = this.lastUsage?.prompt_tokens_details?.cached_tokens;
    if (cached && cached > 0) {
      const hitPct = cached === used ? 100 : Math.min(99, Math.floor((cached / used) * 100));
      const uncached = used - cached;
      let cacheInfo = `${formatTokens(cached)} cached ${hitPct}%`;
      if (hitPct >= 95 && uncached > 0) {
        cacheInfo += ` +${formatTokens(uncached)} new`;
      }
      line += ` ${C.green}(${cacheInfo})${C.reset}`;
    }
    return line;
  }

  formatDetailed(): string {
    const max = this.contextLength;
    const parts: string[] = [];

    if (this.lastUsage) {
      parts.push(`  Prompt:     ${C.cyan}${formatTokens(this.lastUsage.prompt_tokens)}${C.reset} tokens`);
      parts.push(`  Completion: ${C.cyan}${formatTokens(this.lastUsage.completion_tokens)}${C.reset} tokens`);
      parts.push(`  Total:      ${C.cyan}${formatTokens(this.lastUsage.total_tokens)}${C.reset} tokens`);
      const cached = this.lastUsage.prompt_tokens_details?.cached_tokens;
      const written = this.lastUsage.prompt_tokens_details?.cache_write_tokens;
      if (cached && cached > 0) {
        const total = this.lastUsage.prompt_tokens;
        const hitPct = cached === total ? 100 : Math.min(99, Math.floor((cached / total) * 100));
        const uncached = total - cached;
        const uncachedSuffix = uncached > 0 ? `, ${formatTokens(uncached)} uncached` : '';
        parts.push(`  Cached:     ${C.green}${formatTokens(cached)}${C.reset} tokens ${C.dim}(${hitPct}% hit rate${uncachedSuffix})${C.reset}`);
      }
      if (written && written > 0) {
        parts.push(`  Cache write: ${C.yellow}${formatTokens(written)}${C.reset} tokens`);
      }
    } else if (this.estimated) {
      parts.push(`  Estimated:  ${C.dim}~${formatTokens(this.estimatedTokens)} tokens${C.reset}`);
    } else {
      parts.push(`  ${C.dim}No usage data yet. Send a message first.${C.reset}`);
    }

    if (max) {
      const used = this.lastUsage?.prompt_tokens ?? this.estimatedTokens;
      const pct = Math.round((used / max) * 100);
      const color = pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.green;
      parts.push(`  Window:     ${color}${formatTokens(used)}/${formatTokens(max)} (${pct}%)${C.reset}`);
    } else {
      parts.push(`  Window:     ${C.dim}unknown (model context length not resolved)${C.reset}`);
    }

    return parts.join('\n');
  }
}
