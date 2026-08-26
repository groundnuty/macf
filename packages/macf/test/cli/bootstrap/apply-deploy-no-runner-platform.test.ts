/**
 * `deploy` keeps NOTHING of the runner-provisioning contract (groundnuty/
 * macf#943, DR-043 Amendment I2 — "`deploy` keeps nothing of the runner
 * half"). A NEW, dedicated file (not an addition to an existing deploy test)
 * per this repo's own "avoid touching a file another agent may be editing
 * concurrently" convention (see `apply-deploy-seam-identity.test.ts`'s doc)
 * — this file only ever reads source text + imports, so it cannot collide
 * with concurrent behavioral edits to the deploy path.
 *
 * **Why a source-scan, not a full behavioral harness.** `apply` (`apply-fleet.ts`)
 * calls `runner-platform.ts::provisionRunner` directly, in-process — there is
 * no shared "maybe call the runner platform" seam threaded through both
 * `apply` and `deploy` that a behavioral fixture would need to prove
 * unreachable from the deploy side. The actual invariant this issue's AC
 * asks for is narrower and fully static: `runner-platform.ts` (or its
 * exports `provisionRunner`/`deprovisionRunner`) is never IMPORTED by any
 * deploy-path module. That is exactly what a source-scan proves, precisely
 * and without inventing a deploy fixture (`apply-deploy.ts`'s own deps
 * surface, `AgentDeployDeps`, has no field this test could even inject a
 * `fetchImpl` seam through) — same "assert the fact directly, don't invent
 * a heavier proxy for it" discipline `check-before-propose.md` argues for.
 * Same technique this package already uses for a comparable static
 * invariant — see `no-internal-citations-in-user-facing-output.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// This file lives at packages/macf/test/cli/bootstrap/ — three levels up is
// packages/macf/, the package root both src dirs below hang off.
const BOOTSTRAP_DIR = join(import.meta.dirname, '../../../src/cli/bootstrap');
const COMMANDS_DIR = join(import.meta.dirname, '../../../src/cli/commands');

const DEPLOY_PATH_FILES = [
  join(BOOTSTRAP_DIR, 'apply-deploy.ts'),
  join(BOOTSTRAP_DIR, 'fleet-deploy.ts'),
  join(BOOTSTRAP_DIR, 'remaining-deploy.ts'),
  join(COMMANDS_DIR, 'fleet-deploy.ts'),
];

describe('deploy keeps nothing of the runner half (groundnuty/macf#943, DR-043 Amendment I2)', () => {
  it.each(DEPLOY_PATH_FILES)('%s never imports or references runner-platform.ts', (filePath) => {
    const source = readFileSync(filePath, 'utf-8');
    expect(source).not.toMatch(/runner-platform/);
    expect(source).not.toMatch(/\bprovisionRunner\b/);
    expect(source).not.toMatch(/\bdeprovisionRunner\b/);
  });

  it('DECISIVE: the runner-provisioning contract client is imported ONLY by provisioning-phase files — never by any deploy-path file', () => {
    // Grep every .ts source file under bootstrap/ + commands/ (excluding
    // runner-platform.ts itself and its own test file) for an import of it.
    // A future deploy-path file added without reading this test would still
    // be caught, unlike the file-by-file list above (which only covers
    // TODAY's deploy files by name).
    //
    // groundnuty/macf#1212 — `apply-routing.ts::publishTrustedActorsForProvisioned`
    // consults the runner-platform's OWN `GET /runners/{owner}/{repo}` status
    // as an OPTIONAL, advisory-only read (progress narration + a narrow
    // terminal fast-exit — see that function's module doc) alongside the
    // GitHub-side `checkRunnerUsableByRepo` readiness gate this module
    // already used. This is `import type { RunnerPlatformStatusResult }`
    // ONLY — no runtime dependency, no `provisionRunner`/`deprovisionRunner`
    // call.
    //
    // groundnuty/macf#1211 widened the legitimate importer set further:
    // `plan.ts`/`observer.ts` now import
    // `describeRunnerPlatformEndpointResolution`/
    // `resolveRunnerPlatformEndpointWithProvenance`/
    // `RUNNER_PLATFORM_ENDPOINT_ENV_VAR` to surface the endpoint resolution
    // at PLAN time, BEFORE apply ever runs — this is the provisioning
    // phase's OWN read-only reporting surface, not the deploy phase.
    //
    // The invariant this test actually defends (per its own title: "never
    // from any deploy-path file") is a SET EXCLUSION, not a fixed importer
    // count — asserting an exact prior count would have made this test
    // itself the "wrong-path" assertion `assert-the-wrong-path.md` warns
    // against: a literal count pin breaks on any legitimate NEW
    // provisioning-phase importer (#1211 and #1212 landing concurrently and
    // EACH adding one is exactly that scenario), for a reason that has
    // nothing to do with the deploy-path leak this test exists to catch.
    const grepOutput = execFileSync(
      'grep',
      ['-rl', '--include=*.ts', "from './runner-platform.js'", BOOTSTRAP_DIR, COMMANDS_DIR],
      { encoding: 'utf-8' },
    ).trim();
    const importers = grepOutput.length > 0 ? grepOutput.split('\n').map((p) => p.trim()) : [];
    // The real invariant: NONE of the importers is a deploy-path file.
    for (const deployFile of DEPLOY_PATH_FILES) {
      expect(importers).not.toContain(deployFile);
    }
    // The known-good provisioning-phase importers, named explicitly so a
    // genuinely NEW (and possibly wrong) importer is still caught — this
    // list grows only when a provisioning-phase file gains a real reason to
    // read the runner-provisioning contract's shape, same discipline as the
    // deploy-path list above. `apply-routing.ts` (type-only, #1212) and
    // `plan.ts`/`observer.ts` (value imports, #1211) landed in the same
    // cycle, independently of each other.
    const knownProvisioningPhaseImporters = [
      join(BOOTSTRAP_DIR, 'apply-fleet.ts'),
      join(BOOTSTRAP_DIR, 'apply-routing.ts'),
      join(BOOTSTRAP_DIR, 'plan.ts'),
      join(BOOTSTRAP_DIR, 'observer.ts'),
    ];
    expect([...importers].sort()).toEqual([...knownProvisioningPhaseImporters].sort());
  });
});
