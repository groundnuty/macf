/**
 * Tests for the operator secrets file (groundnuty/macf#1197) — one plain
 * KEY=value file instead of a flag per credential. The load-bearing cases:
 * per-KEY (not per-FILE) precedence override, the never-logs-a-value
 * contract, and the aggregate-fail-loud naming.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeOperatorInputSource,
  ensureOperatorSecretsGitignore,
  formatMissingOperatorInputsMessage,
  formatOperatorInputProvenanceLine,
  missingRequiredOperatorInputs,
  operatorSecretsFileTemplate,
  OPERATOR_SECRETS_FILE_KEYS,
  parseOperatorSecretsFile,
  readOperatorSecretsFile,
  resolveOperatorInput,
  writeOperatorSecretsFileTemplate,
} from '../../../src/cli/bootstrap/operator-secrets-file.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'macf-secrets-file-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseOperatorSecretsFile — plain KEY=value (#1197 required: "one file, plain KEY=value")', () => {
  it('parses KEY=value pairs, skipping comments and blank lines', () => {
    const contents = ['# a comment', '', 'FOO=bar', '  # indented comment', 'BAZ=qux  '].join('\n');
    expect(parseOperatorSecretsFile(contents)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips one layer of matching quotes around the value', () => {
    expect(parseOperatorSecretsFile('A="quoted value"\nB=\'single quoted\'\nC=unquoted')).toEqual({
      A: 'quoted value',
      B: 'single quoted',
      C: 'unquoted',
    });
  });

  it('a line with no "=" is skipped, never thrown', () => {
    expect(() => parseOperatorSecretsFile('not a valid line\nFOO=bar')).not.toThrow();
    expect(parseOperatorSecretsFile('not a valid line\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('an empty value is preserved as an empty string (KEY= counts as "not given" downstream, not a parse error)', () => {
    expect(parseOperatorSecretsFile('FOO=')).toEqual({ FOO: '' });
  });

  it('unknown extra keys are tolerated, not fatal (#1197 test list)', () => {
    const values = parseOperatorSecretsFile('SOME_UNKNOWN_KEY=whatever\nMACF_BOOTSTRAP_RUNNER_TOKEN=tok');
    expect(values['SOME_UNKNOWN_KEY']).toBe('whatever');
    expect(values['MACF_BOOTSTRAP_RUNNER_TOKEN']).toBe('tok');
  });
});

describe('readOperatorSecretsFile', () => {
  it('undefined path -> undefined (not an error — a per-fleet file is optional)', () => {
    expect(readOperatorSecretsFile(undefined)).toBeUndefined();
  });

  it('a given, readable path parses successfully', () => {
    const dir = tmpDir();
    const path = join(dir, 'secrets.env');
    writeFileSync(path, 'MACF_BOOTSTRAP_RUNNER_TOKEN=tok123\n', 'utf-8');
    const result = readOperatorSecretsFile(path);
    expect(result).toEqual({ ok: true, values: { MACF_BOOTSTRAP_RUNNER_TOKEN: 'tok123' } });
  });

  it('a given, unreadable path fails loud — never silently degrades to "no values from this tier"', () => {
    const result = readOperatorSecretsFile(join(tmpDir(), 'does-not-exist.env'));
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.message).toContain('does-not-exist.env');
    }
  });
});

describe('resolveOperatorInput — the #1197 operator ruling: per KEY, most-explicit-wins (flag > fleet-file > scope-file > env)', () => {
  const KEY = 'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('flag beats every other tier', () => {
    expect(resolveOperatorInput(KEY, 'flag-value', { [KEY]: 'fleet-value' }, { [KEY]: 'scope-value' })).toEqual({
      value: 'flag-value',
      source: 'flag',
    });
  });

  it('fleet-file beats scope-file and env when no flag', () => {
    vi.stubEnv(KEY, 'env-value');
    expect(resolveOperatorInput(KEY, undefined, { [KEY]: 'fleet-value' }, { [KEY]: 'scope-value' })).toEqual({
      value: 'fleet-value',
      source: 'fleet-file',
    });
  });

  it('scope-file beats env when no flag and no fleet-file value for this key', () => {
    vi.stubEnv(KEY, 'env-value');
    expect(resolveOperatorInput(KEY, undefined, undefined, { [KEY]: 'scope-value' })).toEqual({
      value: 'scope-value',
      source: 'scope-file',
    });
  });

  it('falls back to env when nothing else resolves', () => {
    vi.stubEnv(KEY, 'env-value');
    expect(resolveOperatorInput(KEY, undefined, undefined, undefined)).toEqual({ value: 'env-value', source: 'env' });
  });

  it('resolves to "none" when nothing supplies it anywhere', () => {
    expect(resolveOperatorInput(KEY, undefined, undefined, undefined)).toEqual({ value: undefined, source: 'none' });
  });

  // groundnuty/macf#1197's operator ruling, verbatim: "a fleet supplying
  // one override must not lose every other scope-level value... whole-file
  // shadowing is the obvious wrong implementation and would be silent."
  // DECISIVE: the fleet file overrides ONE key; a SECOND, different key is
  // NOT present in the fleet file at all — it must still resolve from the
  // scope file, proving resolution is per-KEY, not "does a fleet file
  // exist at all."
  it('per-KEY override: a fleet file overriding ONE key does not shadow a DIFFERENT key the scope file supplies', () => {
    const OTHER_KEY = 'MACF_BOOTSTRAP_TS_OAUTH_SECRET';
    const fleetValues = { [KEY]: 'fleet-client-id' }; // OTHER_KEY absent from the fleet file
    const scopeValues = { [KEY]: 'scope-client-id', [OTHER_KEY]: 'scope-secret' };

    const clientIdResolution = resolveOperatorInput(KEY, undefined, fleetValues, scopeValues);
    const secretResolution = resolveOperatorInput(OTHER_KEY, undefined, fleetValues, scopeValues);

    expect(clientIdResolution).toEqual({ value: 'fleet-client-id', source: 'fleet-file' });
    // The decisive assertion: OTHER_KEY still resolves from the scope file
    // — a whole-file-shadowing bug would instead resolve it to `undefined`
    // (or ignore the scope tier entirely) because "the fleet file exists."
    expect(secretResolution).toEqual({ value: 'scope-secret', source: 'scope-file' });
  });

  it('an empty-string value at any tier counts as "not given", falling through to the next tier', () => {
    expect(resolveOperatorInput(KEY, '', { [KEY]: '' }, { [KEY]: 'scope-value' })).toEqual({
      value: 'scope-value',
      source: 'scope-file',
    });
  });
});

describe('provenance reporting — never logs a VALUE while reporting a SOURCE (#1197 requirement)', () => {
  it('describeOperatorInputSource returns a value-free label per tier', () => {
    expect(describeOperatorInputSource('flag')).toMatch(/flag/i);
    expect(describeOperatorInputSource('fleet-file')).toMatch(/fleet/i);
    expect(describeOperatorInputSource('scope-file')).toMatch(/scope/i);
    expect(describeOperatorInputSource('env')).toMatch(/environment/i);
    expect(describeOperatorInputSource('none')).toMatch(/not supplied/i);
  });

  it('formatOperatorInputProvenanceLine never contains a sentinel value even when constructed alongside one', () => {
    const SENTINEL = 'SENTINEL-1197-VALUE-MUST-NEVER-LEAK';
    const resolution = resolveOperatorInput('SOME_KEY', SENTINEL, undefined, undefined);
    expect(resolution.value).toBe(SENTINEL); // sanity: the value WAS resolved
    const line = formatOperatorInputProvenanceLine('SOME_KEY', resolution.source);
    expect(line).not.toContain(SENTINEL);
    expect(line).toContain('SOME_KEY');
  });
});

describe('missingRequiredOperatorInputs / formatMissingOperatorInputsMessage — aggregate fail-loud (#1197 required: "naming every missing key at once")', () => {
  it('returns every required-but-unresolved key, in order, ignoring keys that are not required', () => {
    const missing = missingRequiredOperatorInputs([
      { key: 'A', required: true, value: undefined },
      { key: 'B', required: false, value: undefined },
      { key: 'C', required: true, value: 'present' },
      { key: 'D', required: true, value: '' },
    ]);
    expect(missing).toEqual(['A', 'D']);
  });

  it('formats ONE message naming every missing key together, not one at a time', () => {
    const msg = formatMissingOperatorInputsMessage(['MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID', 'MACF_BOOTSTRAP_TS_OAUTH_SECRET']);
    expect(msg).toContain('MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID');
    expect(msg).toContain('MACF_BOOTSTRAP_TS_OAUTH_SECRET');
  });

  it('carries no internal issue/DR citation — user-facing output, per the citation guard (groundnuty/macf#1061)', () => {
    const msg = formatMissingOperatorInputsMessage(['SOME_KEY']);
    expect(msg).not.toMatch(/\bmacf#\d+\b|\bgroundnuty\/macf#\d+\b|\bDR-0\d{2}\b|\bAmendment [A-Z0-9]\b/);
  });
});

describe('the key registry + template — #1197 required: "a template listing every key apply can consume"', () => {
  it('lists a purpose, how-to-obtain, and storage class for every key', () => {
    for (const info of OPERATOR_SECRETS_FILE_KEYS) {
      expect(info.purpose.length).toBeGreaterThan(0);
      expect(info.howToObtain.length).toBeGreaterThan(0);
      expect(['org-secret', 'org-variable', 'ephemeral-discard']).toContain(info.storageClass);
    }
  });

  it('never includes the age identity key (Amendment C: operator-held, never tool-minted)', () => {
    const keys = OPERATOR_SECRETS_FILE_KEYS.map((k) => k.key);
    expect(keys.some((k) => /age/i.test(k))).toBe(false);
  });

  it('the generated template text mentions every registered key with a blank value', () => {
    const template = operatorSecretsFileTemplate();
    for (const info of OPERATOR_SECRETS_FILE_KEYS) {
      expect(template).toContain(`${info.key}=`);
    }
  });

  it('the template carries no internal issue/DR citation — it is handed to a friend with zero prior context', () => {
    const template = operatorSecretsFileTemplate();
    expect(template).not.toMatch(/\bmacf#\d+\b|\bgroundnuty\/macf#\d+\b|\bDR-0\d{2}\b|\bAmendment [A-Z0-9]\b/);
  });
});

describe('writeOperatorSecretsFileTemplate + ensureOperatorSecretsGitignore — never committed (#1197 required)', () => {
  it('writes the template AND gitignores it in the same call', () => {
    const dir = tmpDir();
    const path = join(dir, 'secrets.env.template');
    const result = writeOperatorSecretsFileTemplate(path);
    expect(result.created).toBe(true);
    expect(existsSync(path)).toBe(true);
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(gitignore.split('\n').map((l) => l.trim())).toContain('secrets.env.template');
  });

  it('refuses to overwrite an existing file — an operator who already filled one in must not have it blanked', () => {
    const dir = tmpDir();
    const path = join(dir, 'secrets.env.template');
    writeFileSync(path, 'MACF_BOOTSTRAP_RUNNER_TOKEN=already-filled-in\n', 'utf-8');
    const result = writeOperatorSecretsFileTemplate(path);
    expect(result.created).toBe(false);
    expect(readFileSync(path, 'utf-8')).toContain('already-filled-in');
  });

  it('ensureOperatorSecretsGitignore is idempotent and appends to (never replaces) a hand-authored .gitignore', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n', 'utf-8');
    ensureOperatorSecretsGitignore(dir, 'secrets.env');
    ensureOperatorSecretsGitignore(dir, 'secrets.env'); // second call — must not duplicate
    const lines = readFileSync(join(dir, '.gitignore'), 'utf-8').split('\n').map((l) => l.trim());
    expect(lines).toContain('node_modules/');
    expect(lines.filter((l) => l === 'secrets.env')).toHaveLength(1);
  });
});
