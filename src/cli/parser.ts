import { CLIOptions } from '../core/types.js';

export function parseArgs(args: string[]): CLIOptions & { positional: string[] } {
  const options: CLIOptions = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--model' || arg === '-m') && i + 1 < args.length) options.model = args[++i];
    else if ((arg === '--key' || arg === '-k') && i + 1 < args.length) options.key = args[++i];
    else if ((arg === '--system' || arg === '-s') && i + 1 < args.length) options.system = args[++i];
    else if ((arg === '--base-url' || arg === '-b') && i + 1 < args.length) options.baseURL = args[++i];
    else if ((arg === '--max-iterations' || arg === '-n') && i + 1 < args.length) {
      const n = parseInt(args[++i], 10);
      if (!isNaN(n) && n > 0) options.maxIterations = n;
    }
    else if ((arg === '--content' || arg === '-c') && i + 1 < args.length) {
      if (!options.contentPaths) options.contentPaths = [];
      options.contentPaths.push(args[++i]);
    }
    else if (arg === '--stats') options.stats = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  return { ...options, positional };
}

export function showHelp(): void {
  console.log(`
ag - Persistent AI coding agent with memory and skills (any model via OpenRouter)

Usage:
  ag                              # Interactive REPL
  ag "what files are here?"       # One-shot mode
  ag --stats                      # Show memory stats
  ag -m openai/gpt-4o "help me"  # Use specific model

Options:
  -m, --model <model>       Model ID (default: anthropic/claude-sonnet-4.6)
  -k, --key <key>           API key (or set OPENROUTER_API_KEY)
  -s, --system <prompt>     Custom system prompt
  -b, --base-url <url>      API base URL (default: OpenRouter; use for local LLMs)
  -n, --max-iterations <n>  Max tool-call iterations (default: 200)
  -c, --content <path>      Attach image/PDF (repeatable: -c img.png -c doc.pdf)
  -y, --yes                 Auto-approve all tool calls (skip confirmation prompts)
      --stats               Show memory file locations and status
  -h, --help                Show this help

REPL commands:
  /model [name|search]     Show, switch, or browse models
  /memory [global|project|clear]  Show or manage memory
  /plan [list|use <name>]  Show or manage plans
  /config [set <k> <v>]    Show or set config
  /tools                   List loaded tools
  /skill [search|add|remove]  Manage skills from skills.sh
  /content [add|list|paste|screenshot|clear]  Manage attached content
  /help                    Show all commands
  /exit                    Exit

Install:
  npx @elementics/ag     # Run directly
  npm install -g @elementics/ag  # Install globally
`);
}
