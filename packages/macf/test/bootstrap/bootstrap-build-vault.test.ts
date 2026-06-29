/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/bootstrap-build-vault.sh`
 * — age-encrypts the assembled secrets into vault.age and guarantees no plaintext
 * is left on disk (DR-035 §4/§5/§6). Tests stub `age` + `age-keygen` on PATH so
 * the round-trip is hermetic.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const SCRIPT = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude', 'scripts', 'bootstrap-build-vault.sh');

/** Stub `age` that writes a marker to the `-o <file>` target (or fails on demand). */
const AGE_OK = `#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
[ -n "$out" ] && printf 'ENCRYPTED-AGE-PAYLOAD\\n' > "$out"
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

function run(args: readonly string[], opts: { readonly ageFail?: boolean } = {}): ReturnType<typeof spawnSync> {
  const stubDir = makeStubBin(opts);
  try {
    // Prepend stub bin so the stub age/age-keygen win; keep real coreutils.
    return spawnSync('bash', [SCRIPT, ...args], {
      env: { PATH: `${stubDir}:${process.env['PATH'] ?? ''}` },
      encoding: 'utf-8',
    });
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

describe('bootstrap-build-vault.sh', () => {
  it('encrypts to vault.age with an explicit --recipient and shreds the plaintext', () => {
    const work = mkdtempSync(join(tmpdir(), 'macf-bs-vault-work-'));
    const plain = join(work, 'vault.plain');
    const out = join(work, 'vault.age');
    writeFileSync(plain, 'MACF_AGENT_FOO_APP_ID="123"\n');
    try {
      const r = run(['--in', plain, '--out', out, '--recipient', 'age1qrecipient000000000000000000000000000000000000000000000000']);
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, 'utf-8')).toContain('ENCRYPTED-AGE-PAYLOAD');
      // plaintext must be gone (shredded) — no plaintext left on disk
      expect(existsSync(plain)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('mints a fresh keypair when --recipient is omitted (writes --key-out)', () => {
    const work = mkdtempSync(join(tmpdir(), 'macf-bs-vault-work-'));
    const plain = join(work, 'vault.plain');
    const out = join(work, 'vault.age');
    const keyOut = join(work, 'age-key.txt');
    writeFileSync(plain, 'SECRET\n');
    try {
      const r = run(['--in', plain, '--out', out, '--key-out', keyOut]);
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);
      expect(existsSync(keyOut)).toBe(true);
      expect(readFileSync(keyOut, 'utf-8')).toContain('AGE-SECRET-KEY');
      expect(existsSync(plain)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('fails (exit 2) when --in is missing', () => {
    const r = run(['--out', '/tmp/whatever.age']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--in');
  });

  it('removes the partial vault and preserves the plaintext when age fails', () => {
    const work = mkdtempSync(join(tmpdir(), 'macf-bs-vault-work-'));
    const plain = join(work, 'vault.plain');
    const out = join(work, 'vault.age');
    writeFileSync(plain, 'SECRET\n');
    try {
      const r = run(
        ['--in', plain, '--out', out, '--recipient', 'age1qrecipient000000000000000000000000000000000000000000000000'],
        { ageFail: true },
      );
      expect(r.status).not.toBe(0);
      // no half-written vault, plaintext NOT shredded (encrypt failed)
      expect(existsSync(out)).toBe(false);
      expect(existsSync(plain)).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
