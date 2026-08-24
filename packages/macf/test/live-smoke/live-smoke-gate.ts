/**
 * Credential-presence gating for the DR-043 provisioning live-smoke
 * (groundnuty/macf#869) — same "loud skip, never a silent green" shape as
 * `test/cli/bootstrap/age-binary-gate.ts`, but WITHOUT that module's
 * CI-throws-on-absence half.
 *
 * `age` ships via `devbox.json` and is expected to ALWAYS be present in
 * CI, so its absence there is a build defect worth failing loud on. Live
 * credentials for THIS suite are the opposite: the issue's explicit
 * constraint is "opt-in... never on the default `make check` path" — an
 * ordinary CI run (and an ordinary developer's shell) is EXPECTED to have
 * none of these set. So this gate never throws, in any environment,
 * including CI — it only ever resolves a boolean per check and, at most
 * once per process, writes a loud (but non-failing) explanation of what
 * got skipped and why, via `process.stderr.write` for the same reason
 * `age-binary-gate.ts` uses it: Vitest's default reporter swallows
 * `console.*` output for a file whose tests all pass (a skip counts as
 * non-failure), which would make the warning as invisible as the
 * unconfigured-credentials state it exists to surface.
 *
 * Each of the four live checks has its OWN required env vars, gated
 * independently — an operator pointing this at just one existing App (to
 * check the installations contract) shouldn't need a target repo/org too.
 */

/** Resolved live-smoke configuration — any field may be absent (that check is skipped). */
export interface LiveSmokeConfig {
  /** Numeric App id for the installations-contract check. Must belong to an App the operator has ALREADY installed — this suite creates no App. */
  readonly appId?: string;
  /** Path to that App's private-key PEM. */
  readonly appKey?: string;
  /** `owner/repo` of an EXISTING repo the ambient `gh` auth can write Actions variables to, for the repo-scope round trip. */
  readonly variableRepo?: string;
  /** An EXISTING org login the ambient `gh` auth can write org-scope Actions variables to, for the org-scope round trip (the macf#866 shape). */
  readonly variableOrg?: string;
  /** `owner/repo` of an EXISTING template repo, for the read-only is_template preflight. */
  readonly templateRepo?: string;
}

const ENV_KEYS = {
  appId: 'MACF_LIVE_SMOKE_APP_ID',
  appKey: 'MACF_LIVE_SMOKE_APP_KEY',
  variableRepo: 'MACF_LIVE_SMOKE_VARIABLE_REPO',
  variableOrg: 'MACF_LIVE_SMOKE_VARIABLE_ORG',
  templateRepo: 'MACF_LIVE_SMOKE_TEMPLATE_REPO',
} as const;

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v !== undefined && v.length > 0 ? v : undefined;
}

/** Pure w.r.t. the env object passed in — defaults to `process.env` for production callers, injectable for tests. */
export function resolveLiveSmokeConfig(env: NodeJS.ProcessEnv = process.env): LiveSmokeConfig {
  return {
    appId: readEnv(env, ENV_KEYS.appId),
    appKey: readEnv(env, ENV_KEYS.appKey),
    variableRepo: readEnv(env, ENV_KEYS.variableRepo),
    variableOrg: readEnv(env, ENV_KEYS.variableOrg),
    templateRepo: readEnv(env, ENV_KEYS.templateRepo),
  };
}

/**
 * One entry per live check — a single source of truth for both "is this
 * check configured" and "how many checks exist total", so the summary
 * banner's count can never drift out of sync with the branches below the
 * way a hand-maintained `${missing.length} of 4` literal could the moment a
 * 5th check is added and this constant isn't updated alongside it.
 */
const CHECKS: readonly {
  readonly configured: (config: LiveSmokeConfig) => boolean;
  readonly describe: () => string;
}[] = [
  {
    configured: (c) => Boolean(c.appId) && Boolean(c.appKey),
    describe: () => `${ENV_KEYS.appId} + ${ENV_KEYS.appKey} (App-JWT -> GET /app/installations contract check)`,
  },
  {
    configured: (c) => Boolean(c.variableRepo),
    describe: () => `${ENV_KEYS.variableRepo} (repo-scope Actions-variable create+delete round trip)`,
  },
  {
    configured: (c) => Boolean(c.variableOrg),
    describe: () => `${ENV_KEYS.variableOrg} (org-scope Actions-variable create+delete round trip)`,
  },
  {
    configured: (c) => Boolean(c.templateRepo),
    describe: () => `${ENV_KEYS.templateRepo} (repo-creation-from-template read-only preflight)`,
  },
];

/** One line per unconfigured check, naming the env var(s) it needs — pure, exported for testing. */
export function describeMissingChecks(config: LiveSmokeConfig): readonly string[] {
  return CHECKS.filter((c) => !c.configured(config)).map((c) => c.describe());
}

/** Total number of independently-gated live checks — exported so the banner (and tests) never hardcode it separately from {@link CHECKS}. */
export function totalLiveSmokeChecks(): number {
  return CHECKS.length;
}

let warnedThisProcess = false;

/**
 * Write the loud (never-failing) skip banner once per process. Safe to call
 * from every describe block in the live-smoke file — only the FIRST call
 * actually writes.
 */
export function warnOnceIfUnconfigured(config: LiveSmokeConfig): void {
  if (warnedThisProcess) return;
  const missing = describeMissingChecks(config);
  if (missing.length === 0) return;
  warnedThisProcess = true;
  const lines = [
    `[live-smoke-gate] provisioning live-smoke: ${String(missing.length)} of ${String(totalLiveSmokeChecks())} check(s) SKIPPED — no live credentials configured.`,
    ...missing.map((m) => `  - ${m}`),
    '  These checks exercise the real GitHub API and cannot be faked; set the env vars above (see the ' +
      'module doc in test/live-smoke/provisioning-live-smoke.test.ts) to run them.',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}

/** Test-only escape hatch so a unit test can reset the once-per-process warn latch between cases. */
export function resetWarnLatchForTests(): void {
  warnedThisProcess = false;
}
