/**
 * Task tool — structured task tracking for plans and sub-agents
 */

import { Tool } from '../core/types.js';
import { loadTasks, withTasks, getActivePlanName, type Task } from '../memory/memory.js';

const VALID_STATUSES = ['pending', 'in_progress', 'done'] as const;

function formatTask(t: Task): string {
  const plan = t.plan ? ` (plan: ${t.plan})` : '';
  const desc = t.description ? `\n   ${t.description}` : '';
  return `${t.id}. [${t.status}] ${t.title}${plan}  (created ${t.created.slice(0, 10)})${desc}`;
}

export function taskTool(cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'task',
      description: 'Manage tasks — the executable steps of a plan. Use to track progress on multi-step work. Tasks appear in context so you always know what\'s done and what remains.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'update', 'read', 'remove', 'clear'],
            description: 'create: new task. list: show all. update: change status. read: task details. remove: delete. clear: remove all done tasks.'
          },
          title: {
            type: 'string',
            description: 'Task title (for create)'
          },
          id: {
            type: 'number',
            description: 'Task ID (for update, read, remove)'
          },
          description: {
            type: 'string',
            description: 'Detailed description of what needs to be done (for create). Gives sub-agents enough context to work independently.'
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done'],
            description: 'New status (for update)'
          }
        },
        required: ['action']
      }
    },
    execute: ({ action, title, description: desc, id, status }: { action: string; title?: string; description?: string; id?: number; status?: string }): string => {
      switch (action) {
        case 'create': {
          if (!title) return 'Error: title is required for create';
          return withTasks(cwd, tasks => {
            const nextId = tasks.length > 0 ? Math.max(...tasks.map(t => t.id)) + 1 : 1;
            const task: Task = {
              id: nextId,
              title,
              description: desc || undefined,
              status: 'pending',
              plan: getActivePlanName(cwd) || undefined,
              created: new Date().toISOString(),
            };
            tasks.push(task);
            return `Task #${nextId} created: ${title}`;
          });
        }

        case 'list': {
          const tasks = loadTasks(cwd);
          if (tasks.length === 0) return 'No tasks.';
          const pending = tasks.filter(t => t.status === 'pending');
          const inProgress = tasks.filter(t => t.status === 'in_progress');
          const done = tasks.filter(t => t.status === 'done');
          const sections: string[] = [];
          if (inProgress.length > 0) sections.push('In Progress:\n' + inProgress.map(formatTask).join('\n'));
          if (pending.length > 0) sections.push('Pending:\n' + pending.map(formatTask).join('\n'));
          if (done.length > 0) sections.push('Done:\n' + done.map(formatTask).join('\n'));
          return sections.join('\n\n');
        }

        case 'update': {
          if (id == null) return 'Error: id is required for update';
          if (!status) return 'Error: status is required for update';
          if (!VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
            return `Error: invalid status "${status}". Use: ${VALID_STATUSES.join(', ')}`;
          }
          return withTasks(cwd, tasks => {
            const task = tasks.find(t => t.id === id);
            if (!task) return `Error: task #${id} not found`;
            task.status = status as Task['status'];
            return `Task #${id} updated: [${status}] ${task.title}`;
          });
        }

        case 'read': {
          if (id == null) return 'Error: id is required for read';
          const tasks = loadTasks(cwd);
          const task = tasks.find(t => t.id === id);
          if (!task) return `Error: task #${id} not found`;
          return formatTask(task);
        }

        case 'remove': {
          if (id == null) return 'Error: id is required for remove';
          return withTasks(cwd, tasks => {
            const idx = tasks.findIndex(t => t.id === id);
            if (idx === -1) return `Error: task #${id} not found`;
            const removed = tasks.splice(idx, 1)[0];
            return `Task #${removed.id} removed: ${removed.title}`;
          });
        }

        case 'clear': {
          return withTasks(cwd, tasks => {
            const before = tasks.length;
            const done = tasks.filter(t => t.status === 'done');
            // Remove done tasks in-place (withTasks saves the mutated array)
            for (const d of done) tasks.splice(tasks.indexOf(d), 1);
            return done.length > 0
              ? `Cleared ${done.length} done task(s). ${tasks.length} remaining.`
              : 'No done tasks to clear.';
          });
        }

        default:
          return `Error: unknown action "${action}". Use: create, list, update, read, remove, clear`;
      }
    }
  };
}
