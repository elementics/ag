import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agentTool } from '../agent.js';
import type { ResultRef } from '../../core/types.js';

// Minimal Agent mock — only the methods agentTool actually calls
function makeChildMock(chatResult = 'child response', usedTokens = 0) {
  return {
    getApiKey: () => 'test-key',
    getBaseURL: () => 'https://api.test',
    getModel: () => 'test-model',
    getCwd: () => '/tmp/fake-cwd',
    getInteractionMode: () => 'interactive' as const,
    initExtensions: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn().mockResolvedValue(chatResult),
    getMessages: vi.fn().mockReturnValue([]),
    getContextTracker: vi.fn().mockReturnValue({ getUsedTokens: () => usedTokens }),
  };
}

function makeParentMock() {
  return {
    getApiKey: () => 'parent-key',
    getBaseURL: () => 'https://api.test',
    getModel: () => 'parent-model',
    getCwd: () => '/tmp/fake-cwd',
    getInteractionMode: () => 'interactive' as const,
  };
}

function makeRef(id: number, toolName = 'web', sizeChars = 5000, summary = 'some content'): ResultRef {
  return { type: 'result_ref', id, tool_name: toolName, size_chars: sizeChars, summary, cache_path: `/tmp/${id}.txt`, introduced_turn: 1 };
}

// Track the child mock created by the mocked Agent constructor.
// Must be a regular function (not arrow) so `new Agent()` works as a constructor.
let childMock: ReturnType<typeof makeChildMock>;

vi.mock('../../core/agent.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Agent: function AgentMock(this: any) { Object.assign(this, childMock); },
}));

// summarizeTurn is only called in the non-raw path
vi.mock('../../core/summarization.js', () => ({
  summarizeTurn: vi.fn().mockResolvedValue({ summary: 'summarized output' }),
  extractFileOps: vi.fn().mockReturnValue({ read: [], modified: [] }),
}));

// memory is used for taskId bookkeeping — stub it out
vi.mock('../../memory/memory.js', () => ({
  withTasks: vi.fn(),
}));

// results mock — controls what getNextResultId/getAllResultRefs return
let nextIdBeforeRun = 1;
let refsAfterRun: ResultRef[] = [];

vi.mock('../../core/results.js', () => ({
  getNextResultId: vi.fn(() => nextIdBeforeRun),
  getAllResultRefs: vi.fn(() => refsAfterRun),
}));

import { summarizeTurn } from '../../core/summarization.js';

beforeEach(() => {
  vi.clearAllMocks();
  childMock = makeChildMock('child response');
  nextIdBeforeRun = 1;
  refsAfterRun = [];
});

describe('agent tool schema', () => {
  it('includes returnRaw parameter', () => {
    const tool = agentTool(makeParentMock() as never);
    const props = (tool.function.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('returnRaw');
    expect((props.returnRaw as { type: string }).type).toBe('boolean');
  });

  it('returnRaw is not required', () => {
    const tool = agentTool(makeParentMock() as never);
    const required = (tool.function.parameters as { required: string[] }).required;
    expect(required).not.toContain('returnRaw');
    expect(required).toContain('prompt');
  });
});

describe('agent tool — returnRaw: true', () => {
  it('returns chat result verbatim without calling summarizeTurn', async () => {
    childMock = makeChildMock('verbatim content from sub-agent');
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'fetch something', returnRaw: true });

    expect(result).toBe('verbatim content from sub-agent');
    expect(summarizeTurn).not.toHaveBeenCalled();
  });

  it('appends usage line when tokens are non-zero', async () => {
    childMock = makeChildMock('raw content', 42000);
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'fetch', returnRaw: true });

    expect(result).toContain('raw content');
    expect(result).toContain('~42K tokens');
  });

  it('returns result without usage suffix when tokens are zero', async () => {
    childMock = makeChildMock('raw content', 0);
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'fetch', returnRaw: true });

    expect(result).toBe('raw content');
  });
});

describe('agent tool — returnRaw: false (default)', () => {
  it('calls summarizeTurn and returns summary', async () => {
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'do work' });

    expect(summarizeTurn).toHaveBeenCalledOnce();
    expect(result).toContain('summarized output');
  });

  it('returnRaw: false explicitly also summarizes', async () => {
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'do work', returnRaw: false });

    expect(summarizeTurn).toHaveBeenCalledOnce();
    expect(result).toContain('summarized output');
  });

  it('falls back to raw result when summarizeTurn throws', async () => {
    vi.mocked(summarizeTurn).mockRejectedValueOnce(new Error('API down'));
    childMock = makeChildMock('fallback raw');
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'do work' });

    expect(result).toContain('fallback raw');
  });
});

describe('agent tool — result ref surfacing', () => {
  it('no ref appendix when sub-agent created no new refs', async () => {
    nextIdBeforeRun = 3;
    refsAfterRun = [makeRef(1), makeRef(2)]; // all exist before run (id < 3)
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'do work' });

    expect(result).not.toContain('Sub-agent result refs');
  });

  it('returnRaw: appends ref appendix after raw response', async () => {
    nextIdBeforeRun = 1;
    refsAfterRun = [makeRef(1, 'web', 45230, 'Title: Nintendo Life')];
    childMock = makeChildMock('raw response');
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'fetch news', returnRaw: true });

    expect(result).toContain('raw response');
    expect(result).toContain('Sub-agent result refs');
    expect(result).toContain('ref #1 [web, 45,230 chars]: Title: Nintendo Life');
    expect(result).toContain('`result` tool');
  });

  it('summarized path: appends ref appendix after summary', async () => {
    nextIdBeforeRun = 1;
    refsAfterRun = [makeRef(1, 'web', 12000, 'Page content')];
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'do work' });

    expect(result).toContain('summarized output');
    expect(result).toContain('Sub-agent result refs');
    expect(result).toContain('ref #1 [web, 12,000 chars]: Page content');
  });

  it('fallback path: appends ref appendix when summarizeTurn throws', async () => {
    vi.mocked(summarizeTurn).mockRejectedValueOnce(new Error('API down'));
    nextIdBeforeRun = 5;
    refsAfterRun = [makeRef(5, 'bash', 3400, 'exit 0, 120 lines')];
    childMock = makeChildMock('fallback raw');
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'do work' });

    expect(result).toContain('fallback raw');
    expect(result).toContain('ref #5 [bash, 3,400 chars]: exit 0, 120 lines');
  });

  it('lists multiple refs in appendix', async () => {
    nextIdBeforeRun = 10;
    refsAfterRun = [
      makeRef(10, 'web', 50000, 'Page A'),
      makeRef(11, 'bash', 4000, 'Command output'),
    ];
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'do work' });

    expect(result).toContain('ref #10 [web, 50,000 chars]: Page A');
    expect(result).toContain('ref #11 [bash, 4,000 chars]: Command output');
  });

  it('ref appendix appears before usage line', async () => {
    nextIdBeforeRun = 1;
    refsAfterRun = [makeRef(1, 'web', 5000, 'some page')];
    childMock = makeChildMock('raw', 10000);
    const tool = agentTool(makeParentMock() as never);

    const result = await tool.execute({ prompt: 'fetch', returnRaw: true });

    const refPos = result.indexOf('Sub-agent result refs');
    const usagePos = result.indexOf('[sub-agent used');
    expect(refPos).toBeGreaterThan(-1);
    expect(usagePos).toBeGreaterThan(refPos);
  });
});
