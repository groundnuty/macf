/**
 * Differentiated consent-gate-2 diagnosis (DR-043 §D2, groundnuty/macf#1179
 * Step 6 — "most of the value in this issue"). Two detectors already exist
 * and, before this module, both terminated in the same generic refusal
 * shape: `install-scope.ts::validateInstallRepositoryScope` catches
 * `repository_selection: "all"` (groundnuty/macf#1136/#1128) and
 * `registry-repo-coverage.ts::buildRegistryRepoValidateInstall` catches a
 * confirmed-but-uncovered registry repo (groundnuty/macf#1012, with the
 * SPECIFIC missing repo already computed by #1164/#1176's `missingRepos`).
 * Both hooks already produce DIFFERENT text — what was missing was a
 * CLASSIFICATION a caller (the "check again" retry page, a future dashboard)
 * can act on without re-deriving it from prose.
 *
 * **Classification is structural, never text-matching.** `#1173`/`#1174`'s
 * whole discipline is "one message source, never re-authored" — parsing an
 * already-authored sentence back apart with a regex would be the same class
 * of drift-risk in the other direction. The two signals this module reads
 * are both ALREADY first-class, typed facts by the time a rejection reaches
 * here: `ConfirmedInstall.repositorySelection` (the live-observed value
 * `install-scope.ts` itself checks) and `InstallRejection.missingRepos` (the
 * exact delta `registry-repo-coverage.ts` already computed — this module
 * does NOT recompute it, per the issue's own instruction).
 *
 * **The honest-unknown floor (Amendment A's "unknown, never a false
 * `present`" applied to diagnosis).** `composeValidateInstall`
 * (`apply-fleet.ts`) chains the scope check before the coverage check and
 * returns the FIRST rejection — so in practice a coverage-short diagnosis
 * only arrives here once scope is already known-good. This module doesn't
 * assume that ordering, though: it reads `repositorySelection` directly off
 * the live `ConfirmedInstall`, independent of which hook actually rejected.
 * The THIRD case — scope already selected, no missingRepos on the rejection
 * — is real and reachable (any bare-string rejection from a hook that isn't
 * either of the two known checks) and MUST NOT be silently folded into
 * either specific case: a confident wrong diagnosis sends the operator to
 * fix the wrong thing, which is worse than an honest "I can't tell."
 */
import type { ConfirmedInstall } from './identity-confirm.js';
import { rejectionParts, type InstallRejection } from './apply-agent.js';
import { validateInstallRepositoryScope } from './install-scope.js';

export type Gate2Diagnosis =
  | { readonly kind: 'scope-wrong'; readonly message: string }
  | { readonly kind: 'coverage-short'; readonly message: string; readonly missingRepos: readonly string[] }
  | { readonly kind: 'unknown'; readonly message: string };

/**
 * Classifies ONE gate-2 rejection against the live install's own observed
 * shape. `install` only needs `repositorySelection` — narrowed via `Pick` so
 * a caller with just that field (no full `ConfirmedInstall` in hand) doesn't
 * need to fabricate one, same reasoning `install-scope.ts::
 * validateInstallRepositoryScope`'s own signature already applies.
 *
 * **groundnuty/macf#1128's structural guard applies here too.** The
 * "is scope wrong" decision below goes through `install-scope.ts::
 * validateInstallRepositoryScope` itself — never a re-derived
 * `repositorySelection === 'selected'` comparison — because
 * `install-scope-source-shape.test.ts` statically scans this package for
 * exactly that duplication and fails the build if it reappears anywhere
 * outside `install-scope.ts`. The `appHandle` argument only shapes that
 * function's OWN message text (discarded here — this module has its own
 * message, `shown`, from the rejection that already fired); the DECISION
 * (`=== undefined` vs not) is what this module actually reads.
 */
export function diagnoseGate2Rejection(
  install: Pick<ConfirmedInstall, 'repositorySelection'>,
  rejection: InstallRejection,
): Gate2Diagnosis {
  const { message, retryInstruction, missingRepos } = rejectionParts(rejection);
  // groundnuty/macf#1174 — never a NEW sentence for the two known cases:
  // `retryInstruction` (when the rejecting hook supplied one) or `message`
  // is EXACTLY what the terminal already logs and the page already renders.
  // This module classifies; it does not re-author.
  const shown = retryInstruction ?? message;

  if (validateInstallRepositoryScope(install.repositorySelection, '(diagnosis)') !== undefined) {
    return { kind: 'scope-wrong', message: shown };
  }
  if (missingRepos !== undefined && missingRepos.length > 0) {
    return { kind: 'coverage-short', message: shown, missingRepos };
  }
  return {
    kind: 'unknown',
    message:
      "apply can't tell specifically what's still wrong with this install (the check that rejected it reported: " +
      `"${shown}") — neither a repository-scope signal nor a specific missing-repository signal was available to ` +
      'classify it further. Re-open the install and re-check that every repository this App needs is selected ' +
      'under "Only select repositories," then try again.',
  };
}

/**
 * The message-line array a {@link Gate2Diagnosis} produces for BOTH the
 * terminal log and the served page (the SAME #1173/#1174 "one message
 * source" discipline `gate2-diagnosis.ts` callers must keep). A one-word
 * kind-prefix so the three cases are visually distinguishable even before
 * reading the sentence itself — never used as the SOLE differentiator (the
 * `kind` field is; see {@link diagnoseGate2Rejection}'s own tests).
 */
export function gate2DiagnosisMessageLines(diagnosis: Gate2Diagnosis): readonly string[] {
  const prefix =
    diagnosis.kind === 'scope-wrong'
      ? 'still wrong (repository scope):'
      : diagnosis.kind === 'coverage-short'
        ? 'still missing repository access:'
        : "apply can't classify this rejection:";
  return [`${prefix} ${diagnosis.message}`];
}

/** The copyable-block repo names for a {@link Gate2Diagnosis} — only `coverage-short` names any (the specific delta); every other kind has nothing narrower to offer than the identity's own full required set, so the caller's existing fallback applies. */
export function gate2DiagnosisRepoNames(diagnosis: Gate2Diagnosis): readonly string[] {
  return diagnosis.kind === 'coverage-short' ? diagnosis.missingRepos : [];
}
