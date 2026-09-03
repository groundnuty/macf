/**
 * Provision-time detection (groundnuty/macf#1194): whether a fleet's
 * `routing.runner.runs_on: self-hosted` declaration ACTUALLY reaches
 * `macf-actions`' `pick-runner` job through the repo's INSTALLED
 * `.github/workflows/agent-router.yml` caller.
 *
 * **Verified live** (not restated from the issue thread) against
 * `groundnuty/macf-actions`'s DEFAULT BRANCH, 2026-08-28 — read via
 * `gh api repos/groundnuty/macf-actions/contents/.github/workflows/agent-router.yml`.
 * (Read as the default branch, not diffed against the `v3.4.2` tag ref —
 * the two are not verified identical here, only that the default branch
 * as read carries the shape described below.) The reusable workflow's
 * `workflow_call.inputs` are EXACTLY `project` (required) and
 * `registry-api-path` (optional) — no input communicates a caller's
 * runner declaration, and `pick-runner`'s hosted/self-hosted choice
 * (`labels='"ubuntu-latest"'` unless `github.actor` is a comma/space/
 * newline member of the `MACF_TRUSTED_ACTORS` repo/org variable AND the
 * event isn't a fork PR) is a pure function of that ONE variable, entirely
 * independent of any `with:` value. `macf-actions#81` tracks adding a
 * runner-intent input to `pick-runner` itself (making it FAIL rather than
 * fall back for a declared-self-hosted fleet — the `macf-actions`-side
 * half of #1194, not this module's concern); until BOTH that ships AND
 * `macf`'s own caller template (`repo-init.ts::generateWorkflow`,
 * verified: emits only `project` and `registry-api-path` under `with:`)
 * is updated to pass whatever new input it adds, ANY installed `with:`
 * block naming only the two known keys below cannot possibly have
 * conveyed a runner declaration.
 *
 * **This is a genuinely connected instrument, not a guaranteed reading**
 * (`assert-the-wrong-path.md` trigger 1 — "an instrument whose result is
 * independent of the thing measured is not an instrument"):
 * {@link conveysRunnerIntent} inspects the ACTUAL installed `with:` block
 * text, which differs per repo today (a stale pre-v3 caller has no
 * `with:` block at all) and CAN differ in the future (a hand-edited
 * workflow, or a future `repo-init` template once macf-actions#81 lands,
 * would both change its answer to `true`) — it does not hardcode a
 * constant `false`. `evaluateRunnerDeclarationReach`'s decisive pair
 * (this module's test file) proves both directions are reachable from a
 * fixture, not merely the direction that matches today's known content.
 *
 * **`'honoured'` is a WEAKER signal than its name suggests — the CLI
 * layer does not treat it as a clean pass.** {@link conveysRunnerIntent}
 * fires on ANY `with:` key outside the known set, not specifically on a
 * key that conveys runner intent — a caller that grows an unrelated
 * third input (a future timeout, a label override, anything
 * `macf-actions` adds that isn't runner-intent) would ALSO read
 * `'honoured'`. This module cannot yet distinguish "the declaration
 * reaches the router" from "something new was added that isn't the two
 * known keys" — see `runner-declaration-check.ts`'s doc for how the CLI
 * layer compensates (never exits clean on `'honoured'` alone).
 *
 * **Non-blocking by design.** Per the issue's own AC ("do NOT block
 * provisioning on it unless the issue says to") and the `#1323` /`#1327`
 * precedent cited on this issue (a whole-run abort is the wrong shape;
 * a live observation must outrank a manifest-level guess): this module
 * only NAMES the disagreement between declaration and installed reality.
 * Nothing in `apply`/`plan` is made to fail because of it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RunnerDeclarationVerdict = 'not-applicable' | 'unknown' | 'not-honoured' | 'honoured';

export interface RunnerDeclarationFinding {
  readonly repo: string;
  readonly verdict: RunnerDeclarationVerdict;
  /** Operator-facing — names the repo, the workflow, what the declaration says, and what the workflow will actually do, per the issue's own "an operator must fix it in one step" requirement. */
  readonly message: string;
}

/**
 * groundnuty/macf#1421 — the ONE place the human-readable tag word for each
 * {@link RunnerDeclarationVerdict} lives, imported by both `plan.ts`
 * ({@link formatRunnerDeclarationLines}) and the standalone `macf routing
 * runner-declaration-check` CLI (`runner-declaration-check.ts::formatFinding`)
 * so the two surfaces render byte-identical vocabulary rather than two
 * hand-synced copies that can silently drift (exactly what this issue
 * fixed: `'honoured'` was tagged `UNCERTAIN` — "we could not tell what the
 * declaration is" — when the true state is "the declaration is present and
 * certain; only the ROUTER'S RUNTIME behaviour is unverified"). `'honoured'`
 * itself stays a real verdict name (see this module's own doc for why it is
 * a weaker signal than its name suggests); only the OPERATOR-FACING WORD
 * changes here.
 */
export function runnerDeclarationTag(verdict: RunnerDeclarationVerdict): string {
  switch (verdict) {
    case 'not-honoured':
      return 'NOT HONOURED';
    case 'unknown':
      return 'UNKNOWN';
    case 'honoured':
      return 'DECLARED (runtime unverified)';
    case 'not-applicable':
      return 'N/A';
  }
}

/**
 * The macf-actions router `with:` input keys verified LIVE (this module's
 * own doc comment above) against `groundnuty/macf-actions`'s reusable
 * `agent-router.yml`: its ENTIRE `workflow_call.inputs` set, nothing
 * fewer. Any `with:` key on an installed caller OUTSIDE this set is
 * evidence the installed workflow does something this reusable
 * workflow's CURRENTLY KNOWN contract doesn't — GitHub hard-errors an
 * unknown `with:` key against `workflow_call.inputs` at workflow-parse
 * time (`repo-init.ts`'s own doc: "an unknown input is a hard error"), so
 * a caller successfully naming a THIRD key can only mean the referenced
 * pin's schema has grown one. That growth is the seam `macf-actions#81`
 * would use, and updating THIS constant (never `conveysRunnerIntent`'s
 * logic) is the whole of what picking up that seam requires here.
 */
export const KNOWN_NON_RUNNER_INTENT_WITH_KEYS: readonly string[] = ['project', 'registry-api-path'];

/** Anchors on the SAME literal macf-actions router `uses:` reference `observer.ts::extractActionsPin`'s (independent, module-private) regex anchors on — kept as an independent copy for the same reason that module documents: this module's own decision (whether the with: block conveys runner intent) is orthogonal to that module's (what pin is observed), and importing across the boundary would either force an unwanted coupling or silently diverge if one changes shape without the other. Captures the leading indentation (group 1, used to locate the sibling `with:` line at the SAME indent) and the pin (group 2). */
const ACTIONS_USES_LINE_RE = /^(\s*)uses:\s*groundnuty\/macf-actions\/\.github\/workflows\/agent-router\.yml@(\S+)\s*$/;

export interface ParsedCallerBlock {
  readonly pin: string;
  /** Every `with:` key name found, in file order. Empty when the `uses:` line has no `with:` block at all (pre-v3 caller, or a v3+ caller some future generator stops emitting `with:` for). */
  readonly withKeys: readonly string[];
}

/**
 * Parses ONE caller `with:` block's key names out of an installed
 * `agent-router.yml`'s raw text, anchored to the FIRST macf-actions
 * `uses:` line found — `repo-init.ts::generateWorkflow` generates
 * exactly one such call site per file, verified by grep against its own
 * source (a single `uses: groundnuty/macf-actions/...` template line).
 * Indentation-based, not a full YAML parse — mirrors
 * `observer.ts::extractActionsPin`'s own "verified regex against real
 * generated content" posture, extended here to also read the sibling
 * `with:` block rather than only the pin.
 *
 * Returns `undefined` when no macf-actions `uses:` line is found at all
 * (content unreadable in a way that already collapsed to a string, or
 * genuinely carries no router call — both fold to the same "cannot
 * confirm" signal for this module's caller, {@link evaluateRunnerDeclarationReach}).
 */
export function extractCallerWithKeys(content: string): ParsedCallerBlock | undefined {
  const lines = content.split('\n');
  let usesIdx = -1;
  let pin = '';
  let baseIndent = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const match = ACTIONS_USES_LINE_RE.exec(lines[idx] ?? '');
    if (match) {
      usesIdx = idx;
      baseIndent = match[1]?.length ?? 0;
      pin = match[2] ?? '';
      break;
    }
  }
  if (usesIdx === -1) return undefined;

  let withLineIdx = -1;
  let withIndent = 0;
  for (let idx = usesIdx + 1; idx < lines.length; idx++) {
    const line = lines[idx] ?? '';
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < baseIndent) break; // dedented past the calling step's own block — no with: for this call
    if (indent === baseIndent) {
      if (/^with:\s*$/.test(trimmed)) {
        withLineIdx = idx;
        withIndent = indent;
      }
      break; // first sibling key at this level decides it either way (with: or something else, e.g. straight to secrets:)
    }
  }
  if (withLineIdx === -1) return { pin, withKeys: [] };

  const withKeys: string[] = [];
  for (let idx = withLineIdx + 1; idx < lines.length; idx++) {
    const line = lines[idx] ?? '';
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= withIndent) break; // dedented out of the with: block
    const keyMatch = /^([A-Za-z0-9_-]+):/.exec(trimmed);
    if (keyMatch?.[1] !== undefined) withKeys.push(keyMatch[1]);
  }
  return { pin, withKeys };
}

/**
 * Whether `withKeys` includes anything beyond the known, LIVE-verified
 * non-runner-intent set — see {@link KNOWN_NON_RUNNER_INTENT_WITH_KEYS}'s
 * doc for why a key outside that set is evidence, not a guess.
 */
export function conveysRunnerIntent(withKeys: readonly string[]): boolean {
  return withKeys.some((key) => !KNOWN_NON_RUNNER_INTENT_WITH_KEYS.includes(key));
}

/**
 * Pure decision — no I/O. `declaredRunsOn` is `manifest.routing?.runner?.runs_on`
 * (`undefined` when the fleet declares no routing runner at all —
 * treated identically to any non-`'self-hosted'` value: hosted is an
 * accepted choice, nothing to check). `installedContent` is the raw text
 * of the repo's installed `.github/workflows/agent-router.yml`,
 * `undefined` when it could not be read — see
 * {@link checkRunnerDeclarationReach} for the live `gh api`-backed
 * wrapper that supplies it.
 *
 * Four outcomes, matching {@link RunnerDeclarationVerdict}:
 *   - declared runner isn't self-hosted -> `'not-applicable'`, no check performed
 *   - installed content unreadable, or unrecognizable as a macf-actions
 *     router call -> `'unknown'` — NEVER `'not-honoured'` (that would be a
 *     confirmed finding from a read that never confirmed anything) and
 *     NEVER treated as "consistent" (the issue's own explicit requirement)
 *   - installed `with:` conveys no runner intent -> `'not-honoured'`,
 *     named: which repo, which pin, what's actually in the `with:` block,
 *     and what the router does instead (MACF_TRUSTED_ACTORS membership only)
 *   - installed `with:` conveys runner intent -> `'honoured'` — reachable
 *     only once macf-actions#81 ships AND this repo's workflow carries the
 *     new key; see this module's own doc for why that is a real, not a
 *     guaranteed, branch
 */
export function evaluateRunnerDeclarationReach(
  repo: string,
  declaredRunsOn: string | undefined,
  installedContent: string | undefined,
): RunnerDeclarationFinding {
  if (declaredRunsOn !== 'self-hosted') return notApplicableFinding(repo);

  if (installedContent === undefined) {
    return {
      repo,
      verdict: 'unknown',
      message:
        `${repo}: could not read the installed .github/workflows/agent-router.yml — cannot confirm whether this fleet's ` +
        '"self-hosted" declaration is honoured by the router. Treat as UNKNOWN, never "consistent".',
    };
  }

  const parsed = extractCallerWithKeys(installedContent);
  if (parsed === undefined) {
    return {
      repo,
      verdict: 'unknown',
      message:
        `${repo}: the installed .github/workflows/agent-router.yml carries no recognizable macf-actions router "uses:" line — ` +
        'cannot confirm whether this fleet\'s "self-hosted" declaration is honoured. Treat as UNKNOWN, never "consistent".',
    };
  }

  return decideFromWithKeys(repo, parsed.pin, parsed.withKeys);
}

/** Shared "declared runner isn't self-hosted" finding — identical text regardless of which entry point (content-based or already-observed) short-circuits on it. */
function notApplicableFinding(repo: string): RunnerDeclarationFinding {
  return {
    repo,
    verdict: 'not-applicable',
    message: `${repo}: routing.runner.runs_on is not "self-hosted" — hosted runners are an accepted choice here; no enforcement check applies.`,
  };
}

/**
 * Module-private: the "with: keys are already known" 3-outcome tail shared
 * by {@link evaluateRunnerDeclarationReach} (content-based — parses
 * `withKeys` itself from raw text) and
 * {@link evaluateRunnerDeclarationReachFromObservation} (groundnuty/macf#1335
 * — consumes ALREADY-parsed `withKeys`, no content of its own to parse) —
 * the ONE place "honoured"/"not-honoured" message wording lives, so the two
 * entry points can never render different words for the identical verdict.
 * `pin` is a display value only (`'(unknown pin)'` when the caller has none
 * to offer) — it never participates in the decision, only the message text.
 */
function decideFromWithKeys(repo: string, pin: string, withKeys: readonly string[]): RunnerDeclarationFinding {
  if (conveysRunnerIntent(withKeys)) {
    return {
      repo,
      verdict: 'honoured',
      message:
        `${repo}: installed agent-router.yml@${pin} passes a "with:" input beyond ` +
        `{${KNOWN_NON_RUNNER_INTENT_WITH_KEYS.join(', ')}} (with: keys: ${withKeys.join(', ')}) — this fleet's self-hosted ` +
        `declaration is DECLARED in the installed workflow. Whether the router ACTS on it is proven only by a routed ` +
        `run landing on the self-hosted runner, not by this static read; this check cannot yet name what a new key ` +
        `does, so verify by hand against the current macf-actions@${pin} workflow_call schema.`,
    };
  }

  // Citation guard (macf#1061): the STRING below must stand on its own —
  // no internal issue numbers. This module's own doc comment above (a
  // maintainer-facing surface, exempt from the guard) carries the actual
  // groundnuty/macf-actions#81 / groundnuty/macf#1194 references.
  const withDescription = withKeys.length > 0 ? withKeys.join(', ') : '(no with: block at all)';
  return {
    repo,
    verdict: 'not-honoured',
    message:
      `${repo}: fleet.yaml declares routing.runner.runs_on: self-hosted, but the installed agent-router.yml@${pin} passes ` +
      `only {${withDescription}} to macf-actions' reusable workflow. No released macf-actions router accepts an input that conveys ` +
      "a runner declaration (verified against the reusable workflow's own live workflow_call.inputs schema) — " +
      "pick-runner's hosted/self-hosted choice depends SOLELY on the MACF_TRUSTED_ACTORS variable, independent of this manifest. " +
      'A missing or drifted trusted-actor entry will silently route real work to a metered GitHub-hosted runner. ' +
      'The reusable workflow does not yet accept an input that would let this declaration reach it; this repo cannot honour ' +
      "the declaration until both that plumbing exists and this repo's installed workflow is regenerated to use it.",
  };
}

/**
 * The `macf bootstrap plan` entry point (groundnuty/macf#1335 — the half of
 * #1194 #1334 deliberately left unwired: a standalone CLI an operator must
 * remember to run is not a guarantee). Consumes fields `observer.ts`'s
 * `githubRegistryObserver` ALREADY populated from its own single per-agent
 * read of the installed `.github/workflows/agent-router.yml`
 * (`ObservedAgentState.actionsPin` / `.routerWithKeys`) — this function does
 * NO I/O of its own and reads NOTHING a second time. That is the load-bearing
 * difference from {@link evaluateRunnerDeclarationReach}: that function (and
 * its live-read wrapper {@link checkRunnerDeclarationReach}) exist for the
 * STANDALONE `macf routing runner-declaration-check` CLI, where a fresh,
 * deliberate live read is exactly what an operator invoking that command
 * wants; wiring `plan` to also call that live-read path would perform a
 * SECOND `gh api` read of the identical file `observer.ts` already read
 * once this run — the parallel-read hazard this issue's own thread warns
 * against.
 *
 * `withKeys === undefined` collapses the SAME two causes
 * `evaluateRunnerDeclarationReach` collapses into one `'unknown'` signal
 * (file unreadable, or no macf-actions `uses:` line found) — `observer.ts`'s
 * single read already folds both into one absent-vs-present observation, so
 * there is no second distinction left to preserve here. `pin` is cosmetic
 * (falls back to a placeholder for the message text) — it is NEVER what
 * decides `'unknown'` vs. a real verdict; `withKeys` alone decides that,
 * mirroring `ObservedAgentState.routerWithKeys`'s own doc.
 */
export function evaluateRunnerDeclarationReachFromObservation(
  repo: string,
  declaredRunsOn: string | undefined,
  pin: string | undefined,
  withKeys: readonly string[] | undefined,
): RunnerDeclarationFinding {
  if (declaredRunsOn !== 'self-hosted') return notApplicableFinding(repo);

  if (withKeys === undefined) {
    return {
      repo,
      verdict: 'unknown',
      message:
        `${repo}: this run could not confirm the installed .github/workflows/agent-router.yml's macf-actions router caller — ` +
        'cannot confirm whether this fleet\'s "self-hosted" declaration is honoured by the router. Treat as UNKNOWN, never "consistent".',
    };
  }

  return decideFromWithKeys(repo, pin ?? '(unknown pin)', withKeys);
}

// --- Live read wrapper ---

export interface RunnerDeclarationDeps {
  /** Raw text of `repo`'s installed `.github/workflows/agent-router.yml` on its default branch. `undefined` on ANY failure (file absent, auth/network, `gh` absent) — NEVER throws. */
  readonly readInstalledWorkflow: (repo: string) => Promise<string | undefined>;
}

/**
 * Real read-only `gh api` call — same shape as
 * `observer.ts::readCallerActionsPin`'s own contents-API read
 * (independent copy; that function returns only the extracted pin, this
 * one needs the FULL text to also read the `with:` block). Operator-
 * privileged ambient `gh` auth, same posture as every other bootstrap
 * observation read in this codebase — see `observer.ts`'s module doc.
 */
async function realReadInstalledWorkflow(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repo}/contents/.github/workflows/agent-router.yml`, '--jq', '.content'],
      { encoding: 'utf-8' },
    );
    return Buffer.from(stdout.replace(/\s+/g, ''), 'base64').toString('utf-8');
  } catch {
    return undefined;
  }
}

export const REAL_RUNNER_DECLARATION_DEPS: RunnerDeclarationDeps = {
  readInstalledWorkflow: realReadInstalledWorkflow,
};

/**
 * Live-backed entry point — resolves `installedContent` via `deps` (only
 * when `declaredRunsOn === 'self-hosted'`; a non-self-hosted declaration
 * never needs the read at all, same short-circuit
 * {@link evaluateRunnerDeclarationReach} performs internally) and defers
 * the actual decision to that pure function.
 */
export async function checkRunnerDeclarationReach(
  repo: string,
  declaredRunsOn: string | undefined,
  deps: RunnerDeclarationDeps = REAL_RUNNER_DECLARATION_DEPS,
): Promise<RunnerDeclarationFinding> {
  if (declaredRunsOn !== 'self-hosted') {
    return evaluateRunnerDeclarationReach(repo, declaredRunsOn, undefined);
  }
  const content = await deps.readInstalledWorkflow(repo);
  return evaluateRunnerDeclarationReach(repo, declaredRunsOn, content);
}
