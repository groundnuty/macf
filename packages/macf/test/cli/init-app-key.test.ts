import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { initAgent, defaultAgentKeyPath } from '../../src/cli/commands/init.js';
import { readAgentConfig } from '../../src/cli/config.js';

/**
 * macf#530 — `macf init` ingests the App private key to the conventional path
 * + fails loud if absent (no more "pointer set without the thing it points to"
 * → deferred cryptic `gh` 401).
 *
 * Tests use an explicit temp `--key-path` for any ingestion so they never write
 * to the real `~/.macf/keys/`; the default-path test uses a unique agent name
 * + provides no `--app-key`, so no file is ever created under the real home.
 */
function tempDir(): string {
  const dir = join(tmpdir(), `macf-appkey-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const baseOpts = {
  project: 'TEST',
  role: 'code-agent',
  appId: '123',
  installId: '456',
  registryType: 'repo',
  registryRepo: 'the-owner/repo',
} as const;

describe('macf init --app-key ingestion (macf#530)', () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = tempDir();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  it('defaultAgentKeyPath returns ~/.macf/keys/<owner>/<project>/<agent>.pem', () => {
    expect(defaultAgentKeyPath('the-owner', 'TEST', 'auditor')).toBe(
      join(homedir(), '.macf', 'keys', 'the-owner', 'TEST', 'auditor.pem'),
    );
  });

  it('ingests --app-key into --key-path with 0600 perms', async () => {
    const src = join(dir, 'downloaded.pem');
    writeFileSync(src, 'KEYDATA');
    const dest = join(dir, 'keys', 'code-agent.pem');

    await initAgent(dir, { ...baseOpts, keyPath: dest, appKey: src });

    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf-8')).toBe('KEYDATA');
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(readAgentConfig(dir)!.github_app!.key_path).toBe(dest);
  });

  it('throws an actionable error when --app-key source is missing', async () => {
    await expect(
      initAgent(dir, { ...baseOpts, keyPath: join(dir, 'k.pem'), appKey: join(dir, 'nope.pem') }),
    ).rejects.toThrow(/app-key.*not found|not found.*app-key/i);
  });

  it('preserves an existing destination key (idempotent — never clobbered)', async () => {
    const dest = join(dir, 'keys', 'code-agent.pem');
    mkdirSync(join(dir, 'keys'), { recursive: true });
    writeFileSync(dest, 'ORIGINAL');
    const src = join(dir, 'new.pem');
    writeFileSync(src, 'REPLACEMENT');

    await initAgent(dir, { ...baseOpts, keyPath: dest, appKey: src });

    expect(readFileSync(dest, 'utf-8')).toBe('ORIGINAL');
  });

  it('warns loudly (no throw) when no key is provided and none exists at the dest', async () => {
    const dest = join(dir, 'keys', 'absent.pem');

    await initAgent(dir, { ...baseOpts, keyPath: dest });

    expect(existsSync(dest)).toBe(false);
    expect(readAgentConfig(dir)).not.toBeNull(); // init still completed
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toMatch(/App private key not found/);
    expect(msg).toMatch(/--app-key/);
  });

  it('defaults key_path to ~/.macf/keys/<owner>/<project>/<agent>.pem when --key-path omitted', async () => {
    // Unique agent name → the real-home path certainly does not exist, and with
    // no --app-key nothing is written there.
    const agent = `eph-${Math.random().toString(36).slice(2)}`;

    await initAgent(dir, { ...baseOpts, name: agent });

    // Owner is derived from the 'repo' registry variant's `owner/repo` —
    // baseOpts.registryRepo is 'the-owner/repo', so the owner segment is
    // 'the-owner' (macf#1214).
    expect(readAgentConfig(dir)!.github_app!.key_path).toBe(defaultAgentKeyPath('the-owner', baseOpts.project, agent));
    expect(warnSpy).toHaveBeenCalled();
  });
});
