import { describe, it, expect } from 'vitest';
import { webTool } from '../web.js';

const web = webTool();

describe('web tool - SSRF protection', () => {
  const blockedUrls = [
    'http://localhost/admin',
    'http://127.0.0.1/secret',
    'http://0.0.0.0:8080/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://10.0.0.1/internal',
    'http://172.16.0.1/internal',
    'http://192.168.1.1/admin',
  ];

  for (const url of blockedUrls) {
    it(`blocks ${new URL(url).hostname}`, async () => {
      const result = await web.execute({ action: 'fetch', url });
      expect(result).toMatch(/blocked.*private|internal/i);
    });
  }

  it('blocks non-http protocols', async () => {
    const result = await web.execute({ action: 'fetch', url: 'ftp://example.com/file' });
    expect(result).toMatch(/http.*https/);
  });

  it('rejects invalid URLs', async () => {
    const result = await web.execute({ action: 'fetch', url: 'not-a-url' });
    expect(result).toMatch(/Invalid URL/);
  });

  it('requires url for fetch', async () => {
    const result = await web.execute({ action: 'fetch' });
    expect(result).toMatch(/url is required/);
  });

  it('requires query for search', async () => {
    const result = await web.execute({ action: 'search' });
    expect(result).toMatch(/query is required/);
  });

  it('unknown action returns error', async () => {
    const result = await web.execute({ action: 'post' });
    expect(result).toMatch(/Unknown action/);
  });

  it('blocks 169.254.x.x link-local addresses', async () => {
    const result = await web.execute({ action: 'fetch', url: 'http://169.254.1.1/metadata' });
    expect(result).toMatch(/blocked/i);
  });

  it('blocks 172.16-31 private range', async () => {
    const result = await web.execute({ action: 'fetch', url: 'http://172.31.255.255/' });
    expect(result).toMatch(/blocked/i);
  });

});
