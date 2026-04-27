# Ag Developer Reference

Self-knowledge for Ag — used by the `self` tool to scaffold custom tools, skills, and extensions. 

When creating a skill, tool or extension interview me relentlessly about every aspect of this  until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer. Ask the questions one at a time. If a question can be answered by exploring the codebase, explore the codebase instead.

---

## Folder Layout

```
~/.ag/                    # global (all projects)
  tools/                  # custom tools (*.mjs)
  skills/                 # custom skills — each is a named directory
    my-skill/
      SKILL.md            # required — frontmatter + instructions
      tools.mjs           # optional — skill-scoped tools
      scripts/            # optional — scripts, helpers, assets (any structure)
      references/         # optional — reference files the skill uses
  extensions/             # custom extensions (*.mjs)
  ag.md                   # this file (edit freely)

.ag/                      # project-local (same structure, overrides global by name)
  tools/
  skills/
  extensions/
```

Local files override global when names match. Built-in tools cannot be overridden.

---

## Tool Interface

A tool is a `.mjs` file that exports a default object with `type`, `function`, and `execute`.

```ts
interface Tool {
  type: 'function';
  function: {
    name: string;           // snake_case, unique across all tools
    description: string;    // used by the model to decide when to call this tool
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required: string[];   // must be present even if empty ([])
    };
  };
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => string | Promise<string>;

  // Optional: marks which calls are safe in plan mode (no-write mode).
  // true = all calls are read-only.
  // string[] = only calls where action matches one of those values are read-only.
  readOnly?: true | string[];

  // Optional: declares which tool argument maps to the permission-system qualifier/value.
  // When set, Ag prompts the user before calling this tool (unless pre-approved).
  // qualifier: name of the arg whose value becomes the permission pattern qualifier
  //            e.g. qualifier: 'target' → permission key is "mytool(staging)"
  // value:     name of the arg whose value is matched by the glob portion (optional)
  permissionKey?: { qualifier: string; value?: string };
}
```

### Field notes

- **`required`** — always include this array, even if empty (`required: []`). Omitting it causes a load failure.
- **`readOnly`** — Ag runs in plan mode by default; tools without `readOnly` will prompt the user for approval on every call in that mode. Set `readOnly: true` for fully read-only tools; set `readOnly: ['list', 'read']` when only some actions are safe.
- **`permissionKey`** — omit entirely if you don't need per-call permission prompts. When present, `qualifier` must be the name of an arg whose runtime value is a string.
- **`signal`** — the AbortSignal passed to `execute` is cancelled when the user interrupts a turn. Check `signal.aborted` in long-running async tools.

### Guardrails

Tool files are scanned before loading. A tool is **rejected** (silently dropped with a load failure) if its `name`, `description`, or any parameter `description` contains:

- Prompt injection phrases ("ignore previous instructions", "system override", etc.)
- Hidden/control characters or zero-width characters
- Base64-encoded content that decodes to injection patterns
- Network call invocations (`fetch(`, `curl(`, etc.) in descriptions

A tool gets a **warning** (loads but logged) for: URLs in descriptions, email addresses, `webhook` references, suspicious "bypass permission" language, or a suspicious name (`system_override`, `sudo`, etc.).

<!-- template:tool -->
```js
export default {
  type: "function",
  function: {
    name: "{{name}}",
    description: "{{description}}",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["run"],
          description: "run: perform the action"
        }
      },
      required: ["action"]
    }
  },
  execute: ({ action }) => {
    switch (action) {
      case "run":
        return "TODO: implement";
      default:
        return `Error: unknown action "${action}"`;
    }
  }
};
```
<!-- /template:tool -->

---

## Skill Structure

A skill is a **directory** whose name is the skill name. The directory must contain a `SKILL.md` file with YAML frontmatter. Everything else in the directory is optional — add scripts, reference files, assets, or sub-folders as needed; they are available to the skill's content and tools at relative paths.

### SKILL.md Frontmatter

```yaml
---
name: my-skill            # required — must match the directory name
description: one-line description shown in /skill list and used by model for activation
always: false             # optional — if true, injected into every system prompt automatically
tools: true               # optional — set to true when the skill includes a tools.mjs file
---
```

**Frontmatter rules:**
- `name` and `description` are required. The skill is skipped silently if either is missing.
- `always: true` — skill body is wrapped in `<skill name="...">...</skill>` and appended to every system prompt. Use sparingly; it consumes context on every turn.
- `tools: true` — tells Ag the skill has a `tools.mjs` file to load. The file is loaded when the skill is activated; tools are registered on the agent for that session.
- Any other frontmatter keys are parsed but ignored.

### Skill body (SKILL.md after frontmatter)

Write the skill instructions as plain markdown. This is what the model reads when the skill is activated. Be direct and specific — the body becomes part of the system prompt for the session.

Good body structure:
- Start with a one-sentence purpose statement
- List any constraints or rules the model must follow
- Include examples of correct vs incorrect behavior if the skill is nuanced
- Reference bundled files by relative path if the skill has them (e.g. `See scripts/validate.py`)

### Skill folder layout

```
my-skill/
  SKILL.md          # required
  tools.mjs         # optional — registers tools when skill is activated
  scripts/          # optional — executable helpers referenced from SKILL.md
  references/       # optional — data files, templates, checklists
  assets/           # optional — images or other static content
```

There is no enforced sub-folder structure beyond `SKILL.md` and `tools.mjs`. Add whatever makes sense for your skill.

### tools.mjs in a skill

Export a default array (or single object) of tool definitions. Each tool follows the same interface as a standalone custom tool. They are loaded and registered when the skill is activated, and unregistered when the session ends.

```js
// my-skill/tools.mjs
export default [
  {
    type: "function",
    function: {
      name: "my_skill_action",
      description: "...",
      parameters: { type: "object", properties: {}, required: [] }
    },
    execute: () => "result"
  }
];
```

Tools in skills are subject to the same guardrails scan as standalone tools.

<!-- template:skill -->
```markdown
---
name: {{name}}
description: {{description}}
---

# {{name}}

{{description}}

## Instructions

TODO: describe what this skill does and how to use it. Be direct — this becomes part of the system prompt when the skill is active.

## Rules

- Rule one
- Rule two

## Examples

**Good:**
> example of correct behavior

**Avoid:**
> example of what not to do
```
<!-- /template:skill -->

---

## Extension Interface

An extension is a `.mjs` file that exports a default **async** function receiving the agent instance. Extensions are loaded once at startup before any conversation begins. Use them to hook into lifecycle events, register tools, or modify agent state.

```js
// .ag/extensions/my-extension.mjs
export default async function(agent) {
  // agent is the full Agent instance — all methods are available
  agent.on('turn_start', ({ iteration, maxIterations, messageCount }) => {
    // runs before each LLM request
  });
}
```

### Available events

All event names use underscores. Handlers receive a typed payload object.

| Event | Payload fields | When it fires |
|---|---|---|
| `turn_start` | `iteration`, `maxIterations`, `messageCount` | Before each LLM request |
| `turn_end` | `iteration`, `hadToolCalls`, `toolCallCount` | After each completed turn |
| `before_request` | `messages`, `systemPrompt`, `model`, `stream`, `baseURL?`, `provider?`, `maskedKey?`, `compacted?` | Before the API call is made |
| `request_ready` | `url`, `body` | After request body is fully resolved (read-only) |
| `after_response` | `message`, `usage?`, `finishReason?`, `model?`, `baseURL?`, `provider?` | After API response received |
| `tool_call` | `toolName`, `toolCallId`, `args`, `block?`, `blockReason?` | Before each tool executes |
| `tool_result` | `toolName`, `toolCallId`, `args`, `content`, `isError`, `terminateTurn?`, `terminationReason?` | After each tool completes |
| `input` | `content`, `skip?` | When user input arrives (set `skip = true` to suppress) |
| `before_compact` | `messageCount`, `cancel?`, `customSummary?` | Before conversation compaction (set `cancel = true` to abort, set `customSummary` to override) |
| `after_compact` | `messagesRemoved`, `newMessageCount`, `summaryPreview` | After compaction completes |
| `checkpoint_create` | `id`, `label?`, `messageIndex`, `turnNumber` | When a checkpoint is saved |
| `checkpoint_restore` | `id`, `mode`, `cancel?` | When a checkpoint restore is requested (set `cancel = true` to abort) |

### Useful agent methods in extensions

```js
agent.on(event, handler)          // subscribe to a lifecycle event; returns unsubscribe fn
agent.addTool(tool)               // register a tool at runtime
agent.log(message)                // spinner-safe output (use instead of console.log)
agent.isSilent()                  // true when running as a sub-agent
agent.queueSteer(message)         // inject a user message before the next turn
agent.getCwd()                    // project working directory
agent.getModel()                  // current model string
agent.setModel(model)             // switch model mid-session
agent.getInteractionMode()        // 'plan' | 'auto'
agent.setInteractionMode(mode)    // switch mode
agent.getGlobalMemory()           // read global memory content
agent.getProjectMemory()          // read project memory content
agent.setGlobalMemory(content)    // overwrite global memory
agent.setProjectMemory(content)   // overwrite project memory
agent.getPlan()                   // read active plan
agent.getCurrentTurn()            // current turn number
agent.getContextUsage()           // context usage summary string
agent.getStats()                  // MemoryStats object
agent.compactNow()                // trigger compaction immediately (async)
```

### Extension patterns

**Register a tool when a skill is activated:**
```js
export default async function(agent) {
  agent.on('turn_start', () => {
    if (agent.isSilent()) return; // skip in sub-agents
  });
  agent.addTool({ type: "function", function: { name: "my_tool", ... }, execute: () => "..." });
}
```

**Log every tool call (skip in sub-agents):**
```js
export default async function(agent) {
  agent.on('tool_call', ({ toolName, args }) => {
    if (!agent.isSilent()) agent.log(`→ ${toolName}`);
  });
}
```

**Inject context before compaction:**
```js
export default async function(agent) {
  agent.on('before_compact', (event) => {
    event.customSummary = `Project: ${agent.getCwd()}\n`;
  });
}
```

<!-- template:extension -->
```js
export default async function(agent) {
  agent.on('turn_start', ({ iteration, maxIterations, messageCount }) => {
    if (agent.isSilent()) return;
    // runs before each LLM request
    // agent.log('starting turn ' + iteration);
  });

  agent.on('turn_end', ({ iteration, hadToolCalls, toolCallCount }) => {
    // runs after each completed turn
  });

  agent.on('tool_call', ({ toolName, toolCallId, args }) => {
    // fires before each tool execution
  });

  agent.on('tool_result', ({ toolName, toolCallId, args, content, isError }) => {
    // fires after each tool execution
  });
}
```
<!-- /template:extension -->

---

## Action Naming Conventions

| Action   | Meaning                                      |
|----------|----------------------------------------------|
| create   | Create a new item                            |
| list     | List all items                               |
| read     | Read details of a specific item              |
| update   | Modify an existing item                      |
| remove   | Delete an item                               |
| enable   | Re-enable a disabled item                    |
| disable  | Disable an item without deleting it          |
| run      | Execute an operation (for single-action tools) |
| search   | Search/query items                           |
| clear    | Bulk-remove all items of a category          |

Use `action` as the first parameter for all multi-action tools. Follow these names exactly to stay consistent with Ag's built-in tools.
