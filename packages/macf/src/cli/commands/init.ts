import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, chmodSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  projectMacfDir, writeAgentConfig, addToAgentsIndex,
  agentCertPath, agentKeyPath,
  caCertPath as caCertPathFor, caKeyPath as caKeyPathFor,
  isValidProjectName, tokenSourceFromConfig,
} from '../config.js';
import { createCA, loadCA } from '@groundnuty/macf-core';
import { generateAgentCert } from '@groundnuty/macf-core';
import { copyCanonicalRules, copyCanonicalScripts } from '../rules.js';
import { seedProjectRulesDir } from '../project-rules.js';
import { reportSeedPromptResponses, seedPromptResponsesConfig } from '../prompt-responses.js';
import { reportSeedStallSignatures, seedStallSignaturesConfig } from '../stall-signatures.js';
import { installGhTokenHook, installStartupPickupHook, installPluginSkillPermissions, installSandboxFdAllowRead, installSandboxExcludedCommands } from '../settings-writer.js';
import { deriveBotLogin, fetchAppSlug } from './doctor.js';
import { fetchPluginToWorkspace, stripPluginMcpServers, linkPluginCliDist } from '../plugin-fetcher.js';
import { writeMcpJsonChannelServer } from '../mcp-json.js';
import { writeClaudeSh, hasManagedHeader } from '../claude-sh.js';
import { writeEnvFiles } from '../env-files.js';
import { writeHostPrelude } from '../host-prelude.js';
import {
  resolveLatestVersions, isValidSemver, isValidActionsRef,
  FALLBACK_VERSIONS, statusMessage,
} from '../version-resolver.js';
import type { MacfAgentConfig, VersionPins } from '../config.js';
import { migrateLocalToGitHub } from './migrate.js';

export interface InitOptions {
  readonly project: string;
  readonly role: string;
  readonly name?: string;
  /**
   * The routing identity — registry key + cert CN (macf#545). Defaults to the
   * agent name; set it only when the routing label must differ from the OTEL
   * bot-name (the substrate: devops-agent vs macf-devops-agent). Written to
   * `macf-agent.json` `routing_label`, baked as the `MACF_ROUTING_LABEL`
   * default, and used as the cert CN — so the registry key and the cert CN
   * stay consistent (mTLS validates CN against the resolved slot).
   */
  readonly routingLabel?: string;
  readonly type?: string;
  /**
   * GitHub App credentials. Required for `repo` / `org` / `profile`
   * registries; not used in `local` registry mode (DR-024 / macf#322).
   * Marked optional so `--local` callers don't have to fabricate
   * placeholder values.
   */
  readonly appId?: string;
  readonly installId?: string;
  readonly keyPath?: string;
  /**
   * Source path of the downloaded App private key (.pem) to INGEST into the
   * conventional destination (`--key-path`, default
   * `~/.macf/keys/<project>/<agent>.pem` — macf#1157) with `0600` perms at
   * init time. Closes the macf#530 "pointer set without
   * the thing it points to" papercut — without ingestion the operator must
   * hand-`cp` the key and a wrong path/perm surfaces later as a cryptic
   * `gh` 401, not at init.
   */
  readonly appKey?: string;
  readonly registryType?: string;
  readonly registryOrg?: string;
  readonly registryUser?: string;
  readonly registryRepo?: string;
  /**
   * Absolute path to the local-registry JSON file. Only honored when
   * `registryType === 'local'`. Defaults to
   * `~/.macf/registry/<project>.json` when unset; the operator can
   * override for non-default placement (separate disk, encrypted home,
   * etc.). DR-024 §"Default `path`".
   */
  readonly registryPath?: string;
  /**
   * One-shot migration source: read agent records from this local-registry
   * JSON file and write each into the new GitHub-backed registry. Only
   * honored when `registryType` is `repo`/`org`/`profile`. Rejected
   * combined with `--local` — local→local migration is a no-op (the
   * operator can copy/rename the file directly). DR-024 §"Migration
   * path — local → GitHub mode".
   */
  readonly migrateFrom?: string;
  /**
   * Host the channel server advertises to the registry + includes in
   * its mTLS cert SAN. When unset, launcher falls back to 127.0.0.1
   * (matches plugin default). Operators routing to agents over the
   * network (Tailscale IP / DNS) must set this. See macf#178.
   */
  readonly advertiseHost?: string;
  /**
   * Tmux session + (optional) window for the on-notify wake path
   * (macf#185). When set, the channel server's onNotify shells out
   * to tmux-send-to-claude.sh to inject the notification prompt
   * into a running Claude TUI. When unset, the server auto-detects
   * from $TMUX if launched inside a tmux pane.
   */
  readonly tmuxSession?: string;
  readonly tmuxWindow?: string;
  readonly cliVersion?: string;
  readonly pluginVersion?: string;
  readonly actionsVersion?: string;
  /**
   * Skip issuing a fresh agent mTLS leaf cert when a valid cert+key pair
   * ALREADY exists at the destination workspace (macf#1000). Defaults to
   * `undefined` (falsy) — the historical, UNCHANGED behavior for `macf
   * init` used directly: {@link issueGithubModeAgentCert} below is
   * unconditional whenever a local CA is present, so a bare `macf init`
   * re-run always refreshes the cert, exactly as before this option
   * existed. Set to `true` ONLY by `fleet deploy`
   * (`bootstrap/fleet-deploy.ts::deployAgent`), which delegates ALL
   * agent-leaf-cert issuance to this function so `generateAgentCert` is
   * reachable from exactly one place per deploy run — see that module's
   * doc + macf#1000 ("one cert-issuance path per run"; #979/#1002 had
   * introduced a SECOND, duplicate call site in `fleet-deploy.ts` itself).
   * Deliberately NOT exposed as a `macf init` CLI flag — it is an internal
   * delegation signal between two code paths, not a second operator-facing
   * way to skip cert issuance (that would just be a new golden-path
   * violation of the same shape this option exists to close).
   */
  readonly skipCertIfPresent?: boolean;
  /**
   * Explicit opt-in to overwrite an existing HAND-AUTHORED `claude.sh`
   * (one that exists but lacks the macf managed-file header) — #897.
   * Without this, `initAgent` refuses (throws) before any workspace
   * state is written when it finds such a file, rather than silently
   * clobbering an operator's customized launcher on a second `init`
   * invocation. Mirrors two existing precedents: `update.ts`'s
   * `hasManagedHeader` preserve-and-warn guard (same discriminator,
   * same header sentinel — {@link hasManagedHeader}), and `repo-init`'s
   * `--force` ("use --force to overwrite" on an existing file).
   *
   * Does NOT gate:
   *   - A workspace with NO existing `claude.sh` (fresh init — nothing
   *     to protect).
   *   - A workspace whose `claude.sh` already carries the managed
   *     header (a normal macf-managed re-init/repair run — this is the
   *     historical unconditional-overwrite behavior every other
   *     `macf init` remediation message in this codebase depends on,
   *     e.g. `config.ts`'s legacy-schema warning).
   *
   * Defaults to `false` (refuse-by-default on a genuine hand-authored
   * file) — this is the one behavior change from pre-#897: previously
   * `initAgent` clobbered a hand-authored `claude.sh` unconditionally.
   *
   * **Scoped to `claude.sh` only — does NOT extend to the operator-managed
   * env files (macf#1116).** `writeEnvFiles` (env-files.ts) preserves an
   * existing `env.telemetry` / `env.tmux` / `env.project-rules` regardless
   * of this flag. The two gates answer different questions (refuse-to-touch
   * a file this tool didn't author, vs preserve-an-existing-value in a file
   * it did) and deliberately don't share a knob — see `writeEnvFiles`'s doc
   * comment for the full reasoning.
   */
  readonly force?: boolean;
  /**
   * Whether this run registers in the global cross-project agents index
   * (~/.macf/agents.json) — macf#1135. Defaults to `true` (unset ≡
   * register, the historical, UNCHANGED behavior for every existing
   * caller). Set to `false` (`--no-agents-index`) for a scoped/ephemeral
   * `macf init` invocation that should not become globally discoverable
   * via `macf status`/`macf peers`/`macf list` on this host — e.g. a
   * release-time harness-check materializing a scratch workspace purely
   * to validate generator output (release.sh's `cmd_harness_check`).
   *
   * Deliberately mode-independent (works for `--local` AND
   * repo/org/profile registries) and independent of the local-registry
   * `--path` flag: `--path`'s own documented purpose is PERMANENT
   * relocation of the registry file (a separate disk, an encrypted home,
   * ...), which is the opposite intent of "this run is ephemeral" — tying
   * the skip to `--path` would silently drop an operator's deliberately-
   * relocated agent out of the global index, with only a log line as the
   * signal. A dedicated flag keeps the two questions ("where does the
   * registry file live" vs "should this workspace be globally
   * discoverable") independently answerable, and covers the GitHub-mode /
   * CI-scratch-dir shape `--path`-only gating could never reach (`--path`
   * only exists for `--local`).
   */
  readonly agentsIndex?: boolean;
}

/**
 * Resolve version pins: explicit flags > network-fetched latest > hardcoded fallback.
 * Validates any explicit flag against format pattern.
 */
async function resolveVersions(opts: InitOptions): Promise<VersionPins> {
  if (opts.cliVersion && !isValidSemver(opts.cliVersion)) {
    throw new Error(`--cli-version must be semver (e.g., 0.1.0), got "${opts.cliVersion}"`);
  }
  if (opts.pluginVersion && !isValidSemver(opts.pluginVersion)) {
    throw new Error(`--plugin-version must be semver (e.g., 0.1.0), got "${opts.pluginVersion}"`);
  }
  if (opts.actionsVersion && !isValidActionsRef(opts.actionsVersion)) {
    throw new Error(`--actions-version must be a tag ref (v1, v1.0, v1.0.0), got "${opts.actionsVersion}"`);
  }

  // Skip the network fetch if all three flags are explicitly set
  const allSet = opts.cliVersion && opts.pluginVersion && opts.actionsVersion;
  if (allSet) {
    return {
      cli: opts.cliVersion!,
      plugin: opts.pluginVersion!,
      actions: opts.actionsVersion!,
    };
  }

  let resolved;
  try {
    resolved = await resolveLatestVersions();
    // Print one targeted message per non-ok component so the user sees the
    // actual reason (no release, network down, malformed response) instead
    // of a single vague "network fetch failed".
    const notOk = Object.entries(resolved.sources)
      .filter(([, status]) => status !== 'ok');
    if (notOk.length > 0) {
      process.stderr.write('Warning: using default versions for some components:\n');
      for (const [component, status] of notOk) {
        process.stderr.write(`  - ${statusMessage(component, status)}\n`);
      }
    }
  } catch {
    process.stderr.write(
      'Warning: version resolution failed entirely, using hardcoded fallbacks\n',
    );
    resolved = {
      versions: FALLBACK_VERSIONS,
      sources: {
        cli: 'network_error' as const,
        plugin: 'network_error' as const,
        actions: 'network_error' as const,
      },
    };
  }

  return {
    cli: opts.cliVersion ?? resolved.versions.cli,
    plugin: opts.pluginVersion ?? resolved.versions.plugin,
    actions: opts.actionsVersion ?? resolved.versions.actions,
  };
}

/**
 * Validate fields that end up embedded verbatim in `claude.sh` via a
 * shell double-quoted template literal (`export APP_ID="${appId}"`,
 * etc.). Reject inputs containing characters that would break quoting
 * or trigger shell expansion. Runs before any workspace state is
 * written so bad inputs fail early, not after partial init. (#105)
 *
 * For `--local` (DR-024 / macf#322) the App-cred checks are skipped —
 * the launcher does not export APP_ID / INSTALL_ID / KEY_PATH in local
 * mode, so the values are unused. The project / role / name allowlist
 * still applies.
 */
function validateInitOpts(opts: InitOptions): void {
  if (!isValidProjectName(opts.project)) {
    throw new Error(
      `project "${opts.project}" must match [a-zA-Z0-9_-]+`,
    );
  }
  // role + name are interpolated into claude.sh shell exports the same
  // way project is. Without this check, `--name 'foo"$(evil)'` would
  // produce an injection-vulnerable launcher. Apply the same allowlist
  // as project — per ultrareview finding C2.
  if (!isValidProjectName(opts.role)) {
    throw new Error(
      `role "${opts.role}" must match [a-zA-Z0-9_-]+`,
    );
  }
  if (opts.name !== undefined && !isValidProjectName(opts.name)) {
    throw new Error(
      `name "${opts.name}" must match [a-zA-Z0-9_-]+`,
    );
  }

  if (opts.registryType === 'local') {
    // Local mode: App-cred fields are not used. Validate `registryPath`
    // if set (must be absolute, no shell-special chars — it ends up in
    // claude.sh's MACF_REGISTRY_PATH export and DR-024 specifies
    // absolute paths).
    if (opts.registryPath !== undefined) {
      if (!isAbsolute(opts.registryPath)) {
        throw new Error(
          `--path "${opts.registryPath}" must be an absolute path`,
        );
      }
      if (/["$`\\\n\r]/.test(opts.registryPath)) {
        throw new Error(
          `--path "${opts.registryPath}" contains a shell-unsafe character (", $, backtick, backslash, or newline)`,
        );
      }
    }
    return;
  }

  // GitHub-mode App credentials are required + must be safely-shaped
  // for shell-double-quoted template embedding. Error messages name
  // the field literally so the existing test-suite regex matches
  // (init.test.ts line 184: empty appId → /appId/).
  if (opts.appId === undefined || opts.appId === '') {
    throw new Error('appId is required (--app-id; omit only when using --local)');
  }
  if (opts.installId === undefined || opts.installId === '') {
    throw new Error('installId is required (--install-id; omit only when using --local)');
  }
  // keyPath is OPTIONAL (macf#530): when omitted it defaults to the
  // conventional ~/.macf/keys/<agent>.pem in initAgent. Only its *shape* is
  // validated here (when provided), since it embeds in the double-quoted
  // claude.sh KEY_PATH export.
  if (!/^\d+$/.test(opts.appId)) {
    throw new Error(
      `appId "${opts.appId}" must be numeric (GitHub App IDs are digits only)`,
    );
  }
  if (!/^\d+$/.test(opts.installId)) {
    throw new Error(
      `installId "${opts.installId}" must be numeric (GitHub installation IDs are digits only)`,
    );
  }
  // Shell-dangerous chars inside double-quoted context. `\` escapes in
  // double quotes; include it to avoid any sub-expansion surprise.
  if (opts.keyPath !== undefined && /["$`\\\n\r]/.test(opts.keyPath)) {
    throw new Error(
      `keyPath "${opts.keyPath}" contains a shell-unsafe character (", $, backtick, backslash, or newline)`,
    );
  }
}

/**
 * Default local-registry file path per DR-024:
 * `~/.macf/registry/<project>.json` (operator-overridable via `--path`).
 *
 * Resolves `~` at init time so the on-disk config + claude.sh both carry
 * absolute paths — the launcher can't re-expand `~` after the operator
 * cd's into another repo (cross-repo cwd trap, see coordination.md
 * Token & Git Hygiene §1).
 */
export function defaultLocalRegistryPath(project: string): string {
  return join(homedir(), '.macf', 'registry', `${project}.json`);
}

/**
 * Conventional per-agent App-key destination:
 * `~/.macf/keys/<owner>/<project>/<agent>.pem` (macf#530; project-scoped as
 * of macf#1157; owner-scoped as of macf#1214). Absolute (homedir-rooted) so
 * the token helper resolves it from any cwd — same cross-repo-cwd
 * discipline as the registry path.
 *
 * **Scoped by `owner` since macf#1214** — a fleet's `<project>/<role>`
 * identity is NOT globally unique: one host commonly provisions fleets from
 * DIFFERENT GitHub owners (orgs/users), and two owners can each run a fleet
 * of the same name (e.g. two `macf-trial` fleets, one per owner) with the
 * SAME role set (`code-agent`, `science-agent`, …). Without the owner
 * segment, the project-scoped path alone reintroduces the exact collision
 * macf#1157 fixed for role-only paths, one level up. `owner` is a directory
 * NESTING, not an invented encoding — the filesystem already has the
 * separator `owner/fleet` needs (see macf#1214's ruling comment). It is the
 * SAME account string `bootstrap/fleet-deploy.ts` reads as
 * `manifest.owner.account`; `macf init`'s own equivalent is derived by
 * `ownerAccountFromRegistry` below from whichever registry variant was
 * resolved for this run.
 *
 * **Scoped by `project` since macf#1157** — the pre-#1157 shape was bare
 * `~/.macf/keys/<agent>.pem` (no project/fleet segment), which let two
 * fleets on the SAME host that happen to share a role name (e.g.
 * `code-agent`) collide on ONE on-disk key: whichever fleet deployed second
 * would either overwrite the first fleet's key or (with the fingerprint
 * guard from macf#975 in place) refuse loud, since the on-disk key's
 * identity never matches the second fleet's vault entry. `project` here IS
 * "fleet" in `macf bootstrap`/`macf fleet deploy` terms —
 * `bootstrap/fleet-deploy.ts::deployAgent` passes `manifest.metadata.name`
 * straight through as `InitOptions.project` — so this brings the key path
 * into line with the SAME scoping unit {@link defaultLocalRegistryPath} and
 * `config.ts::caDir` already use for the registry file and the per-project
 * CA (`caDir`'s own doc: "One subdirectory per project prevents collisions
 * when multiple MACF projects share a machine" — the identical rationale,
 * applied here to keys for the first time).
 */
export function defaultAgentKeyPath(owner: string, project: string, agentName: string): string {
  return join(homedir(), '.macf', 'keys', owner, project, `${agentName}.pem`);
}

/**
 * The pre-#1214 project-scoped, OWNER-LESS key path:
 * `~/.macf/keys/<project>/<agent>.pem` — macf#1157's shape, before macf#1214
 * added the `<owner>` segment. Kept as a READ-ONLY back-compat fallback for
 * the SAME reason {@link legacyAgentKeyPath} exists for the shape before
 * it: an operator's pre-#1214 fleet key (deployed under a single-owner host
 * where the collision never had a chance to surface) keeps resolving
 * without a forced migration. Nothing in this codebase ever WRITES here
 * anymore — every fresh materialization lands at the owner-scoped
 * {@link defaultAgentKeyPath}. Exported so `bootstrap/fleet-deploy.ts` can
 * apply the SAME fallback (there, gated on a vault fingerprint match — see
 * that module's `resolveDefaultKeyPath`) as `ingestAndResolveKeyPath` below
 * does for a direct `macf init` run. This is a SEPARATE tier from — and
 * checked BEFORE — the older, flatter {@link legacyAgentKeyPath}: read-old-
 * write-new stacks, it doesn't replace the prior generation's fallback.
 */
export function legacyProjectAgentKeyPath(project: string, agentName: string): string {
  return join(homedir(), '.macf', 'keys', project, `${agentName}.pem`);
}

/**
 * The pre-#1157 FLAT (unscoped) key path: `~/.macf/keys/<agent>.pem` — no
 * project/fleet segment. Kept as a READ-ONLY back-compat fallback (macf#1157
 * "read-old-write-new" decision — see the issue + `defaultAgentKeyPath`'s
 * own doc): an operator's pre-existing single-fleet key at this location
 * keeps resolving without a forced migration. Nothing in this codebase ever
 * WRITES here anymore — every fresh materialization lands at the
 * project-scoped {@link defaultAgentKeyPath}. Exported so
 * `bootstrap/fleet-deploy.ts` can apply the SAME fallback (there, gated on
 * a vault fingerprint match — see that module's `resolveDefaultKeyPath`) as
 * `ingestAndResolveKeyPath` below does for a direct `macf init` run.
 *
 * **NOT the same shape as a project-PREFIXED filename**
 * (`~/.macf/keys/<project>-<agent>.pem`, e.g. `icsoc-2026-code-agent.pem`).
 * That shape is produced by the separate `tools/macf-bootstrap` DR-035
 * operator tool (`bootstrap-emit-commands.sh`'s own `key_path` convention),
 * never by this function or by anything in `packages/macf` — it is
 * out of scope for the macf#1214 owner-scoping fallback chain, which only
 * ever reads paths THIS codebase itself once wrote.
 */
export function legacyAgentKeyPath(agentName: string): string {
  return join(homedir(), '.macf', 'keys', `${agentName}.pem`);
}

/**
 * The GitHub-account namespace this project's registry lives in — the
 * `<owner>` segment {@link defaultAgentKeyPath} needs (macf#1214). Derived
 * from whichever registry variant `initAgent` already resolved for this
 * run, never a separate `--owner` flag — the registry config already
 * carries the account. Mirrors `bootstrap/fleet-deploy.ts`'s
 * `manifest.owner.account` for the `macf fleet deploy`/`macf bootstrap
 * apply` path; this is `macf init`'s own equivalent for a direct,
 * standalone run.
 *
 * `local` registry mode never reaches this function — `initAgent` skips
 * `ingestAndResolveKeyPath` entirely when `regType === 'local'` (no App key
 * to resolve in local-registry mode at all). The throw below exists only
 * to keep the switch exhaustive and to fail loud, never silently return a
 * placeholder, if that invariant is ever broken by a future change.
 */
function ownerAccountFromRegistry(registry: MacfAgentConfig['registry']): string {
  switch (registry.type) {
    case 'org':
      return registry.org;
    case 'profile':
      return registry.user;
    case 'repo':
      return registry.owner;
    case 'local':
      throw new Error('ownerAccountFromRegistry: local registry mode has no owner-account namespace to key on');
  }
}

/**
 * Resolve the destination App-key path and — when `--app-key <src>` is given —
 * INGEST the downloaded private key to it at `0600`. Fails loud at init time:
 *
 *  - `--app-key` pointing at a missing file → throw (operator error, named).
 *  - key absent at the destination after ingestion (no `--app-key`, none
 *    pre-placed) → loud, actionable WARNING — not a throw, because the key may
 *    legitimately be placed out-of-band, but the missing-key state must surface
 *    HERE rather than as a cryptic `gh` 401 later (the macf#530 silent-fallback:
 *    a pointer set without the thing it points to).
 *
 * Idempotent: an existing key at the destination is preserved, never clobbered
 * (key rotation is a deliberate op, not an init side effect).
 *
 * Returns the path to record in `agent_config.github_app.key_path` (the
 * conventional `~/.macf/keys/<owner>/<project>/<agent>.pem` unless
 * `--key-path` overrides, or an older-generation legacy key is found in
 * place — see the macf#1157 / macf#1214 "read-old-write-new" comment inline
 * below).
 */
function ingestAndResolveKeyPath(opts: InitOptions, agentName: string, absDir: string, owner: string): string {
  const conventionalKeyPath = defaultAgentKeyPath(owner, opts.project, agentName);
  // macf#1157 / macf#1214 "read-old-write-new", now TWO legacy tiers deep:
  // when the operator hasn't pinned --key-path AND isn't ingesting FRESH
  // key material (--app-key), fall back to an OLDER-generation path IF a
  // key already lives there — an existing fleet's key keeps resolving with
  // no forced migration, however many generations back it was written.
  // Checked in write-order (newest-legacy first): the pre-#1214 project-
  // scoped, owner-less path, THEN the pre-#1157 flat path. A fresh
  // --app-key ingest NEVER falls back to either: it always lands at the
  // (owner+project-scoped) conventional path, so a brand-new SECOND
  // project/owner reusing a role name never mistakes an unrelated fleet's
  // legacy key for its own (the exact collision #1157 — and, one level up,
  // #1214 — report). There is no vault to fingerprint-check against here,
  // unlike `fleet-deploy.ts`'s `resolveDefaultKeyPath`, so the fresh-ingest
  // case must never even consider either legacy tier — existence alone is
  // the only signal a standalone `macf init` run has.
  const noFreshIngest = opts.appKey === undefined || opts.appKey === '';
  const legacyProjectPath = legacyProjectAgentKeyPath(opts.project, agentName);
  const legacyFlatPath = legacyAgentKeyPath(agentName);
  const canConsiderLegacy = opts.keyPath === undefined && noFreshIngest && !existsSync(conventionalKeyPath);
  const usesLegacyProjectPath = canConsiderLegacy && existsSync(legacyProjectPath);
  const usesLegacyFlatPath = canConsiderLegacy && !usesLegacyProjectPath && existsSync(legacyFlatPath);
  const keyPathForConfig =
    opts.keyPath ?? (usesLegacyProjectPath ? legacyProjectPath : usesLegacyFlatPath ? legacyFlatPath : conventionalKeyPath);
  const destAbs = isAbsolute(keyPathForConfig)
    ? keyPathForConfig
    : resolve(absDir, keyPathForConfig);

  if (opts.appKey !== undefined && opts.appKey !== '') {
    const srcAbs = resolve(opts.appKey);
    if (!existsSync(srcAbs)) {
      throw new Error(
        `--app-key "${opts.appKey}" not found. Download the App private key (.pem) ` +
          `from the GitHub App settings page and pass its path.`,
      );
    }
    if (existsSync(destAbs)) {
      console.log(`  Key: ${destAbs} already exists — preserving (not clobbered by --app-key)`);
    } else {
      mkdirSync(dirname(destAbs), { recursive: true, mode: 0o700 });
      copyFileSync(srcAbs, destAbs);
      chmodSync(destAbs, 0o600);
      console.log(`  Key: ingested App private key → ${destAbs} (chmod 600)`);
    }
  }

  if (!existsSync(destAbs)) {
    console.warn(
      `\n  ⚠ App private key not found at ${destAbs}.\n` +
        `    Pass --app-key <downloaded .pem> to ingest it now, or place the key\n` +
        `    there yourself: cp <downloaded .pem> ${destAbs} && chmod 600 ${destAbs}\n` +
        `    Until then GH_TOKEN minting fails — gh / git push will 401.\n`,
    );
  }

  return keyPathForConfig;
}

/**
 * Local-registry directory perms enforcement per DR-024 §"Filesystem-permission
 * discipline": parent dir is `0700`, CA-key is `0600`. Creates the dir
 * if absent (with `0700` from the start so umask can't widen it). Idempotent —
 * the second agent in the same project finds the dir + chmods it again.
 */
function ensureLocalRegistryDir(registryPath: string): void {
  const dir = dirname(registryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // mkdir's mode is ANDed with umask, so chmod after to guarantee 0700
  // regardless of umask. Same pattern as macf-core's CA dir creation.
  chmodSync(dir, 0o700);
}

/**
 * Local-mode CA file paths (DR-024 §"Cert flow"): co-located with the
 * registry file at `<dir>/<project>.ca.{crt,key}`.
 */
function localCaCertPath(registryPath: string, project: string): string {
  return join(dirname(registryPath), `${project}.ca.crt`);
}

function localCaKeyPath(registryPath: string, project: string): string {
  return join(dirname(registryPath), `${project}.ca.key`);
}

/**
 * Refuse to clobber a HAND-AUTHORED `claude.sh` on a second `macf init`
 * invocation, unless `--force` was passed (#897).
 *
 * `initAgent` unconditionally called `writeClaudeSh` regardless of what was
 * already on disk — a workspace whose `claude.sh` was hand-authored (no
 * macf managed-file header) got silently overwritten by re-running `init`,
 * with no opt-in and no way to decline. This mirrors the exact discriminator
 * `update.ts` already uses to decide preserve-vs-regenerate
 * ({@link hasManagedHeader}) — same sentinel, so a launcher `update`
 * considers hand-authored is treated identically here.
 *
 * Deliberately does NOT gate:
 *   - No existing `claude.sh` (fresh workspace) — nothing to protect.
 *   - An existing `claude.sh` that already carries the managed header — a
 *     normal macf-managed re-init/repair run. This keeps every existing
 *     `macf init` remediation message in this codebase (e.g. `config.ts`'s
 *     legacy-schema warning, `doctor.ts`'s missing-hooks fix line) working
 *     exactly as documented: those scenarios never involve a hand-authored
 *     launcher, so they never hit this refusal.
 *
 * Runs BEFORE any workspace state is written (mirrors `validateInitOpts`'s
 * own "fail before any mkdir/writeFile" contract — see the `init.test.ts`
 * "rejects before writing any workspace state" test) so a refusal never
 * leaves a half-reinitialized workspace behind.
 */
function refuseUnmanagedClaudeShWithoutForce(absDir: string, force: boolean): void {
  if (force) return;
  const claudeShPath = join(absDir, 'claude.sh');
  if (!existsSync(claudeShPath)) return;
  const existing = readFileSync(claudeShPath, 'utf-8');
  if (hasManagedHeader(existing)) return;
  throw new Error(
    `${claudeShPath} exists and is not macf-managed (no managed-file header) — ` +
      `refusing to overwrite a hand-authored launcher. Pass --force to overwrite it anyway.`,
  );
}

/**
 * Set up a project directory for an agent.
 */
export async function initAgent(projectDir: string, opts: InitOptions): Promise<void> {
  validateInitOpts(opts);

  const absDir = resolve(projectDir);
  refuseUnmanagedClaudeShWithoutForce(absDir, opts.force ?? false);
  const macfDir = projectMacfDir(absDir);
  const agentName = opts.name ?? opts.role;

  // Create directory structure
  mkdirSync(join(macfDir, 'certs'), { recursive: true });
  mkdirSync(join(macfDir, 'logs'), { recursive: true });
  mkdirSync(join(macfDir, 'plugin'), { recursive: true });

  // Build registry config
  let registry: MacfAgentConfig['registry'];
  const regType = opts.registryType ?? 'repo';

  // DR-024 §"Migration path": `--migrate-from local-to-local` is a no-op
  // (rename/copy the file directly). Reject loud rather than silently
  // ignore; the operator-error case where someone is targeting `--local`
  // and reaching for migration tooling deserves a clear message.
  if (regType === 'local' && opts.migrateFrom !== undefined) {
    throw new Error(
      '--migrate-from cannot be combined with --local; migration only ' +
        'applies when moving INTO a GitHub-backed registry.',
    );
  }

  switch (regType) {
    case 'org':
      if (!opts.registryOrg) throw new Error('--registry-org required for org registry');
      registry = { type: 'org', org: opts.registryOrg };
      break;
    case 'profile':
      if (!opts.registryUser) throw new Error('--registry-user required for profile registry');
      registry = { type: 'profile', user: opts.registryUser };
      break;
    case 'repo': {
      const repo = opts.registryRepo ?? detectRepoFromGit(absDir);
      if (!repo) throw new Error('--registry-repo required (or run from a git repo with a GitHub remote)');
      const parts = repo.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format: "${repo}". Expected "owner/repo".`);
      }
      registry = { type: 'repo', owner: parts[0], repo: parts[1] };
      break;
    }
    case 'local': {
      const path = opts.registryPath ?? defaultLocalRegistryPath(opts.project);
      if (!isAbsolute(path)) {
        // Defense in depth — `validateInitOpts` already caught this case
        // for explicit --path. The default path is always absolute.
        throw new Error(`local registry path must be absolute (got "${path}")`);
      }
      registry = { type: 'local', path };
      break;
    }
    default:
      throw new Error(`Unknown registry type: "${regType}"`);
  }

  // Resolve version pins (explicit flags > network-fetched latest > fallback)
  const versions = await resolveVersions(opts);

  // Resolve the App-key destination and (when --app-key is given) ingest the
  // downloaded key there at 0600, failing loud on a missing key (macf#530).
  // Local-registry mode mints no token, so it has no key — and has no
  // owner-account namespace either (ownerAccountFromRegistry would throw),
  // which is exactly why it's excluded from this call.
  const githubKeyPath =
    regType === 'local' ? undefined : ingestAndResolveKeyPath(opts, agentName, absDir, ownerAccountFromRegistry(registry));

  // Write agent config. `github_app` is omitted in local-registry mode
  // (DR-024) — the launcher does not mint a token, and the schema marks
  // the field optional to encode that conditional shape.
  const config: MacfAgentConfig = {
    project: opts.project,
    agent_name: agentName,
    agent_role: opts.role,
    ...(opts.routingLabel !== undefined ? { routing_label: opts.routingLabel } : {}),
    agent_type: (opts.type ?? 'permanent') as 'permanent' | 'worker',
    registry,
    ...(regType === 'local'
      ? {}
      : {
          github_app: {
            app_id: opts.appId!,
            install_id: opts.installId!,
            key_path: githubKeyPath!,
          },
        }),
    ...(opts.advertiseHost !== undefined ? { advertise_host: opts.advertiseHost } : {}),
    ...(opts.tmuxSession !== undefined ? { tmux_session: opts.tmuxSession } : {}),
    ...(opts.tmuxWindow !== undefined ? { tmux_window: opts.tmuxWindow } : {}),
    versions,
  };

  writeAgentConfig(absDir, config);

  // Resolve + write `github_app.bot_login` (DR-028 / macf#535 / macf#707) —
  // the App slug + `[bot]`, the AUTHORITATIVE identity the shipped
  // `check-gh-attribution.sh` PostToolUse hook compares against. Independent
  // of `agent_name` by construction (AC #3): this block never reads or
  // derives from `agent_name`, so it cannot ripple into the OTEL
  // `gen_ai.agent.name` / cert-CN identity surface.
  //
  // Best-effort + non-fatal, same posture as the plugin-fetch block below —
  // a fresh App installation's JWT-mint can legitimately fail (key not yet
  // ingested, App ID typo, no network at init time) and none of that should
  // abort an otherwise-successful `macf init`. `macf doctor --fix` repairs
  // this later once the App/key are reachable.
  if (config.github_app) {
    try {
      const source = tokenSourceFromConfig(absDir, config);
      const slug = await fetchAppSlug(source.appId, source.keyPath);
      const botLogin = deriveBotLogin(slug);
      const updatedConfig: MacfAgentConfig = {
        ...config,
        github_app: { ...config.github_app, bot_login: botLogin },
      };
      writeAgentConfig(absDir, updatedConfig);
      console.log(`  Attribution: resolved github_app.bot_login = ${botLogin}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: could not resolve App slug for bot_login: ${msg}`);
      console.warn('    The attribution hook will fall back to a non-authoritative agent_name');
      console.warn('    guess until this is repaired — run `macf doctor --fix` once');
      console.warn('    the App/key are reachable.');
    }
  }

  // Generate per-concern env files BEFORE the launcher so claude.sh's
  // source-loop on `.claude/.macf/env.*` finds them on first invocation
  // (macf#342 PR-B). The thin claude.sh template depends on these files
  // existing — without them, identity / GitHub / certs / registry /
  // telemetry / tmux env exports are all silently absent.
  const envFilesResult = writeEnvFiles(absDir, config);
  console.log(`  Env: wrote ${envFilesResult.written.length} env file(s) to .claude/.macf/`);
  // Tell the operator what was preserved, not just what was written — a
  // silently-skipped write is a hazard of its own (macf#1105's lesson: an
  // action nobody was shown is one nobody can verify). Only fires on a
  // re-init that finds pre-existing operator-managed files (env.telemetry /
  // env.tmux / env.project-rules); a fresh workspace has nothing to skip.
  if (envFilesResult.skipped.length > 0) {
    const preservedNames = envFilesResult.skipped.map((p) => basename(p)).join(', ');
    console.log(
      `  Env: preserved ${envFilesResult.skipped.length} existing operator-managed file(s): ${preservedNames}`,
    );
  }

  // Host-toolchain bootstrap (DR-031 piece 4). Detect the toolchain backend
  // (devbox / brew / none) on the host and write .claude/.macf/host-prelude.sh,
  // which claude.sh sources FIRST so a minimal-env launch (cron, restart-self
  // relauncher, container entrypoint) re-establishes the toolchain rather than
  // inheriting the operator login-shell PATH.
  writeHostPrelude(absDir);
  console.log(`  Host prelude: wrote .claude/.macf/host-prelude.sh (toolchain bootstrap)`);

  // Generate claude.sh launcher.
  const claudeShPath = writeClaudeSh(absDir, config);

  // Add .macf/ to .gitignore
  updateGitignore(absDir);

  // Register in global index (macf#1135). `addToAgentsIndex` writes to
  // ~/.macf/agents.json unconditionally — a location this function has
  // never derived from `absDir`/`--dir`, in EITHER registry mode. Two
  // independent problems, two independent fixes below:
  //
  //  1. WHICH runs get indexed. `opts.agentsIndex === false`
  //     (`--no-agents-index`) is an explicit, mode-independent opt-out for
  //     a scoped/ephemeral run that should not become globally
  //     discoverable via `macf status`/`macf peers`/`macf list` on this
  //     host — release.sh's cmd_harness_check is exactly this shape: a
  //     scratch, throwaway workspace materialized to validate generator
  //     output. Skipping is never silent — see the console.log below.
  //     Two alternatives considered and rejected:
  //       - Tying the skip to the local-registry `--path` flag instead of
  //         a dedicated flag. Rejected: `--path`'s own documented purpose
  //         is PERMANENT relocation of the registry file (a separate
  //         disk, an encrypted home, ...) — the OPPOSITE intent of "this
  //         run is ephemeral". Coupling the two would silently drop an
  //         operator's deliberately-relocated `--local` agent out of the
  //         global index. It would also only ever cover `--local`
  //         invocations, leaving a GitHub-mode CI/scratch-dir `macf init`
  //         (repo/org/profile registry, no `--path` involved at all)
  //         exposed to the exact same bug this fix closes.
  //       - "Write the index entry under the target path." Rejected:
  //         every reader (`readAgentsIndex`/`loadAllAgents`, which drive
  //         `macf status`/`macf peers`/`macf list`) only ever reads the
  //         ONE global path, so a per-workspace copy would never be read
  //         by anything — not a redirect, a silent no-op with extra steps.
  //     An ordinary run — `agentsIndex` unset/`true`, the default for
  //     every existing caller — is UNCHANGED: it still registers, exactly
  //     as before this fix.
  //  2. WHAT HAPPENS when the write itself fails (e.g. EROFS on a read-only
  //     $HOME). The global index is a cross-project discovery convenience —
  //     nothing about THIS workspace's own operation (its cert, its
  //     claude.sh, its .claude/settings.json written below) depends on it.
  //     A write failure here is therefore NOT fatal to `init`'s purpose:
  //     caught, reported, and init proceeds. Before this fix the call was
  //     unguarded, so an EROFS here aborted init before `.claude/settings.json`
  //     (or anything written after this line) ever landed — the visible
  //     symptom was "settings file missing", not "could not write your
  //     home directory".
  if (opts.agentsIndex === false) {
    console.log(
      '  Index: skipped the global agents index (--no-agents-index) — ' +
        'this run is scoped/ephemeral. Omit the flag to register this ' +
        'workspace normally.',
    );
  } else {
    try {
      addToAgentsIndex(absDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: could not update the global agents index: ${msg}`);
      console.warn(
        `    ${absDir} is still fully initialized; ` +
          '`macf status`/`macf peers`/`macf list` will not discover it ' +
          'automatically until this is resolved.',
      );
    }
  }

  // Copy canonical coordination rules into <workspace>/.claude/rules/
  // (single source of truth shipped with the CLI; refreshed by `macf update`)
  const copiedRules = copyCanonicalRules(absDir);
  if (copiedRules.length > 0) {
    console.log(`  Rules: copied ${copiedRules.length} canonical rule file(s) to .claude/rules/`);
  }

  // Seed the project-tier rule subdir (.claude/rules/project/) with a generic,
  // format-demonstrating `.example` template (DR-026 §3 / F3, macf#501). Init
  // ships to EVERY deployment, so the seed is deployment-agnostic — it never
  // contains a macf-specific rule. The actual project rules arrive on
  // `macf update` / `macf rules refresh` from MACF_PROJECT_RULES_SOURCE
  // (env.project-rules), which init does NOT fetch (keeps init offline-safe +
  // generic).
  const seeded = seedProjectRulesDir(absDir);
  console.log(`  Rules: seeded project-tier example to .claude/rules/project/${seeded}`);

  // Copy canonical helper scripts (e.g., tmux-send-to-claude.sh) into
  // <workspace>/.claude/scripts/. Hooks in settings.local.json.example
  // call these by relative path.
  const copiedScripts = copyCanonicalScripts(absDir);
  if (copiedScripts.length > 0) {
    console.log(`  Scripts: copied ${copiedScripts.length} helper script(s) to .claude/scripts/`);
  }

  // Seed the interactive-prompt auto-responder allowlist
  // (.claude/.macf/prompt-responses.json, DR-033 / macf#645) with the two
  // canonical ceremony-ack entries. Seed-if-absent + never clobber: the config
  // is operator-curated state, so re-running init/update only validates an
  // existing file (loud Inv-2 feedback), never reverts operator edits. The
  // watcher (macf-prompt-watcher.sh, just copied above) reads it at launch.
  reportSeedPromptResponses(seedPromptResponsesConfig(absDir));

  // Seed the stall-signature allowlist (.claude/.macf/stall-signatures.json,
  // DR-037 / macf#686) — the config `macf fleet resume` matches an idle agent's
  // pane against. Seed-if-absent + never clobber (same operator-curated posture
  // as prompt-responses): signature strings are best-effort across Claude Code
  // versions, so re-running init/update only validates an existing file.
  reportSeedStallSignatures(seedStallSignaturesConfig(absDir));

  // Install the attribution-trap PreToolUse hook entry in
  // .claude/settings.json (merge-preserving). Per #140, structurally
  // blocks gh / git push calls when GH_TOKEN isn't a ghs_ bot token —
  // behavioral controls recurred the trap 5 times in a single day.
  installGhTokenHook(absDir);
  console.log(`  Hooks: installed gh-token guard in .claude/settings.json`);

  // Install the canonical role-aware SessionStart work-pickup hook
  // (merge-preserving). Per DR-026/macf#768, delegates the pending-issue
  // query to the plugin's own `issues` command and auto-submits a
  // follow-up prompt for auto-resuming roles — written for every role;
  // the auditor's default-OFF gate is enforced by the script at runtime.
  installStartupPickupHook(absDir);
  console.log(`  Hooks: installed SessionStart work-pickup hook in .claude/settings.json`);

  // Pre-approve the 4 macf-agent plugin skills so first-turn
  // invocations (/macf-status, /macf-issues, etc.) don't block on
  // interactive approval dialogs — essential for SessionStart
  // auto-pickup + general agent autonomy. Operator opted into the
  // plugin deliberately via `macf init`; trusting its own skills is
  // a safe default. Non-macf permissions.allow entries preserved.
  // See macf#189 sub-item 2.
  installPluginSkillPermissions(absDir);
  console.log(`  Permissions: pre-approved macf-agent plugin skills`);

  // Add `/proc/self/fd/**` to sandbox.filesystem.allowRead so Claude
  // Code's Bash-tool harness can pass command-input fds to spawned
  // shells without hitting zsh permission-denied. Every MACF agent
  // pre-#200 silently failed every Bash call; this fixes on init.
  installSandboxFdAllowRead(absDir);
  console.log(`  Sandbox: allowRead for /proc/self/fd/** installed`);

  // Install the canonical `sandbox.excludedCommands` set so dev-loop
  // commands (grep, find, bash, etc.) run unsandboxed and don't hit
  // the claude-code#43454 seccomp regression at zsh-init. Operator-
  // authored entries are preserved; opt-out via
  // MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP=1. See macf#211.
  installSandboxExcludedCommands(absDir);
  console.log(`  Sandbox: excludedCommands canonical set installed`);

  // Fetch the macf-agent plugin at the pinned version and place it at
  // .macf/plugin/ so claude.sh can use --plugin-dir (per DR-013).
  // Network failures here don't abort init — the workspace is usable
  // without the plugin (degrades to rules-only mode), and the user can
  // re-try with `macf update` once connectivity is back.
  try {
    fetchPluginToWorkspace(absDir, versions.plugin);
    // Strip mcpServers from the fetched local plugin.json copy (DR-022
    // Amendment P, groundnuty/macf#995) — the channel-server no longer
    // mounts via the plugin; it mounts as a project .mcp.json server below.
    // Leaving mcpServers here would let Claude Code spawn a SECOND
    // channel-server child from the plugin mount, under a tool namespace
    // nothing pre-approves. MUST run after the fetch (a re-clone would
    // otherwise reintroduce the block). `init` always fetches, so this is
    // unconditionally reached here — unlike `macf update`'s equivalent
    // convergence call (macf#1005), there's no no-fetch path to worry about.
    const stripResult = stripPluginMcpServers(absDir);
    if (stripResult.status === 'refused') {
      // Loud-refuse rather than silently leaving mcpServers in place
      // (silent-fallback-hazards.md) — defensive surface only: a manifest
      // we JUST fetched should always be valid JSON, but a parse failure
      // here must never look like a quiet no-op (macf#1005).
      console.warn(`  Warning: mcpServers not stripped: ${stripResult.reason}`);
    }
    // Deliver the built plugin-CLI by linking .macf/plugin/dist → the running
    // CLI's own dist/ (groundnuty/macf#676). The marketplace plugin ships no
    // dist/, so without this the /macf-* skills fail MODULE_NOT_FOUND. MUST run
    // after the fetch (a re-clone wipes the dir).
    const linkedDist = linkPluginCliDist(absDir);
    console.log(
      `  Plugin: fetched macf-agent@v${versions.plugin} to .macf/plugin/ ` +
      `(mcpServers ${stripResult.status === 'stripped' ? 'stripped' : 'already absent'}` +
      `${linkedDist ? '; plugin-CLI dist linked' : ''})`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: plugin fetch failed: ${msg}`);
    console.warn(`  You can retry later with \`macf update\` once the issue is resolved.`);
  }

  // Write <workspace>/.mcp.json with the channel-server as a project MCP
  // server (DR-022 Amendment P, groundnuty/macf#995) — the mount the
  // launcher's `--dangerously-load-development-channels server:macf-agent`
  // flag (channelNotificationsLines in claude-sh.ts, macf#632) actually
  // resolves against. cs version = versions.cli (monorepo lockstep,
  // groundnuty/macf#421 — never a bare, unpinned npx spec).
  const mcpJsonResult = writeMcpJsonChannelServer(absDir, config, versions.cli);
  if (mcpJsonResult.status === 'refused') {
    console.warn(`  Warning: .mcp.json not written: ${mcpJsonResult.reason}`);
  } else {
    console.log(`  MCP: wrote .mcp.json (macf-agent channel-server, pinned @${versions.cli})`);
  }

  // Generate agent cert. Local-registry mode (DR-024) auto-generates a
  // CA on first invocation; subsequent agents in the same project read
  // the existing CA. GitHub mode reads the per-project CA generated by
  // `macf certs init`.
  if (regType === 'local' && registry.type === 'local') {
    await initLocalModeCertsAndRegistry(absDir, registry.path, opts, agentName);
    console.log(`Agent "${agentName}" initialized in ${absDir} (local-registry mode)`);
    console.log(`  Config: ${join(macfDir, 'macf-agent.json')}`);
    console.log(`  Cert:   ${agentCertPath(absDir)}`);
    console.log(`  Launcher: ${claudeShPath}`);
    console.log(`  Registry: ${registry.path}`);
    return;
  }

  // GitHub-mode cert flow — the ONLY place in this codebase that issues an
  // agent's own mTLS leaf cert for a GitHub-backed registry (macf#1000; see
  // {@link issueGithubModeAgentCert}'s own doc).
  await issueGithubModeAgentCert(absDir, macfDir, agentName, claudeShPath, opts);

  // GitHub-mode migration: read agent records from a local-registry
  // JSON file and write each into the new GitHub-backed registry.
  // Runs AFTER agent cert is in place so the new agent can authenticate
  // immediately. Failure is non-fatal — operator can re-run `migrateFrom`
  // on a working install (init bootstrapping their own agent must
  // succeed regardless). DR-024 §"Migration path".
  if (opts.migrateFrom !== undefined) {
    try {
      await migrateLocalToGitHub(absDir, opts.migrateFrom, registry, opts.project);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  Warning: migration from "${opts.migrateFrom}" failed: ${msg}`);
      console.warn(`  Re-run with \`macf init --migrate-from <path>\` after fixing the source.`);
    }
  }
}

/**
 * `initAgent`'s GitHub-mode agent leaf-cert flow — the ONLY place in this
 * codebase that calls `generateAgentCert` for an agent's own mTLS leaf cert
 * against a GitHub-backed registry (macf#1000). Reads the per-project CA
 * from the conventional, non-injectable path (`caCertPathFor(opts.project)`/
 * `caKeyPathFor(opts.project)` — GitHub mode has no path-override seam; a
 * `fleet deploy` caller materializes the CA at that SAME conventional path
 * BEFORE calling `initAgent` — see `bootstrap/fleet-deploy.ts`'s module doc
 * for why the two must agree on one un-overridden location).
 *
 * **`opts.skipCertIfPresent` (macf#1000) is existence-only.** When `true`
 * AND a cert+key pair is ALREADY at the destination, this function returns
 * without touching either file — it does NOT verify the existing cert is
 * still signed by the CURRENT CA. A stale cert left over from a previous CA
 * is reported the same as a valid one (`'already present — not re-issued'`)
 * and is left in place; chain-validating an existing cert against the
 * current CA is a separate concern, not implemented here. This is UNCHANGED
 * from the pre-#1000 duplicate call site's own contract (`fleet-deploy.ts`'s
 * removed `issueAgentCertIfNeeded` was equally existence-only), so it is not
 * a regression — just a residual worth naming rather than assuming away.
 *
 * Defaults to `skipCertIfPresent` falsy — unconditional reissue whenever a
 * CA is present, which is the historical `macf init` contract and MUST stay
 * unchanged for direct callers (macf#1000 AC "no behaviour change for
 * `macf init` used directly"); only `fleet deploy` passes `true`.
 */
async function issueGithubModeAgentCert(
  absDir: string,
  macfDir: string,
  agentName: string,
  claudeShPath: string,
  opts: Pick<InitOptions, 'project' | 'routingLabel' | 'advertiseHost' | 'skipCertIfPresent'>,
): Promise<void> {
  const caCertFile = caCertPathFor(opts.project);
  const caKeyFile = caKeyPathFor(opts.project);
  if (!(existsSync(caCertFile) && existsSync(caKeyFile))) {
    console.log(`Agent "${agentName}" initialized in ${absDir}`);
    console.log(`  Config: ${join(macfDir, 'macf-agent.json')}`);
    console.log(`  Launcher: ${claudeShPath}`);
    console.log(`\n  No CA found locally. To generate agent cert:`);
    console.log(`    macf certs init     (if first agent — creates CA)`);
    console.log(`    macf certs rotate   (if CA already exists)`);
    return;
  }

  const certDest = agentCertPath(absDir);
  const keyDest = agentKeyPath(absDir);
  if (opts.skipCertIfPresent === true && existsSync(certDest) && existsSync(keyDest)) {
    console.log(`Agent "${agentName}" initialized in ${absDir}`);
    console.log(`  Config: ${join(macfDir, 'macf-agent.json')}`);
    console.log(`  Cert:   ${certDest} (already present — not re-issued)`);
    console.log(`  Launcher: ${claudeShPath}`);
    return;
  }

  try {
    const ca = loadCA(caCertFile, caKeyFile);
    await generateAgentCert({
      // macf#545: cert CN = the routing identity (defaults to agentName), so
      // mTLS validates the CN against the registry slot the router resolved.
      agentName: opts.routingLabel ?? agentName,
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      ...(opts.advertiseHost !== undefined ? { advertiseHost: opts.advertiseHost } : {}),
      certPath: certDest,
      keyPath: keyDest,
    });
    console.log(`Agent "${agentName}" initialized in ${absDir}`);
    console.log(`  Config: ${join(macfDir, 'macf-agent.json')}`);
    console.log(`  Cert:   ${certDest}`);
    console.log(`  Launcher: ${claudeShPath}`);
  } catch (err) {
    console.warn(`  Warning: cert generation failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`Agent "${agentName}" initialized in ${absDir} (no cert — run macf certs rotate)`);
  }
}

/**
 * Local-registry mode (DR-024) cert + registry-dir bootstrap. Idempotent —
 * a second agent in the same project finds the existing CA and signs
 * its cert against it; no re-initialization or re-prompting.
 *
 * The CA lives next to the registry file at
 * `<registry-dir>/<project>.ca.{crt,key}` per DR-024 §"Cert flow":
 * the operator's filesystem ownership of the registry directory IS the
 * trust proof. No `/sign` round-trip; no GitHub-mediated identity.
 */
async function initLocalModeCertsAndRegistry(
  workspaceDir: string,
  registryPath: string,
  opts: InitOptions,
  agentName: string,
): Promise<void> {
  ensureLocalRegistryDir(registryPath);

  const caCertFile = localCaCertPath(registryPath, opts.project);
  const caKeyFile = localCaKeyPath(registryPath, opts.project);

  let caCertPem: string;
  let caKeyPem: string;

  if (existsSync(caCertFile) && existsSync(caKeyFile)) {
    // Second-or-later agent in this project — read the shared CA. The
    // diagnostic is on stderr (matches CA-key-fallback diagnostics in
    // macf-core/config.ts) so operators see which path was taken
    // without parsing structured output.
    process.stderr.write(
      `  Local registry: reusing existing CA at ${caCertFile}\n`,
    );
    const ca = loadCA(caCertFile, caKeyFile);
    caCertPem = ca.certPem;
    caKeyPem = ca.keyPem;
  } else {
    // First agent in this project — generate CA. Skip `client` (no
    // GitHub variables backend in local mode); CA cert lives only on
    // disk. DR-024 §"Cert flow" first-agent flow.
    process.stderr.write(
      `  Local registry: generating new CA at ${caCertFile}\n`,
    );
    const created = await createCA({
      project: opts.project,
      certPath: caCertFile,
      keyPath: caKeyFile,
    });
    caCertPem = created.certPem;
    caKeyPem = created.keyPem;
  }

  // Lock down the CA-key file mode regardless of which path was taken.
  // `createCA` already writes 0600 but a second-agent path through
  // `loadCA` doesn't re-chmod; chmoding here is idempotent + cheap.
  if (process.platform !== 'win32') {
    chmodSync(caKeyFile, 0o600);
  }

  // Generate this agent's cert against the (new or existing) CA.
  await generateAgentCert({
    // macf#545: cert CN = the routing identity (defaults to agentName).
    agentName: opts.routingLabel ?? agentName,
    caCertPem,
    caKeyPem,
    ...(opts.advertiseHost !== undefined ? { advertiseHost: opts.advertiseHost } : {}),
    certPath: agentCertPath(workspaceDir),
    keyPath: agentKeyPath(workspaceDir),
  });
}

function updateGitignore(projectDir: string): void {
  const gitignorePath = join(projectDir, '.gitignore');
  const entry = '.macf/';

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.includes(entry)) {
      appendFileSync(gitignorePath, `\n# MACF agent data\n${entry}\n`);
    }
  } else {
    writeFileSync(gitignorePath, `# MACF agent data\n${entry}\n`);
  }
}

/**
 * Detect owner/repo from git remote. Uses execFileSync (safe — no shell injection).
 */
function detectRepoFromGit(dir: string): string | null {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
    if (match) return `${match[1]}/${match[2]}`;
    return null;
  } catch {
    return null;
  }
}
