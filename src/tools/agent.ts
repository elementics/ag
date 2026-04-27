/**
 * Agent tool — spawn in-process sub-agents for parallel work
 */

import { Tool } from '../core/types.js';
import type { ResultRef } from '../core/types.js';
import { withTasks } from '../memory/memory.js';
import type { Agent } from '../core/agent.js';
import { extractFileOps, summarizeTurn } from '../core/summarization.js';
import { getNextResultId, getAllResultRefs } from '../core/results.js';

function buildRefAppendix(refs: ResultRef[]): string {
  if (!refs.length) return '';
  const lines = refs.map(r =>
    `- ref #${r.id} [${r.tool_name}, ${r.size_chars.toLocaleString()} chars]: ${r.summary}`
  );
  return `\n\n---\nSub-agent result refs — use \`result\` tool to retrieve full content:\n${lines.join('\n')}`;
}

export function agentTool(parentAgent: Agent): Tool {
  return {
    type: 'function',
    function: {
      name: 'agent',
      description: 'Spawn a sub-agent to work on a task independently. Sub-agents get project memory, plan, skills, and tools but start with a clean context (no conversation history). To run agents in parallel, call this tool multiple times in a single response — all calls execute concurrently. Each agent runs autonomously and returns its result. For content-fetching tasks (web pages, files), pass `returnRaw: true` to return the response verbatim without summarization. When the sub-agent retrieves large content, result ref IDs are appended to the response — use the `result` tool with those IDs to retrieve the full untruncated content.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What the sub-agent should do. Be specific — the sub-agent has no conversation history.'
          },
          taskId: {
            type: 'number',
            description: 'Task ID to assign. Auto-marks in_progress at start, done on completion.'
          },
          model: {
            type: 'string',
            description: 'Override model for this agent (e.g. anthropic/claude-haiku for cheaper work)'
          },
          returnRaw: {
            type: 'boolean',
            description: 'Return the sub-agent\'s last response verbatim instead of summarizing. Use when the agent fetches content (web pages, files) that must not be compressed.'
          }
        },
        required: ['prompt']
      }
    },
    execute: async ({ prompt, taskId, model, returnRaw }: { prompt: string; taskId?: number; model?: string; returnRaw?: boolean }): Promise<string> => {
      const cwd = parentAgent.getCwd();

      // If taskId provided, validate and mark in_progress
      let taskTitle: string | undefined;
      let taskDescription: string | undefined;
      if (taskId != null) {
        const err = withTasks(cwd, tasks => {
          const task = tasks.find(t => t.id === taskId);
          if (!task) return `Error: task #${taskId} not found`;
          taskTitle = task.title;
          taskDescription = task.description;
          task.status = 'in_progress';
          return null;
        });
        if (err) return err;
      }

      // Build system prompt suffix with task context
      let suffix = '';
      if (taskId != null && taskTitle) {
        const descLine = taskDescription ? `\n${taskDescription}` : '';
        suffix = `<assigned-task id="${taskId}">\n${taskTitle}${descLine}\n</assigned-task>`;
      }

      // Dynamically import Agent to avoid circular dependency at module level
      const { Agent } = await import('../core/agent.js');

      // Create sub-agent — same project, clean history, no sub-agent tool (depth limit)
      const child = new Agent({
        apiKey: parentAgent.getApiKey(),
        model: model || parentAgent.getModel(),
        baseURL: parentAgent.getBaseURL(),
        cwd,
        maxIterations: 50,
        noHistory: true,
        noSubAgents: true,
        silent: true,
        systemPromptSuffix: suffix,
        interactionMode: parentAgent.getInteractionMode(),
      });

      // Load extensions so sub-agent events fire for extension observers
      await child.initExtensions();

      try {
        // Snapshot ref store before sub-agent runs so we can surface new refs to parent
        const refIdBefore = getNextResultId();

        const result = await child.chat(prompt);

        // Collect any ResultRefs created during sub-agent execution
        const newRefs = getAllResultRefs().filter(r => r.id >= refIdBefore);

        // Mark task done on success
        if (taskId != null) {
          withTasks(cwd, tasks => {
            const task = tasks.find(t => t.id === taskId);
            if (task) task.status = 'done';
          });
        }

        // Get usage info from child
        const tracker = child.getContextTracker();
        const tokens = tracker.getUsedTokens();
        const usageLine = tokens ? `\n[sub-agent used ~${Math.round(tokens / 1000)}K tokens]` : '';

        // returnRaw: skip summarization and return the last response verbatim
        if (returnRaw) return result + buildRefAppendix(newRefs) + usageLine;

        // Generate structured summary of sub-agent work
        const childMessages = child.getMessages();
        const fileOps = extractFileOps(childMessages);
        try {
          const summary = await summarizeTurn(childMessages, 0, {
            baseURL: parentAgent.getBaseURL(),
            apiKey: parentAgent.getApiKey(),
            model: parentAgent.getModel(),
          }, 0, true);
          const fileLines = [
            fileOps.read.length ? `Files read: ${fileOps.read.join(', ')}` : null,
            fileOps.modified.length ? `Files modified: ${fileOps.modified.join(', ')}` : null,
          ].filter(Boolean).join('\n');
          return `${summary.summary}${fileLines ? '\n\n---\n' + fileLines : ''}${buildRefAppendix(newRefs)}${usageLine}`;
        } catch {
          // Summarization failed — return raw result
          return result + buildRefAppendix(newRefs) + usageLine;
        }
      } catch (error) {
        return `Sub-agent error: ${error}`;
      }
    }
  };
}
