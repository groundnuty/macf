import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('generateToken', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
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
    const token = await generateToken();
    expect(token).toBe('env-token-123');
  });

  it('throws when no GH_TOKEN and no App credentials', async () => {
    const { generateToken } = await import('../src/token.js');
    await expect(generateToken()).rejects.toThrow('No GH_TOKEN');
  });
});
