---
name: macf-bootstrap
description: Optional conversational front-end for provisioning a MACF fleet (DR-035, repositioned by DR-043). Gathers the fleet's spec by Q&A, writes it as fleet.yaml, and invokes the deterministic macf bootstrap plan|apply CLI to provision it — per-agent GitHub Apps, repos, routing secrets, per-project CA, and the age-encrypted vault. Invoke to onboard a new MACF fleet (any project, any number of agents) when you'd rather answer questions than hand-author fleet.yaml. The CLI never drives a browser; App creation and the initial App install still need two clicks per App in the operator's OWN browser (GitHub has no API for either — see DR-044 Decision 1). Operator-privileged; run only in the dedicated macf-bootstrap workspace.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# macf-bootstrap — the conversational front-end to `macf bootstrap plan|apply`

You are running in the **operator-privileged `macf-bootstrap` workspace** (DR-035).
You act **AS the operator's GitHub account** — the deliberate inverse of the fleet
attribution discipline — because two GitHub steps are chicken-and-egg: a scoped bot
App cannot create the App that would let it act as itself. Read
`.claude/rules/macf-bootstrap-safety.md` first for the workspace's operator-privilege
posture; **its browser-driving rail description is legacy** (see the note at its top)
— read on below for what actually still needs a browser.

> **What changed, and why this file is short now (DR-043, 2026-08-11, operator-ratified).**
> The provisioning *mechanism* moved to a deterministic CLI core —
> `macf bootstrap plan|apply`, driven by a declarative `fleet.yaml` manifest
> (schema: `packages/macf/src/cli/bootstrap/fleet-manifest.ts`; narrative:
> `design/decisions/DR-043-declarative-fleet-provisioning.md` §D1–§D3). **This skill
> is repositioned as an optional conversational front-end** (DR-043 §D2): it exists
> only to turn a Q&A interview into a `fleet.yaml` file and then hand off to the CLI.
> It no longer drives a browser itself — no Chrome DevTools MCP, no debug-Chrome
> profile-copy dance, no URL-allowlist rail to police a browser it isn't driving. The
> CLI opens the operator's **own, ordinary** browser to a `localhost` redirect for the
> two GitHub steps that remain human-only (App creation, App install) and polls the
> result via the App's own JWT — see DR-043 §D2 and DR-035's 2026-08-11 amendment
> ("Amendment (2026-08-11, DR-043) — CLI-core repositioning") for the full narrative.
> If you'd rather hand-author `fleet.yaml` directly and skip this Q&A entirely, that
> is equally valid — the CLI doesn't care which produced the file.

> **A constitutional floor this whole flow respects (DR-044 Decision 1):**
> *creating and installing a GitHub App is a capability no credential can hold* —
> GitHub exposes it only to a human at a browser, and no amount of automation ever
> removes that. A fleet cannot be created unattended, ever, by construction. Nothing
> below tries to route around that; it collapses everything else that *can* be
> automated so those two clicks per App are the operator's only manual work.

Follow this procedure **in order**.

---

## Step 1 — Validate the environment (best-effort; stop loud on a critical gap)

```bash
"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-validate-env.sh"
```

This checks `gh` authenticated as a **USER** token (NOT a `ghs_` bot — the CLI runs
Mac-side, operator-privileged, per DR-043 §D4) plus `age`/`age-keygen`/`jq`. **Ignore
its Chrome-DevTools-reachability line** — that check predates the CLI-core move and is
a best-effort warning either way (it never blocks the run); this skill no longer needs
a debug Chrome at all. A non-zero exit is still a CRITICAL gap on the checks that do
matter (`gh` as a user, `age` present) — stop and report it to the operator.

> **`$CLAUDE_PROJECT_DIR` must be set.** If it's empty (launched outside the harness),
> `export CLAUDE_PROJECT_DIR="$(pwd)"` first — the macf-bootstrap workspace root.

Also confirm `macf --version` satisfies this workspace's declared
`compatibility.macf` range (`.claude-plugin/plugin.json`) — `bootstrap-validate-env.sh`
enforces this too; a too-old CLI is refused rather than silently emitting broken
`fleet.yaml`/output.

---

## Step 2 — Q&A intake (gather the fleet's spec)

Ask the operator **interactively** for the spec `fleet.yaml` needs. These are
spec-gathering questions, **not** per-action approvals. Each maps directly onto a
`FleetManifestSchema` field (`packages/macf/src/cli/bootstrap/fleet-manifest.ts`):

1. **Fleet / project name** (e.g. `icsoc-2026`) → `metadata.name` — lowercase
   kebab-case; this also derives the fleet's dedicated control-plane repo,
   `<name>-control` (DR-043 Amendment F — see the vault note below).
2. **For each agent** (repeat until the operator says done):
   - **`role`** — the bare `<role>-agent` routing label (e.g. `code-agent`), **never**
     the project-prefixed App handle. Per DR-032/DR-043's Amendment-F-preceding lesson
     (macf#791 — the icsoc routing outage), the App handle `<project>-<role>` is
     *derived*, never written — and as of DR-043 the schema makes the old #1
     provisioning trap **structurally unrepresentable**: `role` starting with the
     fleet-name prefix is a rejected manifest, not an operator discipline point
     (`FleetManifestSchema`'s `superRefine`, same file).
   - **`profile`** — the role template's profile (`research` / `code` / `paper-latex`
     / …), applied VM-side.
   - **`repo`** (`owner/repo`) — created from `defaults.role_template` unless
     `provenance: mirror` (an existing dir, e.g. an Overleaf-backed paper repo, that
     `apply` remote-adds + pushes to instead of cloning).
   - **`deploy_path`** — the filesystem path that will run the agent. **Implicitly the
     LOCAL host** (DR-037 Amendment D, macf#1018) — the manifest has no field naming
     *which* host, so a multi-host fleet still runs the materialize step separately on
     each remote host (Step 5 below), not via a single `apply` invocation from the Mac.
3. **Owner** — `owner.account` + `owner.type` (`user`|`org`) + `owner.registry` (a
   `RegistryConfigSchema` value: `{type: profile, user: …}` / `{type: org, org: …}` /
   `{type: repo, owner: …, repo: …}`).
4. **Advertise host** — `network.advertise_host`, the tailnet FQDN the channel servers
   advertise (or `127.0.0.1` for same-host-only).
5. **Age recipient(s)** — `transport.age_recipients`. **Operator-provided, never
   tool-minted** (DR-043 Amendment C — this is the fleet's master secret; the tool
   must never generate or print it). `[]` is valid syntactically but means "refuse to
   create" — `apply` hard-refuses opening any consent gate with no recipient
   (Amendment C's `wouldCreateWithNoRecipient` pre-flight). The operator runs
   `age-keygen` out-of-band and gives you the **public** recipient(s) only; a VM
   recipient joins later, when that host exists (Amendment C's first-run note).
6. **Tailscale OAuth** (optional) — if this fleet's routing needs it,
   `transport.tailscale_oauth_required: true` makes `apply` refuse *before* gate 1 on
   a fleet that can't route, rather than spending a browser click on one that can't
   (macf#1074). The credential itself is never stored in the manifest.
7. **Runner** (only if this fleet uses a self-hosted GitHub Actions runner) —
   `routing.runner.runs_on` / `.labels` / `.warm`. Declaring `runs_on: self-hosted`
   is what makes a missing `--runner-token` a refusal at apply time (DR-043 Amendment
   H). **`warm` is recorded but not yet enforced** — `apply` doesn't act on it yet
   (`plan` surfaces this honestly as `NOT IMPLEMENTED BY APPLY`, never silently).

Write the answers to a `fleet.yaml` file (e.g. `./.bootstrap-work/fleet.yaml`) matching
the schema. There's no bundled example file — cite the live schema
(`packages/macf/src/cli/bootstrap/fleet-manifest.ts`) or DR-043 §D1's worked example
for the shape; **the schema's `superRefine`/`.strict()` validation is authoritative
over any example**, including DR-043 §D1's own (that section still shows a
`transport.vault_repo` field the schema no longer has — Amendment F removed it; the
vault now always lives in the fleet's own `<name>-control` repo, never an agent's).

---

## Step 3 — Preview: `macf bootstrap plan`

```bash
macf bootstrap plan -f ./.bootstrap-work/fleet.yaml
```

Read-only end to end: parses the manifest, observes current GitHub-side state, and
renders the reconcile plan (create / confirm-then-update / report-extra — **never**
delete; DR-043 §D3). Without `--vault --identity-key`, App/install existence is
observed from `fleet.lock` only and reads **honest-`unknown`**, never a guessed
`present`/`absent` (DR-043 Amendment A's epistemic floor — the identity plane can
confirm *present*, never prove *absent*). Narrate the plan to the operator; nothing
is mutated by this step.

---

## Step 4 — Approve + apply: `macf bootstrap apply`

```bash
macf bootstrap apply -f ./.bootstrap-work/fleet.yaml \
  [--vault <path> --identity-key <path>] \
  [--runner-token <token>]     # only if routing.runner.runs_on: self-hosted
```

`--dry-run` renders the plan plus the exact App manifests that would be submitted,
mutating nothing — useful as a last check before spending a browser click.

Without `--dry-run`, `apply` shows the same plan-approve-once artifact, takes **one**
operator approval (interactive prompt, or `--yes` for automation), then runs
end-to-end: control-repo provisioning (first, before any consent gate — a failure
there aborts before anything else is touched) → per agent: ensure-repo →
confirm-before-create → **consent gate 1** (App creation) → **consent gate 2** (App
install) → `repo-init` → the routing (`runner-ops`) App's own gate 1/gate 2 → the
single whole-payload vault write → `fleet.lock`. See
`packages/macf/src/cli/bootstrap/apply-fleet.ts`'s module doc for the exact,
tested sequence.

**The two consent gates are the whole of the operator's manual work, and they happen
in the operator's own, already-logged-in browser** — no debug Chrome, no profile
copy, no Chrome DevTools MCP:

1. **App creation** — the CLI serves a self-submitting manifest form on `localhost`,
   opens the browser there; the operator clicks **Create**; GitHub redirects to
   `localhost` with a temporary `code`; the CLI exchanges it directly
   (`POST /app-manifests/{code}/conversions`) for `app_id` + the private-key PEM —
   no manual key download, ever.
2. **App install** — the CLI opens the install page; the operator picks
   **"Only select repositories"** (never "All repositories") and clicks **Install**;
   the CLI confirms the result by polling `GET /app/installations` with the App's own
   JWT — no reading a redirect URL off a page.

> **Watch the repository picker (`groundnuty/macf#1128`, open at time of writing).**
> GitHub's install page defaults to nothing forced — choosing **"All repositories"**
> by mistake silently grants that App DR-019's full permission set on *every* repo in
> the account/org, not just this fleet's. `apply` already refuses this for the
> dedicated routing (`runner-ops`) App (`apply-runner-ops.ts::validateRunnerOpsInstall`)
> — as of this writing, the same post-gate-2 check is **not yet wired for ordinary
> agent Apps** (that's #1128's ask). Until it lands, double-check the picker yourself
> on every install click.

Never silently creates a duplicate App (confirm-before-create guard) and never
silently overwrites an existing vault (fails loud unless `MACF_BOOTSTRAP_VAULT_VERSION=1`
— the operator's explicit opt-in to an intended version bump).

---

## Step 5 — Materialize each agent's workspace: `apply`'s deploy phase, or `macf fleet deploy`

`apply` runs a **default deploy phase** after the GitHub-side work above, when given
`--vault --identity-key` — for each agent it decrypts the vault, clones `repo` into
`deploy_path` (or reuses it if present), writes the agent's App key + the per-project
CA, and delegates to the real `macf init` (never reimplemented). `--no-deploy` skips
it; without `--vault --identity-key` it's skipped anyway, loudly, not silently.

**This only reaches hosts local to wherever `apply` itself ran** — `deploy_path` names
a filesystem path, not a remote host (DR-037 Amendment D). For a fleet where the
operator's Mac provisions but the agents run on a different machine (the common
shape — see `use-cases/scientific-paper-fleet.md`), run the equivalent command
**on each target host** after getting the vault + age key there:

```bash
# On the target host, after the vault (via the control repo) + the age key (out-of-band, e.g. scp) are present:
macf fleet deploy -f fleet.yaml --agent <role> --vault <path/to/secrets/vault.age> --identity-key <path/to/age-key>
```

This is the modern equivalent of the old "`git clone` the science repo, hand-paste a
filled-in `macf init` command" hand-off — one idempotent command per agent, delegating
to `macf init` the same way the local deploy phase does. It does not launch the agent
(`./claude.sh`) — that's still the operator's own step, same as always.

---

## The vault now lives in the fleet's own control repo, not an agent's

`apply`'s first act (before any consent gate) is provisioning `<fleet-name>-control` —
a dedicated, operator-owned repo with **no fleet agent granted write** at the
platform-permission level believed originally (DR-043 Amendment F), corrected since
to "**no agent write can land** on its protected branch" via branch protection
(Amendment M — GitHub App permissions are per-App, not per-repo, so "installed but
read-only" was never actually expressible; the guarantee now rests on a branch
protection rule `apply` is designed to assert, though as of this writing that
assertion is **not yet implemented** — Amendment M1 flags its own absence explicitly).
`fleet.yaml`, `fleet.lock`, and the age-encrypted `secrets/vault.age` all live there.
There is **no `transport.vault_repo` field any more** — the location is derived, not
configured, so it can't be pointed at an agent's own repo by mistake.

---

## Retiring or reviving a fleet

Not this skill's job to walk through in detail — the CLI carries a four-rung teardown
ladder (`macf fleet deactivate` / `archive` / `delete-apps` / `destroy`, DR-043
Amendment G), each rung named by what reviving it costs the operator in browser
clicks, down to zero for the first two rungs (the vault + surviving Apps make revival
pure reconciliation). See `macf fleet --help` and DR-043 Amendment G for the current
detail — it, too, has moved since this file was last synced with it.

---

## Gotcha — `ssh -n` silently discards a heredoc

If you (or the operator) hand-write a remote step piping a heredoc into `ssh` — e.g.
running `macf fleet deploy` on a remote host over SSH — **do NOT use `ssh -n`**. The
`-n` flag redirects stdin from `/dev/null`, so the heredoc body is **silently
discarded**: the remote shell reads EOF immediately, runs nothing, and `ssh` exits
**0** (a clean-looking no-op). Canonical form omits `-n`:

```bash
# WRONG — -n discards the heredoc; remote runs nothing, exits 0 (looks fine):
ssh -n <vm> 'bash -s' <<'REMOTE'
  macf fleet deploy -f fleet.yaml --agent code-agent --vault ... --identity-key ...
REMOTE

# RIGHT — no -n; the heredoc reaches the remote shell's stdin:
ssh <vm> 'bash -s' <<'REMOTE'
  macf fleet deploy -f fleet.yaml --agent code-agent --vault ... --identity-key ...
REMOTE
```

---

## What this file does NOT cover any more, and why

The pre-DR-043 version of this file drove the operator's Chrome directly (via the
Chrome DevTools MCP) through the App-manifest form and the install flow, read the
post-redirect URL off the page to capture the exchange `code`, and hand-assembled the
vault plaintext via inline shell before piping it to `bootstrap-build-vault.sh`. All
of that mechanism moved into the CLI (`manifest-flow-server.ts` serves the
`localhost` redirect; `identity-confirm.ts` polls the JWT; `vault-write.ts` is the one
writer) — this file no longer needs to narrate it, and doing so would just be a
second, driftable copy of what the code already does. The workspace's browser-rail
scripts (`check-bootstrap-url-allowlist.sh`, `bootstrap-rail-selftest.sh`,
`.mcp.json`'s Chrome DevTools MCP entry) are **left in place, unused by this
procedure** — `groundnuty/macf#877` scoped their removal separately from this
rewrite.

**This rewrite has not been walked live end-to-end** — DR-043 continues under active
amendment (through Amendment O as of 2026-08-21) and a repeatable live-smoke
(`groundnuty/macf#869`) is still open. Expect rough edges on a first real run, and
report them the same way the pre-DR-043 dogfood loop asked for.

---

## Reminders

- **No per-command approval** beyond the two consent gates + the single plan approval
  — `apply` itself owns that flow now; this skill narrates, it doesn't re-implement
  the gate.
- **Never** attempt a destructive GitHub op outside the teardown ladder above.
- **No plaintext vault on disk by construction** — the CLI's vault writer never
  materializes plaintext to a file; only the fleet-scoped operator key can decrypt
  `secrets/vault.age` (DR-043 §D4/§D5, Amendment D's read-only-decryptable model).
