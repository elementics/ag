/**
 * Agent tool — spawn in-process sub-agents for parallel work
 */

import { Tool } from '../core/types.js';
import { withTasks } from '../memory/memory.js';
import type { Agent } from '../core/agent.js';
import { extractFileOps, summarizeTurn } from '../core/summarization.js';

export function agentTool(parentAgent: Agent): Tool {
  return {
    type: 'function',
    function: {
      name: 'agent',
      description: 'Spawn a sub-agent to work on a task independently. Sub-agents get project memory, plan, skills, and tools but start with a clean context (no conversation history). To run agents in parallel, call this tool multiple times in a single response — all calls execute concurrently. Each agent runs autonomously and returns its result.',
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
          }
        },
        required: ['prompt']
      }
    },
    execute: async ({ prompt, taskId, model }: { prompt: string; taskId?: number; model?: string }): Promise<string> => {
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
      });

      // Load extensions so sub-agent events fire for extension observers
      await child.initExtensions();

      try {
        const result = await child.chat(prompt);

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

        // Generate structured summary of sub-agent work
        const childMessages = child.getMessages();
        const fileOps = extractFileOps(childMessages);
        try {
          const summary = await summarizeTurn(childMessages, 0, {
            baseURL: parentAgent.getBaseURL(),
            apiKey: parentAgent.getApiKey(),
            model: parentAgent.getModel(),
          });
          const fileLines = [
            fileOps.read.length ? `Files read: ${fileOps.read.join(', ')}` : null,
            fileOps.modified.length ? `Files modified: ${fileOps.modified.join(', ')}` : null,
          ].filter(Boolean).join('\n');
          return `${summary.summary}${fileLines ? '\n\n---\n' + fileLines : ''}${usageLine}`;
        } catch {
          // Summarization failed — return raw result
          return result + usageLine;
        }
      } catch (error) {
        return `Sub-agent error: ${error}`;
      }
    }
  };
}
