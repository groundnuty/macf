/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/bootstrap-validate-env.sh`
 * — start-of-run environment validation (DR-035 §1). Critical gaps (non-user gh,
 * missing age, missing jq, missing rails) exit non-zero; the Chrome MCP probe is
 * best-effort (warn only).
 *
 * Tests use a curated PATH (`<stub>:/usr/bin:/bin`) so age/curl/gh resolve ONLY
 * from the stub dir (the host's age/curl/gh live in /home/linuxbrew, excluded),
 * while jq + coreutils still come from /usr/bin. This makes "missing age" a real
 * absence rather than a shadowing trick. The rails check reads the REAL workspace
 * files (which exist), so it never trips in these tests.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const SCRIPT = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude', 'scripts', 'bootstrap-validate-env.sh');

function write(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

/**
 * Build a stub bin dir.
 *  - gh: always present, `gh auth token` prints `ghToken`.
 *  - age: when true, stub `age` + `age-keygen`.
 *  - curl: 'ok' (exit 0) | 'fail' (exit 1) | undefined (absent).
 */
function makeStubBin(opts: {
  readonly ghToken: string;
  readonly age?: boolean;
  readonly curl?: 'ok' | 'fail';
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bs-validate-bin-'));
  write(dir, 'gh', `#!/usr/bin/env bash
if [ "$1" = auth ] && [ "$2" = token ]; then echo "${opts.ghToken}"; exit 0; fi
exit 0
`);
  if (opts.age) {
    write(dir, 'age', `#!/usr/bin/env bash\nexit 0\n`);
    write(dir, 'age-keygen', `#!/usr/bin/env bash\nexit 0\n`);
  }
  if (opts.curl === 'ok') {
    write(dir, 'curl', `#!/usr/bin/env bash\necho '{"Browser":"x"}'\nexit 0\n`);
  } else if (opts.curl === 'fail') {
    write(dir, 'curl', `#!/usr/bin/env bash\nexit 7\n`);
  }
  return dir;
}

function run(stubDir: string): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [SCRIPT], {
    env: { PATH: `${stubDir}:/usr/bin:/bin` },
    encoding: 'utf-8',
  });
}

describe('bootstrap-validate-env.sh', () => {
  it('CRITICAL: gh authenticated as a BOT (ghs_) token, not the operator', () => {
    const dir = makeStubBin({ ghToken: 'ghs_bottoken', age: true, curl: 'ok' });
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/BOT|USER account/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CRITICAL: age missing', () => {
    const dir = makeStubBin({ ghToken: 'gho_usertoken', curl: 'ok' }); // no age
    try {
      const r = run(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/age/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('best-effort WARN (non-fatal): Chrome remote-debugging endpoint unreachable', () => {
    const dir = makeStubBin({ ghToken: 'gho_usertoken', age: true, curl: 'fail' });
    try {
      const r = run(dir);
      expect(r.status).toBe(0); // warn only — not a critical
      expect(r.stderr).toContain('Chrome remote-debugging endpoint NOT reachable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes when gh is a user token + age + Chrome reachable', () => {
    const dir = makeStubBin({ ghToken: 'gho_usertoken', age: true, curl: 'ok' });
    try {
      const r = run(dir);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('environment validation OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
