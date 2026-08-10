/**
 * Tests for `scripts/check-gh-token.sh` — the PreToolUse hook that
 * structurally blocks `gh` / `git push` invocations when `GH_TOKEN`
 * is missing or isn't a bot installation token (`ghs_` prefix).
 *
 * Background (#140): behavioral controls for the attribution trap
 * recurred 5 times in a single day. This hook moves enforcement
 * from operator discipline to the harness itself.
 *
 * The hook receives JSON on stdin per Claude Code's PreToolUse
 * contract: `{ tool_name, tool_input: { command }, ... }`.
 * Exit 0 = allow, exit 2 = block (stderr → Claude as error).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-gh-token.sh');

/**
 * Spawn the hook with a JSON stdin payload + env overrides.
 * Returns the raw spawn result for exit-code + stderr assertions.
 */
function runHook(opts: {
  readonly command: string;
  readonly env?: Record<string, string | undefined>;
}): ReturnType<typeof spawnSync> {
  const payload = JSON.stringify({
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: opts.command },
  });
  // Preserve PATH so bash/jq resolve, but scrub GH_TOKEN/MACF_* unless
  // explicitly set in opts.env. Otherwise ambient GH_TOKEN from the
  // test runner leaks in and masks the negative cases.
  const cleanEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
  };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }
  }
  return spawnSync('bash', [HOOK_SCRIPT], {
    input: payload,
    env: cleanEnv,
    encoding: 'utf-8',
  });
}

describe('check-gh-token.sh (hook)', () => {
  describe('positive path — valid ghs_ token', () => {
    it('allows `gh issue view` when GH_TOKEN starts with ghs_', () => {
      const r = runHook({
        command: 'gh issue view 140',
        env: { GH_TOKEN: 'ghs_faketokenvalue1234567890' },
      });
      expect(r.status).toBe(0);
    });

    it('allows `git push` when GH_TOKEN starts with ghs_', () => {
      const r = runHook({
        command: 'git push origin main',
        env: { GH_TOKEN: 'ghs_faketokenvalue1234567890' },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('negative path — missing or wrong-prefix token', () => {
    it('blocks `gh issue view` when GH_TOKEN is unset', () => {
      const r = runHook({
        command: 'gh issue view 140',
        env: {}, // GH_TOKEN deliberately absent
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/macf-gh-token\.sh/);
    });

    it('blocks `gh issue close` when GH_TOKEN is empty', () => {
      const r = runHook({
        command: 'gh issue close 140',
        env: { GH_TOKEN: '' },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
    });

    it('blocks when GH_TOKEN has user-token prefix (ghp_)', () => {
      const r = runHook({
        command: 'gh pr create',
        env: { GH_TOKEN: 'ghp_personalaccesstokenvalue123' },
      });
      expect(r.status).toBe(2);
    });

    it('blocks when GH_TOKEN has oauth-token prefix (gho_)', () => {
      const r = runHook({
        command: 'gh api user',
        env: { GH_TOKEN: 'gho_oauthtokenvalue1234567890' },
      });
      expect(r.status).toBe(2);
    });

    it('blocks `git push` when GH_TOKEN is unset', () => {
      const r = runHook({
        command: 'git push -u origin HEAD',
        env: {},
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
    });
  });

  describe('wrapper-aware matching (bypass prevention)', () => {
    it('blocks `sudo gh issue close` when token is bad', () => {
      const r = runHook({
        command: 'sudo gh issue close 140',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `GH_TOKEN=x gh ...` (inline env prefix) when outer token is bad', () => {
      // Inline env assignment doesn't rescue us — the hook runs in
      // Claude's process context, where the outer GH_TOKEN is what
      // counts. The inline assignment would only affect the child.
      const r = runHook({
        command: 'GH_TOKEN=ghp_useronly gh pr merge 99',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `env FOO=bar gh ...` when token is bad', () => {
      const r = runHook({
        command: 'env FOO=bar gh issue list',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `make && sudo gh issue close` (chained wrapper)', () => {
      const r = runHook({
        command: 'make && sudo gh issue close 140',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `watch gh run list` when token is bad', () => {
      const r = runHook({
        command: 'watch gh run list',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    // Shell-wrapper bypass — caught by post-#140 audit. `bash -c "gh ..."`
    // and `sh -c '...'` invocations were a trivial bypass in the original
    // regex because `bash`/`sh` weren't in the wrapper allowlist and the
    // `gh` inside the quoted string wasn't preceded by an allowed
    // delimiter. The -c flag executes the quoted string AS A COMMAND,
    // so gh inside it IS an invocation (unlike `echo "gh is cool"` where
    // gh is just literal data).
    it('blocks `bash -c "gh issue close"` when token is bad (shell-wrapper bypass)', () => {
      const r = runHook({
        command: 'bash -c "gh issue close 42"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -c \'gh pr merge\'` (single-quoted form)', () => {
      const r = runHook({
        command: "bash -c 'gh pr merge 1'",
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `sh -c "gh api user"` when token is bad', () => {
      const r = runHook({
        command: 'sh -c "gh api user"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `sudo bash -c "gh issue close"` (chained shell wrapper)', () => {
      const r = runHook({
        command: 'sudo bash -c "gh issue close 42"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -lc "gh ..."` (login shell flag combined with -c)', () => {
      // `-lc` is a shorthand for `-l -c` that some operators use. The
      // regex tolerates the `l` prefix.
      const r = runHook({
        command: 'bash -lc "gh issue close 42"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `sh -c "git push origin main"` (git-push variant)', () => {
      const r = runHook({
        command: 'sh -c "git push origin main"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    // Flag-prefixed shell forms — caught in the meta-audit on PR #153.
    // Operators using bash debug flags (`-x` xtrace) before `-c` was a
    // real bypass in the initial SHELL_C_PATTERN.
    it('blocks `bash -x -c "gh ..."` (xtrace flag before -c)', () => {
      const r = runHook({
        command: 'bash -x -c "gh issue close 42"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -xc "gh ..."` (combined xtrace + -c flag)', () => {
      const r = runHook({
        command: 'bash -xc "gh issue close 42"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -e -xc "gh ..."` (multiple flags + combined form)', () => {
      const r = runHook({
        command: 'bash -e -xc "gh issue close 42"',
        env: {},
      });
      expect(r.status).toBe(2);
    });

    it('still ALLOWS `echo "gh is cool"` (string-mention, not an invocation)', () => {
      // Regression guard — the shell-wrapper fix must not trip on
      // literal `gh` text inside non-executing quoted strings.
      const r = runHook({
        command: 'echo "gh is cool"',
        env: {},
      });
      expect(r.status).toBe(0);
    });
  });

  describe('override — MACF_SKIP_TOKEN_CHECK', () => {
    it('bypasses when MACF_SKIP_TOKEN_CHECK=1, even for gh with no token', () => {
      const r = runHook({
        command: 'gh issue close 1',
        env: { MACF_SKIP_TOKEN_CHECK: '1' },
      });
      expect(r.status).toBe(0);
    });
  });

  // `gh auth *` is identity-management; user-attribution is correct by
  // design, so the hook must not block it. Without this carve-out, the
  // first `gh auth login` in a fresh workspace hits a wall of text
  // before onboarding completes — per science-agent's #140 review.
  describe('carve-out — gh auth is exempt (identity management)', () => {
    it('allows `gh auth login` with no GH_TOKEN (onboarding path)', () => {
      const r = runHook({
        command: 'gh auth login',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `gh auth status` with no GH_TOKEN', () => {
      const r = runHook({
        command: 'gh auth status',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `gh auth token` with no GH_TOKEN', () => {
      const r = runHook({
        command: 'gh auth token',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `gh auth refresh` with no GH_TOKEN', () => {
      const r = runHook({
        command: 'gh auth refresh',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `gh auth setup-git` with no GH_TOKEN', () => {
      const r = runHook({
        command: 'gh auth setup-git',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `sudo gh auth login` (wrapped form) with no GH_TOKEN', () => {
      const r = runHook({
        command: 'sudo gh auth login',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('still BLOCKS `gh authorize-team` (not gh auth — similar prefix, different command)', () => {
      // Defensive: if someone ever adds a command called `authorize-team`
      // or similar, the carve-out should not leak. `gh auth` requires a
      // word boundary (space or end) after `auth`.
      const r = runHook({
        command: 'gh authorize-team foo',
        env: {},
      });
      expect(r.status).toBe(2);
    });
  });

  describe('no-op path — unrelated commands', () => {
    it('allows `ls -la` regardless of GH_TOKEN state', () => {
      const r = runHook({
        command: 'ls -la',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `echo "gh is cool"` (literal inside quoted string, not a gh call)', () => {
      const r = runHook({
        command: 'echo "gh is cool"',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `git status` (git but not git push)', () => {
      const r = runHook({
        command: 'git status',
        env: {},
      });
      expect(r.status).toBe(0);
    });

    it('allows `npm install` with no GH_TOKEN', () => {
      const r = runHook({
        command: 'npm install',
        env: {},
      });
      expect(r.status).toBe(0);
    });
  });

  // Token-shape regression — tightens prefix-only `${var:0:4} == ghs_`
  // to full-shape regex `^ghs_[A-Za-z0-9._-]+$`. The §4.4 failure-injection
  // sprint surfaced the prefix-only weakness as Pattern B's 1/10 anomaly
  // (paper-research §27): `GH_TOKEN='ghs_; rm -rf <sentinel>'` satisfied
  // the prefix check (first 4 chars match) but smuggled shell
  // metacharacters past the boundary. The regex tightening (#364
  // canonical-rule, #365 deployed-impl) restores Pattern B's contract.
  //
  // Charset widened #825/#826: GitHub changed the App installation-token
  // format 2026-04-24 to `ghs_<app-id>_<JWT>` (dots + dashes, variable
  // length), replacing the old opaque 40-char form. GitHub's guidance is
  // to treat tokens as opaque and validate only the invariants we own —
  // non-empty, `ghs_` prefix, injection-safe charset — not length/format.
  // The charset now includes `.` and `-` (both appear in base64url JWTs)
  // while STILL excluding shell metacharacters (whitespace/`;`/`$`/`(`/
  // `)`/`|`/`&`/backtick/quotes) — the charset, not the length, was
  // always the injection-safety invariant.
  describe('shape-validation regex (#365 tightened prefix→full-shape; #825/#826 widened for GitHub new-format tokens)', () => {
    it('blocks the §27 meta-injection variant (GH_TOKEN with embedded shell metacharacters)', () => {
      // The exact injection class that bypassed the prefix-only check
      // in the §4.4 sprint. First 4 chars are `ghs_` but the value
      // continues with `;` + shell command. Pre-fix: ALLOWED; now: blocks.
      const r = runHook({
        command: 'gh issue close 42',
        env: { GH_TOKEN: 'ghs_; rm -rf /tmp/sentinel' },
      });
      expect(r.status).toBe(2);
    });

    it('blocks GH_TOKEN with command-substitution payload (shape escape)', () => {
      const r = runHook({
        command: 'gh pr create',
        env: { GH_TOKEN: 'ghs_$(echo evil)' },
      });
      expect(r.status).toBe(2);
    });

    it('blocks GH_TOKEN with backtick command-substitution payload (shape escape)', () => {
      const r = runHook({
        command: 'gh pr create',
        env: { GH_TOKEN: 'ghs_`id`' },
      });
      expect(r.status).toBe(2);
    });

    it('blocks GH_TOKEN with whitespace after the prefix (shape escape)', () => {
      const r = runHook({
        command: 'gh issue list',
        env: { GH_TOKEN: 'ghs_token with space' },
      });
      expect(r.status).toBe(2);
    });

    it('blocks GH_TOKEN that is only the bare "ghs_ evil" injection shape', () => {
      const r = runHook({
        command: 'gh issue list',
        env: { GH_TOKEN: 'ghs_ evil' },
      });
      expect(r.status).toBe(2);
    });

    it('blocks bare `ghs_` with no body (`+` quantifier requires ≥1 body char)', () => {
      const r = runHook({
        command: 'gh issue view 1',
        env: { GH_TOKEN: 'ghs_' },
      });
      expect(r.status).toBe(2);
    });

    it('allows GH_TOKEN with underscore in body (regex tolerates [A-Za-z0-9._-])', () => {
      // Conservative: underscores are valid in the token shape; only
      // shell metacharacters trigger the block.
      const r = runHook({
        command: 'gh issue view 1',
        env: { GH_TOKEN: 'ghs_token_with_underscore_123' },
      });
      expect(r.status).toBe(0);
    });

    it('allows minimal valid token (ghs_ + single body char)', () => {
      const r = runHook({
        command: 'gh issue view 1',
        env: { GH_TOKEN: 'ghs_a' },
      });
      expect(r.status).toBe(0);
    });

    // --- #825/#826: GitHub's new ghs_<app-id>_<JWT> format ---

    it('allows GH_TOKEN with hyphen in body (widened #825/#826 — dashes appear in base64url JWTs)', () => {
      // Was BLOCKED before #825/#826 (regex tolerated [A-Za-z0-9_] only).
      // GitHub's new-format installation tokens contain `-` from
      // base64url encoding; this must now pass.
      const r = runHook({
        command: 'gh api user',
        env: { GH_TOKEN: 'ghs_token-with-dash' },
      });
      expect(r.status).toBe(0);
    });

    it('allows a realistic GitHub new-format token: ghs_<app-id>_<JWT> with dots AND dashes', () => {
      // Mirrors the shape confirmed live 2026-08-10 via a real
      // `gh token generate` mint for this App (macf#825/#826): ghs_
      // + numeric app-id + `_` + a base64url JWT (header.payload.signature,
      // two dots, may contain dashes from base64url encoding).
      const newFormatToken =
        'ghs_3378862_' +
        'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJpc3MiOiIzMzc4ODYyIiwiaWF0IjoxNzU0ODAwMDAwfQ.' +
        'gK9x-3fQ2z_R8mYqL7pW4vB1cN6dT0aH5jU2sE8oI-yV_gK9x3fQ2z';
      const r = runHook({
        command: 'gh issue view 140',
        env: { GH_TOKEN: newFormatToken },
      });
      expect(r.status).toBe(0);
    });
  });

  // -----------------------------------------------------------------
  // DR-019 Amendment A (#381) — actions:write audit-log emission
  // -----------------------------------------------------------------
  // The hook, in addition to its existing token-shape enforcement,
  // emits OTel span + counter signals when the gh command is in the
  // `actions:write` subcommand class. Emission is observational only:
  // emission failure (OTLP endpoint unreachable, jq absent, etc.) must
  // NOT block the gh call. The only block path remains the token-shape
  // check. See DR-019 Amendment A.
  //
  // Test approach: assert on exit codes + control flow (no real OTel
  // collector). We use a localhost port that's not listening to verify
  // the curl-fallback emission tolerates collector failure; we use an
  // unset OTLP endpoint to verify silent-skip semantics.
  describe('actions:write audit-log emission (DR-019 Amendment A, #381)', () => {
    // Valid ghs_ token + actions:write subcommand → hook passes the
    // token check, classifies the action, emits (or skips), exit 0.
    const VALID_TOKEN = 'ghs_validtoken1234567890abcdef';

    // A localhost port nothing should be listening on. curl will fail
    // fast; the hook must swallow the failure and exit 0.
    const UNREACHABLE_OTLP = 'http://127.0.0.1:1';

    describe('subcommand-class detection — each pattern emits and exits 0', () => {
      it('classifies `gh workflow run` as dispatch and exits 0 (OTLP unset, silent skip)', () => {
        const r = runHook({
          command: 'gh workflow run npm-deprecate.yml --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });

      it('classifies `gh workflow enable` as dispatch and exits 0', () => {
        const r = runHook({
          command: 'gh workflow enable npm-deprecate.yml --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });

      it('classifies `gh workflow disable` as dispatch and exits 0', () => {
        const r = runHook({
          command: 'gh workflow disable npm-deprecate.yml --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });

      it('classifies `gh run cancel` as cancel and exits 0', () => {
        const r = runHook({
          command: 'gh run cancel 1234567890 --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });

      it('classifies `gh run rerun` as rerun and exits 0', () => {
        const r = runHook({
          command: 'gh run rerun 1234567890 --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });

      it('classifies `gh run rerun --failed` as rerun and exits 0', () => {
        const r = runHook({
          command: 'gh run rerun 1234567890 --failed --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });

      it('classifies `gh api .../actions/workflows/.../dispatches` as dispatch and exits 0', () => {
        const r = runHook({
          command:
            'gh api -X POST /repos/groundnuty/macf/actions/workflows/npm-deprecate.yml/dispatches -f ref=main',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });

      it('classifies `gh api .../actions/runs/{id}/cancel` as cancel and exits 0', () => {
        const r = runHook({
          command: 'gh api -X POST /repos/groundnuty/macf/actions/runs/9876543210/cancel',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });

      it('classifies `gh api .../actions/runs/{id}/rerun` as rerun and exits 0', () => {
        const r = runHook({
          command: 'gh api -X POST /repos/groundnuty/macf/actions/runs/9876543210/rerun',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });

      it('classifies `gh api .../actions/runs/{id}/rerun-failed-jobs` as rerun and exits 0', () => {
        const r = runHook({
          command:
            'gh api -X POST /repos/groundnuty/macf/actions/runs/9876543210/rerun-failed-jobs',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });
    });

    describe('wrapper forms — sudo/env prefixes flow through classification', () => {
      // The existing wrapper-aware GH_PATTERN already tolerates `sudo gh`
      // etc. The audit branch hits classify_action with the full command
      // text and looks for `gh <verb>` substring, so wrappers don't
      // disturb detection. Verify by exercising one wrapper form per
      // action class.
      it('handles `sudo gh workflow run ...` and exits 0', () => {
        const r = runHook({
          command: 'sudo gh workflow run npm-deprecate.yml --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });

      it('handles `env CI=1 gh run cancel ...` and exits 0', () => {
        const r = runHook({
          command: 'env CI=1 gh run cancel 1234 --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
      });
    });

    describe('emit-failure is non-blocking (observational only)', () => {
      // Set the OTLP endpoint to a localhost port nothing is listening
      // on. curl will fail (connection refused); the hook must swallow
      // and exit 0. This is the key DR-019 Amendment A guarantee:
      // observability infrastructure failures do NOT propagate to the
      // gh call's success/failure.
      it('exits 0 even when OTLP endpoint is unreachable (dispatch)', () => {
        const r = runHook({
          command: 'gh workflow run npm-deprecate.yml --repo groundnuty/macf',
          env: {
            GH_TOKEN: VALID_TOKEN,
            OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP,
          },
        });
        expect(r.status).toBe(0);
      });

      it('exits 0 even when OTLP endpoint is unreachable (cancel)', () => {
        const r = runHook({
          command: 'gh run cancel 1234 --repo groundnuty/macf',
          env: {
            GH_TOKEN: VALID_TOKEN,
            OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP,
          },
        });
        expect(r.status).toBe(0);
      });

      it('exits 0 even when OTLP endpoint is unreachable (rerun)', () => {
        const r = runHook({
          command: 'gh run rerun 1234 --repo groundnuty/macf',
          env: {
            GH_TOKEN: VALID_TOKEN,
            OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP,
          },
        });
        expect(r.status).toBe(0);
      });

      it('exits 0 when OTLP endpoint is malformed (graceful curl failure)', () => {
        const r = runHook({
          command: 'gh workflow run npm-deprecate.yml --repo groundnuty/macf',
          env: {
            GH_TOKEN: VALID_TOKEN,
            OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-valid-url',
          },
        });
        expect(r.status).toBe(0);
      });
    });

    describe('OTLP-endpoint-unset → silent skip (opt-in observability)', () => {
      // Per CLAUDE.md observability section: emission is opt-in. When
      // OTEL_EXPORTER_OTLP_ENDPOINT is unset, the hook should NOT
      // invoke curl/otel-cli at all. We verify by ensuring the hook
      // exits 0 quickly even without a reachable collector.
      it('does not emit when OTEL_EXPORTER_OTLP_ENDPOINT is unset', () => {
        const r = runHook({
          command: 'gh workflow run npm-deprecate.yml --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN },
        });
        expect(r.status).toBe(0);
        // Whether curl was invoked is implementation detail; the
        // important observable is that the hook exits 0 quickly even
        // without an unreachable-collector backstop. The non-zero
        // emission timeout we set in the script (curl -m 2) bounds
        // worst-case slowness; the unset-endpoint path should not
        // even hit curl.
      });

      it('does not emit when OTEL_EXPORTER_OTLP_ENDPOINT is empty string', () => {
        const r = runHook({
          command: 'gh run cancel 1234 --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN, OTEL_EXPORTER_OTLP_ENDPOINT: '' },
        });
        expect(r.status).toBe(0);
      });
    });

    describe('allowlist semantics — dispatch-only allowlist; cancel/rerun unaffected', () => {
      // Per DR-019 Amendment A: the dispatch allowlist (currently
      // `npm-deprecate.yml`) governs `dispatch` action visibility on
      // the alerting side. The hook itself emits unconditionally (the
      // alerting "unexpected workflow" check lives on the collector /
      // dashboard, not the hook script). cancel/rerun operate on runs
      // not workflows — no allowlist applies to them. These tests
      // exercise the regex variable presence + classification, NOT
      // collector-side alerting.
      it('dispatch to allowlisted workflow (npm-deprecate.yml) emits + exits 0', () => {
        const r = runHook({
          command: 'gh workflow run npm-deprecate.yml --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN, OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP },
        });
        expect(r.status).toBe(0);
      });

      it('dispatch to NON-allowlisted workflow still emits + exits 0 (collector alerts; hook does not block)', () => {
        const r = runHook({
          command: 'gh workflow run unknown-workflow.yml --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN, OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP },
        });
        expect(r.status).toBe(0);
      });

      it('cancel is unaffected by dispatch allowlist (operates on run-id)', () => {
        const r = runHook({
          command: 'gh run cancel 1234567890 --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN, OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP },
        });
        expect(r.status).toBe(0);
      });

      it('rerun is unaffected by dispatch allowlist (operates on run-id)', () => {
        const r = runHook({
          command: 'gh run rerun 1234567890 --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN, OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP },
        });
        expect(r.status).toBe(0);
      });
    });

    describe('regression — non-actions:write gh commands skip audit branch entirely', () => {
      // The audit-log branch only fires for actions:write subcommand
      // classes. Unrelated gh commands (issue / pr / repo / api outside
      // of /actions/...) pass through without classification work.
      it('`gh issue view` (non-actions:write) exits 0 without audit', () => {
        const r = runHook({
          command: 'gh issue view 140 --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN, OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP },
        });
        expect(r.status).toBe(0);
      });

      it('`gh pr create` (non-actions:write) exits 0 without audit', () => {
        const r = runHook({
          command: 'gh pr create --repo groundnuty/macf --title test',
          env: { GH_TOKEN: VALID_TOKEN, OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP },
        });
        expect(r.status).toBe(0);
      });

      it('`gh api /repos/.../issues` (non-actions path) exits 0 without audit', () => {
        const r = runHook({
          command: 'gh api /repos/groundnuty/macf/issues',
          env: { GH_TOKEN: VALID_TOKEN, OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP },
        });
        expect(r.status).toBe(0);
      });

      it('`gh run view` (read-only run subcommand) exits 0 without audit', () => {
        // `gh run view` / `gh run list` / `gh run watch` / `gh run download`
        // are all `actions: read` operations; the audit branch must not
        // classify them as cancel/rerun.
        const r = runHook({
          command: 'gh run view 1234 --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN, OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP },
        });
        expect(r.status).toBe(0);
      });

      it('`gh workflow view` (read-only workflow subcommand) exits 0 without audit', () => {
        const r = runHook({
          command: 'gh workflow view npm-deprecate.yml --repo groundnuty/macf',
          env: { GH_TOKEN: VALID_TOKEN, OTEL_EXPORTER_OTLP_ENDPOINT: UNREACHABLE_OTLP },
        });
        expect(r.status).toBe(0);
      });
    });

    describe('bad-token cases still block; audit branch does not run', () => {
      // Defense-in-depth: token-shape check runs BEFORE audit. A bad
      // token blocks regardless of whether the command would have been
      // an actions:write call.
      it('blocks `gh workflow run` when GH_TOKEN is bad (token check fires before audit)', () => {
        const r = runHook({
          command: 'gh workflow run npm-deprecate.yml',
          env: { GH_TOKEN: 'ghp_useronly1234' },
        });
        expect(r.status).toBe(2);
      });

      it('blocks `gh run cancel` when GH_TOKEN is unset', () => {
        const r = runHook({
          command: 'gh run cancel 1234',
          env: {},
        });
        expect(r.status).toBe(2);
      });
    });

    describe('repo-allowlist regex is grep-able (canonical-rule-update affordance)', () => {
      // The dispatch allowlist regex is declared as a shell variable
      // near the top of the audit branch (MACF_ACTIONS_DISPATCH_ALLOWLIST_REGEX)
      // so future DR amendments can locate + amend it via a focused
      // grep. This test pins that affordance — if the variable ever
      // gets renamed or hidden inside a function, this fails and the
      // next amendment knows to update the spec ref.
      it('script contains the named allowlist variable', async () => {
        const fs = await import('node:fs');
        const content = fs.readFileSync(HOOK_SCRIPT, 'utf-8');
        expect(content).toContain('MACF_ACTIONS_DISPATCH_ALLOWLIST_REGEX');
        expect(content).toContain('npm-deprecate');
      });

      it('script documents the known-instrumentation-gap clause inline', async () => {
        // Per DR-019 Amendment A "Known instrumentation gaps" — surfaces
        // non-Bash subprocess paths as a forward-looking limitation.
        const fs = await import('node:fs');
        const content = fs.readFileSync(HOOK_SCRIPT, 'utf-8');
        expect(content).toMatch(/Known instrumentation gaps|non-Bash subprocess/);
      });
    });

    // macf#388 — resource-attrs population follow-up to #381.
    // Hook emits with resource.attributes populated from claude.sh's
    // OTEL_SERVICE_NAME + OTEL_RESOURCE_ATTRIBUTES env exports (canonical
    // convention per observability-wiring.md). Graceful degradation when
    // env vars are unset (hook running outside claude.sh wrapped session,
    // e.g., devops's direct-invocation smoke).
    describe('resource.attributes population (#388 — claude.sh env passthrough)', () => {
      it('exits 0 with full OTel env passthrough (claude.sh-wrapped session shape)', () => {
        // Real-shape env: OTEL_SERVICE_NAME + OTEL_RESOURCE_ATTRIBUTES per
        // claude.sh export. Endpoint is set so the audit branch hits emit
        // paths; non-listening port → curl silently fails → hook still
        // exits 0 (graceful, observational-only contract).
        const r = runHook({
          command: 'gh workflow run npm-deprecate.yml --repo groundnuty/macf',
          env: {
            GH_TOKEN: VALID_TOKEN,
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/v1',
            OTEL_SERVICE_NAME: 'macf-agent-code-agent',
            OTEL_RESOURCE_ATTRIBUTES:
              'gen_ai.agent.name=code-agent,gen_ai.agent.role=code-agent,service.namespace=macf',
          },
        });
        expect(r.status).toBe(0);
      });

      it('exits 0 when OTel env unset (graceful degradation outside claude.sh)', () => {
        // devops's direct-invocation smoke shape: endpoint set but no
        // OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES. The helper
        // returns the empty resource-attrs array; emission JSON is
        // structurally valid (resource.attributes: []) — same shape as
        // pre-#388. Hook does not error on the missing env.
        const r = runHook({
          command: 'gh run cancel 1234 --repo groundnuty/macf',
          env: {
            GH_TOKEN: VALID_TOKEN,
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/v1',
          },
        });
        expect(r.status).toBe(0);
      });

      it('exits 0 with OTEL_SERVICE_NAME only (partial env shape)', () => {
        // Edge: claude.sh always exports both together, but some
        // partial-bootstrap workspaces could in theory have only
        // OTEL_SERVICE_NAME (e.g., legacy claude.sh shapes pre-#357).
        // Helper handles the partial case — service.name attr present,
        // gen_ai.* absent. Hook still exits 0.
        const r = runHook({
          command: 'gh workflow run npm-deprecate.yml --repo groundnuty/macf',
          env: {
            GH_TOKEN: VALID_TOKEN,
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/v1',
            OTEL_SERVICE_NAME: 'macf-agent-code-agent',
          },
        });
        expect(r.status).toBe(0);
      });

      it('exits 0 with OTEL_RESOURCE_ATTRIBUTES containing malformed pairs', () => {
        // Defensive: OTEL_RESOURCE_ATTRIBUTES that includes empty entries
        // or non-key=value tokens (e.g., trailing comma) must not break
        // emission. Helper filters out empty + key-less entries.
        const r = runHook({
          command: 'gh run rerun 5678 --repo groundnuty/macf --failed',
          env: {
            GH_TOKEN: VALID_TOKEN,
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1/v1',
            OTEL_RESOURCE_ATTRIBUTES: ',gen_ai.agent.name=code-agent,,bad-no-eq,service.namespace=macf,',
          },
        });
        expect(r.status).toBe(0);
      });

      it('script contains the resource-attrs helper + claude.sh env references', async () => {
        // Source-shape regression: pin the helper presence + the two
        // env-var sources it reads from. Catches accidental rename /
        // removal in future refactors.
        const fs = await import('node:fs');
        const content = fs.readFileSync(HOOK_SCRIPT, 'utf-8');
        expect(content).toContain('_macf_audit_build_resource_attrs_json');
        expect(content).toContain('OTEL_SERVICE_NAME');
        expect(content).toContain('OTEL_RESOURCE_ATTRIBUTES');
        // Both curl emit paths (span + metric) wire the helper in.
        expect(content).toMatch(/resource:\s*\{\s*attributes:\s*\$resource_attrs\s*\}/);
      });
    });
  });

  describe('error message quality', () => {
    it('block message points at macf-gh-token.sh helper', () => {
      const r = runHook({
        command: 'gh issue view 1',
        env: {},
      });
      expect(r.stderr).toMatch(/macf-gh-token\.sh/);
    });

    it('block message mentions MACF_SKIP_TOKEN_CHECK override', () => {
      const r = runHook({
        command: 'gh issue view 1',
        env: {},
      });
      expect(r.stderr).toMatch(/MACF_SKIP_TOKEN_CHECK/);
    });

    it('block message surfaces the offending command', () => {
      const r = runHook({
        command: 'gh issue close 42',
        env: {},
      });
      expect(r.stderr).toContain('gh issue close 42');
    });
  });
});
