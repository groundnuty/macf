/**
 * Pin CORRECTNESS vs the fleet manifest — macf#872 — a sibling axis to check 1's
 * pre-existing pin CONSISTENCY (`routing-doctor.ts::resolveRepoPins`/`computeExpectedPin`).
 *
 * **The gap this closes.** Consistency measures modal AGREEMENT across the fleet's
 * routing repos — it answers "do these repos agree with EACH OTHER," never "do they
 * agree with what's actually DESIRED." A fleet where every repo drifted to the SAME
 * stale `macf-actions` pin is `consistent: true` for every repo (they all match the
 * modal, because the modal IS the stale value) — the check is at its most confident
 * exactly when the problem is worst. This module adds the missing axis: compare each
 * repo's pin against an AUTHORITATIVE desired value — the fleet manifest's declared
 * `versions.actions` (DR-043 §D6 GitOps steering input, the SAME field `macf bootstrap
 * plan`'s `actionsVersionItem` already reconciles per-repo) — independent of whether
 * the fleet agrees with itself.
 *
 * **Two independent axes, composed into one fleet-level read.** `consistent` (does
 * this repo match the other repos?) and `correctness` (does this repo match the
 * manifest?) are orthogonal per-repo booleans/tri-states; `classifyPinState` crosses
 * them into the three-plus-one states an operator actually needs to distinguish:
 * `inconsistent` (repos disagree — a mixed rollout or a real misconfiguration),
 * `consistent-and-correct` (repos agree AND match the manifest — genuinely healthy),
 * `consistent-but-wrong` (repos agree but do NOT match the manifest — the uniformly-
 * stale bug this issue exists to catch), and `unknown` (no authoritative desired pin
 * was reachable this run — honest-not-asserted, NEVER collapsed into a pass).
 *
 * **Warn, never fail (design constraint carried from the original issue).** A
 * deliberate older pin is legitimate operator choice; the harm this check exists to
 * surface is SILENT staleness, not staleness itself. `consistent-but-wrong` and
 * `unknown` do NOT flip `routingVerdict`'s HEALTHY/DEGRADED (that stays governed by
 * the pre-existing `consistent` axis, unchanged) — but they DO replace the "pins
 * consistent" text in the SAME clause `summaryLine` already renders, rather than
 * being appended as a separate footnote. A composite line that still reads "pins
 * consistent" while correctness is unknown or wrong is exactly the overstatement
 * macf#872 + the sibling #1111 incident (a HEALTHY verdict over a fleet that could
 * not route at all) both name: each individual check can be honest while the summary
 * a human actually reads still overclaims.
 *
 * **Source resolution — `--manifest` override, else control-repo auto-discovery,
 * else honest `unknown`.** An operator-supplied `--manifest <path>` (local `fleet.yaml`
 * checkout, e.g. run from inside the control repo) wins outright — and a BROKEN
 * explicit override reports `unknown` rather than silently falling back to discovery
 * (an explicit-but-wrong pointer disagreeing with a silently-substituted source is
 * its own silent-fallback hazard). Absent the flag, this module derives the fleet's
 * control-repo name (`<project>-control`, DR-043 Amendment F's `deriveControlRepoName`)
 * and looks for it in the SAME install-set `routing-doctor.ts` already fetched for
 * check 1 (no extra `gh api` round-trip) — if found, its committed `fleet.yaml` is the
 * authoritative source. Neither present → `null`, and `evaluatePinCorrectness` treats
 * `null` as `unknown`, never as a pass. This mirrors DR-043 Amendment A4's "confirm
 * present, never prove absent" applied to a local/GitHub-content read instead of a
 * network probe: most of today's substrate fleets predate `macf bootstrap apply` and
 * have no control repo at all — `unknown` is the CORRECT, honest read for them, not a
 * gap in this check.
 */
import { readFileSync } from 'node:fs';
import { deriveControlRepoName, parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import type { RepoPinRow, RoutingDoctorReport } from './routing-doctor.js';

/**
 * Per-repo pin correctness against the manifest's declared `versions.actions`.
 * `unknown` — no authoritative desired pin was reachable this run (no `--manifest`,
 * no discoverable control repo, or its `fleet.yaml` was unreadable/unparseable/didn't
 * declare `versions.actions`) — honest-not-asserted, NEVER a pass. Comparison is
 * EXACT string equality, mirroring `bootstrap/plan.ts::actionsVersionItem`'s
 * `observed === desired` (the same GitOps-reconcile contract `macf bootstrap plan`
 * already applies per-repo) — so `routing doctor` and `bootstrap plan` agree on the
 * same fleet in the same state, which is exactly the property the operator's live
 * drift test (downgrading one repo's pin and comparing both tools' readings) checks.
 */
export type PinCorrectnessState = 'correct' | 'incorrect' | 'unknown';

export function evaluatePinCorrectness(pin: string | null, desiredPin: string | null): PinCorrectnessState {
  if (desiredPin === null) return 'unknown';
  return pin !== null && pin === desiredPin ? 'correct' : 'incorrect';
}

/**
 * The fleet-level composite crossing CONSISTENCY (agreement) with CORRECTNESS
 * (matches the manifest) — the "three states, not two" macf#872 asks for, plus the
 * honest `unknown` floor and the degenerate `no-callers` case (mirrors `routingVerdict`'s
 * `EMPTY`, but scoped to this one axis so a caller can render/warn on it independently
 * of the overall verdict).
 *
 *  - `no-callers`             — no fleet-member routing-caller repos at all (nothing
 *                               to classify; distinct from `unknown`, which means
 *                               "repos exist but correctness couldn't be checked").
 *  - `inconsistent`           — participating repos do NOT all match each other.
 *                               Unchanged pre-existing verdict-failing state; this
 *                               classification doesn't touch it, only names it.
 *  - `unknown`                — repos agree with each other, but no authoritative
 *                               desired pin was reachable this run.
 *  - `consistent-and-correct` — repos agree with each other AND with the manifest.
 *  - `consistent-but-wrong`   — repos agree with each other but NOT with the
 *                               manifest — the uniformly-stale bug macf#872 exists
 *                               to catch; a consistency-only check reports this
 *                               state identically to `consistent-and-correct`.
 */
export type PinFleetState =
  | 'no-callers'
  | 'inconsistent'
  | 'unknown'
  | 'consistent-and-correct'
  | 'consistent-but-wrong';

/**
 * The pin value shared by every PARTICIPATING repo, independent of whether it
 * matches `expectedPin`/`desiredActionsPin` — `null` when there are no
 * participants, or they don't literally agree with EACH OTHER.
 *
 * Deliberately recomputed from the raw `pin` values rather than trusted from
 * `consistent`: `consistent` is `r.pin === expectedPin`, and `expectedPin` can be
 * an OPERATOR `--expected-pin` override rather than the modal (a separate,
 * pre-existing escape hatch — see `RoutingDoctorReport.desiredActionsPin`'s doc).
 * Under an override that doesn't match reality, every repo reads
 * `consistent:false` even while they all agree with EACH OTHER on a value that
 * simply isn't the asserted target — that fleet is self-agreeing, not
 * "inconsistent" in the sense this module names (repos disagreeing with each
 * other). Recomputing from raw pins keeps `classifyPinState` correct regardless
 * of where `expectedPin` came from, without needing to track that provenance.
 */
function observedUniformPin(repoPins: readonly Pick<RepoPinRow, 'pin' | 'consistent'>[]): string | null {
  const participating = repoPins.filter((r) => r.consistent !== null);
  if (participating.length === 0) return null;
  const first = participating[0]?.pin ?? null;
  return participating.every((r) => r.pin === first) ? first : null;
}

export function classifyPinState(
  report: Pick<RoutingDoctorReport, 'repoPins' | 'desiredActionsPin'>,
): PinFleetState {
  const participating = report.repoPins.filter((r) => r.consistent !== null);
  if (participating.length === 0) return 'no-callers';
  if (observedUniformPin(report.repoPins) === null) return 'inconsistent';
  if (report.desiredActionsPin === null) return 'unknown';
  return participating.every((r) => r.correctness === 'correct') ? 'consistent-and-correct' : 'consistent-but-wrong';
}

/**
 * The pin clause `summaryLine` renders — replacing "pins consistent" in place
 * (never appending a separate footnote) so the top-line an operator actually reads
 * can't claim consistency-as-health while correctness is wrong or unknown. See this
 * module's doc header, "warn, never fail," for why the verdict itself stays untouched.
 */
export function pinClauseText(state: PinFleetState, desiredPin: string | null): string {
  switch (state) {
    case 'inconsistent':
      return 'PIN DIVERGENCE';
    case 'unknown':
      return 'pins consistent — correctness vs manifest UNKNOWN (no fleet.yaml reachable)';
    case 'consistent-but-wrong':
      return `pins consistent but STALE — manifest declares "${desiredPin}"`;
    case 'consistent-and-correct':
      return `pins consistent + current ("${desiredPin}")`;
    case 'no-callers':
      return 'pins consistent'; // unreachable in practice — callers guard on participating.length first
  }
}

/**
 * The dedicated "PIN CORRECTNESS" text-render line — same shape family as
 * `routing-doctor.ts`'s `caCertLine` / ROUTING-CLIENT-CERT-ISSUER line: a
 * standalone, explicitly-labeled statement of what THIS run knows (or does
 * not) about pin correctness, never folded silently into the repo table.
 *
 * The `inconsistent` branch does NOT throw away the per-repo `correctness`
 * this module already computed (it's populated independent of `consistent` —
 * see `resolveRepoPins`): when a desired pin IS known, it reports HOW MANY of
 * the disagreeing repos already match the manifest, which is exactly the
 * useful signal for a fleet mid-rollout (some repos updated, some not) rather
 * than a bare "not evaluated."
 */
export function pinCorrectnessLine(
  report: Pick<RoutingDoctorReport, 'repoPins' | 'desiredActionsPin'>,
): string {
  const state = classifyPinState(report);
  switch (state) {
    case 'no-callers':
      return 'PIN CORRECTNESS (vs fleet manifest): — n/a (no routing-caller repos)';
    case 'unknown':
      return (
        'PIN CORRECTNESS (vs fleet manifest): ? unknown — no fleet.yaml reachable this run ' +
        '(no --manifest override, no discoverable control repo)'
      );
    case 'inconsistent':
      return inconsistentPinCorrectnessLine(report);
    case 'consistent-but-wrong':
      return (
        `PIN CORRECTNESS (vs fleet manifest): ✗ STALE — every repo reads ` +
        `"${observedUniformPin(report.repoPins)}", manifest declares "${report.desiredActionsPin}"`
      );
    case 'consistent-and-correct':
      return `PIN CORRECTNESS (vs fleet manifest): ✓ current ("${report.desiredActionsPin}")`;
  }
}

function inconsistentPinCorrectnessLine(
  report: Pick<RoutingDoctorReport, 'repoPins' | 'desiredActionsPin'>,
): string {
  if (report.desiredActionsPin === null) {
    return (
      'PIN CORRECTNESS (vs fleet manifest): ? not evaluated — repos disagree with each ' +
      'other first (see PIN DIVERGENCE above), and no manifest is reachable to compare against'
    );
  }
  const participating = report.repoPins.filter((r) => r.consistent !== null);
  const matching = participating.filter((r) => r.correctness === 'correct').length;
  return (
    `PIN CORRECTNESS (vs fleet manifest): ${String(matching)}/${String(participating.length)} repos already ` +
    `match "${report.desiredActionsPin}" (mid-rollout, or a genuine misconfiguration — see PIN DIVERGENCE above)`
  );
}

/**
 * The loud-but-non-fatal warning line for a `consistent-but-wrong` fleet
 * (macf#872) — `null` when that state doesn't hold, so a caller can push it
 * into `collectWarnings`' array unconditionally. Uses `observedUniformPin`,
 * never `expectedPin`/`desiredActionsPin` alone, so the message stays correct
 * even when an operator `--expected-pin` override is ALSO in play and
 * disagrees with both the observed value and the manifest.
 */
export function pinCorrectnessWarning(
  report: Pick<RoutingDoctorReport, 'repoPins' | 'desiredActionsPin'>,
): string | null {
  if (classifyPinState(report) !== 'consistent-but-wrong') return null;
  const observed = observedUniformPin(report.repoPins);
  return (
    `pin CORRECTNESS: every routing repo is uniformly pinned to "${observed}", but the fleet manifest ` +
    `declares "${report.desiredActionsPin}" as current — the fleet is consistently STALE, not healthy.`
  );
}

/** Extract `versions.actions` from raw `fleet.yaml` text; `null` on ANY parse failure. */
function extractDesiredActionsPin(yamlText: string): string | null {
  try {
    return parseFleetManifest(yamlText).versions?.actions ?? null;
  } catch {
    return null;
  }
}

/** The local-file (`--manifest <path>`) source. Loud on failure (an explicit operator
 * pointer that doesn't resolve is worth a diagnostic), but still degrades to `null` —
 * never throws out of `resolveDesiredActionsPin`, and never silently falls through to
 * control-repo discovery (an explicit-but-broken override disagreeing with a silently-
 * substituted source is its own silent-fallback hazard; see this module's doc header). */
function readDesiredActionsPinFromFile(manifestPath: string): string | null {
  try {
    return extractDesiredActionsPin(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `macf routing doctor: could not read/parse --manifest "${manifestPath}" (${message}) — ` +
        'pin CORRECTNESS reports unknown for this run.',
    );
    return null;
  }
}

/**
 * Resolve the authoritative desired `macf-actions` pin for THIS run — precedence:
 * explicit `--manifest` override, else control-repo auto-discovery off the ALREADY-
 * FETCHED install-set (no extra `gh api` round-trip), else `null` (honest unknown).
 * NEVER throws.
 */
export async function resolveDesiredActionsPin(
  manifestPathOverride: string | undefined,
  repos: readonly string[],
  project: string,
  readControlManifestYaml: (repo: string) => Promise<string | null>,
): Promise<string | null> {
  if (manifestPathOverride) return readDesiredActionsPinFromFile(manifestPathOverride);

  const controlRepoSuffix = `/${deriveControlRepoName(project)}`;
  const controlRepo = repos.find((r) => r.endsWith(controlRepoSuffix));
  if (!controlRepo) return null;

  const yamlText = await readControlManifestYaml(controlRepo);
  return yamlText === null ? null : extractDesiredActionsPin(yamlText);
}
