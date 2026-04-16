/**
 * Tool schema contract tests — ensures tool definitions (the API contract with LLMs)
 * don't accidentally change shape, names, or required parameters.
 */
import { describe, it, expect } from 'vitest';
import { fileTool } from '../file.js';
import { bashToolFactory } from '../bash.js';
import { grepTool } from '../grep.js';
import { gitTool } from '../git.js';
import { webTool } from '../web.js';
import { memoryTool } from '../memory.js';
import { planTool } from '../plan.js';

const cwd = process.cwd();

function schema(tool: { function: { name: string; description: string; parameters: unknown } }) {
  return { name: tool.function.name, parameters: tool.function.parameters };
}

describe('tool schema contracts', () => {
  it('file tool schema', () => {
    expect(schema(fileTool(cwd))).toMatchSnapshot();
  });

  it('bash tool schema', () => {
    expect(schema(bashToolFactory(cwd))).toMatchSnapshot();
  });

  it('grep tool schema', () => {
    expect(schema(grepTool(cwd))).toMatchSnapshot();
  });

  it('git tool schema', () => {
    expect(schema(gitTool(cwd))).toMatchSnapshot();
  });

  it('web tool schema', () => {
    expect(schema(webTool())).toMatchSnapshot();
  });

  it('memory tool schema', () => {
    expect(schema(memoryTool(cwd))).toMatchSnapshot();
  });

  it('plan tool schema', () => {
    expect(schema(planTool(cwd))).toMatchSnapshot();
  });
});
