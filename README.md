# ag

A persistent AI coding agent with memory. Any model via OpenRouter.

Built as a tool-calling loop with bash — inspired by [How does Claude Code actually work?](https://youtu.be/I82j7AzMU80). Features streaming responses, parallel tool execution, permission prompts, and persistent memory.

## Install

```bash
npx @elementics/ag                     # run directly (prompts for API key on first use)
npm install -g @elementics/ag          # or install globally
```

Or from source:

```bash
git clone https://github.com/elementics/ag
cd ag
npm install && npm run build && npm link
```

## Usage

```bash
ag                              # interactive REPL (prompts before writes/commands)
ag -y                           # auto-approve all tool calls
ag "what files are here?"       # one-shot mode (auto-approves)
ag -m openai/gpt-4o "help me"  # specific model
ag -m openrouter/auto "help"   # let OpenRouter pick
ag --stats                      # show memory status
ag --help                       # all options
```

On first run, `ag` prompts for your OpenRouter API key and saves it to `~/.ag/config.json`. You can also set it via environment variable:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
```

## CLI Options

```
-m, --model <model>       Model ID (default: anthropic/claude-sonnet-4.6)
-k, --key <key>           API key (or set OPENROUTER_API_KEY)
-s, --system <prompt>     Custom system prompt
-b, --base-url <url>      API base URL (default: OpenRouter; use for local LLMs)
-n, --max-iterations <n>  Max tool-call iterations (default: 200)
-c, --content <path>      Attach image/PDF (repeatable: -c img.png -c doc.pdf)
-y, --yes                 Auto-approve all tool calls (skip confirmation prompts)
    --stats               Show memory file paths and status
-h, --help                Show help
```

## Steering

Press **Tab** while the agent is working to course-correct without aborting. This opens a `steer>` prompt with full editing support (backspace, arrow keys, paste). Output is buffered while you type.

- **Tab** — opens steer prompt, pauses output
- **Enter** — submits the steer message and resumes. The LLM sees it on the next turn.
- **Escape** — aborts everything (destructive, same as before)

```
you> build an API with auth

  ⠧ [bash] npm init...
                                          ← press Tab
  steer> use PostgreSQL not SQLite        ← type your correction
                                          ← press Enter
  [steered] use PostgreSQL not SQLite
  ✓ [bash] done                           ← buffered output replays
  ⠧ thinking [2/200]                      ← LLM adjusts
```

Steer messages are queued and injected before the next LLM call — current tool calls are not interrupted.

## REPL Commands

All commands follow the pattern: `/noun` to show, `/noun subcommand` to act.

```
/help                       Show all commands
/model                      Show current model
/model <name>               Switch model (persists to config)
/model search [query]       Browse OpenRouter models
/memory                     Show all memory + stats
/memory global              Show global memory
/memory project             Show project memory
/memory clear project|all   Clear memory
/plan                       Show current plan
/plan list                  List all plans
/plan use <name>            Activate an older plan
/checkpoint [label]          Create a named checkpoint
/checkpoint list            View all checkpoints
/rewind                     Rewind to a checkpoint (interactive)
/rewind last                Quick rewind to most recent checkpoint
/context                    Show context window usage with per-component breakdown
/context compact            Force context compaction now
/config                     Show config + file paths
/config set <k> <v>         Set a config value
/config unset <k>           Remove a config value
/tools                      List loaded tools
/skill                      List installed skills
/skill search [query]       Search skills.sh registry
/skill add <source>         Install skill from registry
/skill remove <name>        Uninstall a skill
/content add <path>         Add image/PDF as [content #N]
/content list               List content refs in session
/content paste              Paste image from clipboard
/content screenshot         Capture screen region
/content clear              Clear all content refs
/permissions                Show permission rules
/permissions allow <p>      Add allow rule (session)
/permissions deny <p>       Add deny rule (session)
/permissions save           Save session rules to project
/permissions clear          Clear session rules
/exit                       Exit
```

## Tools

All action-based tools follow the pattern: `tool(action, ...params)`.

| Tool | Actions | Purpose |
|------|---------|---------|
| `bash` | `background`, `output`, `kill` | Run shell commands; background mode for dev servers |
| `file` | `read` · `list` · `write` · `edit` | Read, browse, create, and edit files |
| `memory` | `save` | Persist a fact to global or project memory |
| `plan` | `save`, `append`, `switch`, `list`, `read` | Manage task plans |
| `git` | `status`, `init`, `branch`, `commit`, `push` | Git workflow |
| `grep` | `search`, `find` | Search file contents (regex), find files by glob |
| `web` | `fetch`, `search` | Fetch web pages, search for current info |
| `content` | `add`, `list`, `paste`, `screenshot`, `clear` | Attach images/PDFs to messages |
| `task` | `create`, `list`, `update`, `read`, `remove`, `clear` | Track tasks for multi-step work |
| `result` | `get`, `info` | Retrieve cached tool results by ref ID |
| `history` | `search`, `recent` | Search or browse conversation history |
| `agent` | — | Spawn sub-agents for parallel work |
| `skill` | — | Activate a skill by name |

### Background Processes

For dev servers, watchers, and long-running processes, use `background=true`:

```
bash(command="npm run dev", background=true)   → PID 12345, returns immediately
bash(action="output", pid=12345)               → read recent output
bash(action="kill", pid=12345)                  → stop the process
```

Background processes are tracked by PID. Output is buffered (100KB rolling). All background processes are killed on exit.

### Sub-Agents

Spawn independent agents to work on tasks in parallel:

```
agent(prompt="Research auth best practices for Node.js")
agent(prompt="Set up the database schema", taskId=2)
agent(prompt="Write unit tests", model="anthropic/claude-haiku")
```

Sub-agents get project memory, plan, skills, tools, and extensions but start with a clean context (no conversation history). When linked to a task via `taskId`, the task is auto-marked `in_progress` at start and `done` on completion. Tasks can include a `description` for richer context.

Multiple `agent()` calls in the same turn run in parallel. Use `model` to route cheap tasks to faster/cheaper models. Sub-agents run silently — only the parent shows `[agent]` start/result lines.

Sub-agents cannot spawn sub-sub-agents (depth limit = 1). Extensions loaded on sub-agents can check `agent.isSilent()` to avoid output.

## Custom Tools

Drop a `.mjs` file in a tools directory and it gets loaded at startup:

```
~/.ag/tools/          # global (all projects)
.ag/tools/            # project-local (overrides global if same name)
```

Each file exports a default tool object:

```js
// ~/.ag/tools/weather.mjs
export default {
  type: "function",
  function: {
    name: "weather",
    description: "Get current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"]
    }
  },
  execute: ({ city }) => {
    // your logic here -- can be async
    return `Weather in ${city}: sunny, 22C`;
  }
};
```

That's it. No config, no registry. Use `/tools` in the REPL to see what's loaded.

### Permission Keys

By default, custom tools require approval for every call (or you allow all calls with `toolname(*)`). To enable fine-grained permission patterns, add a `permissionKey` to your tool:

```js
// .ag/tools/deploy.mjs
export default {
  type: "function",
  function: {
    name: "deploy",
    description: "Deploy to an environment",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["staging", "production"] },
        branch: { type: "string" }
      },
      required: ["target"]
    }
  },
  permissionKey: { qualifier: "target" },
  execute: async ({ target, branch }) => { /* ... */ }
};
```

Now permission patterns can target specific argument values:

| Pattern | Effect |
|---------|--------|
| `deploy(staging)` | Allow staging deploys |
| `deploy(production)` | Allow production deploys |
| `deploy(*)` | Allow all deploys |

**`permissionKey` fields:**

- `qualifier` (required) — arg name whose value becomes the pattern qualifier. E.g., `{ qualifier: "target" }` + `target: "staging"` produces `deploy(staging)`.
- `value` (optional) — arg name whose value is matched by the glob portion. E.g., `{ qualifier: "action", value: "path" }` produces `mytool(read:configs/**)`.

Without `permissionKey`, the only available pattern is `toolname(*)`.

## Skills

Skills are reusable prompt instructions (with optional tools) that the agent activates on-demand. Browse and install from [skills.sh](https://skills.sh):

```bash
/skill search frontend        # search the registry
/skill add anthropic/skills@frontend   # install
/skill                        # list installed
/skill remove frontend        # uninstall
```

Skills are SKILL.md files with YAML frontmatter:

```
~/.ag/skills/          # global (all projects)
.ag/skills/            # project-local (overrides global)
```

```markdown
---
name: my-skill
description: When to use this skill. The agent sees this to decide activation.
---

Your instructions here. The agent loads this content when the skill is activated.
```

Frontmatter fields: `name` (required), `description` (required), `tools: true` (look for tools.mjs alongside), `always: true` (always inject, don't wait for activation).

The agent sees skill names + descriptions in every prompt. When a task matches, it activates the skill automatically via the `skill` tool, loading the full instructions into context.

## Extensions

Extensions hook into the agent's lifecycle to intercept, modify, or extend behavior. Place TypeScript files in `.ag/extensions/` (project) or `~/.ag/extensions/` (global).

```typescript
// .ag/extensions/log-tools.ts
export const name = 'log-tools';
export const description = 'Logs tool calls and errors';

export default function(agent: any) {
  agent.on('tool_call', (event: any) => {
    agent.log(`[log-tools] ${event.toolName}(${JSON.stringify(event.args).slice(0, 80)})`);
  });

  agent.on('tool_result', (event: any) => {
    if (event.isError) agent.log(`[log-tools] error in ${event.toolName}: ${event.content.slice(0, 100)}`);
  });
}
```

Extensions export `name` and `description` for the startup display. Use `agent.log()` instead of `process.stderr.write()` for spinner-safe output.

At startup you'll see:
```
Loaded: global, 3 skill(s), 1 extension(s)
  + log-tools  [extension] Logs tool calls and errors
```
```

### Available Events

Fields marked † are writable — mutations affect agent behavior.

| Event | All fields | Writable |
|-------|-----------|---------|
| `input` | content, skip | content†, skip† |
| `turn_start` | iteration, maxIterations, messageCount | — |
| `before_request` | messages, systemPrompt, model, stream, baseURL, provider, maskedKey, compacted | messages†, systemPrompt† |
| `request_ready` | url, body | — |
| `after_response` | message, usage, finishReason, model, baseURL, provider | — |
| `tool_call` | toolName, toolCallId, args, block, blockReason | args†, block†, blockReason† |
| `tool_result` | toolName, toolCallId, args, content, isError | content†, isError† |
| `before_compact` | messageCount, cancel, customSummary | cancel†, customSummary† |
| `after_compact` | messagesRemoved, newMessageCount, summaryPreview | — |
| `turn_end` | iteration, hadToolCalls, toolCallCount | — |
| `checkpoint_create` | id, label, messageIndex, turnNumber | — |
| `checkpoint_restore` | id, mode, cancel | cancel† |

Handlers run sequentially — each handler sees mutations from previous handlers. Use `agent.on(event, handler)` which returns an unsubscribe function. Use `agent.log(message)` for spinner-safe output.

### Examples

Block dangerous commands:
```typescript
agent.on('tool_call', (event: any) => {
  if (event.toolName === 'bash' && event.args.command?.includes('rm -rf /')) {
    event.block = true;
    event.blockReason = 'Blocked: dangerous command';
  }
});
```

Inject context before every LLM call:
```typescript
agent.on('before_request', (event: any) => {
  event.systemPrompt += '\n\nAlways respond in Spanish.';
});
```

Custom compaction:
```typescript
agent.on('before_compact', (event: any) => {
  event.customSummary = 'Working on auth feature. Files: src/auth.ts, src/middleware.ts';
});
```

Observe finish reason after each LLM response:
```typescript
agent.on('after_response', (event: any) => {
  if (event.finishReason === 'max_tokens') {
    agent.log(`[monitor] hit token limit on ${event.model}`);
  }
});
```

Log API metadata on each request:
```typescript
agent.on('before_request', (event: any) => {
  agent.log(`[monitor] → ${event.provider}/${event.model} (compacted: ${event.compacted})`);
});
```

Log compaction results:
```typescript
agent.on('after_compact', (event: any) => {
  agent.log(`[compact] removed ${event.messagesRemoved} messages → ${event.newMessageCount} remain`);
});
```

## Custom Tools

Drop a `.mjs` file into `~/.ag/tools/` (global) or `.ag/tools/` (project-local) to add a tool the agent can call:

```javascript
// ~/.ag/tools/notify.mjs
export default {
  type: 'function',
  function: {
    name: 'notify',
    description: 'Send a desktop notification',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Notification text' } },
      required: ['message']
    }
  },
  async execute({ message }) {
    // call your notification service, run osascript, etc.
    return `Notified: ${message}`;
  }
};
```

Add `permissionKey` to plug into the permissions system — ag will prompt with `deploy(staging)` or `deploy(production)` as the pattern:

```javascript
// .ag/tools/deploy.mjs
export default {
  type: 'function',
  function: {
    name: 'deploy',
    description: 'Deploy to staging or production',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', enum: ['staging', 'production'] } },
      required: ['target']
    }
  },
  permissionKey: { qualifier: 'target' },
  async execute({ target }) {
    return `Deployed to ${target}`;
  }
};
```

Or register a tool at runtime from an extension using `agent.addTool()`:

```typescript
export default function(agent: any) {
  agent.addTool({
    type: 'function',
    function: {
      name: 'ping',
      description: 'Ping a host and return latency',
      parameters: {
        type: 'object',
        properties: { host: { type: 'string' } },
        required: ['host']
      }
    },
    execute: async ({ host }: { host: string }) => {
      return `pong from ${host}`;
    }
  });
}
```

## Configuration

Persistent settings are stored in `~/.ag/config.json`:

```json
{
  "apiKey": "sk-or-v1-...",
  "model": "anthropic/claude-sonnet-4.6",
  "baseURL": "https://openrouter.ai/api/v1",
  "maxIterations": 25,
  "tavilyApiKey": "tvly-...",
  "contextLength": 131072
}
```

Set values via the REPL (`/config set model openai/gpt-4o`) or edit the file directly. Remove a value with `/config unset <key>` to revert to the default. CLI flags and environment variables always take priority over config file values.

For web search, get a free Tavily API key at [tavily.com](https://tavily.com) (no credit card needed). The agent prompts for it on first use, or set it manually:

```bash
export TAVILY_API_KEY=tvly-...
# or in the REPL:
/config set tavilyApiKey tvly-...
/config set TAVILY_API_KEY tvly-...    # env var name also works
```

## Memory

Three tiers, all plain markdown you can edit directly:

```
~/.ag/
  config.json                       # settings: API key, default model, base URL
  memory.md                         # global: preferences, patterns
  skills/                           # installed skills (from skills.sh or manual)
    frontend/SKILL.md
  tools/                            # custom tools (.mjs files)
  projects/
    <id>/
      memory.md                     # project: architecture, decisions
      plans/                        # timestamped plan files (created on demand)
        2026-04-13T12-31-22-add-auth.md
      tasks.json                    # task tracking (created on demand)
      history.jsonl                 # conversation history (created on demand)
      results/                     # cached tool results (send-once pattern)
        index.json
      checkpoints/                 # conversation + file checkpoints
        index.json
      session-state.json           # session resume context
```

All memory is injected into the system prompt on every API call (capped at ~4000 chars per section to avoid context bloat). The agent reads it automatically and writes via the `memory` and `plan` tools.

### Git workflow with memory

Save your ticket context and PR template to project memory, and the agent will use them when committing and pushing:

```
you> save to project memory: Current ticket: JIRA-123 Add user auth. PR template: ## What\n## Why\n## Testing
you> create a branch for this ticket and start working
```

The agent sees your memory context and will name branches, write commit messages, and format PR descriptions accordingly.

## Local LLMs

Point `ag` at any OpenAI-compatible API. No API key is needed when using a custom base URL:

```bash
ag -b http://localhost:11434/v1 -m gemma4 "hello"   # Ollama
ag -b http://localhost:1234/v1 -m llama3 "hello"     # LM Studio
```

Or set it permanently:

```bash
# In the REPL:
/config set baseURL http://localhost:11434/v1
/config set model gemma4
/config set contextLength 131072              # enables context tracking + auto-compaction
/config unset baseURL                         # back to OpenRouter default
```

Set `contextLength` to your model's context window size so that context tracking and auto-compaction work correctly. Without it, ag can't know the limit and won't compact automatically.

## Permissions

In REPL mode, ag prompts before executing mutating operations. You can allow once, remember for the session, or save to the project:

```
  ? bash: npm test (y)es / (a)lways / (p)roject / (n)o a
  + Session rule: bash(npm:*)
  ✓ [bash] All tests passed
  ? file(write): src/utils.ts (y)es / (a)lways / (p)roject / (n)o p
  + Saved to .ag/permissions.json: file(write:src/**)
  ✓ [file] Wrote src/utils.ts (24 lines, 680B)
```

**Prompt options:**
- **y** — allow this one time
- **a** — allow and remember the pattern for this session
- **p** — allow and save the pattern to project (`.ag/permissions.json`)
- **n** — deny this one time

### Pattern Syntax

Patterns use `Tool(qualifier:glob)` format:

| Pattern | Matches |
|---------|---------|
| `bash(npm:*)` | Any bash command starting with `npm` |
| `bash(git:*)` | Any bash command starting with `git` |
| `file(write:src/**)` | File writes anywhere under `src/` |
| `file(edit:*)` | All file edits |
| `git(commit)` | Git commit |
| `web(fetch:*github.com*)` | Fetch from GitHub domains |
| `bash(*)` | All bash commands |
| `*` | Everything |

### Rule Scopes

| Scope | Storage | Lifetime |
|-------|---------|----------|
| Session | In-memory | Until REPL exits |
| Project | `.ag/permissions.json` | Persists across sessions |
| Global | `~/.ag/permissions.json` | Persists everywhere |

Deny rules always override allow rules. Use `/permissions` to manage rules interactively.

### Built-in Classifications

**Always allowed (no prompt):** `file(read)`, `file(list)`, `grep(*)`, `memory(*)`, `plan(*)`, `skill(*)`, `git(status)`, `web(search)`, `task(*)`, `agent(*)`, `content(*)`, `result(*)`, `history(*)`

**Prompted:** `bash`, `file(write)`, `file(edit)`, `git(commit/push/branch)`, `web(fetch)`

**Always blocked:** `rm -rf /`, fork bombs, `sudo rm`, pipe-to-shell (enforced in code regardless of approval)

Skip all prompts with `ag -y` or `--yes`. One-shot mode (`ag "query"`) auto-approves.

## Guardrails

All externally-loaded tools and skills are scanned at load time for prompt injection and other security issues. This applies to:

- Custom tools (`.mjs` files in `~/.ag/tools/` and `.ag/tools/`)
- Skills (`SKILL.md` files in `~/.ag/skills/` and `.ag/skills/`)
- Skills installed from the registry via `/skill add`

**What gets checked:**

| Category | Severity | Examples |
|----------|----------|---------|
| Direct injection | Block | "ignore previous instructions", "system override", "reveal prompt" |
| Encoded payloads | Block | Base64-encoded injection attempts, HTML entity obfuscation |
| Hidden content | Block | HTML comments with instructions, zero-width characters, control chars |
| Exfiltration | Block/Warn | `fetch()` calls in descriptions (block), URLs/emails (warn) |
| Suspicious overrides | Warn | "bypass security", "auto-approve", "run without permission" |

**Blocked** items are skipped entirely with a warning. **Warned** items still load but emit a warning to stderr:

```
Warning: evil-tool.mjs blocked by guardrails: tool "evil" description: prompt injection: "ignore previous instructions"
Warning: shady-tool.mjs: tool "shady" description: description contains URL
```

When installing a skill from the registry, files are scanned before being written to disk. If the core `SKILL.md` is blocked, the entire installation is aborted.

## Streaming

Responses stream token-by-token with progressive markdown rendering. Tool execution shows animated spinners:

```
  ⠋ thinking [1/25]
  ✓ [grep] src/agent.ts:42: export class Agent
  ⠋ thinking [2/25]

agent> The Agent class is defined in src/agent.ts...
```

Tools execute in parallel when the model returns multiple tool calls.

## Workflow

- Environment context (date, OS, git branch, detected stack) is injected into every system prompt.
- A compact project file listing gives the model awareness of project structure.
- `tool_choice: "auto"` encourages tool use over conversational responses.
- Dangerous bash commands (`find ~`, `rm -rf /`, etc.) are blocked before execution.
- Tool results over 32KB are smart-truncated (first 100 + last 100 lines) to preserve context.
- For multi-step coding tasks, the agent creates a plan before starting and updates it as it goes.
- For simple questions, it just answers directly.
- At 200 iterations the REPL asks if you want to continue.
- Large tool results (>2KB) are cached to disk and replaced with summaries on subsequent turns — the LLM can retrieve full content on demand via `result(action=get)`.
- Large tool call arguments (file writes, edits) are collapsed after the introduction turn.
- Turns with 3+ tool calls are automatically summarized; older turns are replaced with summaries in API calls. Tool outputs from older turns are masked to save context (the agent can retrieve them on demand via result refs).
- Checkpoints are created automatically at each turn start. Use `/rewind` to roll back code, conversation, or both.
- A rolling window of the last 10 user messages is maintained in the system prompt across sessions, so the agent always knows what you asked for.
- The original user request is preserved through compaction — it always stays in context.
- At 90% context window usage, ag automatically summarizes older interactions to free space, then injects a context reconstruction message with the active plan and recent files. Use `/context compact` to trigger manually. Only interaction history is compacted — system prompt, tools, skills, memory, and environment are unaffected. Use `/context` to see a per-component breakdown (system prompt, environment, global memory, skill catalog, tool definitions, custom tools, interactions).

## When to use something else

- **Claude Code** -- if you have a subscription and want MCP, git worktrees, and a polished IDE integration. ag has sub-agents, tasks, and extensions but is terminal-only.
- **aider** -- if your workflow is git-centric (commit-per-change, diff-based editing).
- **Cursor / Windsurf** -- if you want IDE integration. ag is terminal-only.

ag is for when you want a hackable, persistent, model-agnostic agent you fully control.

## Architecture

```
src/
  cli.ts              # entry point
  cli/parser.ts       # arg parsing + help
  cli/repl.ts         # interactive REPL (unified /noun commands)
  core/agent.ts       # agent class, chat loop, tool execution, steering
  core/utils.ts       # spinner, retry, truncation, promise helpers
  core/prompt.ts      # environment detection, read-only rules, request building
  core/compaction.ts  # context compaction (summarize old messages)
  core/config.ts      # persistent config (~/.ag/config.json)
  core/context.ts     # context window usage tracking
  core/events.ts      # event system for extensions (8 lifecycle events)
  core/extensions.ts  # extension discovery and loading
  core/skills.ts      # skill discovery, parsing, loading
  core/registry.ts    # skills.sh search + GitHub install
  core/types.ts       # interfaces
  core/colors.ts      # ANSI colors (respects NO_COLOR)
  core/version.ts     # version from package.json
  core/constants.ts   # AG_DIR, ignore patterns, binary detection
  core/guardrails.ts  # prompt injection scanning (5 threat categories)
  core/loader.ts      # custom tool loader (~/.ag/tools/, .ag/tools/)
  core/permissions.ts # permission manager with glob pattern matching
  core/results.ts     # result ref cache (send-once for large tool outputs)
  core/summarization.ts # turn summarization (LLM-generated summaries)
  core/checkpoint.ts  # checkpoint store (file backups + conversation snapshots)
  memory/memory.ts    # memory, plans, tasks, history, session state
  tools/agent.ts      # sub-agent spawning (in-process, parallel)
  tools/bash.ts       # shell execution + background processes
  tools/file.ts       # file reading + directory listing
  tools/git.ts        # git operations tool
  tools/grep.ts       # code search + file find
  tools/memory.ts     # memory tool
  tools/plan.ts       # plan management tool
  tools/task.ts       # task tracking tool
  tools/web.ts        # web fetch + search tool
  tools/skill.ts      # skill activation tool
  tools/result.ts     # result retrieval tool
  tools/history.ts    # conversation history search tool
```

Zero npm dependencies. Node.js 20+ and TypeScript.

## License

Apache 2.0 — see [LICENSE](LICENSE)
