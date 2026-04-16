import { createInterface, Interface, emitKeypressEvents } from 'node:readline';
import { Agent } from '../core/agent.js';
import { loadConfig, saveConfig, configPath, PersistentConfig } from '../core/config.js';
import { searchRegistry, installSkill, removeSkill, formatInstalls } from '../core/registry.js';
import { C, renderMarkdown } from '../core/colors.js';
import { VERSION } from '../core/version.js';
import { PermissionManager, inferPattern } from '../core/permissions.js';
import type { ConfirmToolCall, PermissionKey, ContentBlock, ContentRef } from '../core/types.js';
import { ingestContent, describeContent, displayContent, getAllContentRefs, resetContentStore } from '../core/content.js';

function truncateCommand(command: string, maxLen = 80): string {
  const firstLine = command.split('\n')[0];
  if (firstLine.length <= maxLen) {
    return command.split('\n').length > 1 ? firstLine + ' ...' : firstLine;
  }
  return firstLine.slice(0, maxLen) + '...';
}

function formatToolSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'bash': return `bash: ${truncateCommand(String(args.command || '(empty)'))}`;
    case 'file': return `file(${args.action}): ${args.path || ''}`;
    case 'git': return `git(${args.action})${args.message ? `: "${args.message}"` : ''}`;
    case 'web': return `web(${args.action}): ${args.url || args.query || ''}`;
    default: return `${toolName}(${JSON.stringify(args).slice(0, 80)})`;
  }
}

function promptQuestion(prompt: string, sharedRl?: Interface): Promise<string> {
  if (sharedRl) {
    // Shared readline already manages terminal — no raw mode changes needed
    return new Promise<string>(resolve => sharedRl.question(prompt, resolve));
  }
  // Fallback: create a temporary readline; exit raw mode so it can work properly
  const wasRaw = process.stdin.isTTY && (process.stdin as any).isRaw;
  if (wasRaw) process.stdin.setRawMode(false);
  return new Promise<string>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, a => { rl.close(); resolve(a); });
  }).finally(() => { if (wasRaw) process.stdin.setRawMode(true); });
}

const SIMPLE_OPTS = `    ${C.cyan}y${C.reset}/${C.cyan}n${C.reset} > `;
const FULL_OPTS = `    ${C.cyan}y${C.reset}/${C.cyan}n${C.reset}  ${C.dim}a${C.reset}=${C.dim}always  ${C.dim}p${C.reset}=${C.dim}project  ${C.dim}d${C.reset}=${C.dim}deny session  ${C.dim}D${C.reset}=${C.dim}deny project${C.reset} > `;

export function createConfirmCallback(sharedRl?: Interface): ConfirmToolCall & { pauseSpinner: (() => void) | null } {
  const cb = async (toolName: string, args: Record<string, unknown>): Promise<'allow' | 'deny'> => {
    // Stop any active spinner before prompting — clear line to avoid garbled output
    if (cb.pauseSpinner) { cb.pauseSpinner(); cb.pauseSpinner = null; }
    process.stderr.write('\x1b[K'); // ensure current line is clear
    const summary = formatToolSummary(toolName, args);
    process.stderr.write(`  ${C.yellow}?${C.reset} ${C.dim}${summary}${C.reset}\n`);
    const answer = await promptQuestion(SIMPLE_OPTS, sharedRl);
    if (answer.trim().toLowerCase() === 'n') {
      process.stderr.write(`  ${C.red}−${C.reset} ${C.dim}Denied${C.reset}\n`);
      return 'deny';
    }
    return 'allow';
  };
  cb.pauseSpinner = null as (() => void) | null;
  return cb;
}

export function createPermissionCallback(pm: PermissionManager, sharedRl?: Interface): ConfirmToolCall & { pauseSpinner: (() => void) | null } {
  const cb = async (toolName: string, args: Record<string, unknown>, permissionKey?: PermissionKey): Promise<'allow' | 'deny'> => {
    // Check permission rules first
    const decision = pm.check(toolName, args, permissionKey);
    if (decision === 'allow') return 'allow';
    if (decision === 'deny') return 'deny';

    // Stop any active spinner before prompting — clear line to avoid garbled output
    if (cb.pauseSpinner) { cb.pauseSpinner(); cb.pauseSpinner = null; }
    process.stderr.write('\x1b[K'); // ensure current line is clear
    const summary = formatToolSummary(toolName, args);
    const pattern = inferPattern(toolName, args, permissionKey);

    process.stderr.write(`  ${C.yellow}?${C.reset} ${C.dim}${summary}${C.reset}\n`);
    const answer = await promptQuestion(FULL_OPTS, sharedRl);

    // Check for uppercase D before lowercasing
    const raw = answer.trim();
    if (raw === 'D') {
      pm.addRule({ pattern, effect: 'deny' }, 'project');
      pm.save('project');
      process.stderr.write(`  ${C.red}−${C.reset} ${C.dim}Saved deny to .ag/permissions.json: ${pattern}${C.reset}\n`);
      return 'deny';
    }

    const choice = raw.toLowerCase();
    switch (choice) {
      case 'a':
        pm.addRule({ pattern, effect: 'allow' }, 'session');
        process.stderr.write(`  ${C.green}+${C.reset} ${C.dim}Session rule: ${pattern}${C.reset}\n`);
        return 'allow';
      case 'p':
        pm.addRule({ pattern, effect: 'allow' }, 'project');
        pm.save('project');
        process.stderr.write(`  ${C.green}+${C.reset} ${C.dim}Saved to .ag/permissions.json: ${pattern}${C.reset}\n`);
        return 'allow';
      case 'n':
        process.stderr.write(`  ${C.red}−${C.reset} ${C.dim}Denied: ${pattern}${C.reset}\n`);
        return 'deny';
      case 'd':
        pm.addRule({ pattern, effect: 'deny' }, 'session');
        process.stderr.write(`  ${C.red}−${C.reset} ${C.dim}Session deny: ${pattern}${C.reset}\n`);
        return 'deny';
      default: // 'y' or anything else = allow once
        return 'allow';
    }
  };
  cb.pauseSpinner = null as (() => void) | null;
  return cb;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(label: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  let i = 0;
  process.stderr.write(`  ${C.dim}${SPINNER_FRAMES[0]} ${label}${C.reset}\n`);
  const id = setInterval(() => {
    process.stderr.write(`\x1b[A\x1b[K  ${C.dim}${SPINNER_FRAMES[i++ % SPINNER_FRAMES.length]} ${label}${C.reset}\n`);
  }, 80);
  return () => { clearInterval(id); process.stderr.write('\x1b[A\x1b[K'); };
}

// ── Context breakdown bar ────────────────────────────────────────────────────

// ANSI 256-color codes for distinct, readable segment colors
const SEGMENT_COLORS = [
  '\x1b[38;5;75m',   // blue
  '\x1b[38;5;114m',  // green
  '\x1b[38;5;179m',  // gold
  '\x1b[38;5;204m',  // pink
  '\x1b[38;5;141m',  // purple
  '\x1b[38;5;80m',   // teal
  '\x1b[38;5;215m',  // orange
  '\x1b[38;5;109m',  // steel
  '\x1b[38;5;168m',  // magenta
  '\x1b[38;5;150m',  // lime
];

function renderContextBreakdown(
  parts: Array<{ label: string; chars: number }>,
  contextLength: number | null,
  actualPromptTokens: number | null,
): string {
  const nc = 'NO_COLOR' in process.env || !process.stderr.isTTY;
  const R = nc ? '' : '\x1b[0m';
  const DIM = nc ? '' : '\x1b[2m';

  const totalChars = parts.reduce((sum, p) => sum + p.chars, 0);
  if (totalChars === 0) return `${DIM}No context data yet.${R}`;

  // Use actual tokens when available; fall back to char estimate
  const hasActual = actualPromptTokens !== null && actualPromptTokens > 0;
  const totalTokens = hasActual ? actualPromptTokens : Math.ceil(totalChars / 4);
  const prefix = hasActual ? '' : '~';
  const BAR_WIDTH = 50;

  const lines: string[] = [];

  // ── Compute segments: proportional share of chars → scaled to total tokens ──
  const segments: Array<{ label: string; tokens: number; pct: number; color: string; blockCount: number }> = [];
  let assignedBlocks = 0;

  for (let i = 0; i < parts.length; i++) {
    const pct = (parts[i].chars / totalChars) * 100;
    const tokens = Math.round((parts[i].chars / totalChars) * totalTokens);
    const blocks = Math.max(pct >= 1 ? 1 : 0, Math.round((parts[i].chars / totalChars) * BAR_WIDTH));
    const color = nc ? '' : SEGMENT_COLORS[i % SEGMENT_COLORS.length];
    segments.push({ label: parts[i].label, tokens, pct, color, blockCount: blocks });
    assignedBlocks += blocks;
  }

  // Adjust to fit BAR_WIDTH exactly
  if (assignedBlocks > BAR_WIDTH && segments.length > 0) {
    const largest = segments.reduce((a, b) => a.blockCount > b.blockCount ? a : b);
    largest.blockCount -= (assignedBlocks - BAR_WIDTH);
  } else if (assignedBlocks < BAR_WIDTH && segments.length > 0) {
    const largest = segments.reduce((a, b) => a.blockCount > b.blockCount ? a : b);
    largest.blockCount += (BAR_WIDTH - assignedBlocks);
  }

  // ── Segmented bar ──
  let bar = '';
  for (const seg of segments) {
    bar += `${seg.color}${'█'.repeat(Math.max(0, seg.blockCount))}${R}`;
  }

  if (contextLength) {
    const usedPct = Math.round((totalTokens / contextLength) * 100);
    const usedBlocks = segments.reduce((s, seg) => s + seg.blockCount, 0);
    const freeBlocks = BAR_WIDTH - usedBlocks;
    if (freeBlocks > 0) bar += `${DIM}${'░'.repeat(freeBlocks)}${R}`;
    lines.push(`  ${bar}  ${DIM}${prefix}${formatTokensShort(totalTokens)}/${formatTokensShort(contextLength)} (${usedPct}%)${R}`);
  } else {
    lines.push(`  ${bar}  ${DIM}${prefix}${formatTokensShort(totalTokens)} tokens${R}`);
  }

  // ── Legend ──
  lines.push('');
  for (const seg of segments) {
    const pctStr = seg.pct < 1 ? '<1' : Math.round(seg.pct).toString();
    lines.push(`  ${seg.color}█${R} ${seg.label.padEnd(18)} ${DIM}${pctStr.padStart(3)}%  ${prefix}${formatTokensShort(seg.tokens)}${R}`);
  }

  return lines.join('\n');
}

function formatTokensShort(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1000000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 8) + '****';
}

export class REPL {
  private readonly agent: Agent;
  private readonly rl: Interface;
  private readonly pm: PermissionManager | null;
  private confirmCb: ReturnType<typeof createPermissionCallback> | null;
  private pendingContentRefs: ContentRef[] = [];

  constructor(agent: Agent, pm?: PermissionManager, confirmCb?: ReturnType<typeof createPermissionCallback>) {
    this.agent = agent;
    this.pm = pm ?? null;
    this.rl = createInterface({ input: process.stdin, output: process.stderr });
    // Rebind the confirm callback to use the shared readline
    if (confirmCb && pm) {
      const shared = createPermissionCallback(pm, this.rl);
      shared.pauseSpinner = confirmCb.pauseSpinner;
      this.confirmCb = shared;
      this.agent.setConfirmToolCall(shared);
    } else if (confirmCb) {
      // Fallback: no permission manager, use basic confirm
      const shared = createConfirmCallback(this.rl);
      shared.pauseSpinner = confirmCb.pauseSpinner;
      this.confirmCb = shared;
      this.agent.setConfirmToolCall(shared);
    } else {
      this.confirmCb = null;
    }
  }

  async start(): Promise<void> {
    const stats = this.agent.getStats();
    const skills = this.agent.getSkills();
    console.error('');
    console.error(`${C.bold}ag v${VERSION}${C.reset} ${C.dim}(${this.agent.getModel()} via OpenRouter)${C.reset}`);
    const customTools = this.agent.getTools().filter(t => !t.isBuiltin);
    const extensions = this.agent.getLoadedExtensions();
    const loaded = [
      stats.globalMemory && 'global',
      stats.projectMemory && 'project',
      stats.planCount > 0 && `${stats.planCount} plan(s)`,
      skills.length > 0 && `${skills.length} skill(s)`,
      customTools.length > 0 && `${customTools.length} tool(s)`,
      extensions.length > 0 && `${extensions.length} extension(s)`,
    ].filter(Boolean);
    if (loaded.length > 0) {
      console.error(`${C.dim}Loaded: ${loaded.join(', ')}${C.reset}`);
    }
    for (const t of customTools) {
      const desc = t.description.slice(0, 60) + (t.description.length > 60 ? '...' : '');
      console.error(`  ${C.green}+${C.reset} ${C.cyan}${t.name}${C.reset}  ${C.dim}[tool] ${desc}${C.reset}`);
    }
    for (const ext of extensions) {
      const desc = ext.description ? ` ${ext.description.slice(0, 60)}${ext.description.length > 60 ? '...' : ''}` : '';
      console.error(`  ${C.green}+${C.reset} ${C.cyan}${ext.name}${C.reset}  ${C.dim}[extension]${desc}${C.reset}`);
    }
    for (const f of this.agent.getToolFailures()) {
      const label = f.name ?? f.file;
      const reason = f.reason.split('\n')[0].slice(0, 60) + (f.reason.length > 60 ? '...' : '');
      console.error(`  ${C.red}−${C.reset} ${C.cyan}${label}${C.reset}  ${C.red}${reason}${C.reset}`);
    }
    const activePlan = this.agent.getActivePlanName();
    if (activePlan) {
      const label = activePlan.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+-?/, '').replace(/-/g, ' ').trim() || activePlan;
      console.error(`${C.dim}Plan: ${label}${C.reset}`);
    }
    if (stats.historyLines > 0) {
      console.error(`${C.dim}History: ${stats.historyLines} messages${C.reset}`);
    }
    // Resolve context window size
    const tracker = this.agent.getContextTracker();
    if (!tracker.getContextLength()) {
      try {
        const models = await this.agent.fetchModels(this.agent.getModel());
        const exact = models.find(m => m.id === this.agent.getModel());
        const match = exact ?? models[0];
        if (match?.context_length) tracker.setContextLength(match.context_length);
      } catch { /* proceed without — fallback handled by tracker */ }
    }
    tracker.estimateFromChars(this.agent.getTotalContextChars());
    const ctxLine = this.agent.getContextUsage();

    console.error(`${C.dim}Commands: /help${C.reset}`);
    if (ctxLine) console.error(ctxLine);
    console.error('');

    // Enable keypress events on stdin for interrupt detection
    if (process.stdin.isTTY) emitKeypressEvents(process.stdin);

    while (true) {
      try {
        const input = await this.ask(`${C.green}you>${C.reset} `);
        if (!input.trim()) continue;
        if (input.startsWith('/')) { await this.handleCommand(input); continue; }
        let hitMaxIterations = false;
        let interrupted = false;

        const runAgent = async (message: string | ContentBlock[]) => {
          const controller = new AbortController();
          let activeSpinnerStop: (() => void) | null = null;

          // ── Steer state ──
          let steerActive = false;
          let steerResolve: (() => void) | null = null;
          const chunkBuffer: import('../core/types.js').StreamChunk[] = [];

          // ── Keypress handler: Escape to abort, Tab to steer ──
          const onKeypress = (_ch: string | undefined, key?: { name: string; sequence: string; ctrl?: boolean; meta?: boolean }) => {
            if (key?.name === 'escape') {
              // 1. Clear whatever spinner is showing
              if (activeSpinnerStop) { activeSpinnerStop(); activeSpinnerStop = null; }
              // 2. Show "interrupting..." spinner immediately (sync)
              activeSpinnerStop = startSpinner(`${C.yellow}interrupting...${C.reset}`);
              // 3. Signal abort (async propagation begins)
              controller.abort();
            } else if (key?.name === 'tab' && !steerActive) {
              // Tab opens steer prompt — pause spinner, buffer output until resolved
              steerActive = true;
              clearSpinner();
              process.stdin.removeListener('keypress', onKeypress);
              this.rl.resume();
              this.rl.question(`  ${C.yellow}steer>${C.reset} `, (answer: string) => {
                this.rl.pause();
                if (answer.trim()) {
                  this.agent.queueSteer(answer.trim());
                }
                // Clear the steer prompt line, show acknowledgement
                process.stderr.write('\x1b[A\x1b[2K');
                if (answer.trim()) {
                  process.stderr.write(`  ${C.yellow}[steered]${C.reset} ${C.dim}${answer.trim()}${C.reset}\n`);
                }
                // Flush buffered chunks
                for (const buffered of chunkBuffer) {
                  renderChunk(buffered);
                }
                chunkBuffer.length = 0;
                steerActive = false;
                process.stdin.on('keypress', onKeypress);
                process.stdin.resume();
                // Unblock any waiting permission prompts
                if (steerResolve) { steerResolve(); steerResolve = null; }
              });
            }
          };

          if (process.stdin.isTTY) {
            this.rl.pause();  // Detach readline so only our keypress handler runs
            process.stdin.on('keypress', onKeypress);
            process.stdin.resume();
          }

          let hasText = false;
          let hadTools = false;
          let lineBuf = '';

          const setSpinner = (fn: (() => void) | null) => {
            activeSpinnerStop = fn;
            if (this.confirmCb) this.confirmCb.pauseSpinner = fn;
          };
          const clearSpinner = () => {
            if (activeSpinnerStop) { activeSpinnerStop(); setSpinner(null); }
          };

          // Register spinner control so extensions can safely write output
          this.agent.setSpinnerControl({
            pause: () => {
              clearSpinner();
              if (hasText) { flushLines(true); process.stderr.write('\n'); hasText = false; }
            },
            resume: () => {},
          });

          // Wrap permissions to wait for steer to finish
          if (this.confirmCb) {
            const originalCb = this.agent.getConfirmToolCall();
            if (originalCb) {
              this.agent.setConfirmToolCall(async (toolName, args, pk) => {
                // Wait for active steer to resolve before prompting
                while (steerActive) {
                  await new Promise<void>(r => { steerResolve = r; });
                }
                return originalCb(toolName, args, pk);
              });
            }
          }

          const flushLines = (final: boolean) => {
            const parts = lineBuf.split('\n');
            lineBuf = final ? '' : (parts.pop() || '');
            for (let i = 0; i < parts.length; i++) {
              process.stderr.write(renderMarkdown(parts[i]) + '\n');
            }
            if (final && lineBuf) {
              process.stderr.write(renderMarkdown(lineBuf));
              lineBuf = '';
            }
          };

          const renderChunk = (chunk: import('../core/types.js').StreamChunk) => {
            switch (chunk.type) {
              case 'thinking':
                clearSpinner();
                if (hasText) { flushLines(true); process.stderr.write('\n'); hasText = false; }
                setSpinner(startSpinner(chunk.content || 'thinking'));
                break;
              case 'text':
                clearSpinner();
                if (!hasText) {
                  if (hadTools) process.stderr.write('\n');
                  process.stderr.write(`${C.bold}agent>${C.reset} `);
                  hasText = true;
                }
                lineBuf += (chunk.content || '');
                if (lineBuf.includes('\n')) flushLines(false);
                break;
              case 'tool_start': {
                clearSpinner();
                if (hasText) { flushLines(true); process.stderr.write('\n'); hasText = false; }
                const cmdPreview = truncateCommand(chunk.content || '', 60);
                setSpinner(startSpinner(`[${chunk.toolName}] ${cmdPreview}`));
                break;
              }
              case 'tool_end': {
                clearSpinner();
                hadTools = true;
                let endLabel = chunk.toolName || '';
                const activeSkills = this.agent.getActiveSkillNames();
                if (endLabel === 'bash' && activeSkills.length > 0) {
                  endLabel = `${endLabel} via ${activeSkills[activeSkills.length - 1]}`;
                }
                const icon = chunk.success ? `${C.green}✓` : `${C.red}✗`;
                const preview = (chunk.content || '').slice(0, 150).split('\n')[0];
                process.stderr.write(`  ${icon} ${C.dim}[${endLabel}]${C.reset} ${C.dim}${preview}${(chunk.content || '').length > 150 ? '...' : ''}${C.reset}\n`);
                break;
              }
              case 'done':
                clearSpinner();
                if (hasText) { flushLines(true); process.stderr.write('\n\n'); }
                else if (!hadTools) process.stderr.write(`${C.bold}agent>${C.reset} ${renderMarkdown(chunk.content || '')}\n\n`);
                break;
              case 'max_iterations':
                clearSpinner();
                hitMaxIterations = true;
                break;
              case 'steer':
                break;
              case 'interrupted':
                clearSpinner();
                interrupted = true;
                if (hasText) { flushLines(true); process.stderr.write('\n'); }
                process.stderr.write(`  ${C.yellow}⚡ Interrupted${C.reset} ${C.dim}(${chunk.content || 'stopped'})${C.reset}\n\n`);
                break;
            }
          };

          try {
            for await (const chunk of this.agent.chatStream(message, controller.signal)) {
              if (steerActive) {
                chunkBuffer.push(chunk);
                continue;
              }
              renderChunk(chunk);
            }
            clearSpinner();
          } catch (e: unknown) {
            clearSpinner();
            // AbortError from fetch is handled inside chatStream; re-throw others
            if (!(e instanceof DOMException && e.name === 'AbortError')) throw e;
            if (!interrupted) {
              interrupted = true;
              process.stderr.write(`  ${C.yellow}⚡ Interrupted${C.reset}\n\n`);
            }
          } finally {
            if (process.stdin.isTTY) {
              process.stdin.removeListener('keypress', onKeypress);
            }
            this.agent.setSpinnerControl(null);
            // Restore original confirm callback if we wrapped it
            if (this.confirmCb) {
              this.agent.setConfirmToolCall(this.confirmCb);
            }
          }
        };

        // Attach pending content refs to the message
        let message: string | ContentBlock[] = input;
        if (this.pendingContentRefs.length > 0) {
          const blocks: ContentBlock[] = [{ type: 'text', text: input }];
          for (const ref of this.pendingContentRefs) {
            blocks.push(ref);
          }
          message = blocks;
          this.pendingContentRefs = [];
        }

        await runAgent(message);
        while (hitMaxIterations && !interrupted) {
          console.error(`${C.yellow}Reached iteration limit.${C.reset}`);
          const answer = await this.ask(`${C.yellow}Continue? (y/n)>${C.reset} `);
          if (answer.trim().toLowerCase() !== 'y') break;
          hitMaxIterations = false;
          await runAgent('continue where you left off');
        }
        // Re-estimate if API didn't return usage (ensures bar reflects current state)
        const tracker = this.agent.getContextTracker();
        if (!tracker.getUsedTokens()) tracker.estimateFromChars(this.agent.getTotalContextChars());
        const ctx = this.agent.getContextUsage();
        if (ctx) console.error(ctx);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`${C.red}Error: ${msg}${C.reset}\n`);
      }
    }
  }

  private async handleCommand(command: string): Promise<void> {
    const [cmd, ...args] = command.slice(1).trim().split(/\s+/);
    const sub = cmd.toLowerCase();

    switch (sub) {
      case 'help':
        console.error(`${C.bold}Commands:${C.reset}`);
        console.error(`  ${C.cyan}/help${C.reset}                  Show this help`);
        console.error(`  ${C.cyan}/model${C.reset}                 Show current model`);
        console.error(`  ${C.cyan}/model <name>${C.reset}          Switch model (persists)`);
        console.error(`  ${C.cyan}/model search [query]${C.reset}  Browse OpenRouter models`);
        console.error(`  ${C.cyan}/memory${C.reset}                Show all memory + stats`);
        console.error(`  ${C.cyan}/memory global${C.reset}         Show global memory`);
        console.error(`  ${C.cyan}/memory project${C.reset}        Show project memory`);
        console.error(`  ${C.cyan}/memory clear <scope>${C.reset}  Clear memory (project or all)`);
        console.error(`  ${C.cyan}/plan${C.reset}                  Show current plan`);
        console.error(`  ${C.cyan}/plan list${C.reset}             List all plans`);
        console.error(`  ${C.cyan}/plan use <name>${C.reset}       Activate an older plan`);
        console.error(`  ${C.cyan}/context${C.reset}               Show context breakdown + usage`);
        console.error(`  ${C.cyan}/context compact${C.reset}       Force context compaction now`);
        console.error(`  ${C.cyan}/config${C.reset}                Show config + file paths`);
        console.error(`  ${C.cyan}/config set <k> <v>${C.reset}    Set a config value`);
        console.error(`  ${C.cyan}/config unset <k>${C.reset}      Remove a config value`);
        console.error(`  ${C.cyan}/tools${C.reset}                 List loaded tools`);
        console.error(`  ${C.cyan}/skill${C.reset}                 List installed skills`);
        console.error(`  ${C.cyan}/skill search [query]${C.reset}  Search skills.sh`);
        console.error(`  ${C.cyan}/skill add <source>${C.reset}    Install skill from registry`);
        console.error(`  ${C.cyan}/skill remove <name>${C.reset}   Uninstall a skill`);
        console.error(`  ${C.cyan}/content add <path>${C.reset}     Add image/PDF as [content #N]`);
        console.error(`  ${C.cyan}/content list${C.reset}           List content refs in session`);
        console.error(`  ${C.cyan}/content paste${C.reset}          Paste image from clipboard`);
        console.error(`  ${C.cyan}/content screenshot${C.reset}     Capture screen region`);
        console.error(`  ${C.cyan}/content clear${C.reset}          Clear all content refs`);
        console.error(`  ${C.cyan}/permissions${C.reset}            Show permission rules`);
        console.error(`  ${C.cyan}/permissions allow <p>${C.reset}  Add allow rule (session)`);
        console.error(`  ${C.cyan}/permissions deny <p>${C.reset}   Add deny rule (session)`);
        console.error(`  ${C.cyan}/permissions save${C.reset}       Save session rules to project`);
        console.error(`  ${C.cyan}/permissions clear${C.reset}      Clear session rules`);
        console.error(`  ${C.cyan}/exit${C.reset}                  Exit`);
        console.error('');
        break;

      // ── /model ────────────────────────────────────────────────────────
      case 'model': {
        const subCmd = args[0]?.toLowerCase();
        if (subCmd === 'search') {
          const query = args.slice(1).join(' ');
          console.error(`${C.dim}Fetching models from OpenRouter...${C.reset}`);
          try {
            const models = await this.agent.fetchModels(query || undefined);
            if (models.length === 0) { console.error(`${C.dim}No models found${query ? ` matching "${query}"` : ''}.${C.reset}\n`); break; }
            const current = this.agent.getModel();
            const shown = models.slice(0, 30);
            for (const m of shown) {
              const marker = m.id === current ? C.green + '> ' : '  ';
              const ctx = m.context_length ? `${C.dim}${Math.round(m.context_length / 1000)}k${C.reset}` : '';
              const price = m.pricing?.prompt ? `${C.dim}$${(parseFloat(m.pricing.prompt) * 1_000_000).toFixed(2)}/M${C.reset}` : '';
              console.error(`${marker}${C.cyan}${m.id}${C.reset} ${ctx} ${price}`);
            }
            if (models.length > 30) console.error(`${C.dim}  ...and ${models.length - 30} more. Filter with /model search <query>${C.reset}`);
            console.error(`${C.dim}  Use /model <id> to switch${C.reset}\n`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`${C.red}Error: ${msg}${C.reset}\n`);
          }
        } else if (args[0]) {
          this.agent.setModel(args.join('/'));
          saveConfig({ model: this.agent.getModel() });
          // Resolve context window for new model
          const tracker = this.agent.getContextTracker();
          if (!tracker.getContextLength()) {
            try {
              const models = await this.agent.fetchModels(this.agent.getModel());
              const exact = models.find(m => m.id === this.agent.getModel());
              const match = exact ?? models[0];
              if (match?.context_length) tracker.setContextLength(match.context_length);
            } catch { /* proceed without */ }
          }
          tracker.estimateFromChars(this.agent.getTotalContextChars());
          const ctxLine = this.agent.getContextUsage();
          console.error(`${C.yellow}Model set to: ${this.agent.getModel()} (saved)${C.reset}`);
          if (ctxLine) console.error(ctxLine);
          console.error('');
        } else {
          console.error(`${C.dim}Current model: ${this.agent.getModel()}${C.reset}\n`);
        }
        break;
      }

      // ── /memory ───────────────────────────────────────────────────────
      case 'memory': {
        const subCmd = args[0]?.toLowerCase();
        if (subCmd === 'global') {
          const content = this.agent.getGlobalMemory();
          console.error(content ? `${C.bold}Global memory:${C.reset}\n${renderMarkdown(content)}\n` : `${C.dim}No global memory. Edit ~/.ag/memory.md${C.reset}\n`);
        } else if (subCmd === 'project') {
          const content = this.agent.getProjectMemory();
          console.error(content ? `${C.bold}Project memory:${C.reset}\n${renderMarkdown(content)}\n` : `${C.dim}No project memory yet.${C.reset}\n`);
        } else if (subCmd === 'clear') {
          const scope = args[1]?.toLowerCase();
          if (scope === 'project') {
            this.agent.clearProject();
            console.error(`${C.yellow}Project memory, plans, and history cleared.${C.reset}\n`);
          } else if (scope === 'all') {
            this.agent.clearAll();
            console.error(`${C.yellow}All memory cleared.${C.reset}\n`);
          } else {
            console.error(`${C.dim}Usage: /memory clear project  or  /memory clear all${C.reset}\n`);
          }
        } else {
          // Show all memory + stats
          const stats = this.agent.getStats();
          const global = this.agent.getGlobalMemory();
          const project = this.agent.getProjectMemory();
          console.error(`${C.bold}Memory${C.reset}`);
          console.error(`  Global:  ${stats.globalMemory ? C.green + 'yes' : C.dim + 'none'}${C.reset}`);
          console.error(`  Project: ${stats.projectMemory ? C.green + 'yes' : C.dim + 'none'}${C.reset}`);
          console.error(`  Plans:   ${C.cyan}${stats.planCount}${C.reset}`);
          console.error(`  Tasks:   ${C.cyan}${stats.taskCount}${C.reset}`);
          console.error(`  Content: ${C.cyan}${stats.contentCount}${C.reset}`);
          console.error(`  History: ${C.cyan}${stats.historyLines}${C.reset} messages`);
          if (global) console.error(`\n${C.bold}Global:${C.reset}\n${renderMarkdown(global)}`);
          if (project) console.error(`\n${C.bold}Project:${C.reset}\n${renderMarkdown(project)}`);
          console.error('');
        }
        break;
      }

      // ── /plan ─────────────────────────────────────────────────────────
      case 'plan': {
        const subCmd = args[0]?.toLowerCase();
        if (subCmd === 'list') {
          const plans = this.agent.getPlans();
          if (plans.length === 0) { console.error(`${C.dim}No plans yet.${C.reset}\n`); break; }
          const activeName = this.agent.getActivePlanName();
          console.error(`${C.bold}Plans (${plans.length}):${C.reset}`);
          plans.forEach(p => console.error(`  ${p.name === activeName ? C.green + '>' : ' '} ${p.name}  ${C.dim}${p.path}${C.reset}`));
          console.error('');
        } else if (subCmd === 'use' && args[1]) {
          const name = args.slice(1).join(' ');
          const plans = this.agent.getPlans();
          const match = plans.find(p => p.name.includes(name));
          if (!match) { console.error(`${C.red}No plan matching "${name}". Use /plan list${C.reset}\n`); break; }
          this.agent.activatePlan(match.name);
          console.error(`${C.yellow}Activated plan: ${match.name}${C.reset}\n`);
        } else {
          const content = this.agent.getPlan();
          console.error(content ? `${C.bold}Current plan:${C.reset}\n${renderMarkdown(content)}\n` : `${C.dim}No plans yet.${C.reset}\n`);
        }
        break;
      }

      // ── /context ──────────────────────────────────────────────────────
      case 'context': {
        if (args[0]?.toLowerCase() === 'compact') {
          const tracker = this.agent.getContextTracker();
          if (!tracker.getContextLength()) {
            console.error(`${C.dim}Cannot compact: context window size unknown.${C.reset}\n`);
            break;
          }
          console.error(`${C.dim}Compacting conversation...${C.reset}`);
          try {
            await this.agent.compactNow();
            console.error(`${C.green}Compaction complete.${C.reset}`);
            const ctx = this.agent.getContextUsage();
            if (ctx) console.error(ctx);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`${C.red}Compaction failed: ${msg}${C.reset}`);
          }
        } else {
          console.error(`${C.bold}Context Window${C.reset}`);
          console.error(this.agent.getContextDetails());
          console.error('');
          console.error(`${C.bold}Breakdown${C.reset}`);
          const breakdown = this.agent.getContextBreakdown();
          const tracker = this.agent.getContextTracker();
          console.error(renderContextBreakdown(breakdown, tracker.getContextLength(), tracker.getUsedTokens()));
        }
        console.error('');
        break;
      }

      // ── /config ───────────────────────────────────────────────────────
      case 'config': {
        const validKeys: (keyof PersistentConfig)[] = ['apiKey', 'model', 'baseURL', 'systemPrompt', 'maxIterations', 'tavilyApiKey', 'autoApprove'];
        const keyAliases: Record<string, keyof PersistentConfig> = {
          'tavily_api_key': 'tavilyApiKey',
          'openrouter_api_key': 'apiKey',
          'api_key': 'apiKey',
          'auto_approve': 'autoApprove',
          'autoapprove': 'autoApprove',
        };
        if (args[0]?.toLowerCase() === 'set' && args[1]) {
          const value = args.slice(2).join(' ');
          if (!value) { console.error(`${C.red}Usage: /config set <key> <value>${C.reset}\n`); break; }
          const rawKey = args[1];
          const key = keyAliases[rawKey.toLowerCase()] ?? rawKey as keyof PersistentConfig;
          if (!validKeys.includes(key)) {
            console.error(`${C.red}Valid keys: ${validKeys.join(', ')}${C.reset}\n`);
            break;
          }
          let parsed: string | number | boolean = value;
          if (key === 'maxIterations') {
            const n = parseInt(value, 10);
            if (isNaN(n) || n <= 0) { console.error(`${C.red}Invalid number: ${value}${C.reset}\n`); break; }
            parsed = n;
          } else if (key === 'autoApprove') {
            parsed = ['true', '1', 'yes'].includes(value.toLowerCase());
            // Apply immediately: toggle confirmation prompts in this session
            if (parsed) {
              this.agent.setConfirmToolCall(null);
              this.confirmCb = null;
              console.error(`${C.green}Auto-approve enabled — tool calls will no longer prompt.${C.reset}`);
            } else {
              const freshCb = this.pm
                ? createPermissionCallback(this.pm, this.rl)
                : createConfirmCallback(this.rl);
              if (this.confirmCb) freshCb.pauseSpinner = this.confirmCb.pauseSpinner;
              this.confirmCb = freshCb;
              this.agent.setConfirmToolCall(freshCb);
              console.error(`${C.yellow}Auto-approve disabled — tool calls will prompt again.${C.reset}`);
            }
          }
          saveConfig({ [key]: parsed });
          const display = (key === 'apiKey' || key === 'tavilyApiKey') ? maskKey(value) : value;
          console.error(`${C.yellow}Config: ${key} = ${display} (saved)${C.reset}\n`);
        } else if (args[0]?.toLowerCase() === 'unset' && args[1]) {
          const rawKey = args[1];
          const key = keyAliases[rawKey.toLowerCase()] ?? rawKey as keyof PersistentConfig;
          if (!validKeys.includes(key)) {
            console.error(`${C.red}Valid keys: ${validKeys.join(', ')}${C.reset}\n`);
            break;
          }
          saveConfig({ [key]: undefined });
          // Reset live agent state to defaults where applicable
          if (key === 'baseURL') this.agent.setBaseURL('https://openrouter.ai/api/v1');
          if (key === 'model') { this.agent.setModel('anthropic/claude-sonnet-4.6'); }
          if (key === 'autoApprove') {
            const freshCb = this.pm
              ? createPermissionCallback(this.pm, this.rl)
              : createConfirmCallback(this.rl);
            if (this.confirmCb) freshCb.pauseSpinner = this.confirmCb.pauseSpinner;
            this.confirmCb = freshCb;
            this.agent.setConfirmToolCall(freshCb);
          }
          console.error(`${C.yellow}Config: ${key} removed${C.reset}\n`);
        } else {
          // Show config + file paths
          const cfg = loadConfig();
          const p = this.agent.getPaths();
          console.error(`${C.bold}Config${C.reset} ${C.dim}(${configPath()})${C.reset}`);
          if (cfg.apiKey) console.error(`  apiKey:        ${C.dim}${maskKey(cfg.apiKey)}${C.reset}`);
          if (cfg.model) console.error(`  model:         ${C.cyan}${cfg.model}${C.reset}`);
          if (cfg.baseURL) console.error(`  baseURL:       ${C.dim}${cfg.baseURL}${C.reset}`);
          if (cfg.maxIterations) console.error(`  maxIterations: ${C.cyan}${cfg.maxIterations}${C.reset}`);
          if (cfg.tavilyApiKey) console.error(`  tavilyApiKey:  ${C.dim}${maskKey(cfg.tavilyApiKey)}${C.reset}`);
          if (cfg.autoApprove !== undefined) console.error(`  autoApprove:   ${cfg.autoApprove ? C.green + 'true' : C.dim + 'false'}${C.reset}`);
          if (!cfg.apiKey && !cfg.model && !cfg.baseURL && !cfg.maxIterations) {
            console.error(`${C.dim}  (using defaults + env vars)${C.reset}`);
          }
          console.error(`\n${C.bold}Paths${C.reset}`);
          console.error(`  Config:  ${configPath()}`);
          console.error(`  Global:  ${p.globalMemory}`);
          console.error(`  Project: ${p.projectMemory}`);
          console.error(`  Plans:   ${p.plansDir}/`);
          console.error(`  History: ${p.history}`);
          console.error('');
        }
        break;
      }

      // ── /tools ────────────────────────────────────────────────────────
      case 'tools': {
        const tools = this.agent.getTools();
        console.error(`${C.bold}Tools (${tools.length}):${C.reset}`);
        for (const t of tools) {
          const prefix = t.isBuiltin ? ' ' : `${C.green}+${C.reset}`;
          console.error(`  ${prefix} ${C.cyan}${t.name}${C.reset}  ${C.dim}${t.description.slice(0, 60)}${t.description.length > 60 ? '...' : ''}${C.reset}`);
        }
        console.error('');
        break;
      }

      // ── /skill ────────────────────────────────────────────────────────
      case 'skill': {
        const subCmd = args[0]?.toLowerCase();
        if (subCmd === 'search') {
          const query = args.slice(1).join(' ');
          if (!query) { console.error(`${C.dim}Usage: /skill search <query>${C.reset}\n`); break; }
          console.error(`${C.dim}Searching skills.sh...${C.reset}`);
          try {
            const results = await searchRegistry(query);
            if (results.length === 0) { console.error(`${C.dim}No skills found for "${query}".${C.reset}\n`); break; }
            const shown = results.slice(0, 20);
            for (const s of shown) {
              console.error(`  ${C.cyan}${s.source}@${s.skillId}${C.reset}  ${C.dim}${formatInstalls(s.installs)} installs${C.reset}`);
            }
            if (results.length > 20) console.error(`${C.dim}  ...and ${results.length - 20} more${C.reset}`);
            console.error(`${C.dim}  Use /skill add <source>@<name> to install${C.reset}\n`);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`${C.red}Error: ${msg}${C.reset}\n`);
          }
        } else if (subCmd === 'add' && args[1]) {
          const source = args[1];
          const stopSpinner = startSpinner(`Installing ${source}`);
          try {
            const msg = await installSkill(source);
            stopSpinner();
            this.agent.refreshSkills();
            console.error(`${C.green}${msg}${C.reset}\n`);
          } catch (e: unknown) {
            stopSpinner();
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`${C.red}Error: ${msg}${C.reset}\n`);
          }
        } else if (subCmd === 'remove' && args[1]) {
          const msg = removeSkill(args[1]);
          this.agent.refreshSkills();
          console.error(`${C.yellow}${msg}${C.reset}\n`);
        } else if (!subCmd) {
          // List installed skills
          const skills = this.agent.getSkills();
          if (skills.length === 0) {
            console.error(`${C.dim}No skills installed. Use /skill search <query> to browse skills.sh${C.reset}\n`);
            break;
          }
          console.error(`${C.bold}Skills (${skills.length}):${C.reset}`);
          for (const s of skills) {
            const flags = [s.always && 'always-on', s.hasTools && 'has tools'].filter(Boolean).join(', ');
            console.error(`  ${C.cyan}${s.name}${C.reset}  ${C.dim}${s.description.slice(0, 60)}${flags ? ` (${flags})` : ''}${C.reset}`);
          }
          console.error('');
        } else {
          console.error(`${C.dim}Usage: /skill, /skill search <q>, /skill add <source>, /skill remove <name>${C.reset}\n`);
        }
        break;
      }

      // ── /permissions ────────────────────────────────────────────────────
      case 'permissions':
      case 'perms': {
        if (!this.pm) {
          console.error(`${C.dim}Permissions not available (auto-approve mode).${C.reset}\n`);
          break;
        }
        const subCmd = args[0]?.toLowerCase();
        if (subCmd === 'allow' && args[1]) {
          const pattern = args.slice(1).join(' ');
          this.pm.addRule({ pattern, effect: 'allow' }, 'session');
          console.error(`${C.green}+ Session allow: ${pattern}${C.reset}\n`);
        } else if (subCmd === 'deny' && args[1]) {
          const pattern = args.slice(1).join(' ');
          this.pm.addRule({ pattern, effect: 'deny' }, 'session');
          console.error(`${C.green}+ Session deny: ${pattern}${C.reset}\n`);
        } else if (subCmd === 'save') {
          const scope = args[1]?.toLowerCase() === 'global' ? 'global' as const : 'project' as const;
          this.pm.save(scope);
          console.error(`${C.yellow}Saved to ${scope} permissions.${C.reset}\n`);
        } else if (subCmd === 'clear') {
          const scope = args[1]?.toLowerCase();
          if (scope === 'project' || scope === 'global') {
            this.pm.clear(scope);
            this.pm.save(scope);
            console.error(`${C.yellow}Cleared ${scope} permissions.${C.reset}\n`);
          } else {
            this.pm.clear('session');
            console.error(`${C.yellow}Cleared session permissions.${C.reset}\n`);
          }
        } else if (subCmd === 'remove' && args[1]) {
          const pattern = args.slice(1).join(' ');
          const removed = this.pm.removeRule(pattern, 'session')
            || this.pm.removeRule(pattern, 'project')
            || this.pm.removeRule(pattern, 'global');
          if (removed) {
            console.error(`${C.yellow}Removed: ${pattern}${C.reset}\n`);
          } else {
            console.error(`${C.dim}No matching rule found.${C.reset}\n`);
          }
        } else {
          // List all rules
          const rules = this.pm.getRules();
          if (rules.length === 0) {
            console.error(`${C.dim}No permission rules. Approve with (a)lways or (p)roject to add rules.${C.reset}\n`);
            break;
          }
          console.error(`${C.bold}Permission Rules:${C.reset}`);
          for (const r of rules) {
            const icon = r.effect === 'allow' ? `${C.green}✓` : `${C.red}✗`;
            console.error(`  ${icon} ${C.dim}[${r.scope}]${C.reset} ${r.effect} ${C.cyan}${r.pattern}${C.reset}`);
          }
          console.error('');
        }
        break;
      }

      // ── /content ──────────────────────────────────────────────────────
      case 'content': {
        const subCmd = args[0]?.toLowerCase();
        if (subCmd === 'add' && args[1]) {
          const filePath = args.slice(1).join(' ');
          const { resolve: resolvePath } = await import('node:path');
          const { existsSync } = await import('node:fs');
          const resolved = resolvePath(filePath);
          if (!existsSync(resolved)) {
            console.error(`${C.red}Error: file not found — ${filePath}${C.reset}\n`);
            break;
          }
          try {
            const ref = ingestContent(resolved, process.cwd());
            this.pendingContentRefs.push(ref);
            const desc = describeContent(ref);
            const display = displayContent(ref);
            console.error(`  ${C.green}Added as [content #${ref.id}]${C.reset} — ${desc}`);
            if (display !== `[content #${ref.id}] ${ref.filename || 'unknown'} — ${desc}`) {
              process.stderr.write(display + '\n');
            }
            console.error('');
          } catch (e: unknown) {
            console.error(`${C.red}Error: ${e instanceof Error ? e.message : String(e)}${C.reset}\n`);
          }
        } else if (subCmd === 'list') {
          const allRefs = getAllContentRefs();
          if (allRefs.length === 0) {
            console.error(`${C.dim}No content in this session. Use /content add <path> to add files.${C.reset}\n`);
            break;
          }
          console.error(`${C.bold}Content (${allRefs.length}):${C.reset}`);
          for (const ref of allRefs) {
            console.error(`  ${C.cyan}[content #${ref.id}]${C.reset} ${ref.filename || 'unknown'} — ${describeContent(ref)}`);
          }
          console.error('');
        } else if (subCmd === 'paste') {
          try {
            const { execFileSync } = await import('node:child_process');
            const { join: joinPath } = await import('node:path');
            const { tmpdir } = await import('node:os');
            const tmpFile = joinPath(tmpdir(), `ag-paste-${Date.now()}.png`);
            if (process.platform === 'darwin') {
              // macOS: use pngpaste or osascript fallback
              try {
                execFileSync('pngpaste', [tmpFile], { timeout: 5000 });
              } catch {
                execFileSync('osascript', ['-e', `tell application "System Events" to write (the clipboard as «class PNGf») to (open for access POSIX file "${tmpFile}" with write permission)`], { timeout: 5000 });
              }
            } else {
              const { openSync: fsOpen } = await import('node:fs');
              execFileSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { timeout: 5000, stdio: ['ignore', fsOpen(tmpFile, 'w'), 'ignore'] });
            }
            const { existsSync: exists } = await import('node:fs');
            if (exists(tmpFile)) {
              const ref = ingestContent(tmpFile, process.cwd());
              this.pendingContentRefs.push(ref);
              console.error(`  ${C.green}Pasted as [content #${ref.id}]${C.reset} — ${describeContent(ref)}\n`);
            } else {
              console.error(`${C.red}No image found in clipboard.${C.reset}\n`);
            }
          } catch (e: unknown) {
            console.error(`${C.red}Error: could not paste from clipboard. ${e instanceof Error ? e.message : String(e)}${C.reset}\n`);
          }
        } else if (subCmd === 'screenshot') {
          try {
            const { execFileSync } = await import('node:child_process');
            const { join: joinPath } = await import('node:path');
            const { tmpdir } = await import('node:os');
            const tmpFile = joinPath(tmpdir(), `ag-screenshot-${Date.now()}.png`);
            if (process.platform === 'darwin') {
              execFileSync('screencapture', ['-i', tmpFile], { timeout: 30000, stdio: 'inherit' });
            } else {
              // Try gnome-screenshot, then scrot
              try {
                execFileSync('gnome-screenshot', ['-a', '-f', tmpFile], { timeout: 30000, stdio: 'inherit' });
              } catch {
                execFileSync('scrot', ['-s', tmpFile], { timeout: 30000, stdio: 'inherit' });
              }
            }
            const { existsSync: exists } = await import('node:fs');
            if (exists(tmpFile)) {
              const ref = ingestContent(tmpFile, process.cwd());
              this.pendingContentRefs.push(ref);
              console.error(`  ${C.green}Captured as [content #${ref.id}]${C.reset} — ${describeContent(ref)}\n`);
            } else {
              console.error(`${C.dim}Screenshot cancelled.${C.reset}\n`);
            }
          } catch (e: unknown) {
            console.error(`${C.red}Error: ${e instanceof Error ? e.message : String(e)}${C.reset}\n`);
          }
        } else if (subCmd === 'clear') {
          resetContentStore();
          // Also wipe project content cache on disk
          try {
            const { paths: memPaths } = await import('../memory/memory.js');
            const { existsSync: exists, rmSync: rm } = await import('node:fs');
            const dir = memPaths(process.cwd()).contentDir;
            if (exists(dir)) rm(dir, { recursive: true });
          } catch { /* ignore cleanup errors */ }
          console.error(`${C.yellow}Cleared all content refs and cache.${C.reset}\n`);
        } else {
          console.error(`${C.dim}Usage: /content add <path>, /content list, /content paste, /content screenshot, /content clear${C.reset}\n`);
        }
        break;
      }

      // ── /exit ─────────────────────────────────────────────────────────
      case 'exit':
      case 'quit':
        console.error(`${C.dim}Goodbye!${C.reset}`);
        process.exit(0);

      default:
        console.error(`${C.red}Unknown command: ${sub}. Type /help${C.reset}\n`);
    }
  }

  private ask(prompt: string): Promise<string> {
    return new Promise(resolve => this.rl.question(prompt, resolve));
  }
}
