/**
 * macf update: dual-purpose command (template-sync + version-bump).
 *
 * Two distinct things happen on every invocation:
 *
 * 1. **Always-on template sync** — refreshes canonical assets from the
 *    INSTALLED CLI BINARY's bundled templates, regardless of any flag
 *    selection. Independent of `versions.cli` / `versions.plugin` /
 *    `versions.actions` in macf-agent.json. Files refreshed:
 *    - `.claude/scripts/`         (canonical helper scripts; #61, #140)
 *    - `.claude/rules/`           (coordination.md + other rules)
 *    - `.claude/settings.json`    (gh-token PreToolUse hook + plugin-skill
 *                                   permissions + sandbox.allowRead +
 *                                   sandbox.excludedCommands; merge-preserving)
 *    - `claude.sh`                (regenerated from current launcher
 *                                   template; #63 — landing template-
 *                                   evolution changes like #60's
 *                                   `--plugin-dir` or #516's monitoring-VM
 *                                   OTLP endpoint (the dedicated VM over
 *                                   Tailscale, OTel-native ports, no +10000
 *                                   offset) without re-running init)
 *    - `.macf/plugin/`            (repair-fetch only, if dir is empty;
 *                                   pin-bump fetch handled separately)
 *
 *    `.claude/rules/` + `.claude/scripts/` specifically are guarded by
 *    `copyCanonicalAssetsGuarded` / `checkCanonicalOverwriteSafety` (#1386,
 *    shared with `init` + `rules refresh` as of #1401): when the installed
 *    CLI's own checkout is behind its canonical branch AND that would
 *    overwrite an existing workspace file with different (older) content,
 *    the copy is REFUSED (loud, non-fatal to the rest of this run) instead
 *    of silently reverting it. `--force` overrides.
 *
 * 2. **Flag-gated version bumps** — `--cli` / `--plugin` / `--actions`
 *    select which version pins in macf-agent.json get bumped to latest;
 *    `--all` selects all three; `--yes` auto-accepts. `--plugin` bump
 *    additionally triggers a fresh `.macf/plugin/` fetch at the new
 *    version.
 *
 * Implication for downstream consumers + reproducible bootstrap (e.g.
 * cv-e2e-test, harness pinning per macf#291): the CLI BINARY'S
 * installed version determines what claude.sh template lands. Operators
 * pinning via `npx -y @groundnuty/macf@<version> update` get a
 * reproducible binary version + therefore a reproducible template.
 * Operators using bare `macf update` get whatever brew/system has —
 * which may pre-date a recent canonical fix (e.g. PR #283).
 *
 * Replaces the earlier plugin-update placeholder (P4). With PR #4 adding
 * version pins, this command is the canonical bumper.
 */
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAgentConfig, writeAgentConfig, tokenSourceFromConfig, resolveCanonicalBranch } from '../config.js';
import { resolveLatestVersions } from '../version-resolver.js';
import { findCliPackageRoot } from '../rules.js';
import { copyCanonicalAssetsGuarded } from '../canonical-overwrite-guard.js';
import { fetchProjectRules, PROJECT_RULES_SOURCE_ENV } from '../project-rules.js';
import { reportSeedPromptResponses, seedPromptResponsesConfig } from '../prompt-responses.js';
import { reportSeedStallSignatures, seedStallSignaturesConfig } from '../stall-signatures.js';
import { installGhTokenHook, installStartupPickupHook, installPluginSkillPermissions, installSandboxFdAllowRead, installSandboxExcludedCommands } from '../settings-writer.js';
import { detectStaleDist, detectUnknownFreshness } from '../build-info.js';
import {
  fetchPluginToWorkspace, workspacePluginDir, stripPluginMcpServers, linkPluginCliDist,
} from '../plugin-fetcher.js';
import { writeMcpJsonChannelServer, readMcpJsonChannelServerVersion } from '../mcp-json.js';
import { resolvePluginUpdateTarget } from '../plugin-hook-resolver.js';
import { writeClaudeSh, hasManagedHeader } from '../claude-sh.js';
import { writeHostPrelude } from '../host-prelude.js';
import {
  refreshEnvFiles,
  migrateMonolithicClaudeSh,
  detectSettingsLocalEnvKeys,
  formatDeprecationWarning,
} from '../env-files-update.js';
import { createClientFromConfig } from '../registry-helper.js';
import { generateToken } from '@groundnuty/macf-core';
import { promptPassword, PromptCancelled } from '../prompt.js';
import { migrateCaKeyToV2, formatMigrationResult } from './migrate-ca-key.js';
import type { VersionPins } from '../config.js';
import type { ResolvedVersions } from '../version-resolver.js';

export interface UpdateOptions {
  readonly all: boolean;
  readonly cli: boolean;
  readonly plugin: boolean;
  readonly actions: boolean;
  readonly yes: boolean;
  readonly dryRun: boolean;
  /**
   * Explicit opt-in to the unified preview-then-prompt-then-execute flow
   * (macf#334). Equivalent to bare `macf update` since the unified flow is
   * the default for non-`--yes` / non-`--dry-run` invocations; the flag
   * exists as an explicit-intent declaration for scripted workflows.
   * `--yes` still wins (bypass).
   */
  readonly confirm?: boolean;
  /**
   * Skip the monolithic→multi-file claude.sh migration AND the
   * env-file refresh step (macf#342 PR-C). Operator opt-out for
   * workspaces that intentionally keep the pre-#342 monolithic
   * launcher (e.g., an out-of-tree fork that has hand-edited
   * claude.sh and doesn't want it auto-rewritten). Migration is
   * normally auto-detection-gated; this flag is a hard skip.
   *
   * Note: skipping does NOT roll back a workspace already migrated.
   * The opt-out is for the migration step only; once the thin
   * template + env files are on disk, they keep being the source
   * of truth. To revert, the operator restores their pre-#342
   * claude.sh from git (or runs `macf init --force`).
   */
  readonly noMigrateEnvFiles?: boolean;
  /**
   * Deliberate opt-in to overwrite canonical rules/scripts even when the
   * installed CLI's own checkout is behind its canonical branch and doing
   * so would revert an existing workspace file to older content
   * (groundnuty/macf#1386). Without this flag, that specific overwrite is
   * refused (loud, non-fatal to the rest of `update()`) rather than
   * silently reverting a file a fresher source had already refreshed.
   */
  readonly force?: boolean;
}

type Component = 'cli' | 'plugin' | 'actions';
const ALL_COMPONENTS: readonly Component[] = ['cli', 'plugin', 'actions'];

function prompt(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

interface DiffRow {
  readonly component: Component;
  readonly current: string;
  readonly latest: string;
  // Mirror the FetchStatus variants for non-ok paths so operators
  // see the actual reason (not yet published vs network down vs
  // malformed response) — not_published was noise for normal
  // pre-release state when conflated with fetch_failed (#111 C2).
  readonly status: 'update' | 'same' | 'not_published' | 'network_error' | 'rate_limited' | 'invalid_response';
}

export function buildDiff(
  current: VersionPins,
  resolved: ResolvedVersions,
): readonly DiffRow[] {
  return ALL_COMPONENTS.map(component => {
    const cur = current[component];
    const lat = resolved.versions[component];
    const source = resolved.sources[component];
    if (source !== 'ok') {
      return { component, current: cur, latest: lat, status: source };
    }
    return {
      component,
      current: cur,
      latest: lat,
      status: cur === lat ? ('same' as const) : ('update' as const),
    };
  });
}

/**
 * Does the .macf/plugin/ dir need a re-fetch? True if the dir doesn't
 * exist OR exists but is empty. `existsSync` alone returns true for an
 * empty dir, which misses the repair case (e.g. workspaces init'd before
 * #60 merged where the directory was created but never populated).
 */
function pluginDirNeedsRepair(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).length === 0;
}

/**
 * Strip mcpServers from the MOUNTED plugin manifest + report the outcome
 * (DR-022 Amendment P, groundnuty/macf#995, fixed groundnuty/macf#1005).
 *
 * Call this UNCONDITIONALLY, independent of whether a fetch happened this
 * invocation — #995's original wiring only called `stripPluginMcpServers`
 * immediately after `fetchPluginToWorkspace`, which is correct for "a fetch
 * always reintroduces the key" but blind to the far more common steady
 * state: a workspace already at the pinned plugin version never re-fetches,
 * so the strip never ran and the old plugin mount survived indefinitely
 * (macf#1005). `stripPluginMcpServers` is a cheap, idempotent, local
 * read-modify-write — safe to call on every invocation regardless of fetch
 * state; it silently no-ops when there's nothing to strip.
 *
 * Reports (console.log) only when the file actually changed, so an
 * already-converged workspace stays quiet on repeat runs. A malformed
 * manifest refuses loudly (console.warn, same posture as the sibling
 * `.mcp.json` write-refusal a few lines below) and writes nothing —
 * silent-fallback-hazards.md is this repo's most-catalogued defect class.
 */
function reportPluginMcpServersStrip(projectDir: string, targetDir: string): void {
  const result = stripPluginMcpServers(projectDir, { targetDir });
  if (result.status === 'stripped') {
    console.log(`Stripped mcpServers from ${result.path}`);
  } else if (result.status === 'refused') {
    console.warn(`Warning: mcpServers not stripped from ${result.path}: ${result.reason}`);
  }
}

function formatRow(row: DiffRow): string {
  const name = row.component.padEnd(10);
  const cur = row.current.padEnd(10);
  const lat = row.latest.padEnd(10);
  let statusText: string;
  switch (row.status) {
    case 'update': statusText = '⬆ update available'; break;
    case 'same': statusText = '✓ up to date'; break;
    // Distinct messages for each failure mode so operators don't
    // chase phantom network issues when the component simply hasn't
    // been published yet (#111 C2).
    case 'not_published': statusText = '· not yet published (using cached)'; break;
    case 'network_error': statusText = '? fetch failed (network) — using cached'; break;
    case 'rate_limited': statusText = '? rate-limited (set GH_TOKEN to raise anon 60 req/h) — using cached'; break;
    case 'invalid_response': statusText = '? unexpected response — using cached'; break;
  }
  return `${name}  ${cur}  ${lat}  ${statusText}`;
}

export function renderDiff(diff: readonly DiffRow[]): string {
  const lines: string[] = [];
  lines.push('Component   Current     Latest      Status');
  lines.push('----------  ----------  ----------  --------');
  for (const row of diff) lines.push(formatRow(row));
  return lines.join('\n');
}

function selectedComponents(opts: UpdateOptions): readonly Component[] {
  if (opts.all) return ALL_COMPONENTS;
  const selected: Component[] = [];
  if (opts.cli) selected.push('cli');
  if (opts.plugin) selected.push('plugin');
  if (opts.actions) selected.push('actions');
  return selected;
}

/**
 * Print the unified preview of pending bumps + ask a single Proceed?
 * prompt (macf#334). Replaces the pre-#334 per-candidate prompt loop —
 * operators wanted "show all, then yes-to-all" instead of being asked
 * y/N for each component in sequence.
 *
 * Returns `true` on `y`/`yes` (case-insensitive); `false` on anything
 * else (including blank input, matching the `[y/N]` default).
 */
async function confirmPlan(rows: readonly DiffRow[]): Promise<boolean> {
  console.log('This run will bump:');
  for (const row of rows) {
    console.log(`  ⬆ ${row.component}: ${row.current} → ${row.latest}`);
  }
  console.log('');
  const answer = await prompt('Proceed? [y/N]: ');
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

/**
 * Main entry. Returns exit code (0 success/noop, 1 failure).
 */
export async function update(
  projectDir: string,
  opts: UpdateOptions,
): Promise<number> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return 1;
  }

  // Stale-dist detection (#144): warn if the installed CLI's dist/ is
  // behind the source repo's current HEAD, so operators catch silent
  // no-op behavior before it bites them. Never blocks the update run.
  const cliPackageRoot = findCliPackageRoot();
  const stale = detectStaleDist(cliPackageRoot);
  if (stale) {
    console.warn(
      `Warning: the installed macf CLI dist/ is stale.\n` +
        `  built from: ${stale.buildCommit.slice(0, 7)} (at ${stale.builtAt})\n` +
        `  source HEAD: ${stale.currentCommit.slice(0, 7)}\n` +
        `  Features merged after ${stale.buildCommit.slice(0, 7)} will not apply.\n` +
        `  Fix: run \`macf self-update\` (or \`cd ${cliPackageRoot} && npm run build\`).\n` +
        `  Note: stale-dist detection only fires for CLI versions >= 0.1.1.\n`,
    );
  } else {
    const unknown = detectUnknownFreshness(cliPackageRoot);
    if (unknown) {
      console.warn(
        `Warning: cannot verify macf CLI dist/ freshness ` +
          `(reason: ${unknown.reason}).\n` +
          `  dist/.build-info.json is missing or incomplete — likely built via ` +
          `\`npx tsc\` directly, skipping the canonical build path.\n` +
          `  Fix: run \`cd ${cliPackageRoot} && npm run build\` to stamp build-info.\n`,
      );
    }
  }

  // Refresh canonical assets (coordination rules + helper scripts) on
  // every `macf update`, regardless of version-pin state. These are tied
  // to the installed CLI binary, not to `versions.cli` in the config —
  // so a newer CLI version always wins, even when pins are unchanged.
  // Running before any short-circuit also repairs workspaces created
  // before these assets existed (otherwise they'd never get coordination.md
  // unless the user happened to bump a pin). See #52 follow-up.
  //
  // "A newer CLI version always wins" is the assumption the copy below
  // depends on — and nothing checked that the CLI actually IS newer until
  // #1386. When the installed CLI is itself a git checkout behind its own
  // canonical branch, the assumption inverts: refuse rather than silently
  // revert an existing workspace file to older content. `--force` is the
  // deliberate-downgrade escape; an undeterminable reference point (no
  // origin remote, unfetched ref) never blocks the write. `#1401` moved the
  // guard-then-copy sequence itself into `copyCanonicalAssetsGuarded`
  // (shared with `init` + `rules refresh`, which had this exact same
  // unguarded call — see that function's doc comment) — see
  // `checkCanonicalOverwriteSafety`'s doc comment for the full rationale.
  const canonicalBranch = resolveCanonicalBranch(config);
  const outcome = copyCanonicalAssetsGuarded(projectDir, {
    packageRoot: cliPackageRoot,
    canonicalBranch,
    force: opts.force,
  });
  if (outcome.guard.kind === 'refuse') {
    if (outcome.copied) {
      console.warn(`Warning: --force overriding a stale-CLI overwrite refusal: ${outcome.guard.detail}`);
    } else {
      console.error(`Refused: ${outcome.guard.detail}`);
    }
  } else if (outcome.guard.kind === 'unknown') {
    console.warn(`Warning: ${outcome.guard.detail}`);
  }

  if (outcome.rules.length > 0) {
    console.log(`Refreshed ${outcome.rules.length} canonical rule file(s) in .claude/rules/`);
  }
  if (outcome.scripts.length > 0) {
    console.log(`Refreshed ${outcome.scripts.length} helper script(s) in .claude/scripts/`);
  }

  // Seed (if absent) / validate (if present) the interactive-prompt
  // auto-responder allowlist (.claude/.macf/prompt-responses.json, DR-033 /
  // macf#645). Operator-curated state → seed-if-absent, never clobber: an
  // existing file is only validated (loud Inv-2 refuse/warn feedback), so
  // `macf update` never reverts an operator's careful allowlist.
  reportSeedPromptResponses(seedPromptResponsesConfig(projectDir));

  // Seed (if absent) / validate (if present) the stall-signature allowlist
  // (.claude/.macf/stall-signatures.json, DR-037 / macf#686) — the config
  // `macf fleet resume` matches an idle agent's pane against. Operator-curated
  // (signatures are best-effort across CC versions) → seed-if-absent, never
  // clobber: an existing file is only validated, never rewritten by update.
  reportSeedStallSignatures(seedStallSignaturesConfig(projectDir));

  // Refresh project-tier rules (DR-026 §3 / F3, macf#501) from
  // MACF_PROJECT_RULES_SOURCE into .claude/rules/project/. Unset → no-op (the
  // tier is optional, like absent universal rules; never an error). This lands
  // in a SUBDIR, so it can't overwrite or shadow the universal
  // .claude/rules/*.md refreshed above. A fetch failure (bad source / network)
  // warns but never aborts the update run.
  if ((process.env[PROJECT_RULES_SOURCE_ENV] ?? '').trim() !== '') {
    try {
      const projectRules = fetchProjectRules(projectDir);
      if (projectRules.length > 0) {
        console.log(
          `Refreshed ${projectRules.length} project-tier rule file(s) in .claude/rules/project/`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: project-rule refresh failed: ${msg}`);
    }
  }

  // Refresh the attribution-trap PreToolUse hook entry (merge-preserving,
  // per #140). Picks up on existing workspaces + keeps the entry current
  // if the CLI changes its form across releases.
  installGhTokenHook(projectDir);
  console.log(`Refreshed gh-token guard hook in .claude/settings.json`);

  // Refresh the canonical role-aware SessionStart work-pickup hook entry
  // (merge-preserving, DR-026/macf#768). Written for every role — the
  // auditor's default-OFF gate is enforced by the script at runtime.
  installStartupPickupHook(projectDir);
  console.log(`Refreshed SessionStart work-pickup hook in .claude/settings.json`);

  // Refresh macf-agent plugin-skill pre-approvals. Picks up new skills
  // added by newer CLI versions + drops any stale patterns pointing
  // at since-removed skills. See macf#189 sub-item 2.
  installPluginSkillPermissions(projectDir);
  console.log(`Refreshed plugin-skill permissions in .claude/settings.json`);

  // Refresh sandbox.filesystem.allowRead /proc/self/fd/** entry
  // (merge-preserving). Fixes every Bash tool call breaking with
  // "permission denied: /proc/self/fd/3" on workspaces created
  // before macf#200.
  installSandboxFdAllowRead(projectDir);
  console.log(`Refreshed sandbox allowRead in .claude/settings.json`);

  // Refresh sandbox.excludedCommands canonical set so dev-loop tools
  // (grep, find, bash, etc.) run unsandboxed and dodge the claude-
  // code#43454 seccomp regression. Operator-authored entries
  // preserved. Opt-out via MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP. See
  // macf#211.
  installSandboxExcludedCommands(projectDir);
  console.log(`Refreshed sandbox excludedCommands in .claude/settings.json`);

  // macf#342 PR-C: monolithic→multi-file migration + claude.sh refresh
  // + per-concern env-file refresh. The three steps run as a unit
  // because they're tightly coupled — the thin claude.sh template (PR-B)
  // depends on the env files existing, so we never want claude.sh
  // refreshed without the env files alongside it. Likewise, migration
  // writes both in lockstep for workspaces upgrading from a pre-#342
  // monolithic launcher.
  //
  // **Operator opt-out**: `--no-migrate-env-files` skips ALL THREE steps
  // (migration, claude.sh refresh, env-file refresh). The flag is for
  // operators with a hand-modified launcher who explicitly don't want
  // it auto-rewritten; the trade-off is they also miss any unrelated
  // launcher template evolution (e.g., a future #283-style endpoint
  // fix) on runs where they pass the flag. Removing the flag on a
  // subsequent run reapplies the canonical template + migration.
  //
  // **Migration order**: `migrateMonolithicClaudeSh` MUST run before
  // `writeClaudeSh`, because writeClaudeSh emits the thin source-loop
  // template that depends on env files; if writeClaudeSh ran first, the
  // operator's claude.sh would become thin without env files on disk
  // until refreshEnvFiles ran later — leaving a brief window where the
  // launcher would source nothing. Migration writes both atomically.
  if (!opts.noMigrateEnvFiles) {
    // DR-029 / macf#623: regenerate claude.sh ONLY when it is macf-managed
    // (carries the managed-header) or absent (fresh workspace). A claude.sh
    // that EXISTS but LACKS the managed-header is hand-authored (e.g. the
    // framework repo's own launcher, or any operator-written one) — preserve
    // it + warn (drift-aware), never clobber it with the generic template.
    // This is the auto-detect path that complements the `--no-migrate-env-files`
    // hard skip: the manual flag short-circuits this whole block above;
    // the managed-header check protects hand-authored launchers even on a
    // normal `macf update` run where the operator didn't pass the flag.
    // Same managed-header discriminator the env.* + host-prelude files use.
    const claudeShPath = join(projectDir, 'claude.sh');
    const existingClaudeSh = existsSync(claudeShPath)
      ? readFileSync(claudeShPath, 'utf-8')
      : null;
    const preserveHandAuthored =
      existingClaudeSh !== null && !hasManagedHeader(existingClaudeSh);

    if (preserveHandAuthored) {
      console.warn(
        `Preserved hand-authored claude.sh (no macf managed-header). ` +
          `Note: it lacks template improvements (e.g. the 0.2.39 host-prelude). ` +
          `Fold them in manually, or 'macf init --force' to adopt the managed template.`,
      );
    } else {
      const migration = migrateMonolithicClaudeSh(projectDir, config);
      if (migration.migrated) {
        console.log(
          `Migrated monolithic claude.sh → thin source-loop template + ` +
            `per-concern env files`,
        );
      } else if (migration.reason === 'unrecognized-template') {
        // A claude.sh that carries the managed-header but matches neither the
        // monolithic nor the thin template (an odd intermediate / mid-rewrite
        // managed launcher). `writeClaudeSh` below WILL overwrite per the
        // managed-file contract — surface the case. (A header-LESS launcher
        // never reaches here; it's preserved by the branch above.)
        console.warn(
          `Note: claude.sh did not match the canonical macf template. ` +
            `Will be overwritten with the current template (managed-file contract).`,
        );
      }

      // Regenerate claude.sh — the launcher template changes over time (e.g.,
      // #60 added --plugin-dir, #283 fixed the retired :4318 OTLP endpoint,
      // #599 added the host-prelude source line) and managed workspaces need
      // those changes without re-running `macf init`. The generated file
      // carries the managed-file header warning users not to edit it. See #63.
      // Doesn't depend on config.versions, so it runs even for legacy configs
      // (before the error-exit for missing versions).
      writeClaudeSh(projectDir, config);
      console.log(`Refreshed claude.sh from current launcher template`);
    }

    // Env-file refresh: macf-managed files (env._helpers / env.identity
    // / env.github / env.certs / env.registry) overwrite + warn-on-
    // handedit; operator-managed files (env.telemetry, env.tmux)
    // bootstrap-write if absent + preserve unconditionally otherwise.
    const refresh = refreshEnvFiles(projectDir, config);
    const summary =
      `Env: refreshed ${refresh.refreshed.length} macf-managed file(s); ` +
      `preserved ${refresh.preserved.length} operator-managed file(s); ` +
      `warned on ${refresh.warnedHandEdits.length} hand-edit(s)`;
    console.log(summary);

    // Host-toolchain bootstrap (DR-031 piece 4). Re-detect the backend +
    // regenerate .claude/.macf/host-prelude.sh in lockstep with claude.sh.
    // This is macf-managed + RE-DETECTED (never preserve-existing) — the
    // host's toolchain may have changed since the last update, and the
    // dynamic re-source the file emits must reflect the current backend.
    // The thin claude.sh sources it FIRST (before the env.* loop).
    writeHostPrelude(projectDir);
    console.log(`Refreshed host-prelude.sh from current toolchain detection`);
  }

  // Resolve the plugin dir claude.sh ACTUALLY MOUNTS (macf#889) — read here,
  // after claude.sh has just been refreshed/preserved above, so a
  // macf-managed launcher regenerated back to the canonical `.macf/plugin`
  // resolves to what it genuinely mounts post-refresh, and a hand-authored
  // launcher (e.g. a substrate workspace hand-wired onto the mcpServers-only
  // `.macf/plugin-cs` variant, DR-005 Decision 6 / macf#533) resolves to
  // ITS mount, never the conventional default. Every plugin-touching step
  // below writes here, not to `workspacePluginDir(projectDir)` directly —
  // macf#889's root cause was exactly that unconditional-default assumption.
  const pluginTarget = resolvePluginUpdateTarget(projectDir);
  if (!pluginTarget.determinable) {
    console.error(
      `Warning: cannot determine which plugin dir claude.sh mounts (${pluginTarget.detail}). ` +
        `Refusing to guess — skipping ALL plugin-dir updates (repair-fetch, version pin, dist-link) ` +
        `this run rather than risk silently updating a manifest nobody mounts. Fix ` +
        `claude.sh's --plugin-dir flag (see \`macf doctor\`), then re-run \`macf update\`.`,
    );
  } else if (pluginTarget.divergesFromDefault) {
    const defaultDir = workspacePluginDir(projectDir);
    const defaultState = existsSync(defaultDir) ? 'present on disk, unmounted' : 'absent';
    console.warn(
      `Warning: claude.sh mounts ${pluginTarget.dir} — that is what this run updates. NOT ` +
        `touching the conventional default ${defaultDir} (${defaultState}).`,
    );
  }

  // macf#342 PR-C deprecation surface: settings.local.json env keys
  // matching MACF_* / OTEL_* are now redundant with the per-concern
  // env files. Backward-compat preserved structurally (macf_settings_get
  // still reads them at runtime); this warning gives operators a window
  // to migrate. No automatic JSON-key migration in this PR — the risk
  // surface is too broad (operator may intentionally have layered
  // overrides). See env-files-update.ts for the full rationale.
  const deprecatedKeys = detectSettingsLocalEnvKeys(projectDir);
  if (deprecatedKeys.length > 0) {
    process.stderr.write(formatDeprecationWarning(deprecatedKeys));
  }

  // DR-011 rev2 auto-migrate: check for legacy v1 CA key backup and
  // upgrade it to v2 (JSON envelope at 600k iters) if found. One-time
  // per project, silent no-op if already v2 or no backup exists.
  // Failures here do NOT block `macf update` — the migration is
  // independent of version bumps and the v1 blob stays decryptable
  // via the read-compat path. See #115.
  try {
    const token = await generateToken(tokenSourceFromConfig(projectDir, config));
    const client = createClientFromConfig(config.registry, token);
    const result = await migrateCaKeyToV2({
      project: config.project,
      client,
      prompt: async (message) => {
        try {
          return await promptPassword({ message });
        } catch (err) {
          if (err instanceof PromptCancelled) {
            return '';
          }
          throw err;
        }
      },
    });
    const summary = formatMigrationResult(result, config.project);
    if (summary) console.log(summary);
  } catch (err) {
    // Don't block update on migration failure (token/network/etc.).
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: CA key migration check failed: ${msg}`);
  }

  // Repair-case plugin fetch: if the MOUNTED plugin dir is absent or empty,
  // fetch the currently-pinned version regardless of whether anything is
  // being bumped. Runs before every short-circuit so workspaces init'd
  // before #60 merged (empty plugin dir) don't require `rm -rf + macf
  // update` to self-heal. See #62. We skip this if config.versions is
  // missing — legacy configs are handled by the error path below. Gated on
  // `pluginTarget.dir` (macf#889): an undeterminable mount already warned
  // loudly above — skip rather than guess at a default.
  if (config.versions && pluginTarget.dir && pluginDirNeedsRepair(pluginTarget.dir)) {
    try {
      fetchPluginToWorkspace(projectDir, config.versions.plugin, { targetDir: pluginTarget.dir });
      console.log(`Repaired ${pluginTarget.dir} with macf-agent@v${config.versions.plugin}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: plugin repair fetch failed: ${msg}`);
    }
  }

  // Strip mcpServers from the MOUNTED plugin manifest — UNCONDITIONALLY,
  // independent of whether the repair-fetch above just ran (groundnuty/
  // macf#1005). This is the convergence step for the common steady state:
  // a workspace whose plugin is ALREADY at the pinned version never hits
  // the repair-fetch branch above, so without this call it would never be
  // stripped at all. Placed here — before every short-circuit `return`
  // below (no-bump-candidates / no-changes / dry-run / legacy-config) — so
  // none of those exit paths skip convergence either. See
  // `reportPluginMcpServersStrip`'s doc comment for the full rationale.
  if (pluginTarget.dir) {
    reportPluginMcpServersStrip(projectDir, pluginTarget.dir);
  }

  // Write/refresh <workspace>/.mcp.json with the channel-server as a project
  // MCP server (DR-022 Amendment P, groundnuty/macf#995) — THE RETROFIT: runs
  // on every `macf update`, unconditionally of whether the plugin needed
  // repair or any version is being bumped, so an EXISTING workspace that
  // predates this change (all nine on the operator's machine, per #995's
  // survey) gets the mount on its next `macf update`, not only on a fresh
  // `macf init`. Gated on `config.versions` (skipped for legacy configs —
  // same posture as the repair-fetch above; the error path just below tells
  // the operator to `macf init --force`). Merge-preserving + idempotent — see
  // `mcp-json.ts::writeMcpJsonChannelServer`'s doc comment for the refuse
  // conditions.
  if (config.versions) {
    const mcpJsonResult = writeMcpJsonChannelServer(projectDir, config, config.versions.cli);
    if (mcpJsonResult.status === 'refused') {
      console.warn(`Warning: .mcp.json not written: ${mcpJsonResult.reason}`);
    } else if (mcpJsonResult.changed) {
      console.log(`Refreshed .mcp.json (macf-agent channel-server, pinned @${config.versions.cli})`);
    }
  }

  // Deliver the built plugin-CLI by linking <mounted>/dist → the running
  // CLI's own dist/ (groundnuty/macf#676). The marketplace plugin ships no
  // dist/, so without this the /macf-* skills fail MODULE_NOT_FOUND. Run
  // unconditionally whenever the MOUNTED plugin dir exists (macf#889) —
  // after the repair fetch above, AND before every short-circuit return
  // below — so an already-init'd consumer hit by the missing-dist bug
  // self-heals on a single `macf update` even when no versions change.
  // Idempotent (replaces a stale link).
  if (pluginTarget.dir && existsSync(pluginTarget.dir) && linkPluginCliDist(projectDir, { targetDir: pluginTarget.dir })) {
    console.log(`Linked plugin-CLI dist into ${pluginTarget.dir}/dist`);
  }

  if (!config.versions) {
    console.error(
      'No "versions" section in macf-agent.json (legacy config).\n' +
      'Run `macf init --force` to migrate with resolved version pins.',
    );
    return 1;
  }

  console.log('Fetching latest versions...');
  const resolved = await resolveLatestVersions();

  const diff = buildDiff(config.versions, resolved);
  console.log('');
  console.log(renderDiff(diff));
  console.log('');

  // Exit 1 if every fetch failed (no current info to compare against).
  // Any non-'update' / non-'same' status counts as failed-to-fetch here.
  const FAIL_STATES: readonly DiffRow['status'][] = ['not_published', 'network_error', 'invalid_response'];
  const allFailed = diff.every(r => FAIL_STATES.includes(r.status));
  if (allFailed) {
    console.error('Error: could not fetch latest versions for any component. Network down?');
    return 1;
  }

  // Determine which components are candidates for bump.
  const explicitSelection = selectedComponents(opts);
  const candidates = diff.filter(row => {
    if (row.status !== 'update') return false;
    if (explicitSelection.length > 0) return explicitSelection.includes(row.component);
    return true;
  });

  if (candidates.length === 0) {
    // Distinguish "all rows OK + same" from "some rows in failure states
    // were silently filtered out" — pre-#335 the latter case printed
    // "Everything is up to date" even when a fetch had failed, masking
    // the actual reason a pin wasn't bumped.
    const FAIL_STATES_FOR_SUMMARY: readonly DiffRow['status'][] = [
      'not_published', 'network_error', 'rate_limited', 'invalid_response',
    ];
    const failedRows = diff.filter(row => FAIL_STATES_FOR_SUMMARY.includes(row.status));
    if (failedRows.length > 0) {
      const skipped = failedRows.map(r => `${r.component} (${r.status})`).join(', ');
      console.log(`No bump candidates. Skipped due to fetch failure: ${skipped}.`);
      console.log('Other pins are up to date. See per-component status above for details.');
    } else {
      console.log('Everything is up to date.');
    }
    return 0;
  }

  // Per macf#334 (unified preview-then-prompt UX): show ALL pending bumps
  // + single Proceed? prompt instead of per-candidate y/N loop. Auto-yes
  // bypass paths preserved (--yes / --all / --<component>) for backward
  // compat with scripted workflows. The `--confirm` flag is an explicit
  // alias for the new default (no behavioral change vs bare `macf update`).
  const autoYes = opts.yes || opts.all || explicitSelection.length > 0;
  let toBump: readonly DiffRow[];
  if (autoYes) {
    toBump = candidates;
  } else if (await confirmPlan(candidates)) {
    toBump = candidates;
  } else {
    toBump = [];
  }

  if (toBump.length === 0) {
    console.log('No changes. Exiting.');
    return 0;
  }

  // Build new versions object.
  const newVersions: VersionPins = {
    cli: config.versions.cli,
    plugin: config.versions.plugin,
    actions: config.versions.actions,
  };
  for (const row of toBump) {
    (newVersions as { [k in Component]: string })[row.component] = row.latest;
  }

  if (opts.dryRun) {
    console.log('\n[dry-run] Would update:');
    for (const row of toBump) {
      console.log(`  ${row.component}: ${row.current} → ${row.latest}`);
    }
    return 0;
  }

  // Used below (in-memory) so the .mcp.json OTEL env block's baked
  // MACF_VERSION / service.version reflect THIS bump — `config` itself is
  // never reassigned, only the on-disk file is (macf#995: a stale in-memory
  // `config.versions.cli` would otherwise pin the npx arg to the new version
  // while baking OTEL attrs that still say the old one).
  const updatedConfig = { ...config, versions: newVersions };
  writeAgentConfig(projectDir, updatedConfig);

  // Re-fetch the plugin when versions.plugin was bumped. The separate
  // repair-case fetch runs earlier (before short-circuits) for empty/
  // missing dirs; this block handles the pin-bump case specifically.
  // Gated on `pluginTarget.dir` (macf#889) — an undeterminable mount was
  // already warned loudly above; the config pin still advances (it's just a
  // JSON write), but no on-disk manifest is touched, so say so explicitly
  // rather than leaving the operator to notice the drift later.
  const pluginBumped = toBump.some(r => r.component === 'plugin');
  if (pluginBumped) {
    if (pluginTarget.dir) {
      try {
        fetchPluginToWorkspace(projectDir, newVersions.plugin, { targetDir: pluginTarget.dir });
        console.log(`Refreshed ${pluginTarget.dir} to macf-agent@v${newVersions.plugin}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: plugin re-fetch failed: ${msg}`);
      }
      // A fetch always overwrites the manifest, reintroducing mcpServers if
      // the marketplace still ships it — strip again (DR-022 Amendment P,
      // groundnuty/macf#995, macf#1005). Runs whether or not the fetch above
      // succeeded — `stripPluginMcpServers` is idempotent against whatever
      // is actually on disk, so this is safe either way.
      reportPluginMcpServersStrip(projectDir, pluginTarget.dir);
    } else {
      console.error(
        `Warning: versions.plugin advanced to v${newVersions.plugin} in macf-agent.json, but the ` +
          `mounted plugin dir is undeterminable — NO on-disk manifest was updated to match.`,
      );
    }
  }

  // Re-pin the channel-server version in .mcp.json (successor to the retired
  // plugin-manifest pin — groundnuty/macf#421 + DR-022 Amendment P /
  // groundnuty/macf#995), regardless of WHICH component bumped: the cs
  // version tracks the CLI (monorepo lockstep), so a CLI bump WITHOUT a
  // plugin bump would otherwise leave `.mcp.json` carrying a stale cs pin.
  // Idempotent when the pin is already current. Unlike the retired
  // plugin-manifest pin, this does NOT depend on `pluginTarget.dir` —
  // `.mcp.json` always lives at the workspace root, independent of which
  // `--plugin-dir` variant is mounted.
  const mcpJsonBumpResult = writeMcpJsonChannelServer(projectDir, updatedConfig, newVersions.cli);
  if (mcpJsonBumpResult.status === 'refused') {
    console.error(`FATAL: post-bump .mcp.json write refused: ${mcpJsonBumpResult.reason}`);
  } else if (mcpJsonBumpResult.changed) {
    console.log(`Pinned channel-server @${newVersions.cli} in .mcp.json`);
  }

  // Pattern A (macf#889/#995) — the load-bearing half: don't just trust that
  // the write above succeeded, READ BACK what `.mcp.json` now pins and
  // assert it matches the target. macf#889's entire failure shape was "the
  // upgrade reports success (it DID write a real manifest) and the agent
  // reports its true version (which nobody compares against the intent)" —
  // this is that comparison, repointed at the new mount. A mismatch here
  // means the write above did not reach the file actually being upgraded
  // (permission fault, race, or a future regression of this same class) —
  // surfaced LOUD rather than left for an operator to eyeball version
  // columns side by side. Deliberately does NOT change the exit code:
  // `upgrade()` (the fleet-roll driver verb, `vm-driver.ts`) shells this
  // command via `execFileSync` with `stdio: 'inherit'`, which THROWS on a
  // non-zero exit — turning this into a hard failure would abort the roll's
  // upgrade→restart transaction mid-flight with the workspace already
  // mutated (exactly the class macf#725's transactional discipline exists
  // to prevent). The loud console.error is captured in the inherited output
  // either way.
  const actualMcpPin = readMcpJsonChannelServerVersion(projectDir);
  if (actualMcpPin !== null && actualMcpPin !== newVersions.cli) {
    console.error(
      `FATAL: post-update verification failed — .mcp.json pins the channel-server at ` +
        `@${actualMcpPin}, not the target @${newVersions.cli}. The write above did not reach ` +
        `the file actually being upgraded. Inspect ` +
        `${join(projectDir, '.mcp.json')}.`,
    );
  }

  if (pluginTarget.dir && existsSync(pluginTarget.dir)) {
    // Re-deliver the plugin-CLI dist link (groundnuty/macf#676). Runs after
    // the plugin re-fetch above (a re-fetch wipes the mounted dir, taking
    // the link with it); idempotent so a no-bump update refreshes a stale
    // link. Unrelated to the channel-server pin above — this delivers the
    // `/macf-*` skill CLI, which still ships via the `--plugin-dir` mount.
    if (linkPluginCliDist(projectDir, { targetDir: pluginTarget.dir })) {
      console.log(`Linked plugin-CLI dist into ${pluginTarget.dir}/dist`);
    }
  }

  console.log('\nUpdated:');
  for (const row of toBump) {
    console.log(`  ✓ ${row.component}: ${row.current} → ${row.latest}`);
  }
  console.log('\nWritten to .macf/macf-agent.json.');
  return 0;
}
