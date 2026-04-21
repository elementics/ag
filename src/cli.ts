#!/usr/bin/env node

import { Agent } from './core/agent.js';
import { REPL, createPermissionCallback } from './cli/repl.js';
import { parseArgs, showHelp } from './cli/parser.js';
import { loadUserTools } from './core/loader.js';
import { loadConfig, saveConfig, configPath } from './core/config.js';
import { PermissionManager } from './core/permissions.js';
import { C } from './core/colors.js';
import { promptInput } from './core/utils.js';
import { needsSetup, runSetupWizard } from './cli/setup.js';
import { cleanupBackgroundProcesses } from './tools/bash.js';
import { ingestContent, describeContent } from './core/content.js';
import type { ContentBlock } from './core/types.js';

async function ensureApiKey(cliKey?: string, baseURL?: string): Promise<string> {
  // 1. CLI flag
  if (cliKey) return cliKey;
  // 2. Environment variable
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  // 3. Config file
  const config = loadConfig();
  if (config.apiKey) return config.apiKey;
  // 4. Custom base URL (local models don't need a key)
  if (baseURL && baseURL !== 'https://openrouter.ai/api/v1') return '';
  // 5. Interactive prompt (TTY only)
  if (process.stdin.isTTY) {
    console.error(`\n${C.bold}Welcome to ag!${C.reset}\n`);
    console.error(`Get your API key at: ${C.cyan}https://openrouter.ai/keys${C.reset}\n`);
    const key = await promptInput(`${C.yellow}Enter your OpenRouter API key:${C.reset} `);
    const trimmed = key.trim();
    if (!trimmed) {
      throw new Error('No API key provided.');
    }
    saveConfig({ apiKey: trimmed });
    console.error(`${C.green}Key saved to ${configPath()}${C.reset}\n`);
    return trimmed;
  }
  // 5. Non-interactive failure
  throw new Error('No API key. Set OPENROUTER_API_KEY, pass -k, or run `ag` interactively to configure.');
}

async function main(): Promise<void> {
  const { positional, ...options } = parseArgs(process.argv.slice(2));

  if (options.help) { showHelp(); process.exit(0); }

  const { tools: extraTools, failures: toolFailures } = await loadUserTools(process.cwd());

  if (!options.key && needsSetup()) {
    await runSetupWizard();
  }

  const config = loadConfig();
  const resolvedBaseURL = options.baseURL || config.baseURL;
  const apiKey = await ensureApiKey(options.key, resolvedBaseURL);

  // One-shot mode (piped) auto-approves; REPL mode prompts unless --yes or config
  const autoApprove = options.yes || positional.length > 0 || config.autoApprove === true;
  const pm = autoApprove ? undefined : new PermissionManager(process.cwd());
  const confirmToolCall = pm ? createPermissionCallback(pm) : undefined;
  const interactionMode = positional.length > 0 ? 'auto' : (config.interactionMode ?? 'plan');

  const agent = new Agent({
    apiKey,
    model: options.model || config.model,
    baseURL: resolvedBaseURL,
    systemPrompt: options.system || config.systemPrompt,
    maxIterations: options.maxIterations || config.maxIterations,
    contextLength: config.contextLength,
    interactionMode,
    extraTools,
    toolFailures,
    confirmToolCall,
  });

  // Load extensions from .ag/extensions/ and ~/.ag/extensions/
  await agent.initExtensions();

  if (options.stats) {
    const stats = agent.getStats();
    const p = agent.getPaths();
    console.log('Memory');
    console.log('---');
    console.log(`Global memory:  ${stats.globalMemory ? 'yes' : 'none'}  (${p.globalMemory})`);
    console.log(`Project memory: ${stats.projectMemory ? 'yes' : 'none'}  (${p.projectMemory})`);
    console.log(`Plans:          ${stats.planCount}  (${p.plansDir}/)`);
    console.log(`Content:        ${stats.contentCount}  (${p.contentDir}/)`);
    console.log(`History:        ${stats.historyLines} interactions  (${p.history})`);
    console.log(`Config:         ${configPath()}`);
    process.exit(0);
  }

  if (positional.length > 0) {
    const text = positional.join(' ');
    let input: string | ContentBlock[] = text;

    if (options.contentPaths?.length) {
      const { resolve: resolvePath } = await import('node:path');
      const blocks: ContentBlock[] = [{ type: 'text', text }];
      for (const p of options.contentPaths) {
        try {
          const ref = ingestContent(resolvePath(p), process.cwd());
          blocks.push(ref);
          console.error(`${C.dim}Added [content #${ref.id}] — ${describeContent(ref)}${C.reset}`);
        } catch (e: unknown) {
          console.error(`${C.red}Error: ${e instanceof Error ? e.message : String(e)}${C.reset}`);
        }
      }
      if (blocks.length > 1) input = blocks;
    }

    const response = await agent.chat(input);
    console.log(response);
    process.exit(0);
  }

  const repl = new REPL(agent, pm, confirmToolCall ?? undefined);
  await repl.start();
}

// Double Ctrl+C to exit: first press is informational, second within 1s exits
let lastSigint = 0;
process.on('SIGINT', () => {
  const now = Date.now();
  if (now - lastSigint < 1000) {
    cleanupBackgroundProcesses();
    console.error('\nGoodbye!');
    process.exit(0);
  }
  lastSigint = now;
  console.error(`\n${C.dim}Press Ctrl+C again to exit${C.reset}`);
});
process.on('exit', () => cleanupBackgroundProcesses());
main().catch(e => { console.error(`Error: ${e.message}`); process.exit(1); });
