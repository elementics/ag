/**
 * First-run setup wizard — provider selection, API key, optional Tavily.
 */

import { loadConfig, saveConfig, configPath } from '../core/config.js';
import { C } from '../core/colors.js';
import { promptInput } from '../core/utils.js';

// ── Provider definitions ───────────────────────────────────────────────────

interface Provider {
  name: string;
  desc: string;
  baseURL?: string;        // undefined = prompt user
  requiresKey: boolean;
  defaultModel?: string;   // undefined = prompt user
  keyURL?: string;         // sign-up link shown during setup
}

const PROVIDERS: Provider[] = [
  {
    name: 'OpenRouter',
    desc: 'cloud — needs API key',
    baseURL: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    defaultModel: 'anthropic/claude-sonnet-4.6',
    keyURL: 'https://openrouter.ai/keys',
  },
  {
    name: 'Local provider',
    desc: 'Ollama, LM Studio, etc.',
    requiresKey: false,
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

const SEP = `  ${C.dim}${'─'.repeat(31)}${C.reset}`;
const CLEAR = process.stderr.isTTY ? '\x1b[2J\x1b[H' : '';

function step(n: number, total: number, label: string): void {
  process.stderr.write(CLEAR);
  process.stderr.write(`\n  ${C.bold}Welcome to ag!${C.reset}\n`);
  process.stderr.write(`\n  ${C.bold}${C.cyan}Step ${n}/${total}${C.reset} ${C.dim}·${C.reset} ${C.bold}${label}${C.reset}\n`);
  process.stderr.write(SEP + '\n\n');
}

async function askRequired(prompt: string): Promise<string> {
  let value = '';
  while (!value) {
    value = (await promptInput(prompt)).trim();
  }
  return value;
}

async function askChoice(prompt: string, max: number): Promise<number> {
  while (true) {
    const raw = (await promptInput(prompt)).trim();
    const n = parseInt(raw, 10);
    if (n >= 1 && n <= max) return n;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function needsSetup(): boolean {
  if (!process.stdin.isTTY) return false;
  if (process.env.OPENROUTER_API_KEY) return false;
  const config = loadConfig();
  return !config.apiKey && !config.baseURL;
}

export async function runSetupWizard(): Promise<void> {
  const totalSteps = 3;

  // ── Step 1: Provider ──

  step(1, totalSteps, 'Provider');

  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i];
    const num = `${i + 1}`;
    const pad = ' '.repeat(16 - p.name.length);
    process.stderr.write(`    ${C.cyan}${num}${C.reset}  ${p.name}${pad}${C.dim}${p.desc}${C.reset}\n`);
  }
  process.stderr.write('\n');

  const choice = await askChoice(`  ${C.yellow}>${C.reset} `, PROVIDERS.length);
  const provider = PROVIDERS[choice - 1];

  // ── Step 2: Connection ──

  if (provider.requiresKey) {
    step(2, totalSteps, 'API Key');

    if (provider.keyURL) {
      process.stderr.write(`  Get yours at: ${C.cyan}${provider.keyURL}${C.reset}\n\n`);
    }

    const key = await askRequired(`  API key: `);
    saveConfig({ apiKey: key });

    if (provider.defaultModel) {
      process.stderr.write(`\n  ${C.green}✓${C.reset} Using ${C.dim}${provider.defaultModel}${C.reset}\n`);
    }
    if (provider.baseURL) {
      saveConfig({ baseURL: provider.baseURL });
    }
  } else {
    step(2, totalSteps, 'Connection');

    const baseURL = await askRequired(`  Base URL ${C.dim}(e.g. http://localhost:11434/v1)${C.reset}: `);
    const model = await askRequired(`  Model name ${C.dim}(e.g. llama3.2, deepseek-coder)${C.reset}: `);
    saveConfig({ baseURL, model });
  }

  // ── Step 3: Tavily (optional) ──

  step(3, totalSteps, 'Web Search (optional)');

  process.stderr.write(`  Tavily is free (no credit card): ${C.cyan}https://app.tavily.com${C.reset}\n\n`);

  const tavilyKey = (await promptInput(`  Tavily key ${C.dim}(Enter to skip)${C.reset}: `)).trim();
  if (tavilyKey) {
    saveConfig({ tavilyApiKey: tavilyKey });
  }

  // ── Done ──

  process.stderr.write(CLEAR);
  process.stderr.write(`\n  ${C.bold}Welcome to ag!${C.reset}\n`);
  process.stderr.write(`\n  ${C.green}✓${C.reset} All set! Config saved to ${C.dim}${configPath()}${C.reset}\n\n`);
}
