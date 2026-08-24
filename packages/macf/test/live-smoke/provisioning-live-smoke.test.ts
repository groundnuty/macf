/**
 * DR-043 provisioning live-smoke (groundnuty/macf#869) — the opt-in,
 * credentialed suite that exercises the REAL GitHub API for the
 * contract-bearing calls the bootstrap tool depends on. Excluded from the
 * default `vitest run` (see `vitest.config.ts`'s `exclude`); run via
 * `npm run test:live-smoke` / `make -f dev.mk test-live-smoke`.
 *
 * **What this answers that `test/cli/bootstrap/live-smoke.test.ts` cannot**:
 * that file proves the ASSERTION logic correctly rejects a malformed
 * response, using fakes — it can never tell you whether GitHub's response
 * still matches the shape those fakes assume. This file asks GitHub
 * directly. Keep both: the fake-driven suite is fast and pins intent; this
 * suite is slow, needs credentials, and answers "does the external system
 * still accept what we send / return what we expect" — see
 * `silent-fallback-hazards.md` for the general shape of the gap between
 * them.
 *
 * **What is and is not covered here** (see `live-smoke.ts`'s module doc for
 * the full reasoning): App-JWT -> `GET /app/installations` (read-only) and
 * Actions-variable create+delete at repo AND org scope (a real write,
 * immediately reversed) are covered. Repo-creation-from-template is
 * covered ONLY as a read-only is_template preflight — NOT an actual
 * generate call, deliberately, per the operator's standing rule against
 * building anything that makes repository removal routine. App-manifest
 * conversion is NOT covered at all — it needs a one-shot code obtainable
 * only by a human clicking through the manifest form; there is no
 * unattended path to it.
 *
 * **Configuration** — every check is independently gated by its own env
 * var(s); an unset check SKIPS (not fails) and a one-time stderr banner
 * (`live-smoke-gate.ts`) names exactly what was skipped and why:
 *
 *   - `MACF_LIVE_SMOKE_APP_ID` + `MACF_LIVE_SMOKE_APP_KEY` — an EXISTING,
 *     already-installed GitHub App's numeric id + private-key PEM path.
 *     This suite never creates an App or drives an install click.
 *   - `MACF_LIVE_SMOKE_VARIABLE_REPO` — `owner/repo` of an EXISTING repo
 *     the ambient `gh` auth (whatever `GH_TOKEN`/`gh auth login` is
 *     already configured as — same assumption every other `gh api`
 *     shell-out in this package makes) can write Actions variables to.
 *   - `MACF_LIVE_SMOKE_VARIABLE_ORG` — an EXISTING org login, same
 *     ambient-auth assumption, for the org-scope round trip.
 *   - `MACF_LIVE_SMOKE_TEMPLATE_REPO` — `owner/repo` of an EXISTING
 *     template repo, for the read-only preflight.
 *
 * With zero env vars set (the default — including in ordinary CI), every
 * test in this file SKIPS and the suite reports green with a loud stderr
 * explanation, never a silent pass and never a failure of the normal
 * `make check` path.
 */
import { describe, it } from 'vitest';
import {
  checkInstallationsContract,
  checkTemplateRepoContract,
  runVariableRoundTrip,
} from '../../src/cli/bootstrap/live-smoke.js';
import { realCreateVariable, realDeleteVariable } from '../../src/cli/bootstrap/variable-write.js';
import { resolveLiveSmokeConfig, warnOnceIfUnconfigured } from './live-smoke-gate.js';

const config = resolveLiveSmokeConfig();
const LIVE_SMOKE_TIMEOUT_MS = 20_000;

// Module-scope, NOT `beforeAll`: when every check is skipIf'd off (the
// zero-credentials default), Vitest never runs `beforeAll` for a describe
// block whose only test is skipped — verified empirically (a `beforeAll`
// banner here silently never fired). Module-scope code, by contrast, always
// executes once at collection time regardless of how many tests end up
// skipped, which is the ONE place in this file guaranteed to run either way.
warnOnceIfUnconfigured(config);

/** Throw the result's own detail on failure — that IS the "fails loudly and specifically" contract the issue asks for; nothing about the GitHub-side reason gets swallowed on the way into the test failure. */
async function expectContractOk(result: { readonly ok: boolean; readonly detail: string }): Promise<void> {
  if (!result.ok) throw new Error(result.detail);
}

describe('installations contract — App-JWT -> GET /app/installations', () => {
  it.skipIf(!config.appId || !config.appKey)(
    'the configured App still reports repository_selection on its confirmed install',
    async () => {
      const result = await checkInstallationsContract(config.appId ?? '', config.appKey ?? '');
      await expectContractOk(result);
    },
    LIVE_SMOKE_TIMEOUT_MS,
  );
});

describe('Actions-variable round trip — repo scope', () => {
  it.skipIf(!config.variableRepo)(
    'creates and deletes a freshly-named repo-scope variable',
    async () => {
      const result = await runVariableRoundTrip(`repos/${config.variableRepo ?? ''}`, realCreateVariable, realDeleteVariable);
      await expectContractOk(result);
    },
    LIVE_SMOKE_TIMEOUT_MS,
  );
});

describe('Actions-variable round trip — org scope (the macf#866 visibility shape)', () => {
  it.skipIf(!config.variableOrg)(
    'creates and deletes a freshly-named org-scope variable, including the required visibility field',
    async () => {
      const result = await runVariableRoundTrip(`orgs/${config.variableOrg ?? ''}`, realCreateVariable, realDeleteVariable);
      await expectContractOk(result);
    },
    LIVE_SMOKE_TIMEOUT_MS,
  );
});

describe('repo-creation-from-template preflight (read-only — creates nothing)', () => {
  it.skipIf(!config.templateRepo)(
    'the configured template repo is reachable and is_template=true',
    async () => {
      const result = await checkTemplateRepoContract(config.templateRepo ?? '');
      await expectContractOk(result);
    },
    LIVE_SMOKE_TIMEOUT_MS,
  );
});
