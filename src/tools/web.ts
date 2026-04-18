import { Tool } from '../core/types.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { promptInput } from '../core/utils.js';

// ── HTML stripping (native fallback when Jina is unavailable) ─────────────

function stripHtml(html: string): string {
  let text = html;

  // Remove script, style, nav, header, footer, aside blocks
  text = text.replace(/<(script|style|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Try to extract article or main content
  const article = text.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (article) text = article[2];

  // Convert headings to markdown-style
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _l, content) => `\n## ${content.trim()}\n`);

  // Convert links to text (url) format
  text = text.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, content) => {
    const label = content.replace(/<[^>]+>/g, '').trim();
    return href && !href.startsWith('#') ? `${label} (${href})` : label;
  });

  // Convert block elements to newlines
  text = text.replace(/<\/?(p|div|li|tr|br)\b[^>]*\/?>/gi, '\n');

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

// ── Action handlers ───────────────────────────────────────────────────────

function isBlockedHost(hostname: string): boolean {
  // Block localhost variants (strip IPv6 brackets)
  const h = hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  // Block cloud metadata endpoints
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return true;
  // Block private IPv4 ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  // Block link-local
  if (/^169\.254\./.test(hostname)) return true;
  return false;
}

async function doFetch(url: string, raw?: boolean): Promise<string> {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'Error: URL must use http:// or https://';
    }
    if (isBlockedHost(parsed.hostname)) {
      return `Error: access to ${parsed.hostname} is blocked (private/internal address).`;
    }
  } catch {
    return 'Error: Invalid URL.';
  }

  const fetchOpts = { signal: AbortSignal.timeout(15_000) };

  // Try Jina Reader first (returns clean markdown, handles JS-rendered pages)
  if (!raw) {
    try {
      const res = await fetch(`https://r.jina.ai/${url}`, {
        ...fetchOpts,
        headers: { 'Accept': 'text/markdown' }
      });
      if (res.ok) {
        const text = await res.text();
        if (text.trim()) return text;
      }
    } catch {
      // Fall through to native fetch
    }
  }

  // Native fetch fallback
  try {
    const res = await fetch(url, fetchOpts);
    if (!res.ok) return `Fetch error: HTTP ${res.status}`;

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const json = await res.json();
      return JSON.stringify(json, null, 2);
    }

    const text = await res.text();

    if (contentType.includes('text/html')) {
      return stripHtml(text);
    }

    return text;
  } catch (error: unknown) {
    return `Fetch failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function ensureTavilyKey(): Promise<string | null> {
  const existing = process.env.TAVILY_API_KEY || loadConfig().tavilyApiKey;
  if (existing) return existing;

  // Interactive prompt if TTY
  if (process.stdin.isTTY) {
    const C = await import('../core/colors.js').then(m => m.C);
    console.error(`\n${C.bold}Web search requires a Tavily API key${C.reset}`);
    console.error(`Sign up free (no credit card): ${C.cyan}https://app.tavily.com${C.reset}\n`);
    const key = await promptInput(`${C.yellow}Enter your Tavily API key:${C.reset} `);
    const trimmed = key.trim();
    if (!trimmed) return null;
    saveConfig({ tavilyApiKey: trimmed });
    console.error(`${C.green}Key saved to config.${C.reset}\n`);
    return trimmed;
  }

  return null;
}

async function doSearch(query: string): Promise<string> {
  const key = await ensureTavilyKey();
  if (!key) {
    return 'Error: Tavily API key not configured. Sign up free at https://tavily.com (no credit card needed), then set TAVILY_API_KEY env var or run /config set tavilyApiKey <key>';
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ api_key: key, query, max_results: 5 })
    });

    if (!res.ok) return `Search error: HTTP ${res.status}`;

    const data = await res.json() as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    if (!data.results?.length) return 'No results found.';

    return data.results.map((r, i) =>
      `${i + 1}. ${r.title || '(untitled)'}\n   ${r.url || ''}\n   ${r.content || ''}`
    ).join('\n\n');
  } catch (error: unknown) {
    return `Search failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── Exported tool ─────────────────────────────────────────────────────────

export function webTool(): Tool {
  return {
    type: 'function',
    function: {
      name: 'web',
      description: 'Web operations. Actions: fetch (retrieve readable content from a URL), search (search the web for current information via Tavily).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['fetch', 'search'], description: 'The web operation to perform.' },
          url: { type: 'string', description: 'URL to fetch (for action=fetch).' },
          query: { type: 'string', description: 'Search query (for action=search).' },
          raw: { type: 'boolean', description: 'If true, use native fetch + HTML stripping instead of Jina Reader (for action=fetch). Default: false.' }
        },
        required: ['action']
      }
    },
    execute: async ({ action, url, query, raw }: {
      action: string; url?: string; query?: string; raw?: boolean;
    }): Promise<string> => {
      switch (action) {
        case 'fetch': {
          if (!url) return 'Error: url is required for action=fetch.';
          return doFetch(url, raw);
        }
        case 'search': {
          if (!query) return 'Error: query is required for action=search.';
          return doSearch(query);
        }
        default: return `Unknown action "${action}". Use: fetch, search.`;
      }
    }
  };
}
