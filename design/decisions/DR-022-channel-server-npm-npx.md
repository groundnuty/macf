# DR-022: Channel-server distribution via npm + npx

**Status:** Proposed
**Date:** 2026-04-22

## Context

Plugin v0.1.8 (marketplace) ships the MACF channel server as `dist/server.js`
inside the plugin tarball. The MCP is configured as
`node ${CLAUDE_PLUGIN_ROOT}/dist/server.js`. The server has Node
dependencies (6 packages including the OpenTelemetry SDK from DR-021)
resolved via a SessionStart npm-install hook writing to
`${CLAUDE_PLUGIN_DATA}/node_modules`, symlinked into
`${CLAUDE_PLUGIN_ROOT}/node_modules` because ESM ignores `NODE_PATH`.

This pattern is the one Claude Code's plugins-reference documents. It has
two structural flaws:

1. **Race between MCP spawn and SessionStart hook.** Claude Code spawns
   the MCP process in parallel with SessionStart hook execution. First-
   launch `node dist/server.js` runs before `npm install` has populated
   `node_modules/`, triggering `ERR_MODULE_NOT_FOUND` on
   `@opentelemetry/api` (or any other statically-imported dep), MCP dies
   with no retry. Second-launch works because deps now exist. Reproduced
   on cv-architect + cv-project-archaeologist on 2026-04-22 with plugin
   v0.1.8 — the post-#196 fix exposed it because the OTEL package set
   is larger than v0.1.7 had.

2. **ESM + NODE_PATH mismatch.** The documented `NODE_PATH` example in
   the plugin docs works only for CommonJS packages. For
   `"type": "module"` packages — which macf-agent is, and every modern
   Node MCP server tends to be — ESM resolution ignores `NODE_PATH` and
   only walks `node_modules/` adjacent to the importer. The current
   workaround is a symlink from `.macf/plugin/node_modules` to
   `${CLAUDE_PLUGIN_DATA}/node_modules`. Fragile, undocumented, and
   itself subject to the race above (symlink exists before npm-install
   populates its target).

Meanwhile, Anthropic's own reference MCP plugin (`context7` in
`claude-plugins-official`) uses a fundamentally different pattern:

    { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } }

Zero local install, zero race condition, zero symlink machinery. The MCP
package is its own npm module, cached by npm, invoked on-demand.

Investigation on 2026-04-22 (captured in
`research/2026-04-22-otel-rollout-postmortem.md` in the science-agent
workspace) compared the three viable distribution patterns and
concluded:

| Pattern | Used by | Race-safe? | Ecosystem norm? |
|---|---|---|---|
| `npx` on-demand fetch | `context7` (Anthropic's own) | yes | yes — the de-facto pattern |
| SessionStart install hook → `CLAUDE_PLUGIN_DATA` | macf-agent v0.1.8 | no (our bug) | documented but only viable for CJS / for servers with no eager imports |
| Bundled `node_modules/` in plugin tarball | none observed in the wild | yes | no — violates Claude Code's cache model |
| Pre-install via `macf` CLI | none (MACF-specific) | yes at next-launch | no — ties install to a framework-specific CLI |

## Decision

**Migrate channel-server distribution to npm + `npx` dispatch,
version-bump marketplace plugin to v0.2.0.**

Publish two npm packages under the `@groundnuty` scope:

1. **`@groundnuty/macf`** — the CLI.
   - Binary: `macf` → `dist/cli/index.js`
   - Replaces the current dev-only `npm link` install flow
   - Operator install: `npm install -g @groundnuty/macf`

2. **`@groundnuty/macf-channel-server`** — the MCP channel server.
   - Binary: `macf-channel-server` → `dist/server.js`
   - Replaces the bundled `dist/server.js` in the marketplace plugin tarball

Marketplace plugin `plugin.json` becomes:

    {
      "mcpServers": {
        "macf-agent": {
          "command": "npx",
          "args": ["-y", "@groundnuty/macf-channel-server"]
        }
      }
    }

Delete from the marketplace plugin:

- SessionStart `npm install` hook (`macf-agent/hooks/hooks.json` or wherever
  it lives post-v0.1.8)
- Bundled `dist/` directory — plugin ships only agents, skills, hooks,
  rules; no runtime code
- `package.json` declaring runtime deps (no longer resolved from the
  plugin dir)

## Rationale

- **Race-condition class eliminated.** `npx` resolution is atomic — npm
  fetches + extracts the package completely before executing. No
  half-populated `node_modules/` for Node to stumble over.
- **ESM-native.** `npx` invokes the package via its published `bin`
  entry in npm's own cache; Node's resolver finds transitive deps via
  the package's own adjacent `node_modules/`. Works regardless of
  `"type": "module"`.
- **Matches ecosystem norm.** Plugin.json shape mirrors `context7`
  (`npx -y @scope/name`). Any developer already familiar with Claude
  Code plugins reads the config without friction.
- **Plugin tarball shrinks 5-10×.** Marketplace plugin becomes config +
  static assets (agents, skills, hooks, rules). No runtime code
  duplication across plugin versions.
- **Version alignment cleaner.** `@groundnuty/macf-channel-server`
  versions independently from the plugin manifest. Plugin.json can pin
  a caret range (`npx -y @groundnuty/macf-channel-server@^0.2`) if we
  want to gate on channel-server compatibility separately from
  plugin-asset changes.
- **CLI install story improved.** `npm install -g @groundnuty/macf`
  supersedes the current `devbox run -- npm ci && npm run build && npm link`
  dance (documented in the macf README). Reduces dev-setup friction.

## Decisions within this DR

### Package split: two packages (option B from triage)

Two packages, not one. `@groundnuty/macf` (CLI) and
`@groundnuty/macf-channel-server` (server). Matches the `context7`
pattern exactly. Plugin.json gets the clean form
`npx -y @groundnuty/macf-channel-server` instead of the wordier
`npx -y -p @groundnuty/macf macf-channel-server`.

Tradeoff: two publish targets to keep in sync, deps may duplicate
between them. Acceptable because:

- CLI rarely needs runtime overlap with the channel server (different
  execution contexts: CLI is a one-shot command, server is a long-lived
  process).
- `@groundnuty/macf` can depend on `@groundnuty/macf-channel-server` if
  any CLI command needs the server's types — npm dedupes transitively.

### Migration strategy: clean cutover (option A)

Plugin v0.1.x becomes unsupported once v0.2.0 ships. No dual-path.
Rationale:

- Three live workspaces total (academic-resume, cv-project-archaeologist,
  macf); no installed-base to protect.
- Dual-path adds complexity without user benefit.
- Current v0.1.8 race makes v0.1.x unfit for production anyway.

Operators on v0.1.x: one `macf update` pulls v0.2.0, relaunch fetches
the channel server from npm (one-time cold-fetch, cached after), MCP
comes up clean.

### Publish pipeline: CI on tag (option A)

GitHub Actions workflow in `groundnuty/macf`: on `v*` tag push, run
`npm publish` for both packages. Requires:

- `groundnuty` npm organization created on npmjs.com (doesn't exist yet)
- `NPM_TOKEN` secret provisioned on `groundnuty/macf` repo with write
  access to the scope
- A tagging convention — propose: `v<semver>` tags on `groundnuty/macf`
  trigger publish of both packages at that version

### Package contents: ship `dist/` (option a)

Both packages ship their built `dist/` directory via `files: ["dist/"]`
in package.json. No bundling (rollup/esbuild) for the initial publish.
Rationale:

- Simpler publish pipeline (just `npm run build && npm publish`)
- Avoids bundler gotchas with ESM + native deps
- Install size is fine for CLI tooling (context7's published package is
  also unbundled)

Optimization (single-file bundle via esbuild or rollup) deferred to a
follow-up DR if install-size becomes a complaint.

## Alternatives considered

### Wrapper shell script that busy-waits for deps

`${CLAUDE_PLUGIN_ROOT}/launch.sh` busy-waits until `node_modules/`
contains the required packages, then `exec`s node. Closes the race
inside the current pattern without requiring npm publish.

**Rejected:** band-aid, adds startup latency (polling sleep), keeps the
ESM/NODE_PATH gotcha, doesn't match the Anthropic reference-plugin
pattern. Every future plugin release re-inherits the structural issue.

### Bundle `node_modules/` into the plugin tarball

Ship the pre-installed dep tree inside the plugin. No race, no install
step.

**Rejected:** violates Claude Code's per-version cache model — every
marketplace plugin version stored separately in `~/.claude/plugins/cache/`
means the full `node_modules/` blob gets re-downloaded and stored on
each update. 5-10× tarball bloat, no cross-version dedup. Zero plugins
in the observed ecosystem use this.

### Pre-install deps during `macf update`

MACF's CLI stages `node_modules/` into `${CLAUDE_PLUGIN_DATA}/` before
the next agent launch. Avoids race at launch time.

**Rejected:** works only because MACF ships its own CLI (not portable
to pure plugin consumers without MACF). Ties install state to a
framework-specific lifecycle rather than the Claude-Code-native one.

## Consequences

### Positive

- First-launch race (v0.1.8 bug class) eliminated structurally
- Plugin tarball shrinks; marketplace install + cache update faster
- CLI installable via standard `npm install -g @groundnuty/macf` —
  drops the dev-time `npm link` requirement from the README
- Operator rollout on v0.2.0: `macf update` → relaunch. First-launch
  pulls the channel server from npm (~5-10 s cold fetch), cached
  thereafter for all future launches across all workspaces

### Negative / cost

- `groundnuty` npm org must be created + ownership claimed (manual
  one-time step, requires an npm account under groundnuty's control)
- `NPM_TOKEN` secret must be provisioned on `groundnuty/macf` repo
- CI publish workflow must be authored + tested
- First launch in a new workspace now requires internet (npm fetch).
  Existing MACF agents run offline fine once deps are cached — same
  property we had before, minus the install-from-source on first boot
- Ongoing burden: semver discipline, package-deprecation workflow,
  namespace stewardship. Non-trivial but standard.

### Neutral

- Rollout scope touches three repos:
  - `groundnuty/macf`: package.json refactor to publish three packages
    (CLI, server, deprecated-internal core — see Amendment A), build
    targets for each, npm publish workflow
  - `groundnuty/macf-marketplace`: plugin.json swap, remove bundled
    `dist/` + `package.json` + SessionStart hook, version bump 0.1.8 → 0.2.0
  - `groundnuty/macf-science-agent` (this workspace): rules docs update
    to drop install-hook/symlink mentions, research/postmortem links
    back to this DR

## Follow-ups

Tracked as code-agent issue (filed after this DR merges). Scope:

1. Create `groundnuty` npm org + claim scope ownership
2. Provision `NPM_TOKEN` secret on `groundnuty/macf` repo
3. Refactor `groundnuty/macf` to an npm-workspaces monorepo publishing
   three packages (per Amendment A):
   - `@groundnuty/macf-core` (deprecated-internal), `@groundnuty/macf`
     (CLI), `@groundnuty/macf-channel-server` (server)
   - Add `files` field to each package's manifest for clean publish
     contents
   - Author npm publish GitHub Actions workflow with
     `npm publish --provenance` across all three (per Amendment B)
4. Cut first publish manually once scope is owned — verify all three
   packages install + invoke correctly via `npx`, verify
   `@groundnuty/macf-core` surfaces its deprecation warning on direct
   install — then automate the same flow in CI
5. Update `groundnuty/macf-marketplace`:
   - plugin.json → `npx` dispatch
   - Delete bundled `dist/`, `package.json`, SessionStart install hook
   - Version bump to v0.2.0 + CHANGELOG entry
6. Update rules docs (`plugin/rules/coordination.md`, README in
   `groundnuty/macf`) — remove install-hook + symlink references,
   document new `npm install -g @groundnuty/macf` CLI install path
7. Verify end-to-end on all three agent workspaces: `macf update` →
   relaunch → MCP boots clean → `macf-agent-<name>` appears in Jaeger
   within 30 s

This sequence replaces the currently-open verification path for
[groundnuty/macf#196](https://github.com/groundnuty/macf/issues/196) +
[#197](https://github.com/groundnuty/macf/issues/197) +
[#200](https://github.com/groundnuty/macf/issues/200) — those fixes
stay merged on main, but the user-observable bug (empty Jaeger, failing
MCP on first launch) is closed by the v0.2.0 cutover, not by the v0.1.8
rollout.

## Links

- Plugins reference: [code.claude.com/docs/en/plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- Investigation artifact: `research/2026-04-22-otel-rollout-postmortem.md`
  in `groundnuty/macf-science-agent` workspace
- Upstream precedent: `~/.claude/plugins/cache/claude-plugins-official/context7/unknown/.mcp.json`
  (Anthropic's `context7` plugin, `npx -y @upstash/context7-mcp`)
- Current-pattern reference: DR-013 (plugin-dir adoption), DR-021 (OTEL
  instrumentation — introduced the dep-heavy server that exposed the
  race)

## Amendments post-review (2026-04-22)

Feasibility review by `macf-code-agent[bot]` on [PR #205](https://github.com/groundnuty/macf/pull/205) surfaced several items that tighten the decisions above. Captured here so the DR document alone (not the PR thread) conveys the as-merged shape.

### Amendment A — Package split revised to B3 (npm workspaces + internal core)

The original §"Package split" claimed CLI/server had limited shared-code overlap. Empirical import-graph analysis (by code-agent) found the overlap is substantial — `src/server.ts` imports from 15 shared modules (`certs/*`, `registry/*`, `config`, `token`, `errors`, `logger`, `otel`, `tracing`, `collision`, `shutdown`, `https`, `mcp`, `health`, `tmux-wake`, `types`), and the CLI overlaps on `certs/`, `registry/`, `token`, `config`.

Confirmed package layout: **npm workspaces monorepo, three packages, all three published**:

- `@groundnuty/macf-core` — shared modules. Published to npm with a `deprecated` field in `package.json` reading *"internal shared code for @groundnuty/macf and @groundnuty/macf-channel-server — do not depend on this directly; use the consumer packages instead."* External consumers who `npm install @groundnuty/macf-core` see the deprecation warning.
- `@groundnuty/macf` — CLI. Published. Declares a concrete runtime dep on `@groundnuty/macf-core` at the lock-step version.
- `@groundnuty/macf-channel-server` — server. Published. Same concrete runtime dep on core.

**Correction from the pre-review version of this amendment:** an earlier draft claimed npm would "inline" the internal core into each public package's tarball on publish. That's not how `npm publish` works — when a workspace package declares a dep on another workspace package without additional tooling, the published `package.json` gets a `workspace:*` protocol specifier that external consumers fail to resolve at install time (the name must exist on the registry). See the [PR #205](https://github.com/groundnuty/macf/pull/205) thread for the technical exchange.

Publishing core as a third package is the ecosystem-standard fix — matches Babel's `@babel/helper-*`, React Native's `@react-native/*`, Angular's `@angular/*` internal packages. The `deprecated` field steers external consumers away from depending on what we keep free to refactor, without requiring a publish-time bundler (option 2 — contradicts §"Package contents: ship `dist/`" doctrine) or a workspace-deps rewriter (option 3 — fragile specialized tooling; both rejected).

Concrete publish pipeline implications:
- Three `npm publish` invocations per release tag, not two
- Provenance (Amendment B) applies uniformly across all three
- Lock-step versioning (Amendment D) applies to all three — one `v<semver>` tag publishes all three at that version
- Operator story unchanged: `npm install -g @groundnuty/macf` resolves `@groundnuty/macf-core` as a transitive dep silently

### Amendment B — npm provenance enabled on all three publishes

All three published packages (`@groundnuty/macf-core`, `@groundnuty/macf`, `@groundnuty/macf-channel-server` — see Amendment A for why core is published) publish with `npm publish --provenance`. Requires:
- OIDC trust configured on npmjs.com → `groundnuty/macf` repo (one-time step on the publish settings for each package)
- `permissions: { id-token: write }` in the publish GitHub Actions workflow
- No new secret — OIDC replaces long-lived credentials for this flow

Provenance attestations appear on each package's npmjs.com page, tying the version to the specific CI run + commit SHA that built it. Supply-chain trust win appropriate for a framework that manages App tokens and PreToolUse hooks.

### Amendment C — `NPM_TOKEN` must be a scope-level granular access token (not classic)

When 2FA is enabled on the `@groundnuty` scope (default and recommended), classic automation tokens can't publish. The `NPM_TOKEN` secret provisioned in amendment 2 of the original DR must be a **granular access token** scoped to `@groundnuty/*` with **Publish** permission. Creating it: npmjs.com → Account → Access Tokens → Generate New Token → Granular Access Token form, not the "classic" tab.

### Amendment D — CLI + server version lock-step

Original DR left open whether the CLI and server packages version independently. Confirmed: **lock-step for v0.2.0 and forward, across all three published packages** (core + CLI + server per Amendment A). One `v<semver>` git tag on `groundnuty/macf` publishes all three at the same version. If lifecycles diverge later (empirically unlikely — CLI and server both depend on core and churn together), introduce `cli/v*` + `server/v*` + `core/v*` tag prefixes then. Don't pay the flexibility tax upfront.

### Amendment E — First-launch SLA split by cache state

Original DR implied a "30 s Jaeger service appearance" AC for verification. Cold-cache npm fetch on flaky or low-bandwidth networks can exceed this. Split:

| Launch state | MCP boot | Jaeger service appearance |
|---|---|---|
| First launch ever (cold npm cache) | ≤ 60 s | ≤ 90 s |
| Subsequent launches (warm cache) | ≤ 10 s | ≤ 30 s |

Cold-fetch cost is paid exactly once per workspace. Worth documenting in operator rollout notes for v0.2.0.

### Amendment F — `macf self-update` branches on install path

Operator install path post-cutover: `npm install -g @groundnuty/macf`. Contributor dev install path: `git clone` + `npm run build` + `npm link`. `macf self-update` detects which and branches:

- npm-global install → `npm install -g @groundnuty/macf@latest`
- npm-link dev install → `git pull origin main && npm run build` (existing behavior)

README "Installing macf" section is restructured: npm-global becomes the primary install path; the current `npm link` flow moves to a "Contributing" subsection. The #144 stale-dist warning (build-info check on `macf update`) becomes a dev-install-only signal.

### Amendment G — Tarball before/after listing required in the follow-up AC

Concrete `tar tvzf` of marketplace plugin v0.1.8 vs v0.2.0 side-by-side is a required artifact on the follow-up implementation issue. Defensive against accidental deletion of agent templates, skills, hooks (non-install), or rules during the bundled-dist removal.

### Amendment H — Rollback constraint: verification must complete within 72 h unpublish window

npm allows unpublish for 72 h after publish; after that, remediation is publish a patch (v0.2.1), not rollback. Operator-facing implication: end-to-end verification on all three agent workspaces (academic-resume, cv-project-archaeologist, macf) must complete within the window. Explicit timeline AC in the follow-up issue.

### Amendment I — Marketplace plugin repo location unchanged

Post-cutover the marketplace plugin is config-only (agents, skills, hooks, rules, `plugin.json`) and small. No restructuring needed — `groundnuty/macf-marketplace/macf-agent/` stays as-is. The marketplace repo remains the canonical discovery path for Claude Code plugin installs.

### Amendment J — First-publish-path gotchas (observed 2026-04-22 bootstrap)

The `v0.2.0-rc.0` → `v0.2.0-rc.1` bootstrap surfaced **four structural error classes** that each only visible via the real `npm publish` run — every one a silent misconfiguration until the registry-side validator spoke up. Captured here so the next scoped-npm-publish bootstrap (any future `@<scope>/*` framework offshoot from the MACF lineage) runs through in ≤1 cycle instead of 4.

**Pre-bootstrap checklist** (verify all before pushing the first `v*` tag):

1. **Workflow publish commands use `npm publish --workspace=<name>` from monorepo root**, not `cd packages/<name> && devbox run -- npm publish`. Rationale: `devbox run` resets cwd to the devbox project root regardless of preceding `cd`, so the inner `npm publish` runs from monorepo root and packs the (usually private) root `package.json`. Symptom: `EPRIVATE` on first publish step. Cross-ref: [macf#217](https://github.com/groundnuty/macf/pull/217).

2. **Granular NPM_TOKEN has "Bypass 2FA" checkbox explicitly enabled** during token creation on npmjs.com — even if the npm account has no 2FA. Rationale: npm's registry-side publish policy treats bypass-2FA as a per-token capability, not inherited from account 2FA state. Symptom: `403 2FA required` on publish step. No workflow change; operator regenerates the token with the box checked. Cross-ref: science-agent's 2026-04-22 finding on [macf#206](https://github.com/groundnuty/macf/issues/206).

3. **Every package.json has `repository` with `type + url + directory`**, plus `homepage`, `bugs`, and `license` for hygiene. Rationale: `npm publish --provenance` signs a sigstore attestation that includes the OIDC-asserted source repo URL; npm's server-side validator cross-checks `package.json.repository.url` against that URL. Missing → `422 Unprocessable Entity — Failed to validate repository information`. In a monorepo, also include `directory` so npm registry metadata links to the package's subpath. Cross-ref: [macf#218](https://github.com/groundnuty/macf/pull/218).

4. **Every file listed in `package.json.bin` has `#!/usr/bin/env node` as literal line 1**. Rationale: npm's install `chmod +x`'s bin files + shells invoke them directly; without a shebang, the OS can't dispatch to node. TypeScript preserves shebangs only when at file offset 0 — a leading blank line or BOM kills it. Symptom: `Syntax error: "(" unexpected` when `npx`-ing the bin. Regression guard filed as [macf#220](https://github.com/groundnuty/macf/issues/220). Cross-ref: [macf#219](https://github.com/groundnuty/macf/pull/219).

**Operator post-bootstrap actions** (once the above four are verified + first `v*` tag publishes cleanly):

5. **Configure OIDC trusted-publishing per package** on each npmjs package settings page (one-time, ~5 min/package). Once trust is configured, subsequent publishes use OIDC for auth AND provenance signing; `NPM_TOKEN` becomes a fallback/emergency mechanism. The chicken-and-egg (can't configure OIDC trust on a package that doesn't exist yet) is the reason the publish workflow uses a dual-path auth shape per Amendment B.

6. **Rotate `NPM_TOKEN`** after the bootstrap publish succeeds + OIDC is configured. The bootstrap token was present in at least one ephemeral CI context + any console paste during setup; rotation closes that exposure loop without impacting future publishes (OIDC is now the primary path).

7. **Deprecate broken bootstrap versions on npm** via `npm deprecate @<scope>/<pkg>@<bad-version> "<reason>"`. Specifically, any rc versions that predate the shebang fix or other boot-time bugs should be marked deprecated so casual consumers don't accidentally install them.

8. **Add a top-level `LICENSE` file** to the monorepo matching the `license` field in each package.json. npm warns (not errors) on publish when the package claims a license without a LICENSE file adjacent. Trivial hygiene; typical MIT template.

**Why four cycles on this bootstrap:** MACF is the first `@groundnuty`-scoped publish. Every error class 1–4 is observable only through real-registry behavior; no dry-run or CI-time check catches them. Future frameworks published under the same scope skip errors 1–3 automatically because the workflow template, token, and package.json shape all exist; error 4 (shebang) is per-package and needs the `macf#220` regression guard to prevent.

### Amendment K — MCP tool surface for hook invocation (added 2026-04-26)

The original DR (2026-04-22) framed `@groundnuty/macf-channel-server` as the MCP server bridging HTTP `/notify` / `/health` / `/sign` endpoints (per DR-015) into Claude Code via MCP stdio. With Claude Code 2.1.118's `type: "mcp_tool"` hook surface (per DR-023), the channel server gains a new responsibility: **expose MCP tools for hook invocation**.

**No new package.** Tools live in the same `@groundnuty/macf-channel-server` package — registered via `server.registerTool` (per `/modelcontextprotocol/typescript-sdk` v1.x). The same process that handles HTTP-mediated routing also handles in-process hook-driven tool calls.

UC-1 (`notify_peer` Stop hook, per DR-023) is the first tool to ship. UC-2/3/4 ship in follow-up cycles.

**No version-pinning consequence for the npm-dispatch flow.** `npx -y @groundnuty/macf-channel-server` continues to fetch the latest matching version; the tool surface is additive within the v0.x series. If breaking changes to the tool surface ever happen, the major-version bump (v1.x) carries the discontinuity per Amendment D's lock-step versioning rule.

Cross-ref:

- DR-015 amendment (two surface types: HTTP endpoints + MCP tools)
- DR-023 (full mcp_tool hook architecture)

### Amendment L — Sigstore TLOG race recovery + pre-flight collision check (added 2026-05-18)

The `v0.2.25` publish on 2026-05-18 surfaced a structural failure mode in the multi-package publish-with-provenance workflow: **sigstore's transparency log (TLOG) is append-only**, so retrying a failed publish at the same tag/version produces a `TLOG_CREATE_ENTRY_ERROR (409)` on any package whose attestation entry was already submitted in the failed run. Witness chain:

1. **First run** aborted on pre-existing test flakes (5s vitest timeouts in `update.test.ts` + `check-lgtm-gate.test.ts`; intermittent GitHub anon-API rate-limit during plugin-version resolution).
2. **Retry by tag-recreate** (`git push origin :refs/tags/v0.2.25` + retag + push) — tests passed (confirming the flakes), but the sigstore TLOG entries from the prior run's `npm publish --provenance` step blocked the retry's attestation on `@groundnuty/macf-channel-server@0.2.25` with a 409. `@groundnuty/macf-core@0.2.25` + `@groundnuty/macf@0.2.25` had already published cleanly in the retry's first two steps before the 409.
3. **Result**: a structurally broken split-publish — `@groundnuty/macf@0.2.25` on npm declares dep on the non-existent `@groundnuty/macf-channel-server@0.2.25`. Consumer `npm install -g @groundnuty/macf@0.2.25` fails on dep resolution.
4. **Recovery**: bump to `v0.2.26` (identical content; just a different version-string tag) → re-publish all three → clean. Orphan `0.2.25` versions deprecated via the operator-side `npm-deprecate.yml` workflow dispatch.

**Why retry-by-tag-recreate is structurally broken**: sigstore's TLOG is a [Rekor](https://github.com/sigstore/rekor)-based transparency log; entries are append-only by design. The same tarball content (same hash → same attestation payload) produces the same TLOG entry; the second attempt to write it gets a 409 duplicate-rejection. There is no operator action that "clears" the prior TLOG entry within useful timescales — Rekor entries persist indefinitely.

**Structural defense (lands with this amendment via macf#377)**: the `publish.yml` workflow now includes a **pre-flight registry collision check** that runs after the per-package `package.json` version check and BEFORE any `npm publish` step. It queries the npm registry for each package's current `dist-tags.latest`; if any of the three matches the about-to-publish target version, the workflow fails with an actionable error message:

```
::error::@groundnuty/macf-channel-server@0.2.25 is ALREADY at the target version on npm — refusing to retry.
::error::Likely cause: a prior publish run partially succeeded (sigstore TLOG race during retry-by-tag-recreate).
::error::Recovery: bump all three packages to the next patch version + re-tag + push.
```

This catches partial-publish recovery cleanly: the workflow refuses to enter the publish steps if the registry is already mid-state for the requested version. Dry-run is exempt (no real publish would happen; the check would otherwise block valid dry-run iteration on the current released version).

**Recovery procedure (canonical, codified):**

When a publish workflow fails partway through AND any of the three packages successfully published before the failure (you'll see this when the pre-flight check fires the next time, OR when consumer install paths break):

1. **Don't retry by tag-recreate** — the sigstore 409 blocks it for any package that submitted its TLOG entry in the failed run, structurally.
2. **Bump all three `package.json` versions** to the next patch (e.g. `0.2.25` → `0.2.26`). Content is otherwise identical to the broken release.
3. **Update the cross-package dep refs** — `@groundnuty/macf` + `@groundnuty/macf-channel-server` both declare a dep on `@groundnuty/macf-core` at the lock-step version (per Amendment D); bump those declared versions too.
4. **Update CHANGELOG** documenting the bump-recovery (operator-facing transparency). Pattern: a section noting the sigstore-TLOG-race causality + content-identical republish + cross-link to the broken intermediate version's deprecation status.
5. **Commit + new tag (e.g. `v0.2.26`) + push** — pre-flight check passes (no collision; the new version isn't on npm); publish proceeds cleanly across all three.
6. **Verify all three published**: `curl -sfL https://registry.npmjs.org/@groundnuty/<pkg> | jq -r '.["dist-tags"].latest'` for each.
7. **Deprecate orphaned partially-published versions** via the operator-side `npm-deprecate.yml` workflow_dispatch (App lacks `actions: write` until DR-019 Amendment A lands; operator runs the dispatch by hand). Skip the package(s) that DIDN'T publish in the broken cycle — there's nothing to deprecate.
8. **Mirror the new version to `macf-marketplace`** — skip the broken intermediate.

**Sibling test-flake stabilization** (also macf#377): the first-run failure that triggered the entire recovery chain was caused by pre-existing test flakes in CI's publish workflow. Two specific test files reproduce 5s vitest timeouts intermittently — `packages/macf/test/cli/update.test.ts` (`returns 1 when config has no versions section (legacy)`) + `packages/macf/test/hooks/check-lgtm-gate.test.ts` (`allows merge when gh is not on PATH (worst-case missing tool)`). Root-cause hypothesis: GitHub anon-API rate-limit (60 req/h shared across all CI runs in the org) during plugin-version resolution. The fix lifts the per-test timeout from the global 5s to 30s for the affected cases; root-cause stabilization (mocking the version-resolution path) tracked separately for follow-up.

**Cross-references:**

- Incident witness: macf#371 (the /sign rename PR whose release hit this), macf#377 (the follow-up hazard tracking issue this amendment closes)
- Failed runs: `gh run view 26062478419` (first attempt; test flake) + `gh run view 26062643159` (retry; sigstore 409)
- Recovery run: `gh run view 26062830815` (v0.2.26 publish; clean)
- Memory: `reference_sigstore_tlog_recovery.md` + `feedback_sigstore_tlog_race_on_retry.md`

### Amendment M — AgentCard schema proto-alignment (added 2026-05-19)

Phase 1 (`groundnuty/macf#370` / v0.2.24) shipped the AgentCard discovery endpoint with a Zod schema hand-rolled from the spec docs page (a2a-protocol.org). Phase 2c (`groundnuty/macf#393`) re-verified against the canonical proto source (`a2aproject/A2A:specification/a2a.proto` per spec § 1.4 — "the single authoritative normative definition") and surfaced structural drift between Phase 1's lenient parse-friendly shape and the proto-canonical required-field set.

**Structural changes shipped in v0.2.30 (Phase 2c release):**

- **REMOVED top-level `id`** — proto has no `AgentCard.id` field. Phase 1 emitted `${project}-${agentName}` as a synthesized id; canonical clients don't expect it.
- **REMOVED top-level `url`** — proto has no `AgentCard.url`. The endpoint URL relocates to `supportedInterfaces[0].url` per the canonical `message AgentInterface` model.
- **ADDED `description` as required** (was optional in Phase 1; proto says `[REQUIRED]`).
- **ADDED `supportedInterfaces` as required** (`repeated AgentInterface` per proto field 3 `[REQUIRED]`). Each entry: `url`, `protocolBinding` (`"JSONRPC"` for MACF), optional `tenant`, `protocolVersion` (`"1.0"`).
- **ADDED `defaultInputModes` + `defaultOutputModes` as required** (proto fields 10+11 `[REQUIRED]`, `repeated string`). MACF advertises the conservative pair `["text/plain", "application/json"]`.
- **AgentSkill: `description` + `tags` upgraded from optional to required** per proto fields 3+4 `[REQUIRED]`. All MACF skills already populated these fields in Phase 2a; just enforcing in the schema.

**Why the proto is the source of truth, not the docs page:** the spec text says "spec/a2a.proto is the single authoritative normative definition of all protocol data objects and request/response messages" (§ 1.4). The docs page (a2a-protocol.org) is a surveyed/summarized view that can drift from the canonical proto — Phase 1's research-step trusted the docs page and missed the required-field set. The Phase 2c verification re-pulled the proto directly.

**Migration risk (consumer-facing):**

- Pre-flight grep on 2026-05-19 across `macf-{code,science,devops}-agent` + `macf-testbed` workspaces confirmed ZERO external consumers of Phase 1's AgentCard shape — Phase 1 shipped ~24h prior (v0.2.24 on 2026-05-18); no integration window for downstream parsers to lock in to the old shape.
- The strict-validation regression test (`test/integration/a2a-python-sdk.test.ts:"strict-validation: all proto-required AgentCard fields present on SDK-parsed shape"`) pins the canonical-shape invariant against the real Python `a2a-sdk` v1.0.3 parser; future drift fails loud at CI time, not at runtime against external clients.

**`/macf/sign` exclusion invariant preserved:** Phase 1's DR-010 Path 2 invariant — `/macf/sign` MUST NOT appear in the AgentCard `skills` list — survives Phase 2c. Live cryptographic attestation stays MACF-only; A2A-spec clients SHOULD NOT depend on it. Source-level test continues passing.

**Cross-references:**

- Phase 2c driver: macf#393 (this work)
- Phase 1 (drift source): macf#370 + PR #375 (v0.2.24)
- Phase 2a (immediate prior): macf#390 + PR #391 (v0.2.29)
- Canonical proto: `a2aproject/A2A:specification/a2a.proto`
- Memory: `feedback_map_design_proposals_to_spec_sections.md` (proto-vs-docs source-of-truth principle)

### Amendment N — OIDC Trusted Publishers replaces long-lived npm token (added 2026-05-20)

The 5-iteration recovery arc 2026-05-19T21:30Z → 2026-05-20T03:04Z (`groundnuty/macf#368`) demonstrated that long-lived granular access tokens accumulate hidden state with multiple silent failure modes. The recovery's final success (v0.2.32) was via **architectural pivot to npm OIDC Trusted Publishers**, not via fixing the token. This amendment codifies OIDC as the canonical CI-publish authentication mechanism for MACF's `@groundnuty/macf{,-core,-channel-server}` packages.

**Recovery arc as the empirical witness:**

| Iteration | Outcome | Root-cause layer |
|---|---|---|
| v0.2.29 (Phase 2a release-cut) | FAIL npm 404 PUT | Token-acquisition: scope/identity mismatch hypothesis |
| v0.2.30 (Phase 2c+2b bundle) | FAIL identical npm 404 | Token-acquisition: same |
| v0.2.31 (Phase 2d+3 bundle) | FAIL npm EOTP | Token-capability: "Bypass two-factor authentication" missing on regenerated token |
| **v0.2.32 (recovery release)** | **SUCCESS** | **Authentication-mechanism: OIDC Trusted Publishers pivot** |

Each layer's hazard was UNDISCOVERABLE before its predecessor surfaced. Token-capability (v0.2.31 EOTP) was on the candidate-causes list since v0.2.29 (`#368` 22:01Z surfaced 5 candidates including "2FA-bypass missing") but only confirmed empirically after token regeneration. This is the **substrate-evolution-cadence pattern** at the release-pipeline layer — sister to the 4-iteration cadence v0.2.1→v0.2.4 (multi-agent-coordination layer) documented in `project_substrate_evolution_release_cadence.md`.

**OIDC Trusted Publishers — structural benefits over long-lived tokens:**

| Aspect | Long-lived token | OIDC Trusted Publishers |
|---|---|---|
| Auth secret on GitHub | Yes (`NPM_TOKEN`) | None |
| Rotation lifecycle | Per-token-expiry + per-scope-edit + per-2FA-policy-change | Eliminated |
| 2FA-bypass surface | Per-token capability (silent fail when missing) | Eliminated (OIDC IS the auth) |
| Audit trail | Token-as-actor (account-level) | Workflow-as-actor (org/repo/workflow-level) — finer-grained |
| Failure mode at publish time | `404` / `EOTP` / `Bad credentials` (3+ distinct modes catalogued) | Reduced surface (trusted-publisher contract violations) |
| Recovery cost when broken | Token regen + capability-config audit + NPM_TOKEN secret rotation | Trusted-publisher relationship re-config (npm UI) |

**Workflow changes shipped during the recovery (canonical pattern for future packages):**

- **`f0fdcd0`** — `npm@11.14.1` user-prefix install in publish workflow. OIDC needs npm 11.5.1+; Node-bundled npm on Ubuntu runners may be older. Canonical pin form:

  ```bash
  npm install -g --prefix ~/.npm-global npm@11.14.1   # PINNED; bump explicitly when needed
  ```

  **Do NOT use floating tags** (`npm@11.x` / `npm@latest`) — silent bumps as npm 11.y.z releases violate the pin-discipline the recovery arc itself surfaced (per `feedback_no_floating_tags_in_ci_pins.md`).

- **`ff485d9`** — bare `npm publish` (not `devbox run -- npm publish`). Precise mechanism (worth capturing for future maintainers):
  - Devbox uses Nix's **read-only** store at `/nix/store/.../lib`; `devbox run -- npm install -g npm@X` hits `EACCES` on `mkdir` there
  - User-prefix install (`--prefix ~/.npm-global`) sidesteps the read-only path
  - **Inside** `devbox run --`, devbox prepends nix-store paths to `PATH` → devbox's `npm@10.8.3` (devbox-pinned) takes precedence over the user-prefix `npm@11.14.1`
  - **Outside** `devbox run --`, the runner's `GITHUB_PATH` puts `~/.npm-global/bin` first → upgraded npm wins

  Rule: **bare `npm publish` for OIDC** (need npm 11.5.1+); **`devbox run --` for everything else** that depends on devbox's pinned Node toolchain. Follows from the asymmetric PATH-stacking, not just generic "PATH override."

- **`acfdede`** — post-publish attestation verify uses `.dist.attestations.url` (canonical), NOT `.dist.attestations.provenance.url` (false-positive shape that breaks CI verification step).

**Permissions required on the workflow:**

```yaml
permissions:
  contents: read
  id-token: write   # OIDC token issuance for npm Trusted Publishers
```

**npm-side configuration:**

Package admin (operator role) configures the trusted-publisher relationship in npm UI:

1. npmjs.com → Package → Settings → Trusted Publishers → Add Publisher
2. Provider: GitHub Actions
3. Repository owner: `groundnuty`
4. Repository: `macf`
5. Workflow filename: `.github/workflows/publish.yml`
6. Environment: (blank; or `production` if env-gated)

**Sigstore TLOG orphan accounting (live empirical evidence):**

| Version | logIndex | Outcome |
|---|---|---|
| v0.2.25 | 1573948960 | Sub-shape A (sigstore-409-on-retry, test-flake) |
| v0.2.29 | 1575263520 | Sub-shape B (npm-404-after-sigstore-success) |
| v0.2.30 | 1575475073 | Sub-shape B |
| v0.2.31 | 1576145129 | Sub-shape B (EOTP) |
| v0.2.32 | (valid attestation) | SUCCESS |

5 cumulative orphans (4 from the recovery arc; sigstore TLOG is append-only by design). v0.2.25 had npm-published orphans (`@groundnuty/macf{,-core}@0.2.25`) requiring future `npm-deprecate.yml` workflow_dispatch; v0.2.29/v0.2.30/v0.2.31 never reached npm — nothing to deprecate npm-side.

**Migration recommendation for existing macf-adjacent packages:**

Future MACF packages (e.g., if `@groundnuty/macf-marketplace` or `@groundnuty/macf-actions` adopts npm publish) SHOULD use OIDC from the start. Existing packages on token-based publish can migrate opportunistically (not urgent unless a token-class failure surfaces) — the workflow change is reversible.

**Cross-references:**

- Recovery arc thread: `groundnuty/macf#368` 2026-05-19T21:30Z → 2026-05-20T03:04Z
- Workflow commits: `f0fdcd0` + `ff485d9` + `aad5a15` + `acfdede` (all merged 2026-05-20T~02-03Z on `main`)
- Sister-class canonical-rule: `silent-fallback-hazards.md` Instance 9 (sigstore TLOG orphans; merged via PR `#403`)
- Prior gotcha: `reference_npm_token_bypass_2fa.md` (science-agent memory; 2026-04-22 DR-022 bootstrap)
- Substrate-evolution-cadence pattern: `project_substrate_evolution_release_cadence.md` — release-pipeline layer is the third arc instance
- OIDC pattern adopter: `feedback_oidc_trusted_publishers_for_npm.md` (science-agent memory; 2026-05-20)

### Amendment O — Legacy `notify_peer` envelope sunset criterion: Option A (counter-based) (added 2026-05-20)

Per Phase 4 (`groundnuty/macf#405` + PR `#409`) which surfaced three sunset criterion options for the legacy `POST /notify` envelope path (used by `notify_peer` MCP tool pre-A2A; see DR-023 UC-1), operator selected **Option A — counter-based** on `groundnuty/macf#368` 2026-05-20T~23:35Z.

**Sunset criterion (formal codification):**

> The legacy `POST /notify` envelope path is sunset when **no `notify_peer` legacy-path invocations have been observed for 60 consecutive days** across all known MACF deployments. Observation is via the `macf.outbound.protocol: 'legacy'` span attribute count in Tempo (per Phase 3 #407 wiring; observed via the release-hygiene Grafana dashboard's macf-release-hygiene UID per `groundnuty/macf-devops-toolkit#74` + `#77`).

**Rationale (per Phase 4 design doc `design/phases/P-A2A-phase-4.md § Step 4`):**

- **Option A (selected)**: usage-driven sunset; avoids premature removal while ANY consumer still uses the path. Sister-shape to feature-flag-removal discipline (`feature.is_used()` returning false for N days → safe to remove).
- Option B (calendar-based, e.g., 2026-09-30): rejected — forcing-function discipline carries risk of breaking still-active callers.
- Option C (phase-completion-based + 30 days): also viable but A is purer (no Phase-5-execution dependency on the criterion itself).

**Observation procedure:**

1. **Baseline establishment** (Phase 5 execution step 7): once CV consumer fleet migrates to v0.2.32+ (Phase 5 ACs 1-3 satisfied), the legacy-invocation count baseline is established. Query Tempo periodically:

   ```
   {macf.outbound.protocol="legacy"} | rate() over [1d]
   ```

   When this rate goes to zero, the 60-day observation window starts.

2. **60-day observation window**: continuously monitor the legacy-invocation rate. Any non-zero observation in the window resets the timer.

3. **Sunset trigger**: at end of 60 consecutive zero-rate days, a sunset-execution PR removes the legacy `/notify` envelope handler from `macf-channel-server` source. The removal PR will:
   - Reference this Amendment O in its body
   - Cite the specific Tempo query results establishing the 60-day zero observation
   - Update `silent-fallback-hazards.md` Instance 6 + `gh-token-attribution-traps.md` to mark their `notify_peer` references as historical-witness-only with the sunset date
   - Bump the channel-server version (breaking change for any straggling legacy callers; expected zero per the criterion)

**Out of scope for this amendment:**

- Actual sunset-execution PR (triggered when criterion fires; not pre-scheduled per Option A's usage-driven discipline)
- Phase 5 8-item checklist execution (separate; tracked via `groundnuty/macf#406`)
- Future Phases beyond #406 if additional consumer-fleet onboarding surfaces (Phase 5 pattern generalizes per `design/phases/P-A2A-phase-5.md § Out of scope`)

**Cross-references:**

- Phase 4 (sunset criterion options): `groundnuty/macf#405` + PR `#409` (`design/phases/P-A2A-phase-4.md § Step 4`)
- Phase 5 (CV consumer-fleet migration; baseline-establishment step): `groundnuty/macf#406` + PR `#410` (`design/phases/P-A2A-phase-5.md § AC 5 + AC 7`)
- Phase 3 (protocol selection + `macf.outbound.protocol` span attr): `groundnuty/macf#396` + PR `#407` (`packages/macf-channel-server/src/notify-peer.ts § dispatchToPeer`)
- DR-023 UC-1 (legacy `/notify` envelope shape that this amendment prepares to sunset)
- Master tracking: `groundnuty/macf#368` — operator decision recorded 2026-05-20T~23:35Z
- Release-hygiene dashboard: `groundnuty/macf-devops-toolkit:macf-release-hygiene` Grafana UID (#74 + #77 shipped 2026-05-20)

### Amendment P — channel-server mounts via project `.mcp.json` (`server:`), not the plugin's `mcpServers` (added 2026-06-28, spike-proven `macf#641`; stdio-coupling + Path-B `macf#642`/#643)

**The channel-server moves from the plugin manifest's `mcpServers` to a project `<ws>/.mcp.json` MCP server.** Spike-proven on auditor (2026-06-28): native Claude Code channel-push **never worked for any macf agent** because a `--plugin-dir`-mounted plugin's channel id is `plugin:<name>:<server>` (e.g. `plugin:macf-agent:macf-agent`), and the `--dangerously-load-development-channels` dev-flag **rejects** that colon-triple form; the `plugin:<name>@<marketplace>` form is allowlist-enforced (incompatible with project-isolation); **only `server:<name>` — a manual `.mcp.json` MCP server — is dev-flag-loadable for a non-allowlisted channel** and stays project-scoped. (This is why every agent's only working delivery all along was the tmux-wake fallback, masking the dead native path — see silent-fallback-hazards Instance 15.)

- **Mechanism:** `macf init/update` writes `<ws>/.mcp.json` with `macf-agent` = `npx -y @groundnuty/macf-channel-server@<pinned>` **plus the OTEL env block** (env does NOT inherit across the MCP spawn boundary — `macf#422` — so the telemetry config must live in the `.mcp.json` server's `env`, not be assumed-inherited). `mcpServers` is **stripped from the plugin manifest**; the plugin keeps skills/agents/hooks/rules via `--plugin-dir`. Launcher keeps `--dangerously-load-development-channels server:macf-agent` (now resolves). Settings `enabledMcpjsonServers: ["macf-agent"]` pre-approves so launch doesn't stall on the server-approval prompt.
- **The version pin moves with it (supersedes the plugin-manifest pin for the channel-server):** the `@<pinned>` in the `.mcp.json` `npx` args is now the channel-server's pin (DR-013's plugin-versioning no longer governs the channel-server; it still governs the `--plugin-dir` plugin's skills/agents/hooks/rules). Lock-step versioning (Amendment D) still holds across the three npm packages.
- **Tool namespace flips** (see DR-023): `mcp__plugin_macf-agent_macf-agent__*` → `mcp__macf-agent__*`; Stop-hook `server:"plugin:macf-agent:macf-agent"` → `"macf-agent"`; pre-approved permission patterns updated in lockstep.

**Stdio-coupling fragility + Path B (the deeper architectural finding, `macf#642`/#643).** The `.mcp.json` server is still a **stdio MCP child of Claude Code** — so its survival is coupled to the main agent's activity: under heavy main-thread load CC stops servicing the stdio pipe, deems the connection dead, and kills the child, which is **never auto-respawned** (observed: code-agent's server died silently at 7.4 h under ~880k-token load; science's idle server ran 9.5 h). **The `.mcp.json` mount does NOT fix this** (stdio either way). The decoupling fix is **Path B — migrate the channel-server to an HTTP/SSE MCP transport** (a separate, long-lived process whose lifecycle is not bound to CC's stdio servicing). `macf#643` (guaranteed file-based forensic log + top-level crash handlers, transport-independent) lands **first** as the diagnostic foundation that makes the current stdio deaths visible and verifies Path B. **DR-031 interaction:** the supervision watchdog's mTLS `/health` probe *detects* a stdio-starvation death and relaunches (HEAL), but a relaunched stdio server dies again under the same load — so HEAL is **bounded-downtime mitigation, not a fix**, until Path B decouples the lifecycle (noted in DR-031).

**Rollout (per `macf#641`):** spike ✓ → full `.mcp.json` config on ONE agent (auditor, already spiked) + **live-verify in a real TTY** (NOT `claude -p` — it can't see channel activation; the dev-flag + resume-summary prompts are interactive, `anthropics/claude-code#42486`) → fleet via `macf init/update` + relaunch. **Per-agent live-verify is mandatory** — the entire notification-death investigation is the monument to why offline/headless verification misses this.

Status note: this amendment records the spike-proven + operator-directed (`#641` "commit to native channels") design; the migration ratifies with DR-013/022/023 before the fleet rollout.
