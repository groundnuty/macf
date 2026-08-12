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
 *
 * macf#848 (structural hardening — no-eval read path): `vault.sh` used to
 * `eval` the decrypted plaintext to export it, so ITS safety rested entirely
 * on the writer's (`buildVaultPlaintext`) character blocklist staying
 * exhaustive forever. It now PARSES `KEY=VALUE` lines directly instead — see
 * the `vault.sh — no-eval KEY=VALUE parse (macf#848)` describe block below,
 * which pins: (a) compat with the OLD double-quoted `KEY="value"` form (a
 * real vault already exists in the wild using it, written 2026-08-12 by the
 * first live provision); (b) the NEW single-quoted `KEY='value'` form; (c)
 * the load-bearing property — a HOSTILE value (containing `$(...)` or
 * backticks) is assigned LITERALLY and never executes, regardless of what a
 * writer emits.
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

// OLD double-quoted form — still the live fleet's real vault shape (written
// 2026-08-12, pre-macf#848). Doubles as the macf#848 read-compat fixture.
const VAULT_PLAINTEXT = [
  'MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID="333333"',
  `MACF_AGENT_ICSOC_2026_CODE_AGENT_PRIVATE_KEY_B64="${Buffer.from('FAKE-AGENT-PEM').toString('base64')}"`,
  `MACF_ICSOC_2026_CA_KEY_B64="${Buffer.from('FAKE-CA-KEY').toString('base64')}"`,
  `MACF_ICSOC_2026_CA_CERT_B64="${Buffer.from('FAKE-CA-CERT').toString('base64')}"`,
  '',
].join('\n');

// NEW single-quoted form — what buildVaultPlaintext emits post-macf#848.
// Same field values as VAULT_PLAINTEXT so the two fixtures are directly comparable.
const VAULT_PLAINTEXT_SINGLE_QUOTED = [
  "MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID='333333'",
  `MACF_AGENT_ICSOC_2026_CODE_AGENT_PRIVATE_KEY_B64='${Buffer.from('FAKE-AGENT-PEM').toString('base64')}'`,
  `MACF_ICSOC_2026_CA_KEY_B64='${Buffer.from('FAKE-CA-KEY').toString('base64')}'`,
  `MACF_ICSOC_2026_CA_CERT_B64='${Buffer.from('FAKE-CA-CERT').toString('base64')}'`,
  '',
].join('\n');

/** Source vault.sh in `shell` with a stubbed age + the plaintext-as-vault.age,
 *  an isolated HOME, and a trailing marker. Returns the spawn result.
 *  `opts.plaintext` overrides the default (OLD double-quoted) fixture — used
 *  by the macf#848 compat + hostile-value tests below. */
function sourceVault(
  shell: 'bash' | 'zsh',
  opts: { trailer: string; plaintext?: string },
): ReturnType<typeof spawnSync> {
  const work = mkdtempSync(join(tmpdir(), 'macf-vault-src-'));
  const tpl = join(work, 'tpl');
  mkdirSync(tpl, { recursive: true });
  // Copy the real vault.sh next to a "vault.age" that the stub age will cat back.
  writeFileSync(join(tpl, 'vault.sh'), readFileSync(VAULT_SH, 'utf-8'));
  writeFileSync(join(tpl, 'vault.age'), opts.plaintext ?? VAULT_PLAINTEXT);
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

describe('vault.sh — no-eval KEY=VALUE parse (macf#848)', () => {
  it('never evals the decrypted vault plaintext — only the static zsh self-path-resolution eval remains', () => {
    const code = read(VAULT_SH, 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    // The load-bearing absence: `eval` applied to attacker-influenced decrypted
    // content. The ONE legitimate `eval` left resolves this script's own path
    // under zsh from a hardcoded, script-authored string — never vault content.
    expect(code).not.toMatch(/eval\s+"?\$_vault_plain"?/);
    expect(code).not.toMatch(/eval\s+"?\$\{_vault_plain/);
    // set -a / set +a auto-export (paired with the removed eval) is gone too.
    expect(code).not.toMatch(/^\s*set\s+-a\b/m);
  });

  it(
    'compat: exports OLD double-quoted KEY="value" lines into the sourcing shell ' +
      '(a real vault already exists in the wild using this form, written 2026-08-12)',
    () => {
      const r = sourceVault('bash', {
        trailer: 'echo "APP_ID=[$MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID]"',
        plaintext: VAULT_PLAINTEXT,
      });
      expect(r.stdout, `stderr:\n${r.stderr}`).toContain('APP_ID=[333333]');
    },
  );

  it("exports NEW single-quoted KEY='value' lines into the sourcing shell", () => {
    const r = sourceVault('bash', {
      trailer: 'echo "APP_ID=[$MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID]"',
      plaintext: VAULT_PLAINTEXT_SINGLE_QUOTED,
    });
    expect(r.stdout, `stderr:\n${r.stderr}`).toContain('APP_ID=[333333]');
  });

  it.skipIf(!HAS_ZSH)("compat + new form both export correctly under zsh too", () => {
    const rOld = sourceVault('zsh', {
      trailer: 'echo "APP_ID=[$MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID]"',
      plaintext: VAULT_PLAINTEXT,
    });
    expect(rOld.stdout, `stderr:\n${rOld.stderr}`).toContain('APP_ID=[333333]');
    const rNew = sourceVault('zsh', {
      trailer: 'echo "APP_ID=[$MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID]"',
      plaintext: VAULT_PLAINTEXT_SINGLE_QUOTED,
    });
    expect(rNew.stdout, `stderr:\n${rNew.stderr}`).toContain('APP_ID=[333333]');
  });

  it(
    'a hostile value with $(...) command substitution is assigned LITERALLY and NEVER EXECUTES ' +
      '(the READER must be safe regardless of what a writer emits — this bypasses buildVaultPlaintext entirely)',
    () => {
      const work = mkdtempSync(join(tmpdir(), 'macf-vault-hostile-cmdsub-'));
      const sentinel = join(work, 'PWNED-CMDSUB');
      const hostilePlaintext = [`MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID='$(touch ${sentinel})'`, ''].join('\n');
      const r = sourceVault('bash', {
        trailer: 'echo "APP_ID=[$MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID]"',
        plaintext: hostilePlaintext,
      });
      // Round-trips as the LITERAL text — not the (never-run) command's output.
      expect(r.stdout, `stderr:\n${r.stderr}`).toContain(`APP_ID=[$(touch ${sentinel})]`);
      // The proof: the side effect never happened.
      expect(existsSync(sentinel)).toBe(false);
    },
  );

  it('a hostile value with backticks is also assigned LITERALLY and NEVER EXECUTES', () => {
    const work = mkdtempSync(join(tmpdir(), 'macf-vault-hostile-backtick-'));
    const sentinel = join(work, 'PWNED-BACKTICK');
    const hostilePlaintext = [`MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID='\`touch ${sentinel}\`'`, ''].join('\n');
    const r = sourceVault('bash', {
      trailer: 'echo "APP_ID=[$MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID]"',
      plaintext: hostilePlaintext,
    });
    expect(r.stdout, `stderr:\n${r.stderr}`).toContain(`APP_ID=[\`touch ${sentinel}\`]`);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('a hostile value under the OLD double-quoted form is also assigned LITERALLY and NEVER EXECUTES', () => {
    const work = mkdtempSync(join(tmpdir(), 'macf-vault-hostile-dq-'));
    const sentinel = join(work, 'PWNED-DQ');
    // The OLD writer's blocklist would have rejected this at write time — but
    // the READER must not depend on that: a hand-edited or pre-macf#848 vault
    // with this shape must still be inert.
    const hostilePlaintext = [`MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID="$(touch ${sentinel})"`, ''].join('\n');
    const r = sourceVault('bash', {
      trailer: 'echo "APP_ID=[$MACF_AGENT_ICSOC_2026_CODE_AGENT_APP_ID]"',
      plaintext: hostilePlaintext,
    });
    expect(r.stdout, `stderr:\n${r.stderr}`).toContain(`APP_ID=[$(touch ${sentinel})]`);
    expect(existsSync(sentinel)).toBe(false);
  });
});
