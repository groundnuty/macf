/**
 * The operator-secrets file (groundnuty/macf#1197) — ONE plain `KEY=value`
 * file instead of a growing set of `--<thing>-secret` flags. Motivated by
 * the operator's own framing: "if a friend of mine starts doing this from
 * scratch, he doesn't have any references" — a reference (`#1161`'s scope
 * store) presumes a referent, which a cold organisation does not have. This
 * file is the cold-start answer; the scope store remains the warm-reuse
 * answer (see that module's own doc for the distinction).
 *
 * ## Precedence — operator-ruled, per KEY not per FILE
 *
 * Most-explicit-wins, extending `--runner-token`'s existing flag-over-env
 * rule rather than inventing a second ordering: **CLI flag -> per-fleet
 * file -> per-scope file -> env**. Resolved independently for EVERY key
 * ({@link resolveOperatorInput}) — the operator's own words: "a fleet
 * supplying one override must not lose every other scope-level value...
 * whole-file shadowing is the obvious wrong implementation and would be
 * silent." Looking each tier up by key, rather than gating on "does the
 * fleet file exist at all," is what makes that guarantee hold.
 *
 * ## Scope, not just secrets
 *
 * The file carries SCOPE INPUTS, not only secrets (#1197's second ruling,
 * surfaced by `#1211`'s `MACF_RUNNER_PLATFORM_ENDPOINT` — a plain org
 * VARIABLE, not a secret). The operator supplies values; the TOOL decides
 * each key's storage class — {@link OPERATOR_SECRETS_FILE_KEYS}'s
 * `storageClass` field documents what the EXISTING consumer of each key
 * already does with it (`apply-routing-secrets.ts` writes the Tailscale
 * pair as org secrets; `runner-platform.ts`'s scope tier treats the
 * endpoint as a variable) — this module does not itself write anything to
 * GitHub, and never asks the operator to classify a key.
 *
 * ## What stays out
 *
 * The age identity (private) key is deliberately ABSENT from this file and
 * from {@link OPERATOR_SECRETS_FILE_KEYS} — Amendment C: operator-held,
 * never tool-minted. `age_recipients` in `fleet.yaml` is its public
 * pointer; this module generalises THAT precedent (public reference
 * committed, private material outside it), it does not fold the key in.
 *
 * ## Never logged, never committed
 *
 * Every function in this module that returns human-facing text
 * ({@link describeOperatorInputSource}, {@link formatOperatorInputProvenanceLine},
 * {@link formatMissingOperatorInputsMessage}) takes KEY NAMES and SOURCE
 * TIERS only — never a resolved value. Committing is prevented at the
 * write side: {@link writeOperatorSecretsFileTemplate} always ensures the
 * containing directory's `.gitignore` covers the file it just wrote, so
 * "never committed" does not depend on the operator remembering.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { TS_OAUTH_CLIENT_ID_ENV_VAR, TS_OAUTH_SECRET_ENV_VAR } from './apply-routing-secrets.js';
import { RUNNER_TOKEN_ENV_VAR } from './apply-routing.js';
import { RUNNER_PLATFORM_ENDPOINT_ENV_VAR } from './runner-platform.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Parsing ---

/**
 * Dotenv-lite parser for the operator-secrets file (#1197 required: "one
 * file, plain KEY=value"). Deliberately minimal + permissive: blank lines
 * and `#`-comments are skipped, a line with no `=` is skipped rather than
 * thrown (a friend hand-editing this for the first time should not get a
 * parse exception over a stray line), and one layer of matching `'...'`/
 * `"..."` quoting around the value is stripped. Unknown keys are NOT
 * filtered here — tolerating them is required (#1197's test list: "a file
 * with unknown extra keys is tolerated, not fatal"); the caller decides
 * which keys it looks up, so an extra line nobody reads is simply never
 * consulted.
 */
export function parseOperatorSecretsFile(contents: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (key.length > 0) values[key] = value;
  }
  return values;
}

/** Either `{ok:true, values}` (parsed, possibly empty) or `{ok:false, message}` (unreadable) — never throws. */
export type OperatorSecretsFileReadResult = { readonly ok: true; readonly values: Readonly<Record<string, string>> } | { readonly ok: false; readonly message: string };

/**
 * Reads + parses one tier of the operator-secrets file. `undefined` path is
 * NOT an error — the tier is simply absent (#1197's ruling: "a per-fleet
 * file is optional... its absence is the normal case, not a warning"). A
 * GIVEN path that cannot be read IS an error: a typo'd `--secrets-file`
 * path must never silently degrade to "no values from this tier," which
 * would be indistinguishable from "operator deliberately omitted this
 * tier" and hide the mistake.
 */
export function readOperatorSecretsFile(path: string | undefined): OperatorSecretsFileReadResult | undefined {
  if (path === undefined) return undefined;
  try {
    return { ok: true, values: parseOperatorSecretsFile(readFileSync(path, 'utf-8')) };
  } catch (err) {
    return { ok: false, message: `could not read operator secrets file "${path}": ${errMessage(err)}` };
  }
}

// --- Precedence resolution (per KEY, never per FILE) ---

export type OperatorInputSource = 'flag' | 'fleet-file' | 'scope-file' | 'env' | 'none';

export interface OperatorInputResolution {
  readonly value: string | undefined;
  readonly source: OperatorInputSource;
}

/**
 * The #1197 operator-ruled precedence, most-explicit-wins: CLI flag ->
 * per-fleet file -> per-scope file -> env — resolved for THIS key alone.
 * An empty string at any tier counts as "not given," matching the
 * `.length > 0` convention `checkTsOauthFlagsComplete`/
 * `checkRunnerTokenPreflight` already apply to flag/env values, so an
 * accidentally-blank `KEY=` line in a file falls through exactly like an
 * unset flag would.
 */
export function resolveOperatorInput(
  key: string,
  flagValue: string | undefined,
  fleetFileValues: Readonly<Record<string, string>> | undefined,
  scopeFileValues: Readonly<Record<string, string>> | undefined,
): OperatorInputResolution {
  if (flagValue !== undefined && flagValue.length > 0) return { value: flagValue, source: 'flag' };
  const fleetValue = fleetFileValues?.[key];
  if (fleetValue !== undefined && fleetValue.length > 0) return { value: fleetValue, source: 'fleet-file' };
  const scopeValue = scopeFileValues?.[key];
  if (scopeValue !== undefined && scopeValue.length > 0) return { value: scopeValue, source: 'scope-file' };
  const envValue = process.env[key];
  if (envValue !== undefined && envValue.length > 0) return { value: envValue, source: 'env' };
  return { value: undefined, source: 'none' };
}

// --- Provenance reporting (value-free, by construction) ---

const OPERATOR_INPUT_SOURCE_LABEL: Readonly<Record<Exclude<OperatorInputSource, 'none'>, string>> = {
  flag: 'an explicit CLI flag',
  'fleet-file': 'the per-fleet secrets file',
  'scope-file': 'the per-scope secrets file',
  env: 'an environment variable',
};

/** Human label for a resolution source — takes the TIER, never the value, so it is safe to print unconditionally. */
export function describeOperatorInputSource(source: OperatorInputSource): string {
  return source === 'none' ? 'not supplied' : OPERATOR_INPUT_SOURCE_LABEL[source];
}

/** One "KEY: source" line, safe to print verbatim in `plan`/`apply` output (#1197: "never log a VALUE while reporting a SOURCE"). */
export function formatOperatorInputProvenanceLine(key: string, source: OperatorInputSource): string {
  return `${key}: ${describeOperatorInputSource(source)}`;
}

// --- Aggregate fail-loud (Pattern D, silent-fallback-hazards.md) ---

export interface OperatorInputRequirement {
  readonly key: string;
  readonly required: boolean;
  readonly value: string | undefined;
}

/**
 * Pure aggregation — #1197 required: "a missing REQUIRED key fails before
 * any gate opens, naming every missing key at once," not one-at-a-time
 * discovery. Takes ALREADY-resolved requirement facts (the caller decides
 * what "required" means for its own manifest; this function does not
 * re-derive requiredness or know about vaults) and returns every key that
 * is required but unresolved, in the order given.
 */
export function missingRequiredOperatorInputs(entries: readonly OperatorInputRequirement[]): readonly string[] {
  return entries.filter((e) => e.required && (e.value === undefined || e.value.length === 0)).map((e) => e.key);
}

export const MISSING_OPERATOR_INPUTS_CODE = 'operator_inputs_missing';

/**
 * One aggregate, value-free message naming every missing key. Also names
 * `--vault`/`--identity-key` as the alternative way to satisfy a declared
 * requirement — a value already living in the vault never needs to be
 * repeated into this file at all, and a caller that gates this check on
 * "vault flags absent" (the only regime it can safely fire in — see
 * `bootstrap-apply.ts`'s wiring) owes the operator that pointer.
 */
export function formatMissingOperatorInputsMessage(missingKeys: readonly string[]): string {
  return (
    `missing required operator input${missingKeys.length === 1 ? '' : 's'}: ${missingKeys.join(', ')}. ` +
    'Supply each via a CLI flag, the per-fleet secrets file, the per-scope secrets file, or its environment ' +
    "variable fallback — run `macf bootstrap secrets template` for what each key is for and how to obtain it. " +
    'Already have these in a vault instead? Supply --vault/--identity-key and this check is skipped in favor ' +
    'of confirming the vaulted values directly.'
  );
}

// --- The key registry + template ---

export type OperatorSecretsFileStorageClass = 'org-secret' | 'org-variable' | 'ephemeral-discard';

const STORAGE_CLASS_LABEL: Readonly<Record<OperatorSecretsFileStorageClass, string>> = {
  'org-secret': 'stored as an encrypted org/account secret',
  'org-variable': 'stored as a plain org/account variable (not encrypted — reachability is the access control)',
  'ephemeral-discard': 'used once for this run, never stored anywhere',
};

export interface OperatorSecretsFileKeyInfo {
  readonly key: string;
  readonly purpose: string;
  readonly howToObtain: string;
  readonly storageClass: OperatorSecretsFileStorageClass;
}

/**
 * Every key `bootstrap apply` (and, for the platform endpoint, `bootstrap
 * plan`/other legs) can consume from this file (#1197 required: "a
 * template listing every key apply can consume"). `storageClass` documents
 * — never decides — what the EXISTING consumer of each key already does
 * with it; the operator is never asked to classify anything. Deliberately
 * excludes the age identity key — see this module's doc, "What stays out."
 */
export const OPERATOR_SECRETS_FILE_KEYS: readonly OperatorSecretsFileKeyInfo[] = [
  {
    key: TS_OAUTH_CLIENT_ID_ENV_VAR,
    purpose: 'Tailscale OAuth client ID — lets apply mint an ephemeral tailnet auth key for cross-agent routing.',
    howToObtain: 'Tailscale admin console -> Settings -> OAuth clients -> Generate client (tag the fleet needs, e.g. tag:ci).',
    storageClass: 'org-secret',
  },
  {
    key: TS_OAUTH_SECRET_ENV_VAR,
    purpose: 'The pair to the client ID above — supply both, or neither.',
    howToObtain: 'Issued alongside the client ID in the same Tailscale OAuth client screen; shown once at creation time.',
    storageClass: 'org-secret',
  },
  {
    key: RUNNER_TOKEN_ENV_VAR,
    purpose: 'A GitHub Actions self-hosted runner registration token — only needed when a repo has no usable runner yet.',
    howToObtain: 'gh api -X POST /orgs/<org>/actions/runners/registration-token --jq .token (expires in about an hour — get a fresh one if apply is re-run later).',
    storageClass: 'ephemeral-discard',
  },
  {
    key: RUNNER_PLATFORM_ENDPOINT_ENV_VAR,
    purpose: 'The tailnet hostname of the runner-provisioning platform apply calls to warm self-hosted runners.',
    howToObtain: "The operator's own runner-platform deployment address, e.g. http://<tailnet-host>:8088 — ask whoever runs it.",
    storageClass: 'org-variable',
  },
];

/**
 * The `KEY=value` template text (#1197 required: "a template listing every
 * key ... with what each is for and how to obtain it — 'here is the file,
 * fill it in' is the deliverable"). Every value is left BLANK, never a
 * placeholder that looks real (the same "empty is the honest unset state"
 * `age_recipients: []` already establishes). ONE template serves both the
 * per-fleet and the per-scope tier — the file format does not differ by
 * tier, only by which flag it is passed to.
 */
export function operatorSecretsFileTemplate(): string {
  const lines: string[] = [
    '# MACF operator secrets file (see `macf bootstrap secrets template --help`).',
    '# Plain KEY=value, one per line. Fill in the values you have; leave the rest blank.',
    '# NEVER commit this file — the tooling that wrote it already gitignored it for you.',
    '#',
    '# Precedence when both a per-fleet and a per-scope file exist: CLI flag > per-fleet',
    '# file > per-scope file > environment variable — resolved per KEY, not per file, so a',
    '# fleet file overriding ONE key still inherits every other value from the scope file.',
    '',
  ];
  for (const info of OPERATOR_SECRETS_FILE_KEYS) {
    lines.push(`# ${info.purpose}`);
    lines.push(`# How to obtain: ${info.howToObtain}`);
    lines.push(`# Storage: ${STORAGE_CLASS_LABEL[info.storageClass]}`);
    lines.push(`${info.key}=`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Idempotently ensures `dir`'s `.gitignore` excludes `fileBasename` —
 * mirrors `control-repo.ts::ensureControlRepoGitignore`'s exact shape
 * (append-only, never replaces an operator-hand-authored `.gitignore`,
 * no-op if already present).
 */
export function ensureOperatorSecretsGitignore(dir: string, fileBasename: string): void {
  const gitignorePath = join(dir, '.gitignore');
  let existing = '';
  try {
    existing = readFileSync(gitignorePath, 'utf-8');
  } catch {
    // No `.gitignore` yet — `existing` stays `''`.
  }
  if (existing.split('\n').some((line) => line.trim() === fileBasename)) return;
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${existing}${separator}${fileBasename}\n`, 'utf-8');
}

/**
 * Writes the template to `path` AND ensures the containing directory's
 * `.gitignore` covers it in the SAME call — #1197 required: "never
 * committed... gitignored by the tooling that creates it, not by the
 * operator remembering." Refuses to overwrite an existing file (an
 * operator who already filled one in must not have it silently blanked).
 */
export function writeOperatorSecretsFileTemplate(path: string): { readonly created: boolean } {
  if (existsSync(path)) return { created: false };
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, operatorSecretsFileTemplate(), 'utf-8');
  ensureOperatorSecretsGitignore(dir, basename(path));
  return { created: true };
}
