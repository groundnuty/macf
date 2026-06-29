/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/bootstrap-build-vault.sh`
 * — age-encrypts the assembled secrets into vault.age. The plaintext is PIPED on
 * STDIN and streamed into `age`; no `vault.plain` file is ever written
 * (secure-by-construction — science's #659 secrets-on-disk review, DR-035 §4).
 * Tests stub `age` + `age-keygen` on PATH so the round-trip is hermetic.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const SCRIPT = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude', 'scripts', 'bootstrap-build-vault.sh');

/**
 * Stub `age` that emulates encryption by writing `AGE:` + whatever it reads on
 * STDIN to the `-o <file>` target. Echoing STDIN lets us prove the plaintext
 * actually flowed through the pipe (not a file).
 */
const AGE_OK = `#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
{ printf 'AGE:'; cat; } > "$out"
exit 0
`;
const AGE_FAIL = `#!/usr/bin/env bash
echo "age: simulated failure" >&2
exit 1
`;
/** Stub `age-keygen` that writes a key file with a `# public key: age1...` line. */
const KEYGEN_OK = `#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
{ echo "# created: 2026-01-01"; echo "# public key: age1stubpubkey00000000000000000000000000000000000000000000000"; echo "AGE-SECRET-KEY-1STUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBSTUB"; } > "$out"
echo "Public key: age1stubpubkey..." >&2
exit 0
`;

function makeStubBin(opts: { readonly ageFail?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bs-vault-bin-'));
  writeFileSync(join(dir, 'age'), opts.ageFail ? AGE_FAIL : AGE_OK);
  chmodSync(join(dir, 'age'), 0o755);
  writeFileSync(join(dir, 'age-keygen'), KEYGEN_OK);
  chmodSync(join(dir, 'age-keygen'), 0o755);
  return dir;
}

function run(
  args: readonly string[],
  opts: { readonly ageFail?: boolean; readonly input?: string } = {},
): ReturnType<typeof spawnSync> {
  const stubDir = makeStubBin(opts);
  try {
    // Prepend stub bin so the stub age/age-keygen win; keep real coreutils.
    return spawnSync('bash', [SCRIPT, ...args], {
      env: { PATH: `${stubDir}:${process.env['PATH'] ?? ''}` },
      // Plaintext is piped on STDIN — the whole point of the refactor.
      input: opts.input ?? '',
      encoding: 'utf-8',
    });
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

describe('bootstrap-build-vault.sh', () => {
  it('encrypts STDIN to vault.age with an explicit --recipient — no vault.plain on disk', () => {
    const work = mkdtempSync(join(tmpdir(), 'macf-bs-vault-work-'));
    const out = join(work, 'vault.age');
    try {
      const r = run(
        ['--out', out, '--recipient', 'age1qrecipient000000000000000000000000000000000000000000000000'],
        { input: 'MACF_AGENT_FOO_APP_ID="123"\n' },
      );
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);
      // the piped plaintext actually flowed through age (proves STDIN-pipe)
      expect(readFileSync(out, 'utf-8')).toContain('MACF_AGENT_FOO_APP_ID="123"');
      // SECURE-BY-CONSTRUCTION: no plaintext file is ever created
      expect(existsSync(join(work, 'vault.plain'))).toBe(false);
      // the work dir contains ONLY the encrypted vault — no stray plaintext
      expect(readdirSync(work)).toEqual(['vault.age']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('mints a fresh keypair when --recipient is omitted (writes --key-out); still no vault.plain', () => {
    const work = mkdtempSync(join(tmpdir(), 'macf-bs-vault-work-'));
    const out = join(work, 'vault.age');
    const keyOut = join(work, 'age-key.txt');
    try {
      const r = run(['--out', out, '--key-out', keyOut], { input: 'SECRET\n' });
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);
      expect(existsSync(keyOut)).toBe(true);
      expect(readFileSync(keyOut, 'utf-8')).toContain('AGE-SECRET-KEY');
      expect(existsSync(join(work, 'vault.plain'))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('fails (exit 2) when --out is missing', () => {
    const r = run(['--recipient', 'age1qx'], { input: 'SECRET\n' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--out');
  });

  it('rejects the removed --in flag with a STDIN migration hint (exit 2)', () => {
    const r = run(['--in', '/tmp/whatever.plain', '--out', '/tmp/whatever.age'], { input: 'SECRET\n' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--in is removed');
    expect(r.stderr).toContain('STDIN');
  });

  it('fails (exit 2) on empty STDIN — a silently-empty vault is a hazard', () => {
    const work = mkdtempSync(join(tmpdir(), 'macf-bs-vault-work-'));
    const out = join(work, 'vault.age');
    const keyOut = join(work, 'age-key.txt');
    try {
      const r = run(['--out', out, '--key-out', keyOut], { input: '' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('empty plaintext');
      // no vault produced, and no orphan key minted (empty-check precedes keygen)
      expect(existsSync(out)).toBe(false);
      expect(existsSync(keyOut)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('on age failure removes the partial vault AND the minted key — no plaintext anywhere', () => {
    const work = mkdtempSync(join(tmpdir(), 'macf-bs-vault-work-'));
    const out = join(work, 'vault.age');
    const keyOut = join(work, 'age-key.txt');
    try {
      const r = run(['--out', out, '--key-out', keyOut], { ageFail: true, input: 'SECRET\n' });
      expect(r.status).not.toBe(0);
      // no half-written vault, no orphan minted key, and (by construction) no plaintext file
      expect(existsSync(out)).toBe(false);
      expect(existsSync(keyOut)).toBe(false);
      expect(existsSync(join(work, 'vault.plain'))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
