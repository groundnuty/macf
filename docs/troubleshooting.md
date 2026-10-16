# Troubleshooting

Real failure modes catalogued from substrate operating experience + cv-e2e-test rehearsals. Each entry: symptom → diagnosis → fix → cross-reference. Source-of-truth for the hazard class is `design/silent-fallback-catalog.md`; this doc translates each instance into operator-actionable form.

## Quick lookup

| Symptom | Section |
|---|---|
| Agent hits "Do you want to create X?" prompt mid-session | [§ settings.json drift](#settingsjson-drift--writeedit-prompt-mid-session) |
| Routing succeeds (HTTP 200) but agent doesn't wake | [§ silent-fallback Instance 3](#silent-fallback-instance-3--rc-mode-blocks-tmux-send-keys) |
| Issue auto-closes when PR merges (wasn't supposed to) | [§ GitHub auto-close](#github-auto-close-keyword-instance-2) |
| `gh` operations attributed to your user, not the bot | [§ token attribution traps](#token-attribution-traps) |
| `macf doctor` warns on Write/Edit but they're in `settings.local.json` | [§ doctor false-positive (resolved)](#doctor-false-positive-resolved-in-v029) |
| Counter values 1/5 of expected in Prometheus | [§ counter-reset (resolved)](#counter-reset-resolved-in-v029) |
| `gh issue comment` blocked with "describing-context leak" | [§ Check B blocking legitimate use](#check-b-blocking-legitimate-use) |
| `gh issue comment` blocked with "zero routing-active mentions" | [§ Check A blocking legitimate use](#check-a-blocking-legitimate-use) |
| "Resource not accessible by integration" 403 | [§ App permission gap](#app-permission-gap-cross-repo-coordination) |

## settings.json drift — Write/Edit prompt mid-session

**Symptom:** agent in autonomous coordination hits an interactive permission prompt like *"Do you want to create cv-e2e-2026-04-22.tex?"* mid-test. Test stalls — autonomous agents can't dismiss interactive prompts without operator click-through.

**Diagnosis:** the workspace's `.claude/settings.json` (or `.claude/settings.local.json`) `permissions.allow` array is missing `Write` and `Edit`. Empirical example: cv-architect on `groundnuty/academic-resume` (cv-e2e-test rehearsal #11b, 2026-04-30) had `["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Bash(*)", "Agent", "mcp__*", "Skill(macf-agent:*)"]` — Bash was allowed (file ops via shell work, slow path), but Write tool calls fired the interactive prompt every time.

**Fix:** add `Write` and `Edit` to `permissions.allow`. Canonical placement is **`settings.local.json`** (operator-managed local override; Claude Code TUI doesn't auto-rewrite this file):

```bash
# .claude/settings.local.json
{
  "permissions": {
    "allow": [
      "Write",
      "Edit"
    ]
  }
}
```

Per Claude Code's canonical settings semantics ([macf#305](https://github.com/groundnuty/macf/issues/305) verified via <https://code.claude.com/docs/en/settings.md>), `permissions.{allow,deny,ask}` arrays MERGE/concatenate across `settings.json` + `settings.local.json` (not replace; opposite to scalar settings). So entries in `settings.local.json` extend the workspace allow list rather than overriding.

**Verify:**

```bash
macf doctor
```

Expected: `Workspace permissions (macf#296)` section shows `[PASS]` after Write + Edit are added. Pre-v0.2.9 the doctor read only `settings.json` (false-positive WARN even when entries lived in `settings.local.json`); post-v0.2.9 it reads the merged view.

**Investigation note** (per [macf#302](https://github.com/groundnuty/macf/issues/302)): cv-architect's substrate-side workaround is to add Write+Edit to `settings.local.json`. The original `settings.json` may have been getting overwritten by an external rehearsal-bootstrap path — not by `macf update`'s settings-writers (which round-trip operator-authored entries cleanly per the regression test in PR #303).

**Cross-references:** [`silent-fallback-hazards.md`](../design/silent-fallback-catalog.md) (sister-pattern at the Claude Code permission layer); [features.md § macf doctor](features.md#macf-doctor--three-section-report-v029).

## Silent-fallback Instance 3 — RC mode blocks `tmux send-keys`

**Symptom:** routing-Action workflow shows status "completed" + conclusion "success" (HTTP 200 from channel server in Stage 3, or `ssh ... tmux send-keys` exit 0 in Stage 2), but the recipient agent's TUI doesn't wake. Prompt arrives but isn't processed.

**Diagnosis:** the recipient TUI is in Remote Control (RC) mode. RC mode silently buffers `send-keys` input but doesn't process it. Stage 2 transport is most affected (SSH + `tmux send-keys` returns success when the keys arrive in the buffer; the recipient never sees them). Stage 3 transport reduces but doesn't eliminate the class — channel server's `/notify` returns HTTP 200 after running the result-invariant assertion that the prompt was injected, but if the TUI silently rejects the keystroke after injection, the assertion can return a false positive.

**Fix (Stage 3 / DR-020 wake mechanism):** `mTLS HTTPS POST /notify` against the channel server is the structural defense — Pattern A applied at the routing layer. The HTTP 200 is conditioned on the recipient's `onNotify` handler completing the wake, which includes a result-invariant check that the prompt landed in the recipient's session.

**Workaround (Stage 2 / substrate):** if you observe the silent-buffer pattern, attach to the recipient tmux session (`tmux attach -t <session>:<window>`) and verify the agent is responsive. If RC mode is engaged, exit it (Ctrl+b `:` then `set -g status`); send-keys should work afterward. Substrate workspaces remain on Stage 2 per operator directive 2026-04-27 — the workaround is operator-driven.

**Cross-references:** [`silent-fallback-hazards.md`](../design/silent-fallback-catalog.md) Instance 3; [DR-020](../design/decisions/DR-020-notify-wake-mechanism.md); [DR-017](../design/decisions/DR-017-ssh-elimination.md).

## GitHub auto-close keyword (Instance 2)

**Symptom:** issue closes automatically when its associated PR merges, but the issue author wasn't ready to close it (e.g., wanted to verify the fix on `main` first). Closure trail shows "closed by GitHub" with no human/agent action.

**Diagnosis:** the PR body contained a GitHub auto-close keyword (`Closes #N`, `Fixes #N`, `Resolves #N`, or any of 9 case-variants). GitHub's parser is case-insensitive + negation-blind + context-blind: `does not close #N` triggers auto-close anyway. Once a `<verb> #<number>` token is in the PR body, the issue gets closed on merge regardless of surrounding context.

The diagnostic signature is the merge-to-close gap: ~1 second between PR merge timestamp and issue close timestamp.

**Fix:** use **`Refs #N`** in PR bodies. Strip auto-close vocabulary entirely from any body about NOT closing or closure-discipline. The 9 variants to avoid: `Closes`, `Fixes`, `Resolves`, `Close`, `Fix`, `Resolve`, `Closed`, `Fixed`, `Resolved` — followed by `#N`.

```markdown
# WRONG (auto-closes #N on merge, even if you write text saying don't):
This PR does not close #N; only addresses one part.

# CORRECT:
Refs #N
```

**Recovery:** if auto-close fires unintentionally, reopen + acknowledge:

```bash
gh issue reopen <N> --repo <owner>/<repo> --comment "Reopened — auto-close fired on PR merge but verification incomplete."
```

**Cross-references:** [`coordination.md` Issue Lifecycle 1](../packages/macf/plugin/rules/coordination.md); `feedback_github_negation_blind_autoclose.md` (catalogued in operator memory).

## Token attribution traps

**Symptom:** `gh` operations show your user identity (`<your-username>`) instead of the bot (`<app-name>[bot]`) in commits, comments, and PR creations. Cross-agent routing breaks — peers don't @-mention "you" because they're addressing your bot, but your operations are landing as your user.

**Diagnosis:** `GH_TOKEN` is empty / null / a user token (`ghp_*`, `gho_*`, `ghu_*`) instead of a bot installation token (`ghs_*`). Common causes:

1. **Bare `gh token generate ... | jq` pattern** — if `gh token generate` fails, `jq` succeeds (no `pipefail`), `GH_TOKEN` becomes the string `"null"`, and every subsequent `gh` operation falls back to stored `gh auth login` as the user.
2. **Clock drift** — JWT signing fails ("could not be decoded"); machine clock skewed beyond GitHub's tolerance.
3. **Wrong App or installation ID** — token generation succeeds but for the wrong identity.
4. **Missing App permission** — token has `ghs_` prefix but lacks the permission for a specific endpoint; that one call 401s and `gh` falls through to user auth.
5. **Cross-repo cwd** — token helper called via relative path (`./.claude/scripts/macf-gh-token.sh`); path resolves against subdir cwd; helper not found; returns empty.

**Fix (immediate):** use the canonical fail-loud helper:

```bash
GH_TOKEN=$("$MACF_WORKSPACE_DIR/.claude/scripts/macf-gh-token.sh" \
  --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || exit 1
export GH_TOKEN
```

Use `$MACF_WORKSPACE_DIR/` (absolute) NOT `./` (relative). `claude.sh` exports `MACF_WORKSPACE_DIR` to the agent's workspace absolute path; helper invocations from any cwd find the helper.

**Fix (structural defense):** the `check-gh-token.sh` PreToolUse hook ([macf#140](https://github.com/groundnuty/macf/issues/140)) intercepts every `gh` and `git push` invocation; blocks (`exit 2`) if `GH_TOKEN` lacks `ghs_` prefix. Distributed by `macf init` to every workspace. Catches `sudo gh`, `bash -c "gh ..."`, `bash -xc`, `GH_TOKEN=x gh`, etc. Override (use sparingly): `MACF_SKIP_TOKEN_CHECK=1 gh ...` for one knowingly user-attributed operation (e.g., `gh auth login` during onboarding).

**Verify identity:**

```bash
GH_TOKEN=$GH_TOKEN ./.claude/scripts/macf-whoami.sh
```

Expected: `bot installation token` for a `ghs_*` token. If you see a user login + non-zero exit, the trap fired — diagnose per the causes above.

**Cross-references:** [`coordination.md` Token & Git Hygiene](../packages/macf/plugin/rules/coordination.md); [`gh-token-attribution-traps.md`](../packages/macf/plugin/rules/gh-token-attribution-traps.md); [DR-019](../design/decisions/DR-019-app-permissions.md).

## Doctor false-positive (resolved in v0.2.9)

**Symptom (pre-v0.2.9):** `macf doctor` warns *"Write absent — autonomous coordination requires Write tool"* on a workspace that visibly has Write in `permissions.allow`. Operator's eye sees `cat .claude/settings.local.json` showing Write present.

**Diagnosis:** pre-v0.2.9 the doctor read only `.claude/settings.json` for the permissions check. Operator-canonical placement of Write/Edit is in `.claude/settings.local.json` (Claude Code TUI doesn't auto-rewrite this file; substrate-side `settings.json` sometimes IS auto-managed). The doctor missed entries in the local override file.

**Fix:** upgrade to v0.2.9+. PR #306 ([macf#305](https://github.com/groundnuty/macf/issues/305)) updated `getPermissionsAllow` / `getPermissionsDeny` to read the merged view of both files per Claude Code's canonical merge semantics (arrays union, scalars replace).

```bash
npm install -g @groundnuty/macf@latest
macf doctor   # now reads merged view; false-positive resolved
```

**Cross-references:** [features.md § macf doctor](features.md#macf-doctor--three-section-report-v029).

## Counter-reset (resolved in v0.2.9)

**Symptom (pre-v0.2.9):** Prometheus counter values for `macf_notify_received_total` / `macf_notify_peer_total` show ~1/5 of expected during scenario-08 N=5 sweeps. Range queries reveal counter trajectory dropping back to 0 between export cycles.

**Diagnosis:** OTel SDK was using CUMULATIVE temporality by default. Process restarts between export cycles produced zero-resets in the cumulative trajectory; Prometheus storage saw these as discrete drops, breaking `rate()` and `increase()` calculations across the test window.

**Fix:** upgrade to v0.2.9+. PR #308 ([macf#281](https://github.com/groundnuty/macf/issues/281) Phase 2) configures `OTLPMetricExporter` with `temporalityPreference: AggregationTemporality.DELTA`. Each export interval emits the increments-this-interval rather than running totals; process restarts produce independent delta points (not zero-resets); the OTel Collector aggregates by series identity to reconstruct cumulative — robust to N-process / restart topologies.

**Verify:** counter trajectories should now be monotonically non-decreasing across process restarts. Phase 1 doc workaround (`sum(increase(metric[range])) by (labels)` in PromQL) becomes obsolete post-fix.

**Cross-references:** `silent-fallback-hazards.md` Instance 7; [DR-021](../design/decisions/DR-021-otel-instrumentation.md).

**Operator-side check:** the OTel Collector config in `groundnuty/macf-devops-toolkit`'s central-collector CR needs to handle DELTA-temporality counters. Prometheus is fundamentally cumulative, so the collector's `prometheusremotewrite` exporter needs `aggregation: cumulative` or equivalent cumulative-rebuild configured. Verify if metrics start showing strange shapes post-upgrade.

## Check B blocking legitimate use

**Symptom:** `gh issue comment <N> --body "..."` blocks with `BLOCKED by MACF mention-routing-hygiene hook: this comment contains raw @<bot>[bot] mention(s) in describing-context (mid-line, not backticked)`.

**Diagnosis (most common):** legitimate describing-context use of an `@<bot>[bot]` handle, where the recipient agent should NOT receive a routing ping. Example: a status report quoting another agent's prior work.

**Fix:** wrap the handle in backticks. Per `mention-routing-hygiene.md` §5:

```markdown
# WRONG (mid-line raw mention triggers routing):
The @macf-tester-2-agent[bot] response was clean.

# CORRECT (backticks suppress routing):
The `@macf-tester-2-agent[bot]` response was clean.
```

**Diagnosis (single-line --body false positive):** known heuristic limitation. `gh issue comment N --body "@<bot>[bot] please review"` flags because the addressing form starts mid-line (after `--body "`, no preceding newline). The canonical idiom puts addressing on its own line in multi-line bodies. Fix:

```bash
# Multi-line body via heredoc — addressing line at start
gh issue comment <N> --body "$(cat <<EOF
@<bot>[bot] please review
EOF
)"
```

**Override (rare; for genuinely legitimate edge cases):** `MACF_SKIP_MENTION_CHECK=1 gh issue comment <N> --body "..."`. Rule of thumb: if you're frequently using the override, your phrasing probably needs adjusting — the hook catches an actual recurring discipline class.

**Cross-references:** [`mention-routing-hygiene.md`](../packages/macf/plugin/rules/mention-routing-hygiene.md) §7; [features.md § PreToolUse hooks](features.md#pretooluse-hooks-path-2-structural-enforcement).

## Check A blocking legitimate use

**Symptom:** `gh issue comment <N> --body "..."` blocks with `BLOCKED by MACF mention-routing-hygiene hook: this comment has zero routing-active @<bot>[bot] mentions. Per coordination.md §Communication 1: "Put an @mention in every comment, because routing depends on it. A comment that only closes your own issue needs none."`.

**Diagnosis:** the comment body has no addressing-active `@<bot>[bot]` mention (or only backticked describing-form mentions, which are routing-suppressed). Per [`coordination.md` §Communication 2](../packages/macf/plugin/rules/coordination.md), comments without addressing don't reach peers — they're silently invisible.

**Fix:** add an addressing mention to the recipient peer:

```bash
gh issue comment <N> --body "$(cat <<EOF
@<recipient-handle>[bot] PR is ready for review.
EOF
)"
```

If the recipient is the issue reporter, use `gh issue view <N> --json author --jq '.author.login'` to identify them, then `@<author-name>` in the comment.

**Override (rare; legitimate no-recipient cases):** `MACF_SKIP_MENTION_CHECK=1` for self-status posts on already-closed issues, test-orchestration scratch comments, etc. Same caveat as Check B: frequent override use means your discipline needs adjusting.

**Subcommand bypass:** `gh issue close --comment "..."` and `gh pr close --comment "..."` bypass Check A (self-close verification comments are canonically reporter-internal — no recipient required). Check B still applies on close subcommands.

**Cross-references:** [`mention-routing-hygiene.md`](../packages/macf/plugin/rules/mention-routing-hygiene.md) §7; [features.md § PreToolUse hooks](features.md#pretooluse-hooks-path-2-structural-enforcement).

## App permission gap (cross-repo coordination)

**Symptom:** `gh issue comment` / `gh pr comment` returns `Resource not accessible by integration (HTTP 403)` on a repo where you've successfully read state (`gh issue view` worked). Sister-bot routes a notification to you; you can READ but can't reply.

**Diagnosis:** the agent's GitHub App is installed on the target repo, but with insufficient permissions. Common gap: install allows reads (needed to receive routing notifications) but lacks `pull_requests: write` / `issues: write`.

The diagnostic signatures:

- `gh api /repos/<owner>/<repo>/pulls/<n> --jq '.title'` returns 200 (read works) → install is present
- `gh pr comment <n> --body "test"` returns 403 (write fails) → permission gap

**Fix (immediate):** post the substantive content on a repo where you DO have write access; cross-reference the original. For cross-repo coordination via macf-devops-toolkit (substrate observed gap as of 2026-04-30), relay the comment via `groundnuty/macf` or `groundnuty/macf-testbed` (where code-agent has full write).

**Fix (structural):** the operator (App admin) installs the App with the canonical 7 permissions per [DR-019](../design/decisions/DR-019-app-permissions.md): `metadata`, `contents`, `issues`, `pull_requests`, `actions_variables`, `workflows`, `actions`. Each consumer of the App must accept the new permissions on their workspace.

**Verify:**

```bash
macf doctor   # surfaces all DR-019 gaps + the diagnostic for which permission is missing
```

**Cross-references:** [DR-019](../design/decisions/DR-019-app-permissions.md); [features.md § macf doctor](features.md#macf-doctor--three-section-report-v029).

## Closure-direction inversion (recurring rule-application discipline)

**Symptom:** science-agent (or another peer) tells you to "self-close as reporter" after merging your PR — but the issue's `gh issue view --json author` shows them as the filer.

**Diagnosis:** confidence-bypass on the verification step. The clarifier in `coordination.md` §Issue Lifecycle 1 (case-table per [PR #304](https://github.com/groundnuty/macf/pull/304)) covers the four `{filed, implemented} × {self, peer}` cases explicitly. When the close-handoff comes mid-review as a passing remark, the implicit "implementer = closer" heuristic can win over the case-table check if the verify step isn't invoked.

**Fix:** unconditionally run `gh issue view <N> --json author --jq '.author.login'` on EVERY close-handoff, regardless of subjective confidence. If the result is YOUR login, self-close. If it's the peer's login, post `@<peer> ready for you to close when verified` and STOP.

**The four cases per [`coordination.md`](../packages/macf/plugin/rules/coordination.md) Issue Lifecycle 1:**

| You filed? | You implemented? | You merged? | Who closes? |
|---|---|---|---|
| YES | YES | YES | **You** (case 1: filer + implementer + merger; self-close) |
| YES | NO (peer impl) | NO (peer merged) | **You** (case 2: filer; peer's action ends at merge-handoff) |
| NO (peer filed) | YES | YES | **Peer** (case 3: filer; you @-mention them, do NOT close) |
| NO (peer filed) | NO (peer impl) | NO (peer merged) | **Peer** (case 4: observer) |

The substitution-mistake pattern: confusing "I implemented" with "I'm the reporter." Both directions of the inversion exist:

- **Failure mode A** — closing someone else's issue because you implemented the fix
- **Failure mode B** — telling the implementer to self-close YOUR issue because they merged the fix (the inversion this section addresses)

**Cross-references:** [`coordination.md` Issue Lifecycle 1](../packages/macf/plugin/rules/coordination.md); PR [#304](https://github.com/groundnuty/macf/pull/304) Inversion warning section.

## Stale CLI dist (npm-link dev installs)

**Symptom:** `macf <subcommand>` produces unexpected behavior or missing flags; CLI behavior doesn't match what's in `packages/macf/src/`.

**Diagnosis:** the linked CLI is loading from a stale `dist/`. Cause: source code modified without rebuilding. `make -f dev.mk check` only runs `typecheck`, not `build` (intentional, post-[macf#127](https://github.com/groundnuty/macf/issues/127)) — so `make check` passing doesn't mean `dist/` is current.

**Fix:**

```bash
macf self-update   # pulls origin/main + rebuilds dist/ in one step
# or just rebuild without pulling:
make -f dev.mk build
```

**Detect:** [macf#144](https://github.com/groundnuty/macf/issues/144) added stale-dist detection. `macf update` warns when the installed CLI's `dist/` is behind the source repo's HEAD (build-info stamp comparison).

**Cross-references:** [features.md § CLI surface](features.md#cli-surface).

## Devbox publish cwd trap

**Symptom:** `devbox run -- npm publish` from inside `packages/macf/` publishes the workspace ROOT package instead of `@groundnuty/macf`. Wrong package version goes live.

**Diagnosis:** `devbox run` resets cwd to the project root before running the inner command. `cd packages/macf && devbox run -- npm publish` ends up running `npm publish` from project root, not from the package subdir.

**Fix:** use `npm publish --workspace=<package-name>` from the root:

```bash
# From project root:
devbox run -- npm publish --workspace=@groundnuty/macf
```

**Cross-references:** `feedback_devbox_monorepo_publish_cwd.md` (catalogued in operator memory).

## Cross-references for the broader hazard class

The 8-instance silent-fallback hazard catalog lives in [`design/silent-fallback-catalog.md`](../design/silent-fallback-catalog.md). For new failure modes that share the "surface succeeds; outcome fails" shape, surface them there as new instances with a Pattern A-E defense classification.

For sister discipline-class catalogs:

- [`gh-token-attribution-traps.md`](../packages/macf/plugin/rules/gh-token-attribution-traps.md) — token-identity hazards
- [`mention-routing-hygiene.md`](../packages/macf/plugin/rules/mention-routing-hygiene.md) — routing leak/missing class
- [`pr-discipline.md`](../packages/macf/plugin/rules/pr-discipline.md) — PR review/merge discipline
- [`coordination.md`](../packages/macf/plugin/rules/coordination.md) — cross-cutting rules

For escalation paths when a hazard isn't yet catalogued: file an issue on `groundnuty/macf-science-agent` so the canonical hazards rule can be updated.
