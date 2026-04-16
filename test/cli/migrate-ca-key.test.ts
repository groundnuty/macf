/**
 * Tests for DR-011 rev2 auto-migrate (#115).
 *
 * Covers:
 *   - Idempotency (v2 already → silent no-op)
 *   - No variable (fresh project) → silent no-op
 *   - v1 → v2 successful migration
 *   - Wrong passphrase → status tag + v1 blob untouched in registry
 *   - Mid-migration interrupt (writeVariable throws) → v1 blob untouched
 *     in registry; next attempt succeeds
 *   - formatMigrationResult wording matches DR-011 rev2 doctrine
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  migrateCaKeyToV2, formatMigrationResult, isV1Blob,
} from '../../src/cli/commands/migrate-ca-key.js';
import {
  encryptCAKey, encryptCAKeyV1Legacy, decryptCAKey,
} from '../../src/certs/ca.js';
import type { GitHubVariablesClient } from '../../src/registry/types.js';

const SAMPLE_PEM =
  '-----BEGIN PRIVATE KEY-----\n' +
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ' +
  'C7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dV\n' +
  '-----END PRIVATE KEY-----\n';

function mockClient(initialValue: string | null): GitHubVariablesClient & {
  readonly _state: { value: string | null };
} {
  const state = { value: initialValue };
  return {
    writeVariable: vi.fn().mockImplementation(async (_name: string, value: string) => {
      state.value = value;
    }),
    readVariable: vi.fn().mockImplementation(async () => state.value),
    listVariables: vi.fn().mockResolvedValue([]),
    deleteVariable: vi.fn().mockResolvedValue(undefined),
    _state: state,
  };
}

describe('isV1Blob', () => {
  it('returns true for raw base64 (no leading `{`)', () => {
    expect(isV1Blob('SGVsbG8gV29ybGQ=')).toBe(true);
    // Actual v1 output shape.
    const v1 = encryptCAKeyV1Legacy(SAMPLE_PEM, 'p');
    expect(isV1Blob(v1)).toBe(true);
  });

  it('returns false for v2 JSON envelope', () => {
    const v2 = encryptCAKey(SAMPLE_PEM, 'p');
    expect(isV1Blob(v2)).toBe(false);
    expect(isV1Blob('{"v":2,"iter":600000,"payload":"x"}')).toBe(false);
  });

  it('handles leading whitespace (robustness)', () => {
    expect(isV1Blob('  {"v":2}')).toBe(false);
  });
});

describe('migrateCaKeyToV2', () => {
  const project = 'TEST';
  const passphrase = 'correct-pass';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no_variable when the registry key is missing', async () => {
    const client = mockClient(null);
    const prompt = vi.fn().mockResolvedValue(passphrase);

    const result = await migrateCaKeyToV2({ project, client, prompt });

    expect(result).toEqual({ status: 'no_variable' });
    expect(prompt).not.toHaveBeenCalled();
    expect(client.writeVariable).not.toHaveBeenCalled();
  });

  it('returns already_v2 for a v2 blob — no prompt, no write (idempotent)', async () => {
    const v2 = encryptCAKey(SAMPLE_PEM, passphrase);
    const client = mockClient(v2);
    const prompt = vi.fn();

    const result = await migrateCaKeyToV2({ project, client, prompt });

    expect(result).toEqual({ status: 'already_v2' });
    expect(prompt).not.toHaveBeenCalled();
    expect(client.writeVariable).not.toHaveBeenCalled();
    expect(client._state.value).toBe(v2);
  });

  it('migrates v1 → v2 on correct passphrase', async () => {
    const v1 = encryptCAKeyV1Legacy(SAMPLE_PEM, passphrase);
    const client = mockClient(v1);
    const prompt = vi.fn().mockResolvedValue(passphrase);

    const result = await migrateCaKeyToV2({ project, client, prompt });

    expect(result).toEqual({ status: 'migrated' });
    expect(prompt).toHaveBeenCalledOnce();

    // Registry now holds the v2 envelope.
    const newValue = client._state.value!;
    expect(newValue.startsWith('{')).toBe(true);
    const envelope = JSON.parse(newValue) as Record<string, unknown>;
    expect(envelope['v']).toBe(2);
    expect(envelope['iter']).toBe(600000);

    // Round-trip: the new v2 blob decrypts to the original PEM.
    expect(decryptCAKey(newValue, passphrase)).toBe(SAMPLE_PEM);
  }, 20000);

  it('prompt message includes the DR-011 rev2 canonical text + project name', async () => {
    const v1 = encryptCAKeyV1Legacy(SAMPLE_PEM, passphrase);
    const client = mockClient(v1);
    const prompt = vi.fn().mockResolvedValue(passphrase);

    await migrateCaKeyToV2({ project: 'CV', client, prompt });

    const message = prompt.mock.calls[0]![0] as string;
    expect(message).toContain('v1/iter=10000 → v2/iter=600000');
    expect(message).toContain('for project CV');
    expect(message).toContain('one-time passphrase prompt');
    expect(message).toContain('Enter CA key passphrase:');
  }, 20000);

  it('returns wrong_passphrase + leaves v1 blob untouched on wrong passphrase', async () => {
    const v1 = encryptCAKeyV1Legacy(SAMPLE_PEM, 'real-pass');
    const client = mockClient(v1);
    const prompt = vi.fn().mockResolvedValue('wrong-pass');

    const result = await migrateCaKeyToV2({ project, client, prompt });

    expect(result).toEqual({ status: 'wrong_passphrase' });
    // No write happened — v1 blob still in registry.
    expect(client.writeVariable).not.toHaveBeenCalled();
    expect(client._state.value).toBe(v1);
  });

  it('returns error status + leaves v1 untouched when writeVariable fails', async () => {
    // Simulates mid-migration interrupt: decrypt OK, re-encrypt OK,
    // but the registry write fails (network error, 403, etc.). We
    // want the v1 blob intact so the operator can retry.
    const v1 = encryptCAKeyV1Legacy(SAMPLE_PEM, passphrase);
    const client = mockClient(v1);
    vi.mocked(client.writeVariable).mockRejectedValueOnce(new Error('network error'));
    const prompt = vi.fn().mockResolvedValue(passphrase);

    const result = await migrateCaKeyToV2({ project, client, prompt });

    expect(result.status).toBe('error');
    expect((result as { message: string }).message).toContain('network error');
    // writeVariable WAS called (and threw), but our mock's state
    // setter didn't fire because we used mockRejectedValueOnce.
    // So the stored value remains v1.
    expect(client._state.value).toBe(v1);
    expect(isV1Blob(client._state.value!)).toBe(true);
  }, 20000);

  it('second run after a transient error migrates successfully', async () => {
    // Mid-migration interrupt recovery: after the first call errors,
    // a retry should re-prompt and complete the migration cleanly.
    const v1 = encryptCAKeyV1Legacy(SAMPLE_PEM, passphrase);
    const client = mockClient(v1);
    vi.mocked(client.writeVariable).mockRejectedValueOnce(new Error('transient'));
    const prompt = vi.fn().mockResolvedValue(passphrase);

    const first = await migrateCaKeyToV2({ project, client, prompt });
    expect(first.status).toBe('error');

    // Second attempt: writeVariable is no longer mock-rejected.
    const second = await migrateCaKeyToV2({ project, client, prompt });
    expect(second).toEqual({ status: 'migrated' });

    // Final state is v2.
    expect(isV1Blob(client._state.value!)).toBe(false);
    expect(decryptCAKey(client._state.value!, passphrase)).toBe(SAMPLE_PEM);
  }, 30000);
});

describe('formatMigrationResult', () => {
  it('returns empty string for silent no-ops', () => {
    expect(formatMigrationResult({ status: 'no_variable' }, 'P')).toBe('');
    expect(formatMigrationResult({ status: 'already_v2' }, 'P')).toBe('');
  });

  it('logs a completion message for successful migration', () => {
    const out = formatMigrationResult({ status: 'migrated' }, 'CV');
    expect(out).toContain('v2/600k');
    expect(out).toContain('CV_CA_KEY_ENCRYPTED');
  });

  it('logs a retry hint on wrong passphrase', () => {
    const out = formatMigrationResult({ status: 'wrong_passphrase' }, 'P');
    expect(out).toContain('wrong passphrase');
    expect(out).toContain('untouched');
    expect(out).toContain('re-run');
  });

  it('surfaces the error message on other failures', () => {
    const out = formatMigrationResult({ status: 'error', message: '403 forbidden' }, 'P');
    expect(out).toContain('403 forbidden');
    expect(out).toContain('untouched');
  });
});
