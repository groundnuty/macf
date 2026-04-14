import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('generateToken', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Clear token-related env vars
    delete process.env['GH_TOKEN'];
    delete process.env['APP_ID'];
    delete process.env['INSTALL_ID'];
    delete process.env['KEY_PATH'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns GH_TOKEN from environment when available', async () => {
    process.env['GH_TOKEN'] = 'env-token-123';

    const { generateToken } = await import('../src/token.js');
    expect(generateToken()).toBe('env-token-123');
  });

  it('throws when no GH_TOKEN and no App credentials', async () => {
    const { generateToken } = await import('../src/token.js');
    expect(() => generateToken()).toThrow('No GH_TOKEN');
  });
});
