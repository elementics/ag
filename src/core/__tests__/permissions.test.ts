import { describe, it, expect } from 'vitest';
import { isReadOnlyToolCall } from '../agent.js';

describe('isReadOnlyToolCall', () => {
  describe('always read-only tools', () => {
    it('grep search is read-only', () => {
      expect(isReadOnlyToolCall('grep', { action: 'search', pattern: 'foo' })).toBe(true);
    });

    it('grep find is read-only', () => {
      expect(isReadOnlyToolCall('grep', { action: 'find', pattern: '*.ts' })).toBe(true);
    });

    it('memory save is read-only', () => {
      expect(isReadOnlyToolCall('memory', { action: 'save', tier: 'global', content: 'x' })).toBe(true);
    });

    it('plan is read-only', () => {
      expect(isReadOnlyToolCall('plan', { action: 'save', content: 'x' })).toBe(true);
    });

    it('skill is read-only', () => {
      expect(isReadOnlyToolCall('skill', { name: 'frontend' })).toBe(true);
    });
  });

  describe('file tool — action-dependent', () => {
    it('file read is read-only', () => {
      expect(isReadOnlyToolCall('file', { action: 'read', path: 'foo.ts' })).toBe(true);
    });

    it('file list is read-only', () => {
      expect(isReadOnlyToolCall('file', { action: 'list', path: '.' })).toBe(true);
    });

    it('file write is NOT read-only', () => {
      expect(isReadOnlyToolCall('file', { action: 'write', path: 'foo.ts', content: 'x' })).toBe(false);
    });

    it('file edit is NOT read-only', () => {
      expect(isReadOnlyToolCall('file', { action: 'edit', path: 'foo.ts', old_string: 'a', new_string: 'b' })).toBe(false);
    });
  });

  describe('git tool — action-dependent', () => {
    it('git status is read-only', () => {
      expect(isReadOnlyToolCall('git', { action: 'status' })).toBe(true);
    });

    it('git commit is NOT read-only', () => {
      expect(isReadOnlyToolCall('git', { action: 'commit', message: 'fix' })).toBe(false);
    });

    it('git push is NOT read-only', () => {
      expect(isReadOnlyToolCall('git', { action: 'push' })).toBe(false);
    });

    it('git branch is NOT read-only', () => {
      expect(isReadOnlyToolCall('git', { action: 'branch', name: 'feat/x' })).toBe(false);
    });
  });

  describe('web tool — action-dependent', () => {
    it('web search is read-only', () => {
      expect(isReadOnlyToolCall('web', { action: 'search', query: 'foo' })).toBe(true);
    });

    it('web fetch is NOT read-only', () => {
      expect(isReadOnlyToolCall('web', { action: 'fetch', url: 'https://example.com' })).toBe(false);
    });
  });

  describe('unknown/mutating tools', () => {
    it('bash is NOT read-only', () => {
      expect(isReadOnlyToolCall('bash', { command: 'echo hi' })).toBe(false);
    });

    it('unknown custom tool is NOT read-only', () => {
      expect(isReadOnlyToolCall('deploy', { target: 'prod' })).toBe(false);
    });
  });
});
