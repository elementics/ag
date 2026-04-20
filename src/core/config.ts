import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { AG_DIR } from './constants.js';
const CONFIG_PATH = join(AG_DIR, 'config.json');

export interface PersistentConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  systemPrompt?: string;
  maxIterations?: number;
  tavilyApiKey?: string;
  autoApprove?: boolean;
  contextLength?: number;
}

export const CONFIG_KEYS: readonly (keyof PersistentConfig)[] = [
  'apiKey', 'model', 'baseURL', 'systemPrompt', 'maxIterations',
  'tavilyApiKey', 'autoApprove', 'contextLength',
];

export const CONFIG_KEY_ALIASES: Readonly<Record<string, keyof PersistentConfig>> = {
  'tavily_api_key': 'tavilyApiKey',
  'openrouter_api_key': 'apiKey',
  'api_key': 'apiKey',
  'auto_approve': 'autoApprove',
  'autoapprove': 'autoApprove',
};

export function configPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): PersistentConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveConfig(partial: Partial<PersistentConfig>): void {
  const existing = loadConfig();
  const merged = { ...existing, ...partial };
  for (const key of Object.keys(merged) as (keyof PersistentConfig)[]) {
    if (merged[key] === undefined || merged[key] === null) delete merged[key];
  }
  if (!existsSync(AG_DIR)) mkdirSync(AG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');
  chmodSync(CONFIG_PATH, 0o600);
}
