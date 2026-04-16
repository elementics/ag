/**
 * Content tool — re-fetch or inspect previously shared content (images, PDFs, etc.)
 */

import type { Tool } from '../core/types.js';
import { getContentRef, describeContent, markRefRequested } from '../core/content.js';

function doGet(ref?: number): string {
  if (ref === undefined || ref === null) return 'Error: ref is required for action=get.';
  const entry = getContentRef(ref);
  if (!entry) return `Error: content #${ref} not found. Use content(action=info) to list available content.`;

  // Mark for re-injection: resolveMessagesForAPI will send the full content on the next API call
  markRefRequested(entry.id);

  const desc = describeContent(entry);
  const lines = [`[content #${entry.id}]: ${entry.filename || 'unknown'}`, desc];
  if (entry.width && entry.height) lines.push(`Dimensions: ${entry.width}×${entry.height}`);
  if (entry.page_count) lines.push(`Pages: ${entry.page_count}`);
  lines.push(`Type: ${entry.media_type}`);
  lines.push(`Size: ${entry.size_bytes} bytes`);
  lines.push(`Hash: ${entry.hash.slice(0, 12)}...`);
  // Note: the actual image/file content block is injected into the next API call
  // by resolveMessagesForAPI when the model requests it via this tool.
  return lines.join('\n');
}

function doInfo(ref?: number): string {
  if (ref === undefined || ref === null) return 'Error: ref is required for action=info.';
  const entry = getContentRef(ref);
  if (!entry) return `Error: content #${ref} not found.`;

  return [
    `Content #${entry.id}`,
    `Filename: ${entry.filename || 'unknown'}`,
    `Type: ${entry.media_type}`,
    entry.width && entry.height ? `Dimensions: ${entry.width}×${entry.height}` : null,
    entry.page_count ? `Pages: ${entry.page_count}` : null,
    `Size: ${entry.size_bytes} bytes`,
    `Hash: ${entry.hash}`,
    `Turn introduced: ${entry.introduced_turn}`,
  ].filter(Boolean).join('\n');
}

export function contentTool(_cwd: string): Tool {
  return {
    type: 'function',
    function: {
      name: 'content',
      description: 'Content operations. Actions: get (retrieve a previously shared image or file — the full visual content is returned so you can see it), info (get metadata about a content item without loading it).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'info'], description: 'The content operation.' },
          ref: { type: 'number', description: 'Content reference number (e.g. 1 for [content #1]).' },
        },
        required: ['action'],
      },
    },
    execute: async ({ action, ref }: { action: string; ref?: number }): Promise<string> => {
      switch (action) {
        case 'get': return doGet(ref);
        case 'info': return doInfo(ref);
        default: return `Unknown action "${action}". Use: get, info.`;
      }
    },
  };
}
