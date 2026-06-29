/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/bootstrap-exchange-manifest.sh`
 * — the helper that redeems a GitHub App-manifest `code` for the created App's
 * credentials (app_id + private-key PEM + client/webhook secrets), DR-035 §3/§5.
 *
 * The exchange calls `gh api POST /app-manifests/<code>/conversions`; tests
 * prepend a stub `gh` to PATH (mirrors check-bootstrap-gh-guard.test.ts). The
 * stub emits a valid mock conversions response (PEM newlines escaped as `\n`,
 * exactly as the real API returns) on the good code and a non-2xx (exit 1) on a
 * bad code.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const SCRIPT = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude', 'scripts', 'bootstrap-exchange-manifest.sh');

/**
 * A stub `gh` that emulates the conversions endpoint:
 *  - code "goodcode"  → 200 + full JSON (pem with escaped \n, as the real API)
 *  - code "emptycode" → 200 but no id/pem (silent-fallback guard target)
 *  - anything else    → non-2xx (exit 1, error on stderr)
 */
function makeStubGhDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bs-exchange-gh-'));
  const stub = `#!/usr/bin/env bash
if [ "$1" = api ]; then
  case "$*" in
    *app-manifests/goodcode/conversions*)
      cat <<'JSON'
{"id":424242,"name":"icsoc-2026-code-agent","slug":"icsoc-2026-code-agent","client_id":"Iv1.deadbeef","client_secret":"sekret","webhook_secret":"whook","pem":"-----BEGIN RSA PRIVATE KEY-----\\nMIIabc\\n-----END RSA PRIVATE KEY-----\\n"}
JSON
      exit 0 ;;
    *app-manifests/emptycode/conversions*)
      echo '{"name":"n"}'
      exit 0 ;;
    *)
      echo "gh: HTTP 422 Unprocessable Entity (code already taken)" >&2
      exit 1 ;;
  esac
fi
exit 0
`;
  const p = join(dir, 'gh');
  writeFileSync(p, stub);
  chmodSync(p, 0o755);
  return dir;
}

function run(args: readonly string[]): ReturnType<typeof spawnSync> {
  const stubDir = makeStubGhDir();
  try {
    return spawnSync('bash', [SCRIPT, ...args], {
      env: { PATH: `${stubDir}:${process.env['PATH'] ?? ''}` },
      encoding: 'utf-8',
    });
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

describe('bootstrap-exchange-manifest.sh', () => {
  it('parses app_id + pem + secrets from a mock conversions response', () => {
    const r = run(['goodcode']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, string>;
    expect(out['app_id']).toBe('424242');
    expect(out['client_id']).toBe('Iv1.deadbeef');
    expect(out['client_secret']).toBe('sekret');
    expect(out['webhook_secret']).toBe('whook');
    // pem decoded with real newlines (jq -r unescaped the \n)
    expect(out['pem']).toContain('BEGIN RSA PRIVATE KEY');
    expect(out['pem']).toContain('\n');
  });

  it('writes the normalized JSON to --out at 0600', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'macf-bs-exchange-out-'));
    const outFile = join(outDir, 'app.json');
    try {
      const r = run(['goodcode', '--out', outFile]);
      expect(r.status).toBe(0);
      expect(existsSync(outFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(outFile, 'utf-8')) as Record<string, string>;
      expect(parsed['app_id']).toBe('424242');
      expect(statSync(outFile).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('fails LOUD on a non-2xx exchange (bad/expired code)', () => {
    const r = run(['badcode']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('exchange failed');
  });

  it('fails (exit 2) when no code is given', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no manifest code');
  });

  it('fails LOUD on a 2xx that returns no app_id/pem (result-invariant guard)', () => {
    const r = run(['emptycode']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no app_id|no private key/);
  });
});
