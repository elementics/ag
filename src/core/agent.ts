import { Message, Tool, AgentConfig, StreamChunk, ConfirmToolCall, ContentBlock, ContentRef } from './types.js';
import { AgentEventEmitter, type EventName, type EventHandler } from './events.js';
import { discoverExtensions, loadExtensions, type ExtensionMeta } from './extensions.js';
import { C } from './colors.js';
import { loadContext, loadHistory, appendHistory, rewriteHistory, getStats, clearProject, clearAll, paths, saveGlobalMemory, saveProjectMemory, savePlan, appendPlan, setActivePlan, getActivePlanName, loadGlobalMemory, loadProjectMemory, loadPlan, loadPlanByName, listPlans, cleanupTasks, saveSessionState, loadSessionState, type MemoryStats } from '../memory/memory.js';
import { bashToolFactory } from '../tools/bash.js';
import { memoryTool } from '../tools/memory.js';
import { planTool } from '../tools/plan.js';
import { gitTool } from '../tools/git.js';
import { skillTool, type SkillHost } from '../tools/skill.js';
import { webTool } from '../tools/web.js';
import { taskTool } from '../tools/task.js';
import { agentTool } from '../tools/agent.js';
import { grepTool } from '../tools/grep.js';
import { fileTool } from '../tools/file.js';
import { contentTool } from '../tools/content.js';
import { resultTool } from '../tools/result.js';
import { historyTool } from '../tools/history.js';
import { consumeRequestedRefs, resolveContent, getContentRef, restoreContentIndex, pruneContentCache, estimateMessageContentChars } from './content.js';
import { cacheResult, RESULT_REF_THRESHOLD, consumeRequestedResults, resolveResult, getResultRef, restoreResultIndex, saveResultIndex } from './results.js';
import { discoverSkills, buildSkillCatalog, getAlwaysOnContent, loadSkillTools, type SkillMeta } from './skills.js';
import { ContextTracker } from './context.js';
import { startSpinner, fetchWithRetry, truncateToolResult, raceAll } from './utils.js';
import { getEnvironmentContext, isReadOnlyToolCall, getProjectListing, buildRequestBody } from './prompt.js';
import { compactMessages, COMPACT_THRESHOLD, COMPACT_HEAD_KEEP, COMPACT_TAIL_KEEP } from './compaction.js';
import { summarizeTurn, extractFileOps, TURN_SUMMARY_THRESHOLD, type TurnSummary } from './summarization.js';
import { CheckpointStore } from './checkpoint.js';

export const MAX_ITERATIONS_REACHED = '[Max iterations reached]';

// Re-export extracted functions for backwards compatibility
export { fetchWithRetry, truncateToolResult, raceAll } from './utils.js';
export { getEnvironmentContext, isReadOnlyToolCall } from './prompt.js';

const MAX_MESSAGES = 200;

export class Agent implements SkillHost {
  private readonly apiKey: string;
  private model: string;
  private baseURL: string;
  private readonly baseSystemPrompt: string;
  private readonly systemPromptSuffix: string;
  private readonly maxIterations: number;
  private readonly tools: Map<string, Tool>;
  private readonly cwd: string;
  private messages: Message[] = [];

  private allSkills: SkillMeta[] = [];
  private activeSkillContent: string[] = [];
  private cachedContext: string = '';
  private cachedCatalog: string = '';
  private cachedAlwaysOn: string = '';
  private readonly builtinToolNames: Set<string> = new Set();
  private readonly toolFailures: Array<{ file: string; reason: string }>;
  private contextTracker: ContextTracker;
  private compactionInProgress = false;
  private confirmToolCall: ConfirmToolCall | null;
  private readonly events = new AgentEventEmitter();
  private loadedExtensions: ExtensionMeta[] = [];
  private spinnerControl: { pause: () => void; resume: () => void } | null = null;
  private readonly silent: boolean;
  private readonly noHistory: boolean;
  private steerQueue: string[] = [];
  private currentTurn = 0;
  private turnSummaries = new Map<number, import('./summarization.js').TurnSummary>();
  private turnMessageStartIndex = 0;
  private checkpointStore: CheckpointStore | null = null;
  private currentCheckpointId: string | null = null;

  constructor(config: AgentConfig = {}) {
    this.model = config.model || 'anthropic/claude-sonnet-4.6';
    this.baseURL = config.baseURL || 'https://openrouter.ai/api/v1';
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || '';
    const isDefaultBaseURL = this.baseURL === 'https://openrouter.ai/api/v1';
    if (!this.apiKey && isDefaultBaseURL) throw new Error('No API key. Set OPENROUTER_API_KEY, pass -k, or run `ag` interactively to configure.');
    this.baseSystemPrompt = config.systemPrompt || `You are ag, a coding agent that completes tasks by calling tools. You work autonomously — never ask the user for information you can find yourself.

# Tool use
- To read files, use file(action=read). Do NOT use bash with cat, head, or tail.
- To edit files, use file(action=edit). Do NOT use bash with sed or awk.
- To create files, use file(action=write). Do NOT use bash with echo or heredocs.
- To search file contents, use grep(action=search). Do NOT use bash with grep or rg.
- To find files by name/pattern, use grep(action=find). Do NOT use bash with find or ls.
- To browse directories, use file(action=list). Do NOT use bash with ls or tree.
- Use bash only for running commands: tests, builds, installs, servers, and system operations.
- Use git for all version control operations — not bash with git commands.
- If the user mentions a file vaguely, search for it with grep(action=find) before anything else.

# Working with code
- Always read a file before editing it. Never propose changes to code you haven't read.
- Do not create new files unless necessary — prefer editing existing files.
- Do what was asked, nothing more. Don't add features, refactor surrounding code, add comments, or make "improvements" beyond the request.
- Don't add error handling or validation for scenarios that can't happen. Trust internal code.
- Be careful not to introduce security vulnerabilities (XSS, SQL injection, command injection). If you notice insecure code you wrote, fix it immediately.

# Error recovery
- If a tool fails, diagnose why before switching tactics. Read the error, check your assumptions, try a focused fix.
- Don't retry the identical action. Don't abandon a viable approach after a single failure either.
- If file(action=edit) fails with "not found", re-read the file to verify exact content.
- If bash returns a non-zero exit code, read the stderr output to understand the failure.
- Ask the user only when genuinely stuck after investigation, not as a first response to friction.

# Git workflow
- Read the diff before committing. Write concise commit messages that explain why, not what.
- Never amend commits or force-push without the user asking.
- Never commit files that contain secrets (.env, credentials, keys).

# History
- When the user asks about past conversations or work and you cannot answer from your current context, use history(action=search, query="<keyword>") to search conversation history. This searches user messages, assistant responses, tool calls, file paths, and result summaries.
- Use history(action=recent) to see the last few conversation entries for broader context.
- This is a last resort — try answering from your current context and memory first.

# Output
- Be concise. Short responses, no filler, no trailing summaries of what you just did.
- When referencing code, include the file path and relevant context.
- Only use markdown formatting when it aids clarity.
- Always follow instructions in <global-memory> — these are persistent user preferences that override defaults.

# Verification
- After making changes, verify they work: run tests, check for syntax errors, or start the dev server as appropriate.
- If a task involves multiple steps, verify each step before proceeding to the next.

# Tools available
- file(read/list/write/edit) — view, browse, create, and edit files
- grep(find) — locate files by glob · grep(search) — search content by regex
- bash — run shell commands, tests, installs, builds
- git — status, branch, commit, push
- memory(save) — persist facts across sessions (global or project tier)
- plan — create and manage multi-step task plans
- web(fetch/search) — fetch pages or search the web
- task(create/list/update/read/remove/clear) — manage tasks for multi-step work
- agent(prompt, taskId?, model?) — spawn sub-agents for parallel work. Call multiple times in one response to run concurrently. Always include key findings from sub-agents in your response — the user cannot see tool output in full.
- skill — activate a skill by name`;
    this.systemPromptSuffix = config.systemPromptSuffix || '';
    this.silent = config.silent ?? false;
    this.noHistory = config.noHistory ?? false;
    this.maxIterations = config.maxIterations || 200;
    this.cwd = config.cwd || process.cwd();
    this.confirmToolCall = config.confirmToolCall ?? null;

    // Discover skills
    this.allSkills = discoverSkills(this.cwd);

    // Register built-in tools
    this.tools = new Map();
    this.addTool(bashToolFactory(this.cwd));
    this.addTool(memoryTool(this.cwd));
    this.addTool(planTool(this.cwd));
    this.addTool(gitTool(this.cwd));
    this.addTool(grepTool(this.cwd));
    this.addTool(fileTool(this.cwd));
    this.addTool(webTool());
    this.addTool(taskTool(this.cwd));
    this.addTool(contentTool(this.cwd));
    this.addTool(resultTool(this.cwd));
    this.addTool(historyTool(this.cwd));
    if (!config.noSubAgents) this.addTool(agentTool(this));
    if (this.allSkills.length > 0) this.addTool(skillTool(this));
    this.builtinToolNames = new Set(this.tools.keys());
    for (const t of config.extraTools ?? []) this.addTool(t);
    this.toolFailures = config.toolFailures ?? [];

    // Context window tracking
    this.contextTracker = new ContextTracker(this.model);
    if (config.contextLength) this.contextTracker.setContextLength(config.contextLength);

    // Cache context and skill catalog (invalidated on skill activation/refresh)
    this.refreshCache();

    // Load recent conversation history for continuity (sub-agents start clean)
    if (!config.noHistory) {
      // Try session state resume first (structured summary), fall back to raw history
      const sessionState = loadSessionState(this.cwd);
      if (sessionState) {
        this.messages = [{
          role: 'user',
          content: `Resuming previous session. Here's where things stand:\n\n${sessionState.summary}\n\nRecent files read: ${sessionState.recentFileOps.read.join(', ') || 'none'}\nRecent files modified: ${sessionState.recentFileOps.modified.join(', ') || 'none'}${sessionState.activePlan ? `\nActive plan: ${sessionState.activePlan}` : ''}`,
        }];
        this.currentTurn = sessionState.turnNumber;
      } else {
        this.messages = loadHistory(this.cwd);
      }
      restoreContentIndex(this.cwd, this.messages);
      restoreResultIndex(this.cwd);
      pruneContentCache(this.cwd);
      cleanupTasks(this.cwd);
      this.checkpointStore = new CheckpointStore(paths(this.cwd).projectDir);
    }
  }

  addTool(tool: Tool): void {
    const name = tool.function.name;
    if (this.builtinToolNames.size > 0 && this.builtinToolNames.has(name)) {
      process.stderr.write(`${C.yellow}Warning: tool "${name}" overwrites built-in tool${C.reset}\n`);
    }
    this.tools.set(name, tool);
  }

  /** Append to history unless this is a sub-agent (noHistory mode) */
  private appendToHistory(msg: Message): void {
    if (!this.noHistory) appendHistory(msg, this.cwd);
  }

  /** Subscribe to an agent lifecycle event. Returns an unsubscribe function. */
  on<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
    return this.events.on(event, handler);
  }

  /** Discover and load extensions from .ag/extensions/ and ~/.ag/extensions/ */
  async initExtensions(extraPaths?: string[]): Promise<void> {
    const discovered = discoverExtensions(this.cwd);
    const all = [...discovered, ...(extraPaths ?? [])];
    if (all.length > 0) {
      this.loadedExtensions = await loadExtensions(this, all);
    }
  }

  /** Metadata for successfully loaded extensions */
  getLoadedExtensions(): ExtensionMeta[] {
    return this.loadedExtensions;
  }

  /** Spinner-safe log for extensions. Pauses spinner, writes, resumes. */
  log(message: string): void {
    if (this.spinnerControl) this.spinnerControl.pause();
    process.stderr.write(message + '\n');
    if (this.spinnerControl) this.spinnerControl.resume();
  }

  /** Called by the REPL to register spinner pause/resume for safe output */
  setSpinnerControl(control: { pause: () => void; resume: () => void } | null): void {
    this.spinnerControl = control;
  }

  private refreshCache(): void {
    this.cachedContext = loadContext(this.cwd, { skipTasks: this.noHistory });
    this.cachedCatalog = buildSkillCatalog(this.allSkills);
    this.cachedAlwaysOn = getAlwaysOnContent(this.allSkills);
  }

  private get systemPrompt(): string {
    const parts = [this.baseSystemPrompt];
    parts.push(getEnvironmentContext(this.cwd));
    const listing = getProjectListing(this.cwd);
    if (listing) parts.push(listing);
    if (this.cachedContext) parts.push(this.cachedContext);
    if (this.cachedCatalog) parts.push(this.cachedCatalog);
    if (this.cachedAlwaysOn) parts.push(this.cachedAlwaysOn);
    if (this.activeSkillContent.length > 0) {
      parts.push(this.activeSkillContent.join('\n\n'));
    }
    if (this.systemPromptSuffix) parts.push(this.systemPromptSuffix);
    return parts.join('\n\n');
  }

  private getRequestBody(stream: boolean, overrides?: { messages?: Message[]; systemPrompt?: string }): Record<string, unknown> {
    let messages = overrides?.messages ?? this.messages;
    // Collapse older turns that have summaries
    if (this.turnSummaries.size > 0) {
      messages = this.collapseOlderTurns(messages);
    }
    return buildRequestBody({
      model: this.model,
      systemPrompt: overrides?.systemPrompt ?? this.systemPrompt,
      messages,
      tools: Array.from(this.tools.values()).map(t => ({ type: t.type, function: t.function })),
      stream,
      currentTurn: this.currentTurn,
    });
  }

  /** Replace older turn message sequences with their summaries */
  private collapseOlderTurns(messages: Message[]): Message[] {
    const result: Message[] = [];
    let i = 0;
    while (i < messages.length) {
      const turn = messages[i]._turn;
      if (turn != null && turn !== this.currentTurn && this.turnSummaries.has(turn)) {
        // Skip all messages from this turn, inject summary once
        const summary = this.turnSummaries.get(turn)!;
        result.push({
          role: 'user',
          content: `[Turn ${turn} summary — ${summary.toolCallCount} tool calls collapsed]\n\n${summary.summary}`,
        });
        while (i < messages.length && messages[i]._turn === turn) i++;
      } else {
        result.push(messages[i]);
        i++;
      }
    }
    return result;
  }

  /** Save current session state to disk for resume on next startup */
  private saveSessionState(): void {
    if (this.noHistory) return;
    // Aggregate recent turn summaries for the summary text
    const recentSummaries = [...this.turnSummaries.values()].slice(-5);
    const summary = recentSummaries.length > 0
      ? recentSummaries.map(s => s.summary).join('\n\n---\n\n')
      : this.messages
          .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 0)
          .slice(-3)
          .map(m => (m.content as string).slice(0, 500))
          .join('\n\n');
    // Always extract file ops from messages directly (not just from turn summaries)
    const fileOps = extractFileOps(this.messages);
    saveSessionState({
      timestamp: new Date().toISOString(),
      turnNumber: this.currentTurn,
      summary: summary || 'No activity to summarize.',
      recentFileOps: fileOps,
      activePlan: getActivePlanName(this.cwd),
    }, this.cwd);
  }

  async activateSkill(name: string): Promise<string> {
    const skill = this.allSkills.find(s => s.name === name);
    if (!skill) return `Skill "${name}" not found. Available: ${this.allSkills.map(s => s.name).join(', ')}`;
    if (this.activeSkillContent.some(c => c.includes(`name="${name}"`))) {
      return `Skill "${name}" is already active.`;
    }
    this.activeSkillContent.push(`<skill name="${name}">\n${skill.content}\n</skill>`);
    this.refreshCache();

    // Load tools if skill has them
    if (skill.hasTools) {
      const tools = await loadSkillTools(skill.dir);
      for (const t of tools) this.addTool(t);
      if (tools.length > 0) {
        return `Skill "${name}" activated with ${tools.length} tool(s): ${tools.map(t => t.function.name).join(', ')}`;
      }
    }
    return `Skill "${name}" activated. Instructions loaded.`;
  }

  private async compactConversation(customSummary?: string): Promise<void> {
    const result = await compactMessages(
      this.messages,
      { baseURL: this.baseURL, apiKey: this.apiKey, model: this.model },
      customSummary,
    );
    if (!result) return;

    this.messages = result.messages;
    this.appendToHistory(result.summaryMsg);

    // Re-estimate context usage from the compacted messages
    const compactedChars = this.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)
      + this.systemPrompt.length;
    this.contextTracker.estimateFromChars(compactedChars);
  }

  async chat(content: string | ContentBlock[], signal?: AbortSignal): Promise<string> {
    let finalContent = '';
    let stopSpinner = () => {};

    try {
      for await (const chunk of this.chatStream(content, signal)) {
        switch (chunk.type) {
          case 'thinking':
            stopSpinner();
            stopSpinner = this.silent ? () => {} : startSpinner(chunk.content || 'thinking');
            break;
          case 'text':
            stopSpinner();
            stopSpinner = () => {};
            break;
          case 'tool_start':
            stopSpinner();
            stopSpinner = this.silent ? () => {} : startSpinner(`[${chunk.toolName}] ${(chunk.content || '').slice(0, 80)}`);
            break;
          case 'tool_end':
            stopSpinner();
            stopSpinner = () => {};
            if (!this.silent) {
              const icon = chunk.success ? `${C.green}✓` : `${C.red}✗`;
              const preview = (chunk.content || '').slice(0, 150).split('\n')[0];
              process.stderr.write(`  ${icon} ${C.dim}[${chunk.toolName}]${C.reset} ${C.dim}${preview}${(chunk.content || '').length > 150 ? '...' : ''}${C.reset}\n`);
            }
            break;
          case 'done':
            finalContent = chunk.content || '';
            break;
          case 'interrupted':
            return '[interrupted by user]';
          case 'max_iterations':
            return MAX_ITERATIONS_REACHED;
          case 'steer':
            break;
        }
      }
    } finally {
      stopSpinner();
    }
    return finalContent;
  }

  async *chatStream(content: string | ContentBlock[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    // ── input event ── (only for string content; content blocks pass through)
    if (typeof content === 'string') {
      const inputEvent = { content, skip: false };
      await this.events.emit('input', inputEvent);
      if (inputEvent.skip) return;
      content = inputEvent.content;
    }

    this.currentTurn++;
    this.turnMessageStartIndex = this.messages.length; // Mark where this turn's messages begin

    // Set introduced_turn on any content refs
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'content_ref') {
          (block as ContentRef).introduced_turn = this.currentTurn;
        }
      }
    }

    const userMessage: Message = { role: 'user', content, _turn: this.currentTurn };
    this.messages.push(userMessage);
    this.appendToHistory(userMessage);

    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }

    let turnToolCallCount = 0;

    // ── Auto-checkpoint at turn start (skip first turn — nothing to rewind to) ──
    if (this.checkpointStore && this.currentTurn > 1) {
      const cp = this.checkpointStore.create(this.messages.length - 1, this.currentTurn);
      this.currentCheckpointId = cp.id;
      await this.events.emit('checkpoint_create', {
        id: cp.id, label: cp.label, messageIndex: cp.messageIndex, turnNumber: cp.turnNumber,
      });
    }

    for (let i = 0; i < this.maxIterations; i++) {
      // ── Abort check: top of iteration ──
      if (signal?.aborted) {
        this.messages.push({ role: 'assistant', content: '[interrupted by user]' });
        yield { type: 'interrupted' };
        return;
      }

      // ── Inject steer messages before next LLM turn ──
      while (this.steerQueue.length > 0) {
        const steer = this.steerQueue.shift()!;
        const steerMsg: Message = { role: 'user', content: steer };
        this.messages.push(steerMsg);
        this.appendToHistory(steerMsg);
        yield { type: 'steer', content: steer };
      }

      // ── turn_start event ──
      await this.events.emit('turn_start', { iteration: i, maxIterations: this.maxIterations, messageCount: this.messages.length });

      const iterLabel = this.maxIterations > 1 ? ` [${i + 1}/${this.maxIterations}]` : '';
      yield { type: 'thinking', content: `thinking${iterLabel}` };

      // ── before_compact event ──
      if (!this.compactionInProgress && this.contextTracker.shouldCompact(COMPACT_THRESHOLD)) {
        const compactEvent = { messageCount: this.messages.length, cancel: false, customSummary: undefined as string | undefined };
        await this.events.emit('before_compact', compactEvent);
        if (!compactEvent.cancel) {
          this.compactionInProgress = true;
          try { await this.compactConversation(compactEvent.customSummary); }
          catch (e) {
            if (!this.silent) process.stderr.write(`  ${C.dim}Compaction failed: ${e} — falling back to truncation${C.reset}\n`);
            const keep = COMPACT_HEAD_KEEP + COMPACT_TAIL_KEEP;
            if (this.messages.length > keep) {
              const head = this.messages.slice(0, COMPACT_HEAD_KEEP);
              const tail = this.messages.slice(-COMPACT_TAIL_KEEP);
              const truncMsg: Message = {
                role: 'user',
                content: `[Conversation truncated — ${this.messages.length - keep} older messages removed to stay within context limit]`
              };
              this.messages = [...head, truncMsg, ...tail];
            }
          }
          finally { this.compactionInProgress = false; }
        }
      }

      // ── before_request event ──
      const reqEvent = { messages: this.messages, systemPrompt: this.systemPrompt, model: this.model, stream: true };
      await this.events.emit('before_request', reqEvent);

      // ── API call with abort signal and retry ──
      let res: Response;
      try {
        res = await fetchWithRetry(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
          body: JSON.stringify(this.getRequestBody(true, { messages: reqEvent.messages, systemPrompt: reqEvent.systemPrompt })),
          signal
        });
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          this.messages.push({ role: 'assistant', content: '[interrupted by user]' });
          yield { type: 'interrupted' };
          return;
        }
        throw e;
      }

      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      if (!res.body) throw new Error('No response body for streaming');

      // Parse SSE stream
      let assistantContent = '';
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let usage: import('./types.js').Usage | null = null;
      let streamAborted = false;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          if (signal?.aborted) { streamAborted = true; break; }
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            let parsed;
            try { parsed = JSON.parse(data); } catch { continue; }

            // Capture usage from any chunk that has it (may coexist with delta)
            if (parsed.usage) usage = parsed.usage;

            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            // Text content
            if (delta.content) {
              assistantContent += delta.content;
              yield { type: 'text', content: delta.content };
            }

            // Tool calls (streamed incrementally)
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls.has(idx)) {
                  toolCalls.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
                }
                const entry = toolCalls.get(idx)!;
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) {
                  entry.name = tc.function.name;
                  // Show tool names as they arrive (replaces spinner in real-time)
                  const names = [...toolCalls.values()].map(t => t.name).filter(Boolean);
                  const unique = [...new Set(names)];
                  const label = unique.length === 1 && unique[0] === 'agent'
                    ? `preparing ${names.length} sub-agent${names.length > 1 ? 's' : ''}`
                    : `preparing ${names.join(', ')}`;
                  yield { type: 'thinking', content: label };
                }
                if (tc.function?.arguments) entry.arguments += tc.function.arguments;
              }
            }
          }
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          streamAborted = true;
        } else { throw e; }
      } finally {
        try { reader.cancel(); } catch { /* already closed */ }
      }

      // If aborted during streaming, discard partial message
      if (streamAborted) {
        this.messages.push({ role: 'assistant', content: '[interrupted by user]' });
        yield { type: 'interrupted' };
        return;
      }

      if (usage) this.contextTracker.update(usage);

      // Build assistant message
      const msg: Message = { role: 'assistant', content: assistantContent || null, _turn: this.currentTurn };
      if (toolCalls.size > 0) {
        msg.tool_calls = Array.from(toolCalls.values()).map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments }
        }));
      }

      // ── after_response event ──
      await this.events.emit('after_response', { message: msg, usage: usage ?? undefined });

      this.messages.push(msg);
      this.appendToHistory(msg);

      if (!msg.tool_calls?.length) {
        // ── turn_end event (no tools) ──
        await this.events.emit('turn_end', { iteration: i, hadToolCalls: false, toolCallCount: 0 });

        // ── turn summarization (for turns with enough tool calls) ──
        if (turnToolCallCount >= TURN_SUMMARY_THRESHOLD && !this.silent) {
          const turnMsgs = this.messages.slice(this.turnMessageStartIndex);
          summarizeTurn(turnMsgs, this.currentTurn, {
            baseURL: this.baseURL, apiKey: this.apiKey, model: this.model,
          }, this.turnMessageStartIndex, true).then(summary => {
            this.turnSummaries.set(this.currentTurn, summary);
            this.saveSessionState();
          }).catch(() => { /* summary failure is non-fatal */ });
        } else if (!this.silent) {
          this.saveSessionState();
        }

        const doneText = typeof msg.content === 'string' ? msg.content
          : Array.isArray(msg.content) ? msg.content.filter((b): b is import('./types.js').TextBlock => b.type === 'text').map(b => b.text).join('')
          : '';
        yield { type: 'done', content: doneText };
        return;
      }

      // Notify consumers that tools are about to run
      if (msg.tool_calls.length > 1) {
        const names = msg.tool_calls.map((c: import('./types.js').ToolCall) => c.function.name);
        const unique = [...new Set(names)];
        const label = unique.length === 1 && unique[0] === 'agent'
          ? `${names.length} sub-agents running`
          : `${names.length} tools: ${unique.join(', ')}`;
        yield { type: 'thinking', content: label };
      }
      for (const call of msg.tool_calls) {
        const args = (() => { try { return JSON.parse(call.function.arguments || '{}'); } catch { return null; } })();
        const summary = args
          ? String(args.command ?? args.action ?? args.prompt ?? call.function.name).slice(0, 80)
          : `${call.function.name} (malformed arguments)`;
        yield { type: 'tool_start' as const, toolName: call.function.name, toolCallId: call.id, content: summary };
      }

      // Permission checks — run sequentially so prompts don't overlap
      const permissionDecisions = new Map<string, 'allow' | 'deny'>();
      for (const call of msg.tool_calls) {
        if (signal?.aborted) break;
        const tool = this.tools.get(call.function.name);
        if (!tool) continue;
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.function.arguments || '{}'); }
        catch { permissionDecisions.set(call.id, 'deny'); continue; }
        if (this.confirmToolCall && !isReadOnlyToolCall(call.function.name, args)) {
          permissionDecisions.set(call.id, await this.confirmToolCall(call.function.name, args, tool.permissionKey));
        }
      }

      // ── Checkpoint file backups before write tools execute ──
      if (this.checkpointStore && this.currentCheckpointId) {
        for (const call of msg.tool_calls) {
          if (!isReadOnlyToolCall(call.function.name, (() => { try { return JSON.parse(call.function.arguments || '{}'); } catch { return {}; } })())) {
            const args = (() => { try { return JSON.parse(call.function.arguments || '{}'); } catch { return {}; } })();
            const filePath = (args.path || args.file_path) as string | undefined;
            if (filePath) this.checkpointStore.backupFile(this.currentCheckpointId, filePath);
          }
        }
      }

      // Execute tool calls — yield results as they complete (not Promise.all)
      const execPromises = msg.tool_calls.map(async (call) => {
        if (signal?.aborted) return { call, content: '[cancelled by user]', isError: true };
        const tool = this.tools.get(call.function.name);
        if (!tool) return { call, content: `Error: unknown tool "${call.function.name}"`, isError: true };
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.function.arguments || '{}'); }
        catch { return { call, content: 'Error: malformed tool arguments', isError: true }; }

        if (permissionDecisions.get(call.id) === 'deny') {
          return { call, content: 'Tool call denied by user.', isError: true };
        }

        // ── tool_call event ──
        const tcEvent = { toolName: call.function.name, toolCallId: call.id, args, block: false, blockReason: undefined as string | undefined };
        await this.events.emit('tool_call', tcEvent);
        if (tcEvent.block) {
          return { call, content: tcEvent.blockReason || 'Blocked by extension', isError: true };
        }
        args = tcEvent.args as Record<string, unknown>;

        try {
          const rawResult = await tool.execute(args);
          let result = truncateToolResult(rawResult);
          let isError = result.startsWith('Error:') || result.startsWith('EXIT ');

          // ── tool_result event ──
          const trEvent = { toolName: call.function.name, toolCallId: call.id, args, content: result, isError };
          await this.events.emit('tool_result', trEvent);
          result = trEvent.content;
          isError = trEvent.isError;

          return { call, content: result, isError };
        } catch (error) {
          return { call, content: `Tool error: ${error}`, isError: true };
        }
      });

      // Yield results as they resolve (not waiting for all)
      const completedCallIds = new Set<string>();
      for await (const r of raceAll(execPromises)) {
        completedCallIds.add(r.call.id);

        // If a content(get) or result(get) tool was called, inject the actual content
        let toolContent: string | ContentBlock[] = r.content;
        const requestedContent = consumeRequestedRefs();
        const requestedResults = consumeRequestedResults();
        if (requestedContent.size > 0 || requestedResults.size > 0) {
          const blocks: ContentBlock[] = [{ type: 'text', text: r.content }];
          for (const refId of requestedContent) {
            const ref = getContentRef(refId);
            if (ref) {
              try { blocks.push(resolveContent(ref)); } catch { /* cache miss — skip */ }
            }
          }
          for (const refId of requestedResults) {
            const ref = getResultRef(refId);
            if (ref) {
              const full = resolveResult(ref);
              if (!full.startsWith('Error:')) blocks.push({ type: 'text', text: full });
            }
          }
          if (blocks.length > 1) toolContent = blocks;
        }

        // Cache large tool results as ResultRefs (send-once pattern)
        if (typeof toolContent === 'string' && !r.isError && toolContent.length > RESULT_REF_THRESHOLD) {
          let args: Record<string, unknown> | undefined;
          try { args = JSON.parse(r.call.function.arguments || '{}'); } catch { /* ignore */ }
          const resultRef = cacheResult(r.call.function.name, toolContent, this.currentTurn, this.cwd, args);
          // On introduction turn: send full content + ref metadata
          toolContent = [
            { type: 'text', text: toolContent },
            resultRef,
          ];
        }

        this.messages.push({ role: 'tool', tool_call_id: r.call.id, content: toolContent, _turn: this.currentTurn });
        this.appendToHistory({ role: 'tool', tool_call_id: r.call.id, content: toolContent });
        yield { type: 'tool_end', toolName: r.call.function.name, toolCallId: r.call.id, content: r.content, success: !r.isError };

        // Check abort after each tool completes
        if (signal?.aborted) break;
      }

      // Re-estimate context so shouldCompact() reflects tool result sizes
      if (!signal?.aborted) {
        this.contextTracker.estimateFromChars(this.getTotalContextChars());
        saveResultIndex(this.cwd);
      }

      // Fill placeholders for any tool calls that didn't complete (API requires all tool_call_ids)
      if (signal?.aborted && msg.tool_calls) {
        for (const call of msg.tool_calls) {
          if (!completedCallIds.has(call.id)) {
            const placeholder: Message = { role: 'tool', tool_call_id: call.id, content: '[cancelled by user]' };
            this.messages.push(placeholder);
            this.appendToHistory(placeholder);
          }
        }
        this.messages.push({ role: 'assistant', content: '[interrupted by user]' });
        yield { type: 'interrupted', content: `${completedCallIds.size} completed, ${msg.tool_calls.length - completedCallIds.size} cancelled` };
        return;
      }

      // ── turn_end event ──
      turnToolCallCount += msg.tool_calls.length;
      await this.events.emit('turn_end', { iteration: i, hadToolCalls: true, toolCallCount: msg.tool_calls.length });
    }
    yield { type: 'max_iterations' };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Return the char-size breakdown of every context component */
  getContextBreakdown(): Array<{ label: string; chars: number }> {
    const parts: Array<{ label: string; chars: number }> = [];
    parts.push({ label: 'System prompt', chars: this.baseSystemPrompt.length });
    parts.push({ label: 'Environment', chars: getEnvironmentContext(this.cwd).length });
    const listing = getProjectListing(this.cwd);
    if (listing) parts.push({ label: 'Project files', chars: listing.length });

    // cachedContext contains global memory + project memory + plan, but we want them separate
    const globalMem = loadGlobalMemory(this.cwd);
    const projectMem = loadProjectMemory(this.cwd);
    const plan = loadPlan(this.cwd);
    if (globalMem) parts.push({ label: 'Global memory', chars: globalMem.length + '<global-memory>\n\n</global-memory>'.length });
    if (projectMem) parts.push({ label: 'Project memory', chars: projectMem.length + '<project-memory>\n\n</project-memory>'.length });
    if (plan) parts.push({ label: 'Plan', chars: plan.length + 50 /* tags + header */ });

    if (this.cachedCatalog) parts.push({ label: 'Skill catalog', chars: this.cachedCatalog.length });
    if (this.cachedAlwaysOn) parts.push({ label: 'Always-on skills', chars: this.cachedAlwaysOn.length });
    if (this.activeSkillContent.length > 0) {
      parts.push({ label: 'Active skills', chars: this.activeSkillContent.join('\n\n').length });
    }

    // Tool definitions (sent in every API call as the tools array)
    const builtinChars = Array.from(this.tools.values())
      .filter(t => this.builtinToolNames.has(t.function.name))
      .reduce((sum, t) => sum + JSON.stringify({ type: t.type, function: t.function }).length, 0);
    const customChars = Array.from(this.tools.values())
      .filter(t => !this.builtinToolNames.has(t.function.name))
      .reduce((sum, t) => sum + JSON.stringify({ type: t.type, function: t.function }).length, 0);
    if (builtinChars > 0) parts.push({ label: 'Tool definitions', chars: builtinChars });
    if (customChars > 0) parts.push({ label: 'Custom tools', chars: customChars });

    // Messages (conversation history)
    let contentChars = 0;
    const msgChars = this.messages.reduce((sum, m) => {
      let size: number;
      if (typeof m.content === 'string') {
        size = m.content.length;
      } else if (Array.isArray(m.content)) {
        size = 0;
        for (const block of m.content) {
          if (block.type === 'text') size += block.text.length;
          // content_ref and image_url/file blocks handled by estimateMessageContentChars
        }
        contentChars += estimateMessageContentChars(m, this.currentTurn);
      } else {
        size = 0;
      }
      if (m.tool_calls) size += JSON.stringify(m.tool_calls).length;
      return sum + size;
    }, 0);
    if (msgChars > 0) parts.push({ label: 'Messages', chars: msgChars });
    if (contentChars > 0) parts.push({ label: 'Content', chars: contentChars });

    return parts;
  }

  getTools(): Array<{ name: string; description: string; isBuiltin: boolean }> {
    return Array.from(this.tools.values()).map(t => ({
      name: t.function.name,
      description: t.function.description,
      isBuiltin: this.builtinToolNames.has(t.function.name),
    }));
  }
  getToolFailures(): Array<{ file: string; name?: string; reason: string }> { return this.toolFailures; }
  getModel(): string { return this.model; }
  getBaseURL(): string { return this.baseURL; }
  getApiKey(): string { return this.apiKey; }
  getCwd(): string { return this.cwd; }
  isSilent(): boolean { return this.silent; }

  /** Queue a message to inject before the next LLM turn (non-destructive steering) */
  queueSteer(message: string): void {
    this.steerQueue.push(message);
  }
  setModel(model: string): void { this.model = model; this.contextTracker = new ContextTracker(model); }
  setBaseURL(url: string): void { this.baseURL = url; }
  getConfirmToolCall(): ConfirmToolCall | null { return this.confirmToolCall; }
  setConfirmToolCall(cb: ConfirmToolCall | null): void { this.confirmToolCall = cb; }
  async compactNow(): Promise<void> { await this.compactConversation(); }

  async fetchModels(query?: string): Promise<Array<{ id: string; name: string; context_length: number; pricing?: { prompt?: string; completion?: string } }>> {
    const res = await fetchWithRetry(`${this.baseURL}/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` }
    });
    if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
    const data = await res.json() as { data: Array<{ id: string; name: string; context_length: number; pricing?: { prompt?: string; completion?: string } }> };
    let models = data.data || [];
    if (query) {
      const q = query.toLowerCase();
      models = models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    }
    return models;
  }

  getSkills(): SkillMeta[] { return this.allSkills; }
  getActiveSkillNames(): string[] {
    const names: string[] = [];
    for (const c of this.activeSkillContent) {
      const match = c.match(/name="([^"]+)"/);
      if (match) names.push(match[1]);
    }
    return names;
  }
  refreshSkills(): void { this.allSkills = discoverSkills(this.cwd); this.refreshCache(); }

  getStats(): MemoryStats { return getStats(this.cwd); }
  getPaths() { return paths(this.cwd); }

  getGlobalMemory(): string { return loadGlobalMemory(this.cwd); }
  getProjectMemory(): string { return loadProjectMemory(this.cwd); }
  getPlan(): string { return loadPlan(this.cwd); }
  getPlanByName(name: string): string { return loadPlanByName(name, this.cwd); }
  getPlans() { return listPlans(this.cwd); }

  setGlobalMemory(content: string): void { saveGlobalMemory(content, this.cwd); }
  setProjectMemory(content: string): void { saveProjectMemory(content, this.cwd); }
  setPlan(content: string, name?: string): void { savePlan(content, name, this.cwd); }
  appendToPlan(content: string): void { appendPlan(content, this.cwd); }
  activatePlan(name: string): void { setActivePlan(name, this.cwd); }
  getActivePlanName(): string | null { return getActivePlanName(this.cwd); }

  clearProject(): void { this.messages = []; this.contextTracker.reset(); this.checkpointStore?.clear(); this.turnSummaries.clear(); clearProject(this.cwd); }
  clearAll(): void { this.messages = []; this.contextTracker.reset(); this.checkpointStore?.clear(); this.turnSummaries.clear(); clearAll(this.cwd); }

  // ── Context tracking ───────────────────────────────────────────────────
  getContextUsage(): string { return this.contextTracker.format(); }
  getContextDetails(): string { return this.contextTracker.formatDetailed(); }
  getContextTracker(): ContextTracker { return this.contextTracker; }
  getSystemPromptSize(): number { return this.systemPrompt.length; }
  getMessages(): Message[] { return [...this.messages]; }
  getTurnSummaries(): Map<number, TurnSummary> { return new Map(this.turnSummaries); }
  getCheckpointStore(): CheckpointStore | null { return this.checkpointStore; }
  getEvents(): AgentEventEmitter { return this.events; }

  /** Truncate conversation to a specific message index (for rewind) */
  truncateMessages(toIndex: number): void {
    this.messages = this.messages.slice(0, toIndex);
    // Rewrite history to match the rewound state
    if (!this.noHistory) rewriteHistory(this.messages, this.cwd);
  }

  /** Inject a summary message after rewind */
  injectSummary(summary: string): void {
    this.messages.push({
      role: 'user',
      content: `[Rewound — summary of subsequent work]\n\n${summary}`,
    });
  }
  /** Total estimated chars across all context components (system prompt + tools + messages) */
  getTotalContextChars(): number {
    return this.getContextBreakdown().reduce((sum, p) => sum + p.chars, 0);
  }
}
