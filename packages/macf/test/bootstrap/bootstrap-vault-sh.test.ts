/**
 * Tests for `tools/macf-bootstrap/templates/vault.sh` — the vault accessor
 * committed alongside vault.age into the science repo and SOURCED on the VM.
 *
 * First-run finding (macf-automated-github-setup#1): the prior vault.sh ran
 * `set -euo pipefail` + bash-isms (`compgen`, `${!var}`) and, sourced into the
 * VM's zsh login shell, TOOK THE OPERATOR'S SHELL DOWN. It also only materialized
 * the per-agent App PEMs, never the per-project CA. These tests pin both fixes:
 *   (1) source-safety — parses under `bash -n` AND `zsh -n`; no errexit/nounset
 *       leak into the caller when sourced (the actual shell-kill failure mode);
 *   (2) it materializes the per-project CA (ca-cert.pem + ca-key.pem) in addition
 *       to the per-agent PEMs.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const VAULT_SH = join(REPO_ROOT, 'tools', 'macf-bootstrap', 'templates', 'vault.sh');

function have(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).status === 0;
}
const HAS_ZSH = have('zsh');

/** A stub `age` that ignores flags and prints its LAST argument's file verbatim,
 *  so `age -d -i <key> <vault.age>` just emits whatever we wrote into <vault.age>
 *  — no real crypto, fully hermetic. */
const AGE_STUB = `#!/usr/bin/env bash
last=""
for a in "$@"; do last="$a"; done
cat "$last"
`;

function stubBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-vault-bin-'));
  writeFileSync(join(dir, 'age'), AGE_STUB);
  chmodSync(join(dir, 'age'), 0o755);
  return dir;
}

const VAULT_PLAINTEXT = [
  'MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID="333333"',
  `MACF_AGENT_ICSOC_2026_CODE_AGENT_PRIVATE_KEY_B64="${Buffer.from('FAKE-AGENT-PEM').toString('base64')}"`,
  `MACF_ICSOC_2026_CA_KEY_B64="${Buffer.from('FAKE-CA-KEY').toString('base64')}"`,
  `MACF_ICSOC_2026_CA_CERT_B64="${Buffer.from('FAKE-CA-CERT').toString('base64')}"`,
  '',
].join('\n');

/** Source vault.sh in `shell` with a stubbed age + the plaintext-as-vault.age,
 *  an isolated HOME, and a trailing marker. Returns the spawn result. */
function sourceVault(shell: 'bash' | 'zsh', opts: { trailer: string }): ReturnType<typeof spawnSync> {
  const work = mkdtempSync(join(tmpdir(), 'macf-vault-src-'));
  const tpl = join(work, 'tpl');
  mkdirSync(tpl, { recursive: true });
  // Copy the real vault.sh next to a "vault.age" that the stub age will cat back.
  writeFileSync(join(tpl, 'vault.sh'), readFileSync(VAULT_SH, 'utf-8'));
  writeFileSync(join(tpl, 'vault.age'), VAULT_PLAINTEXT);
  const ageKey = join(work, 'age-key.txt');
  writeFileSync(ageKey, 'AGE-SECRET-KEY-stub');
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  const bin = stubBin();
  return spawnSync(shell, ['-c', `source '${join(tpl, 'vault.sh')}'; ${opts.trailer}`], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      MACF_VAULT_AGE_KEY: ageKey,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      // Carry the work dir out so the caller can inspect materialized files.
      MACF_TEST_HOME: home,
    },
  });
}

describe('vault.sh — source-safety (shell-kill fix, macf-automated-github-setup#1)', () => {
  it('parses cleanly under bash -n', () => {
    const r = spawnSync('bash', ['-n', VAULT_SH], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it.skipIf(!HAS_ZSH)('parses cleanly under zsh -n (the VM login shell)', () => {
    const r = spawnSync('zsh', ['-n', VAULT_SH], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('does NOT contain the shell-killing bash-isms (set -euo pipefail / compgen / ${!})', () => {
    // Check EXECUTABLE lines only — comment lines legitimately document the old
    // (removed) constructs as history, which must not trip the absence check.
    const code = read(VAULT_SH, 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    // The errexit/nounset/pipefail leak is THE failure mode — it must be gone.
    expect(code).not.toMatch(/set\s+-euo\s+pipefail/);
    expect(code).not.toMatch(/^\s*set\s+-e\b/m);
    // compgen + ${!var} indirect expansion are the bash-only constructs that
    // broke under zsh; the rewrite parses the decrypted text directly instead.
    expect(code).not.toMatch(/\bcompgen\b/);
    expect(code).not.toMatch(/\$\{!/);
  });

  it('does not leak errexit into the sourcing shell (bash): a later `false` is survived', () => {
    // Source the (functional) vault, then run a failing command + a marker. If
    // errexit had leaked, the marker would never print.
    const r = sourceVault('bash', { trailer: 'false; echo REACHED_AFTER_FALSE' });
    expect(r.stdout).toContain('REACHED_AFTER_FALSE');
  });

  it('does not leak nounset into the sourcing shell (bash): an unset var is survived', () => {
    const r = sourceVault('bash', { trailer: 'echo "[${THIS_IS_UNSET}]"; echo REACHED_UNSET' });
    expect(r.stdout).toContain('REACHED_UNSET');
  });

  it.skipIf(!HAS_ZSH)('does not kill the zsh login shell when sourced (errexit not leaked)', () => {
    const r = sourceVault('zsh', { trailer: 'false; echo REACHED_AFTER_FALSE' });
    expect(r.stdout).toContain('REACHED_AFTER_FALSE');
  });
});

describe('vault.sh — CA materialization (No-CA-on-VM fix)', () => {
  it('references the CA-materialize path (CA_CERT_B64 + ca-cert.pem)', () => {
    const src = read(VAULT_SH, 'utf-8');
    expect(src).toMatch(/_CA_(CERT|KEY)_B64/);
    expect(src).toContain('ca-cert.pem');
    expect(src).toContain('ca-key.pem');
    expect(src).toContain('.macf/certs/');
  });

  it('materializes BOTH per-agent PEMs and the per-project CA when sourced', () => {
    const r = sourceVault('bash', { trailer: 'echo DONE' });
    expect(r.stdout).toContain('DONE');
    // Resolve the materialized paths from the stderr "wrote …" lines (the work
    // dir is random per-run); then assert the files exist with decoded bytes.
    const pemLine = r.stderr.match(/wrote (.*\/\.macf\/keys\/icsoc-2026-code-agent\.pem)/);
    const caCertLine = r.stderr.match(/wrote (.*\/\.macf\/certs\/icsoc-2026\/ca-cert\.pem)/);
    const caKeyLine = r.stderr.match(/wrote (.*\/\.macf\/certs\/icsoc-2026\/ca-key\.pem)/);
    expect(pemLine, `stderr:\n${r.stderr}`).not.toBeNull();
    expect(caCertLine, `stderr:\n${r.stderr}`).not.toBeNull();
    expect(caKeyLine, `stderr:\n${r.stderr}`).not.toBeNull();
    // The files actually exist with the decoded bytes.
    expect(existsSync(pemLine![1])).toBe(true);
    expect(existsSync(caCertLine![1])).toBe(true);
    expect(existsSync(caKeyLine![1])).toBe(true);
    expect(readFileSync(caCertLine![1], 'utf-8')).toBe('FAKE-CA-CERT');
    expect(readFileSync(caKeyLine![1], 'utf-8')).toBe('FAKE-CA-KEY');
    expect(readFileSync(pemLine![1], 'utf-8')).toBe('FAKE-AGENT-PEM');
  });
});
