# Fleet Deployment Runbook

**Status:** Active runbook — the operator-facing companion to
[`DR-043`](decisions/DR-043-declarative-fleet-provisioning.md).
**Audience:** an operator taking a fleet from nothing to a routing, running set
of agents using `macf bootstrap` / `macf fleet`.
**Scope:** this document is instructions, not a changelog. Internal issue
numbers appear only where they pin a fact against the exact PR that shipped
it — skip them on a first read.

## Why this document exists, and why it is one file, not two

Every defect that motivated writing this runbook came from a **non-happy
path**: an omitted optional field with no visible effect until routing died,
a cancelled consent gate, two fleets sharing an owner account. A guide that
only walked the happy path would have prevented none of them. So this
document is deliberately **one file with two reading modes**, not a short
tutorial plus a separate long reference:

- Read **§1–§4** top to bottom the first time you provision a fleet. That is
  the complete happy path, and it is short enough to follow while typing.
- Treat **§5 onward** as the reference you drop into mid-provisioning: every
  flag, every manifest field and its default, every environment variable,
  every exit code, and every non-happy path this fleet family has actually
  hit. Each step in §1–§4 links down to the reference section that covers it.

A split into two files was considered and rejected: a reference that lives
apart from the runbook goes stale exactly the way this issue exists to fix —
one file means one place to keep current, and `--help` (§5) is *always*
correct even if this document lags, because it is generated from the same
source this document was written from.

**Everything below is derived from the schema in
`packages/macf/src/cli/bootstrap/fleet-manifest.ts`, the command definitions
in `packages/macf/src/cli/index.ts`, and the modules under
`packages/macf/src/cli/bootstrap/`** — never from another doc, and never from
DR-043's own §D1 example, which predates several amendments (see the callout
in §6). Where a fact could not be confirmed from source or a live run, it is
marked **unverified** rather than guessed.

---

## 1. Credentials you must supply — decide these before you start

`macf bootstrap apply` provisions almost everything for you, but **three
credentials cannot be provisioned by any tool** — they must exist before you
run `apply`, or the run refuses (by design, not by omission):

| Credential | Where it's supplied | Why the tool can't mint it |
|---|---|---|
| **The fleet's age key** | `transport.age_recipients` in `fleet.yaml` — the **public** recipient string(s) only | DR-043 Amendment C: the age private key decrypts the *entire* vault (every App's private key, the CA key). It is the fleet's master secret. If the provisioning tool minted it, the tool would have held the fleet's master secret at some point — the opposite of the custody model this whole design exists to hold. Run `age-keygen` yourself, out-of-band, and paste only the `age1…` public line into the manifest. |
| **Tailscale OAuth client ID + secret** | Only ever lives in the fleet's vault, written by hand or via a future vault-write path — **no `apply` flag accepts it directly today** | No vault has ever held it and GitHub Actions secrets are **write-only** — once it's on a repo, nothing (not even the operator) can read it back out. It cannot be *recovered*, only *supplied*, every time. |
| **A GitHub Actions runner-registration token** | `--runner-token <token>` or `MACF_BOOTSTRAP_RUNNER_TOKEN` | It's a one-hour-lived, per-request token from `POST /orgs/<org>/actions/runners/registration-token` — nothing durable to store. Mint one right before you run `apply`. |
| **The Tailscale OAuth pair** | `--ts-oauth-client-id <id>` + `--ts-oauth-secret <secret>`, or `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID` / `MACF_BOOTSTRAP_TS_OAUTH_SECRET` | **Supply both or neither.** Required whenever `transport.tailscale_oauth_required: true` — routing cannot function without it. On a **fresh organisation there is nothing to inherit**: no vault holds it, and GitHub Actions secrets are write-only, so a value already set on a sibling repo cannot be read back. A flag/env value wins over one restored from a vault. |
| **The runner-platform endpoint** (only if `routing.runner.runs_on: self-hosted`) | `MACF_RUNNER_PLATFORM_ENDPOINT` (env, per-run override) → the **scope's shared Actions variable** (the normal case, see below) → `transport.runner_platform_endpoint` in `fleet.yaml` (narrow per-fleet override) → unconfigured (non-fatal — see §6.5) | **A VARIABLE, not a secret** — a tailnet address; reachability is the access control, not obscurity. **Supply it once per scope, not once per fleet:** `gh variable set MACF_RUNNER_PLATFORM_ENDPOINT --org <org> --visibility all --body http://<host>:<port>` (or `--repo`/user-profile scope for a non-org fleet) makes every fleet on that scope — including ones that don't exist yet — inherit it for free. `plan` names which of the four sources actually supplied it before you approve `apply` (groundnuty/macf#1211). |

**`age_recipients: []` is not "no key" — it is the literal instruction "no key
exists yet, mint one."** Since Amendment C, the tool refuses that outright
rather than complying: an unconfigured `age_recipients` on a fresh fleet is a
**hard refusal before consent gate 1 ever opens** (`apply-fleet.ts`'s
`wouldCreateWithNoRecipient` check). If you see this refusal, run
`age-keygen`, put the printed `age1…` public key in the manifest, and re-run.
Keep the private key file — it is the only way anyone (including you) can
ever decrypt this fleet's vault again.

**A second recipient (the VM's own age key) joins the list once agents are
actually running** — DR-043 §D5/Amendment C: the vault must be decryptable by
*either* the operator's key (so a Mac-side re-run can read prior state) *or*
the VM's key (so `vault.sh` can decrypt at agent runtime). Don't wait for
this before your first `apply` — the operator's own key is sufficient for the
first run; the VM key is added once it exists.

---

## 2. The manifest, minimally

Every field below is **required** unless marked optional. This is the
smallest manifest that parses and provisions a two-agent fleet with no
self-hosted runner (github-hosted only):

```yaml
apiVersion: macf/v0
kind: Fleet
metadata:
  name: my-fleet                    # lowercase kebab-case; becomes the App-handle
                                     #   prefix and the control-repo name
owner:
  account: my-org                   # or your personal account
  type: org                         # 'org' | 'user'
  registry: { type: profile, user: my-org }   # see §6.2 for the other 3 forms —
                                     #   { type: org, ... } is REFUSED, see §7.5

network:
  advertise_host: my-tailnet-node.tailXXXX.ts.net

transport:
  age_recipients:
    - age1yourpublickeyhere...      # §1 — operator-run age-keygen, never []

defaults:
  role_template: my-org/agentic-repo-template
  app_manifest: dr-019              # accepted by schema; currently UNCONSUMED
                                     #   downstream — see §6.3

agents:
  - role: code-agent                # bare role, NOT the derived App handle — see §6.4
    profile: engineering            # currently UNCONSUMED downstream — see §6.4
    repo: my-org/my-fleet-code-agent
    deploy_path: /home/ubuntu/repos/my-fleet/my-fleet-code-agent
  - role: science-agent
    profile: research
    repo: my-org/my-fleet-science-agent
    deploy_path: /home/ubuntu/repos/my-fleet/my-fleet-science-agent
```

**If this fleet needs to route through a self-hosted runner** (the trap this
runbook exists because of — see §7.1), add:

```yaml
routing:
  runner:
    runs_on: self-hosted            # the ONLY value that means anything today;
                                     #   omit the whole `routing:` block for
                                     #   github-hosted-only routing (see §7.1
                                     #   for what "omit" actually costs you)
    labels: [self-hosted, macf-vm]  # optional; cross-checked against what the
                                     #   router actually emits — see §6.5
    warm: 1                         # optional, defaults to 1 — see §6.5
```

For every optional field this schema accepts and what you get by not
deciding it, see **§6 — Complete manifest field reference**.

---

## 3. The click sequence

### 3.1 Draft and check the plan (no mutation, no browser)

```bash
macf bootstrap plan -f fleet.yaml
```

Read-only end to end. Renders a 3-verb reconcile plan — **create** /
**confirm-then-update** / **report-only** (never delete) — against whatever
already exists on GitHub. Re-run this any time; it never costs a click.

**Verify:** the plan text lists every App/repo/secret this run would touch.
If a section you expected is silently absent (most commonly: no routing
line at all), that is the manifest telling you something is undeclared —
go back to §2/§6 before proceeding, not after.

### 3.2 Dry-run the real thing

```bash
macf bootstrap apply -f fleet.yaml --dry-run
```

Renders the plan **plus the exact GitHub App manifests** that would be
submitted at gate 1. Mutates nothing. This is the last point at which a
mistake costs you zero clicks.

**Verify:** read the "Apps that would be created" block. Each App name must
be ≤ 34 characters (GitHub's hard cap — checked before this render; see
§8.6) and every planned name should be one you recognize.

### 3.3 Run it for real

```bash
macf bootstrap apply -f fleet.yaml
```

You'll see the full plan again, then **one approval prompt** — this is the
DR-043 "plan-approve-once" gate (`--yes` skips it for non-interactive runs).
Approve, and the run drives, per declared agent:

1. **Control-repo provisioning** (step 0, the very first mutation — see
   §6.1). Nothing else happens until `<fleet>-control` exists and holds a
   committed `fleet.yaml`.
2. **Confirm-before-create** — for each role, is there already a `fleet.lock`
   entry / a live App by this name? If yes, skip straight to (4) for that
   role (a **resumed** identity — see §7.6).
3. **Consent gate 1 — App creation.** A browser tab opens at a
   self-submitting App-manifest form. **Click Create.** The CLI captures the
   result via a localhost redirect — nothing to copy-paste.
4. **Consent gate 2 — installation.** A browser tab opens at the App's
   install page. **Click "Only select repositories," pick exactly the repos
   this App needs, click Install.** Never "All repositories" — see §7.2 for
   why that specific choice is enforced, not merely recommended. The CLI
   polls `GET /app/installations` under the App's own JWT until it sees the
   install (or you cancel — see §7.7).
5. Repeat (2)–(4) for every declared agent, then the account-shared **router
   App** (§6.5) and, if a self-hosted runner is declared, the **runner-ops
   App** — both driven through the same two gates.
6. **The vault write** — every credential minted or reused this run, in one
   whole-payload write to `secrets/vault.age` in the control repo.
7. **The routing secrets + trusted-actors publish** (§6.5, §7.1).
8. **The default deploy phase** — see §3.4.

**Verify after the run:** read the printed summary top to bottom — it names
every leg that needs your attention (never silently). Then run the full
**§4 checklist** — the summary and the checklist ask different questions and
neither substitutes for the other.

### 3.4 Deploy the agents

By default, `apply` also **materializes each agent's workspace** — clones
`repo`, writes its App key + the CA, delegates to the real `macf init` — but
**only on whatever host `apply` itself ran on** (`deploy_path` is a
filesystem path, not a remote-host address; see §6.1 `network.advertise_host`
vs `deploy_path`).

- **Single-host fleet** (the Mac that ran `apply` also runs the agents):
  nothing further to do — deploy already ran.
- **Multi-host fleet** (the Mac provisions; a VM runs the agents — the
  common shape): run `apply` with `--no-deploy` from the Mac for the
  GitHub-side work only, get the vault + age key onto the VM out-of-band
  (the control repo + `scp`/similar for the key), then on the VM:

  ```bash
  macf fleet deploy -f fleet.yaml --agent code-agent \
    --vault <path-to-vault.age> --identity-key <path-to-age-private-key>
  ```

  Once per agent. Idempotent — an already-materialized workspace is
  reported as skipped, not re-cloned.

**Verify:** row 6 of the §4 checklist.

---

## 4. The "is it actually working" checklist

**`macf-trial` — a real fleet in the `macf-experiment` org — is 3-of-6 on
this checklist right now, and reproduces every gap below.** The commands in
this table were run read-only against it while writing this runbook; output
is quoted verbatim where captured live, and marked accordingly otherwise.

| # | Component | How to prove it |
|---|---|---|
| 1 | **Apps + identities in vault** | `macf bootstrap status -f fleet.yaml --vault <vault> --identity-key <key>` — every declared role should read `confirmed`, not `unknown`/`skipped-unverified`. Without `--vault`/`--identity-key`, every identity row is honestly `unknown` (Amendment A's floor) — that is not a failure, it's the tool telling you it cannot see without the credential. |
| 2 | **Control repo** | `gh api /repos/<owner>/<fleet>-control` — must exist, `archived: false`. `gh api /repos/<owner>/<fleet>-control/contents/fleet.yaml` and `.../fleet.lock` must both return 200 (committed, not still local-only). |
| 3 | **CA + routing-client certs** | `gh variable list --repo <owner>/<fleet>-control \| grep CA_CERT` (registry leg) **and** `gh variable list --repo <owner>/<agent-repo> \| grep CA_CERT` (per-repo leg — DR-043 needs BOTH places, macf#806) **and** `gh secret list --repo <owner>/<agent-repo> \| grep ROUTING_CLIENT` — expect `ROUTING_CLIENT_CERT` + `ROUTING_CLIENT_KEY`. **Verified live on `macf-trial`:** both present on every agent repo and the control repo. |
| 4 | **Routing secrets** (the six `agent-router.yml` requires — §6.5) | `gh secret list --repo <owner>/<agent-repo>` — expect ALL SIX: `MACF_ROUTING_APP_ID`, `MACF_ROUTING_APP_KEY`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `ROUTING_CLIENT_CERT`, `ROUTING_CLIENT_KEY` (or the single bundled `MACF_ROUTING_BUNDLE` on a bundle-capable caller — see §6.5). **Verified live on `macf-trial`:** only `ROUTING_CLIENT_CERT`/`ROUTING_CLIENT_KEY` present — the other four are absent (§7.3, §7.4 explain the two independent reasons). **Also check** `gh variable list --repo <owner>/<agent-repo> \| grep MACF_TRUSTED_ACTORS` — **absent on `macf-trial`**, because no `routing:` block was ever declared (§7.1, live-reproduced). |
| 5 | **Self-hosted runners registered** (only meaningful if `routing.runner.runs_on: self-hosted` is declared) | Repo-level: `gh api /repos/<owner>/<agent-repo>/actions/runners --jq .total_count` — **verified live on `macf-trial`: `0`**. Org-level: `gh api /orgs/<owner>/actions/runners --jq .total_count` — needs `admin:org` scope; a `403` here is **honest-unknown, not "zero"** (§ DR-043 Amendment H2's own floor) — don't conflate a permission gap with a confirmed absence. If a runner-provisioning contract is wired (`MACF_RUNNER_PLATFORM_ENDPOINT`, §6.6), also check `gh variable list --repo <owner>/<agent-repo> \| grep MACF_TRUSTED_ACTORS` is present — its absence means routing falls back to GitHub-hosted regardless of whether a runner exists (§7.1). |
| 6 | **Deployed workspaces** | On the host that should be running each agent: `ls <deploy_path>/.claude` (workspace materialized) and `macf fleet status --dir <deploy_path>` (agent process actually alive + registered). A `deploy_path` that exists on a *different* host than the one you're checking from renders `unknown`, not `absent` — `macf bootstrap apply`'s own summary states this explicitly per agent (`remaining-deploy.ts`). |

**Reading the six rows together:** rows 1–3 are what `apply`'s GitHub phase
gets you on a clean run. Rows 4–5 are what "provisioned" does **not** imply —
a fleet can be 3-of-6 exactly like `macf-trial` and still print a clean,
successful `apply` summary, because a **skipped** routing leg and a
**zero-runner** count are not the same signal as a **failed** leg (see §8 for
the exact exit-code semantics this distinction rests on). Row 6 is a
separate axis again — "provisioned" (GitHub side exists) is not "deployed"
(a workspace was materialized) is not "running" (a process is alive and
registered). Treat all six as independent facts; a summary line claiming
"provisioned" asserts none of rows 4–6 by itself.

---

## 4a. Adding an agent to an already-provisioned fleet

**A different happy path from §1–§4 — those provision a fleet from nothing;
this scales one that already routes.** Everything below only applies once a
fleet has at least one working agent; a fleet's very first `apply` never
hits any of it. Live-exercised end to end scaling `macf-trial` from 2 agents
to 3 in the `macf-experiment` org.

### The click cost is not 2

Adding one agent costs the same 2 browser clicks as any new identity (§3.3
steps 3–4: gate 1 "Create," gate 2 "Install") **plus one more "Save" click
for every already-provisioned fleet-level App whose installation doesn't yet
cover the new agent's repo.** Today there are at most two such Apps:

| Fleet-level App | Declared when | Its expected repo set |
|---|---|---|
| `runner-ops` | `routing.runner.runs_on: self-hosted` (§6.5) | every declared agent's repo — grows every time you add one |
| the router App | `owner.registry` is `type: repo` or `type: profile` (§6.2) | the registry repo (fixed) — still checked, for the same live-membership reason |

So the ceiling is **2 (the new agent's own App) + 0, 1, or 2 more "Save"
clicks** — never a flat 2. Which of the two fleet-level Apps (if either)
actually need one depends on this specific run; `apply` computes it fresh
every time (see "The procedure," step 2) and opens only the gates that are
actually stale — never one per missing repo, one gate per App names its
whole missing set. **Because the router App is shared across every fleet in
an owner scope by default (§6.5, `transport.router_app_scope: 'shared'`),
that scope-wide install set only grows — the next fleet you scale in the
same scope inherits whatever coverage already exists, not a clean slate.**

### The procedure

1. **Get the current manifest, then append the new agent — matching the
   existing list-item indent exactly.** `agents:` entries are 2-space-indented
   list items (§2's example manifest); appending a new entry indented to
   match the *fields* of the previous entry (4 spaces) instead of its `- `
   marker changes what the YAML means, not always with a loud parse error —
   verify structurally with step 2 immediately after editing, before doing
   anything else. If you don't already have the fleet's current `fleet.yaml`
   locally:

   ```bash
   gh api /repos/<owner>/<fleet>-control/contents/fleet.yaml --jq '.content' | base64 -d > fleet.yaml
   ```

   Then append an entry shaped exactly like the existing ones (§6.3 field
   reference):

   ```yaml
   agents:
     - role: code-agent
       profile: engineering
       repo: my-org/my-fleet-code-agent
       deploy_path: /home/ubuntu/repos/my-fleet/my-fleet-code-agent
     - role: writing-agent          # the new entry — same "- " indent as above
       profile: docs
       repo: my-org/my-fleet-writing-agent
       deploy_path: /home/ubuntu/repos/my-fleet/my-fleet-writing-agent
   ```

2. **Plan with `--vault`/`--identity-key` — not bare `plan`.** This is the
   one command that shows you the widen-gate *before* you spend a click on
   it:

   ```bash
   macf bootstrap plan -f fleet.yaml --vault <path> --identity-key <path>
   ```

   Read the table for an `install_scope` row. `VERB=UPDATE, CONFIRM=yes`
   naming `runner-ops` or the router App's handle means that App will reopen
   its install page this run; the `REASON` column names the exact missing
   repo, e.g. *"App "my-fleet-runner-ops" is missing repository access to
   my-org/my-fleet-writing-agent — add exactly this repo under 'Repository
   access' … then click 'Save.'"* No such row (only `NOOP`s, or the section
   is silent) means no widen this time.

   **`macf bootstrap apply -f fleet.yaml --dry-run` will NOT show you this
   row** — its preview is computed before the widen-gate machinery runs, by
   design (it would otherwise have to reorder `apply`'s own gate flow).
   `plan` with the vault flags above is the only ahead-of-time view of a
   pending widen.

3. **Apply for real.** If the fleet declares `routing.runner.runs_on:
   self-hosted` (§6.5), mint a fresh runner-registration token first (§1 —
   one-hour TTL, needed again even if you minted one for this fleet before):

   ```bash
   macf bootstrap apply -f fleet.yaml --vault <path> --identity-key <path> \
     --runner-token <token>
   ```

   Approve the plan. The run drives, in order: the new agent's own gate 1 +
   gate 2 (§3.3 steps 3–4) — **then**, only once every agent identity is
   confirmed, it reopens gate 2 for each fleet-level App step 2 flagged.
   **Click "Save" on each one** — never "Install" again, the App already
   exists — and the CLI polls the same way gate 2 always does (10-minute
   budget, same cancel/resume semantics as §7.6/§7.7: a cancelled or timed-
   out widen is safe to retry, a re-run reopens only whatever is still
   stale). Control-repo labels for the new role are created automatically as
   part of this same run's control-repo sync — no separate click for that
   (verified in step 4 of "Verify," below).

4. **Deploy the new agent's workspace** — §3.4, unchanged by anything above.

### What you'll actually hit if you skip step 2, or click too slowly

**The new agent's own self-hosted runner never comes up, while its siblings
already show a healthy count.** Because the manifest declares
`routing.runner.runs_on: self-hosted`, `apply` waits for the new repo's
runner unconditionally, narrating progress as it goes (e.g. `waiting for the
runner requested THIS run to become usable for "<owner>/<new-agent-repo>" …
45s/600s elapsed; runner platform reports 0 available`). If the underlying
platform confirms a genuinely terminal state — not a startup delay, one that
plain polling will never clear — `apply`'s printed summary carries this
exact reason text for that repo:

    role/repo "<owner>/<new-agent-repo>": the runner-provisioning platform reports a TERMINAL
    failure for this repo's runner — FailedUpdateRegistrationToken (Updating registration
    token failed). This is not a startup delay; polling will not clear it. MACF_TRUSTED_ACTORS
    was NOT written; this repo continues routing on ubuntu-latest (billed on private repos)
    until the underlying provisioning problem is fixed (commonly: the fleet's GitHub App is
    not installed on the repo owner, so no registration token can be minted) and
    `macf bootstrap apply` is re-run.

That "GitHub App is not installed on the repo owner" line **is** the drift
step 2's `install_scope` row already named — `runner-ops` (the App that
mints the registration token) doesn't cover the new repo yet. **The fix is
step 3's widen click, not a retry of the same `apply` run** — re-running
`apply` without widening reproduces the identical failure, because nothing
about the App's install scope changed.

### Verify

```bash
# 1. No install-scope drift left.
macf bootstrap plan -f fleet.yaml --vault <path> --identity-key <path>
# expect: any `install_scope` row reads NOOP, reason text like
#   App "my-fleet-runner-ops" installation covers every repo the manifest declares (3 expected, 0 missing).

# 2. The new repo has a registered, usable runner (§4 row 5, same command).
gh api /repos/<owner>/<new-agent-repo>/actions/runners --jq '.total_count'
# expect: 1 (may still read 0 for a few minutes right after the widen click —
# that is provisioning latency, not a failure; re-check rather than re-running apply)

# 3. Routing is live for the new repo.
gh variable get MACF_TRUSTED_ACTORS --repo <owner>/<new-agent-repo>
# expect: non-empty, includes the new agent's bot login + the owner account login

# 4. The control repo's label queue has the new role.
gh label list --repo <owner>/<fleet>-control --json name --jq '.[].name'
# expect: includes the new agent's bare role, e.g. `writing-agent`
```

---

## 4b. Migrating a pre-control-plane fleet (macf#878)

**A third happy path, distinct from both §1–§4 and §4a — this one's Apps,
repos, and routing are already real on GitHub, but there is no
`<fleet>-control` repo, no committed `fleet.yaml`, and no `fleet.lock`.**
Three fleets are in this state as of writing: `macf`, `icsoc-2026`, and
`ppam-2026` — verified against the live registry, ruled in scope on
macf#878 (2026-08-12).

**`bootstrap apply` cannot be pointed at a fleet like this.** Its
`confirmBeforeCreateGuard` authorizes `create` for any role with no prior
`fleet.lock` entry — true of *every* role here — so it marches straight
into gate 1 and dies on GitHub's globally-unique App-name collision (a real
App already exists under that name). Loud, not silent, but the wrong tool.
Use the two commands below instead, which touch neither an agent's App,
install, or repo, nor the vault.

### The procedure

1. **Confirm each role's `owner/repo` binding.** Nothing in this tool can
   discover it live (enumerating an App installation's repos needs an
   install token this credential-free step never holds) — read it from the
   fleet's own routing config or ask its science agent. For the three
   fleets above, as directly observed on 2026-08-27:

   | Fleet | Roles → repo | Source |
   |---|---|---|
   | `macf` | code→`groundnuty/macf`, science→`groundnuty/macf-science-agent`, devops→`groundnuty/macf-devops-toolkit`, auditor→`groundnuty/macf-auditor-agent` | this repo's own `.github/agent-config.json` |
   | `icsoc-2026` | science→`groundnuty/icsoc-2026-science-agent`, code→`groundnuty/icsoc-2026-code-agent`, paper→`groundnuty/icsoc-2026-paper` | repo names only (naming convention + macf#878's role list) — this pass did not independently read `icsoc-2026`'s own `agent-config.json` |
   | `ppam-2026` | **out of scope — local-registry fleet** | Resolved (macf#1307, 2026-08-27): this is a **DR-024 local-registry fleet**, not a GitHub-routed one. `~/.macf/registry/ppam-2026.json` records **one** agent (`science-agent`, `repo=None`, `host=127.0.0.1`) — `repo=None` is correct for that mode, not a missing binding. The earlier "two permanent agents" reading came from `~/.macf/agents.json`, a 2-entry index spanning **all** fleets. The similarly-named `ppam-2026-mcp-onedata-replication-package` has no `.github/workflows` and is not a routing caller. **This procedure does not apply**: it assumes GitHub-hosted per-role agent repos, which this fleet has never had. Note `groundnuty` is a **User**, not an Organization, so `GET /orgs/groundnuty/...` returns 404 by construction — that 404 is not evidence about any fleet's registry. |

2. **Draft a manifest from live state:**

   ```bash
   macf bootstrap manifest scaffold --owner <org> --fleet <name> \
     --agent code-agent=<owner>/<repo> --agent science-agent=<owner>/<repo> ... \
     --out fleet.yaml
   ```

   Every field the tool cannot confirm is rendered as an explicit `# TODO`
   comment with the key *omitted* — never a placeholder value. `versions:`
   and `transport.age_recipients` are deliberately **never** scaffolded
   (Amendment L: declaring either converts today's observed drift into
   tomorrow's enforced intent, or falsely tells a future `apply` "no age key
   exists yet, mint one" for a fleet that already has one).

3. **Read the draft and fill every TODO by hand.** A clean YAML parse of the
   scaffold proves only well-formedness, never correctness — its
   observations come from the same `observer.ts` reads `bootstrap plan`
   would diff it against, so a `plan` run against an unreviewed scaffold
   agrees with itself by construction and proves nothing (this is
   `assert-the-wrong-path.md`'s Trigger-1 circularity, named for this exact
   scenario; no test in this codebase asserts "scaffold ⇒ empty plan," and
   this runbook doesn't either). `defaults.role_template` in particular is a
   project decision the scaffold refuses to guess at.

4. **Give the fleet its control repo:**

   ```bash
   macf bootstrap control-repo init -f fleet.yaml --json
   ```

   Create-or-reuse `<fleet>-control` and commit `fleet.yaml` as its first
   act — nothing else. Never opens a browser consent gate, never touches an
   agent's App/install/repo/`fleet.lock`, never touches the vault (verify
   against the command's own `--help` if this runbook and the CLI ever
   disagree). Idempotent: re-running against an already-migrated fleet
   makes no further GitHub writes (`status: "reused"`, `mutated: false`) —
   see `bootstrap-control-repo-init.test.ts`'s two `DECISIVE` cases for the
   proof. An existing-but-archived control repo, or a same-named repo that
   isn't this fleet's, is refused outright — never silently adopted or
   revived.

5. **Move the vault — an operator step this repo does not automate.**
   Per Amendment D, decrypting an existing vault is operator-privileged
   only; no command in this codebase performs the decrypt→re-encrypt→commit
   sequence, and this runbook does not invent one it hasn't verified. What
   is established: the destination is `<fleet>-control`'s `secrets/vault.age`
   (the only vault path `CONTROL_REPO_COMMIT_ALLOWLIST` permits, alongside
   `fleet.yaml`/`fleet.lock`/`.gitignore` — never `secrets/recovery`), and
   the re-encrypt should target the Amendment-B/C `age_recipients` list
   rather than the legacy single-recipient key. Remove the old
   `vault.age` from the fleet's agent repo via a normal, reviewed PR — never
   a force-push — and say in that PR's body that the encrypted copy remains
   in the repo's git history (acceptable by default; scrubbing it is a
   separate, optional operator call).

6. **Confirm the migrated layout parses:**

   ```bash
   macf bootstrap plan -f <fleet>-control/fleet.yaml --json
   ```

   Expect every role to read `create, LOW CONFIDENCE` — this migration path
   deliberately defers lock-seeding/identity-plane adoption to a later
   increment (macf#878 design point 4). A clean run here proves the
   manifest parses and the control repo is reachable, not that the fleet's
   identity plane has been "adopted."

### Sequencing

**Do `icsoc-2026` and `ppam-2026` first, `macf` last** — ruled on
macf#878 (2026-08-25), not carried in DR-043 itself. The first two are
lower-blast-radius rehearsals of the identical procedure; `macf` is the
substrate the migrating agent itself runs in, so a mistaken manifest there
converges the very machinery doing the converging. Scaffold `macf`'s
manifest early — while the other two are in flight — so it gets the
longest review exposure, but hold `control-repo init` for it until the
other two are done.

### Closure condition

This migration is complete for a fleet only once **all three** hold: the
control repo exists, its committed `fleet.yaml` has been reviewed
(TODOs resolved, `versions:`/`age_recipients` deliberately still absent
until an operator declares them), and the vault has moved. A repo existing
with an unreviewed scaffold committed verbatim does not count — see step 3.

---

## 5. Where `--help` beats this document

The CLI is under active amendment. Before trusting a flag's behavior against
this runbook, check the live source:

```bash
macf bootstrap --help
macf bootstrap apply --help
macf fleet --help
```

Everything in §6–§9 below was read directly out of
`packages/macf/src/cli/index.ts` and `packages/macf/src/cli/bootstrap/*.ts`
on this repo's `main` — but that source moves faster than this document will
be re-read. If the two disagree, source (and `--help`, generated from it)
wins.

---

## 6. Complete manifest field reference

Single source of truth: `FleetManifestSchema` in
`packages/macf/src/cli/bootstrap/fleet-manifest.ts`. The schema is
`.strict()` throughout — an unrecognized key is a loud parse error, never a
silently-dropped typo.

### 6.1 Top level

| Field | Required? | Default if omitted | Notes |
|---|---|---|---|
| `apiVersion` | required | — | must be the literal `macf/v0` |
| `kind` | required | — | must be the literal `Fleet` |
| `metadata.name` | required | — | lowercase kebab-case, must start with an alnum (`^[a-z0-9][a-z0-9-]*$`). Propagates into the derived control-repo name (`<name>-control`), every App handle (`<name>-<role>`), and the registry variable segment. |
| `versions.macf` / `versions.actions` | optional (whole `versions:` block) | omitted → no GitOps steering target; `apply` doesn't reconcile version drift for either plane | §D6/Amendment L: `versions.macf` is reconciled by `macf fleet upgrade` under a verify-green gate; `versions.actions` is reconciled by `macf repo-init` re-pinning the router workflow. `apply` **names the remedy and refuses to run it itself** — a version mismatch is Confirm-then-update, never silent auto-roll. |
| `owner.account` | required | — | the GitHub org or user login that owns the fleet |
| `owner.type` | required | — | `user` \| `org` — shapes the manifest-form URL and interacts with the router-App scope derivation (§6.5) |
| `owner.registry` | required | — | see §6.2 |
| `network.advertise_host` | required | — | the tailnet hostname other agents use to reach this fleet's channel servers; consumed by `macf fleet deploy` (`advertiseHost`) |
| `transport.age_recipients` | required (array; `.min(0)`, **not** `.min(1)`) | `[]` is the create-path REFUSAL trigger, never "skip minting" — see §1 | operator-supplied public keys only, never a private key, never tool-minted (Amendment C) |
| `transport.tailscale_oauth_required` | optional | `false` | declares that this fleet's router needs `TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET`; when `true` and the vault doesn't hold them, `apply` refuses **before gate 1** rather than spend a click on a fleet that can't route (§7.4) |
| `transport.router_app_scope` | optional | `'shared'` | `'shared'` (one router App per **owner scope**, reused across every fleet on that account) vs `'per-fleet'` (a dedicated router App for this fleet alone) — see §6.5, §7.3 |
| `transport.router_app_origin_fleet` | optional | omitted | provenance-only: names which fleet's vault this fleet's copy of a shared router credential came from. Purely a marker — declaring it changes no behavior; see §7.3 |
| `transport.runner_platform_endpoint` | optional | omitted | the LOWEST-precedence, narrowest tier of the runner-platform endpoint resolution — an escape hatch for a fleet that genuinely needs a different runner-provisioning platform than its scope's shared one, not the intended common path. A VARIABLE, never a secret — safe to commit to `fleet.yaml`. See §1 + §6.5 (groundnuty/macf#1211) |
| `defaults.role_template` | required | — | the GitHub template repo new agent repos are cloned from |
| `defaults.app_manifest` | required | — | **accepted by the schema but UNCONSUMED anywhere downstream today** (verified: zero non-schema, non-fixture references in source). Every real fleet uses the literal `dr-019` by convention; the DR-019 permission set is hardcoded in `app-manifest.ts` regardless of what this field says. Write `dr-019`; nothing currently reads it. |
| `agents[]` | required, `.min(1)` | — | see §6.3 |
| `routing.runner` | optional (whole `routing:` block) | **omitted → `MACF_TRUSTED_ACTORS` is never written, at all** | §7.1 — this is the trap. See §6.5 for the sub-fields. |
| `collaborators[]` | optional | omitted → no cross-fleet federation | DR-036/DR-041 cross-fleet guest trust. **Parsed but not reconciled** by `apply` today (day-2, per DR-043's use-case catalog) |
| `shared` | optional | omitted | `.strict()`, requires **both** `routing_app` and `ts_oauth` together. **Currently unconsumed** anywhere in the codebase — `transport.router_app_scope` is the field that actually carries the shared-vs-per-fleet choice (§6.5); this field predates that decision and is not wired to anything |
| `trust.ca` / `trust.federated_cas[]` | **removed** (groundnuty/macf#1201) | — | these two parsed but were never read by anything — the sharpest of the schema's inert fields, since their own doc comment described a CA-plan gating relationship that never existed. **A `fleet.yaml` that still declares a `trust:` section gets a targeted refusal at parse time**, naming the field and telling the operator to remove it — not a bare `.strict()` "unrecognized key." Fleet-level CA/federation trust is still an open design (`#810`); it is not re-added here ahead of that design's enforcement. A fleet gets its own CA unconditionally either way — nothing about CA provisioning depended on this section. |

### 6.2 `owner.registry` — the four forms

From `@groundnuty/macf-core`'s `RegistryConfigSchema` (a union, not a
`fleet-manifest.ts` type):

| Form | Shape | Works with `macf bootstrap apply` today? |
|---|---|---|
| `{ type: profile, user: <account> }` | personal-account registry | **Yes** — the substrate fleet uses this |
| `{ type: repo, owner: <o>, repo: <r> }` | a specific repo holds the registry vars | **Yes** — `macf-trial` uses this; the only form that works for an **org-owned** fleet today |
| `{ type: org, org: <o> }` | org-level registry vars | **No — refused before consent gate 1.** Every ordinary agent App's manifest derives its permissions solely from the DR-019 set, which contains **no organization-scoped permission at all**, so no App this tool provisions could ever read `GET /orgs/{org}/actions/variables/{name}` — independent of install scope. The refusal names both working alternatives above. |
| `{ type: local, path: <p> }` | DR-024 local-registry mode | Schema-legal, but this is the non-GitHub single-host mode — not the path a `macf bootstrap apply`-provisioned fleet exercises in practice |

**If you own an org-hosted fleet, use `{ type: repo, ... }` pointed at the
control repo (`<fleet>-control`) — never `{ type: org, ... }`.**

### 6.3 `agents[]` — one entry per agent

| Field | Required? | Default | Notes |
|---|---|---|---|
| `role` | required | — | the **bare** role (`code-agent`, not `<fleet>-code-agent`) — the App handle is *derived* as `<fleet-name>-<role>`, never declared. Writing the already-prefixed form is a parse-time rejection (the #791 double-prefix trap). Lowercase kebab, no leading/trailing/double dashes; must be unique across `agents[]`. |
| `profile` | required | — | **accepted by the schema but currently UNCONSUMED anywhere in `apply`/`deploy`.** Real fixtures show it is not a function of `role` (`science-agent` → `research`, but also `runner-ops` → `code` in one worked example) — write something meaningful for a human reader; nothing downstream reads it today. |
| `repo` | required | — | `owner/repo`; must be unique across `agents[]` |
| `deploy_path` | required | — | a **filesystem path on whatever host runs `apply`/`fleet deploy`** — there is no field naming *which* host, so this is implicitly local (DR-037 Amendment D) |
| `provenance` | optional | omitted (behaves as `'template'`) | `'template'` (default — clone `repo` from `role_template`) or `'mirror'` (an existing dir, e.g. an Overleaf-backed paper repo, that `apply` remote-adds + pushes to instead of cloning) |

### 6.4 The one thing this schema makes unrepresentable on purpose

The App **handle** (`<fleet-name>-<role>`, globally unique on GitHub) is
never a manifest field — there is no `app_handle` / `app_id` key on
`FleetAgentSchema` at all. Declaring one is a `.strict()` parse rejection.
This closes the #1 provisioning trap from the DR-035 field experience
(macf#791): a manifest that wrote the already-derived handle into `role`
would double-prefix on the next derivation.

### 6.5 `routing.runner` — the field this runbook exists because of

```yaml
routing:
  runner:
    runs_on: self-hosted
    labels: [self-hosted, macf-vm]
    warm: 1
```

| Field | Required? | Default | Notes |
|---|---|---|---|
| `runs_on` | required (once `routing:` is present) | — | the **only** value that means anything today is the literal `self-hosted`. **Omitting the whole `routing:` block is silently different from declaring it with any other value** — see §7.1. |
| `labels` | optional | omitted → the convention `[self-hosted, macf-vm]` applies uncross-checked | when given, this is a **cross-check** against what `macf-actions`' router actually emits on its self-hosted branch (`ROUTER_EMITTED_LABELS`, hardcoded to `['self-hosted', 'macf-vm']`) — a superset check, not the value that decides runner usability. Declaring a label set that DOESN'T carry both router-emitted labels is a **parse-time rejection**, not a runtime surprise (macf#934). |
| `warm` | optional | `1` | DR-009 §7.4: "latency above all; `warm: 1` is mandatory, not a default to tune." `0` is meaningful only for a fleet explicitly declared dormant. |

**Two independent mechanisms both gate on this block, and satisfying one
does not satisfy the other (§7.1's "silent cost" made concrete):**

1. **`MACF_TRUSTED_ACTORS`** — the trust-allowlist variable `pick-runner`
   reads to decide `ubuntu-latest` vs `[self-hosted, macf-vm]`. Written
   **only after** `apply` confirms a usable runner exists (register-before-
   route, DR-043 Amendment H.1) — gated by `--runner-token`
   (§7's flag reference) deciding whether `apply` even *attempts* detection.
2. **The runner-provisioning contract** (its endpoint resolved per §1's
   flag/env → scope-variable → manifest → none chain, DR-043 Amendment I,
   groundnuty/macf#1211) — a separate, non-fatal call `apply` makes to
   actually create/update a runner pod for this repo, independent of the
   token above. If NOTHING in that chain resolves, `plan` says so before you
   approve `apply`, and the call itself reports `'not-configured'`; nothing
   about that is fatal, but it also means nothing provisioned a runner for
   you via this path — a runner registered by other means still satisfies
   mechanism 1 above.

**The router App** (role `router`, never declared in `agents[]`) is a
minimal, read-only-permissioned App (`actions_variables: read`,
`metadata: read`) that mints the registry-read token `agent-router.yml`
needs. `transport.router_app_scope` decides whether it's **shared** across
every fleet on the owner account (default) or **per-fleet**. See §7.3 for
the live, verified failure mode this default produces for a second fleet in
the same scope.

### 6.6 Environment variables the bootstrap path honors

| Variable | Read by | Effect |
|---|---|---|
| `MACF_BOOTSTRAP_RUNNER_TOKEN` | `bootstrap apply` | Fallback for `--runner-token` when the flag is omitted. CLI flag wins on conflict. |
| `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID` | `bootstrap apply` | Fallback for `--ts-oauth-client-id`. CLI flag wins on conflict. |
| `MACF_BOOTSTRAP_TS_OAUTH_SECRET` | `bootstrap apply` | Fallback for `--ts-oauth-secret`. CLI flag wins on conflict. |
| `MACF_BOOTSTRAP_VAULT_VERSION` (`=1`) | `bootstrap apply`, `vault-write.ts` | Changes an existing `secrets/vault.age` from fail-loud-on-clobber to version-aside-and-write (a timestamped sibling file, never an in-place overwrite). Default: fail loud. |
| `MACF_RUNNER_PLATFORM_ENDPOINT` | `apply-fleet.ts`'s runner-provisioning call, `macf bootstrap plan` (Amendment I, groundnuty/macf#1211) | The `groundnuty/runner-platform` tailnet HTTP endpoint — the TOP (env) tier of a four-tier resolution: this env var → the fleet's `owner.registry` scope's shared Actions variable of the SAME name (the normal case — see §1) → `transport.runner_platform_endpoint` in `fleet.yaml` → unconfigured. Has **no baked-in default** (unlike `api.github.com`) since it names one operator's private tailnet address — every tier can be absent; nothing is ever guessed. Nothing resolved → every provision call reports `'not-configured'`, non-fatally, and `plan` names the gap before you approve `apply`. |
| `MACF_RECOVERY_DIR` | `vault-write.ts` | Overrides where per-agent recovery artifacts (Amendment B — the durable-before-gate-2 credential copy) are written. Default derives from `XDG_CONFIG_HOME`/home dir. |
| `MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES` (`=1`) | `fleet destroy` | One of three required acknowledgments for the terminal teardown rung (§9). Deliberately not a flag alone — friction is the design intent. |

### 6.7 `fleet.lock` — what gets written back, and by whom

You never hand-author this file. `apply` writes it: `app_id`/`install_id`
per agent, non-secret **fingerprints** of each secret (never the secret
value — the vault holds that), and `deployed_version` once observed.
`schema_version: 1` today. A `scope_credentials` marker (Amendment,
groundnuty/macf#1162) appears only when this fleet resolved a shared-scope
credential (the router App) via a cross-fleet vault copy — its absence on a
`'shared'`-scope fleet whose vault genuinely lacks that credential is
itself informative (§7.3).

### 6.8 Flags that must be given together, or not at all

Checked directly across every command's option definitions in
`packages/macf/src/cli/index.ts` — these are the flag pairs/groups where
giving one without the other is either rejected outright or silently
changes what the command does, not merely a documentation nicety:

| Command(s) | Constraint | What happens if you violate it |
|---|---|---|
| `bootstrap plan`, `bootstrap status`, `bootstrap apply`, `bootstrap manifest scaffold`, `fleet deploy` | `--vault <path>` and `--identity-key <path>` are **together-or-neither** | Enforced (`checkVaultFlagsComplete` / the same check inlined for `fleet deploy`): giving exactly one without the other is a refusal, not a silent degrade to the vault-free default — this is deliberate: a half-given pair usually means the operator forgot the second flag, not that they intended vault-free operation. |
| `fleet destroy` | `--age-identity <path>` is **required when** `--shred-age-key` is given (not required otherwise) | `--shred-age-key` alone doesn't refuse at the flag level, but the shred step has nothing to act on without a path — always pass both together. |
| `fleet destroy` | `--destroy-repositories`, the interactive fleet-name confirmation, **and** `MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES=1` are **all three required** | Missing any one refuses the run — none of the three is optional or implied by either of the others (§9). |
| `bootstrap apply` | `--runner-token <token>` (or `MACF_BOOTSTRAP_RUNNER_TOKEN`) is **required when** the manifest declares `routing.runner.runs_on: self-hosted` | A manifest-conditioned requirement, not a flag-to-flag one: the flag is optional on a fleet with no self-hosted runner declared. When it declares self-hosted and the flag is missing, `apply` prints a warning before gate 1 (same timing as before) but **no longer aborts the run** — every OTHER leg (routing secrets, CA, repo-init, vault composition) still proceeds; only the `MACF_TRUSTED_ACTORS` write itself is withheld, and the run still exits non-zero overall (groundnuty/macf#1209; §7.1, §6.5). |
| `bootstrap apply` | `--ts-oauth-client-id` and `--ts-oauth-secret` are **mutually required** — supplying one without the other is refused before the manifest is even parsed. Both are **required when** the manifest declares `transport.tailscale_oauth_required: true` and no vault supplies the pair. |
| `bootstrap manifest scaffold` | `--owner`, `--fleet`, and at least one `--agent role=owner/repo` are all `requiredOption`s; `--vault`/`--identity-key` follow the same together-or-neither rule as the row above | The three required options have no defaults at all (commander refuses to run without them); the vault pair is optional but paired. |

No other command in `packages/macf/src/cli/index.ts`'s `bootstrap`/`fleet`
families was found to have a cross-flag requirement beyond these five rows
— every other flag on every other command is independently optional.

---

## 6a. Provisioning into a COLD scope — and the one rule for a scope kept cold deliberately

A scope (an org or user account) is **warm** once it hosts a fleet: shared Apps exist, `TS_OAUTH_*` and other scope-level credentials are already in place, and fleet N+1 inherits them. A **cold** scope has none of that, and every scope-level credential must be supplied — which is what `macf bootstrap secrets template` and the operator-inputs file exist for (§1).

**Warmth is per-credential and per-actor, not per-scope.** A scope can hold the shared router and no Tailscale OAuth; it can be fully warm for fleet Apps and completely cold for a third-party controller that has never been installed. Ask *which prerequisites does this scope satisfy for this actor*, never *is this scope warm*.

### If you are standing up an organisation in order to MEASURE a cold start, do not prepare it

Every end-to-end fleet test to date has run on a scope that already hosted a fleet — shared Apps reused rather than created, credentials already deployed. **A cold start has therefore never been measured**, and it cannot be measured twice on the same scope: the first provision warms it permanently.

> **A cold-test scope's entire value is that it is untouched. Every convenience installed there "to make it work" destroys the measurement it exists to produce.**

So, on a scope reserved for that measurement: **no controller App, no shared router, no pre-seeded `TS_OAUTH_*`, no org variables, nothing.** Run `bootstrap apply` against it exactly as a newcomer would, with only the manifest and the operator-inputs file.

**If it fails for want of something, that is the finding — not an obstacle to clear before the real test.** Record what was missing, then supply it through the supported path and note the cost. The list of things a fresh scope turns out to need *is* the result.

**This does not apply to a working scope.** On `macf-experiment` or any scope in ordinary use, install what you need and fix what is broken; the constraint is specific to a scope being held as a measurement instrument.

## 7. Non-happy paths — what you actually hit, and why

Each of these was live-observed this month provisioning real fleets in the
`macf-experiment` org. None of them raise an unhandled exception — each
produces a specific, named outcome; the point of this section is knowing
what that outcome means before you see it.

### 7.1 A fleet with no `routing:` block declared — routing silently never works

**What you did:** omitted `routing:` entirely (or declared it with a
`runs_on` value other than the literal `self-hosted`).

**What happens:** `apply-fleet.ts` gates the entire `MACF_TRUSTED_ACTORS`
write on `manifest.routing?.runner !== undefined &&
manifest.routing.runner.runs_on === 'self-hosted'`. When that's false, the
write is skipped — **not reported as skipped, not warned about, nothing
prints**. The run otherwise looks completely clean.

**Why this is worse than it sounds for this framework specifically.**
DR-043 Amendment H frames the failure mode as *"silent cost"* — routing
falls through to a GitHub-hosted runner on every event, drawing down quota
and billing beyond it on private repos, while a paid-for self-hosted runner
sits idle. That framing is correct for `pick-runner`'s own logic (it always
emits *something*, hosted or self-hosted, never nothing) — but it describes
the router's perspective, not the delivery outcome. **The canonical MACF
topology requires agent channel-servers to be reached over a Tailscale
join** (confirmed: `apply-router-app.ts`'s own doc notes the runner platform
"may be deleted entirely if agent channel-servers become reachable without
a tailnet join" — i.e., today they are not). A GitHub-hosted runner has no
tailnet join. So for the standard MACF deployment, the hosted fallback isn't
merely a cost — it is a runner class that **cannot reach the private
endpoint the routed job needs to deliver to.**

**Live-reproduced:** `macf-trial`'s `fleet.yaml` has no `routing:` key at
all. `gh variable list --repo macf-experiment/trial-code-agent` shows no
`MACF_TRUSTED_ACTORS` entry, confirmed against a live read while writing
this runbook.

**Fix:** declare the `routing.runner` block from §6.5, supply
`--runner-token`, re-run `apply`.

### 7.2 An install scoped to "All repositories" — refused

**What you did:** on the consent-gate-2 install page, clicked "All
repositories" instead of "Only select repositories."

**What happens:** GitHub's App-manifest flow has no field to force the
installed scope at creation time — `repository_selection` is exclusively an
install-time choice the operator makes by clicking. So this can only be
caught **after the fact**: every App type (agent Apps, the router App,
runner-ops) shares one post-gate-2 check
(`install-scope.ts::validateInstallRepositoryScope`) that rejects anything
other than the literal `"selected"`. The run refuses with a message naming
the exact App and telling you to reopen its install page and pick
"Only select repositories" instead.

**Why it's enforced, not merely advised:** a broader install grants that
App's entire permission set (including `contents: write`) on every repo it
can see — including repos outside this fleet. **Picking "Only select
repositories" correctly is necessary but not sufficient** — §7.9 covers the
sibling refusal when the *right kind* of install still misses one specific
repo. Two live fleets hit exactly
this before the check was generalized to every App type.

### 7.3 A second fleet in the same owner scope reusing the shared router — cannot route

**What you did:** provisioned a second fleet in an owner scope that already
has a fleet (so `transport.router_app_scope` defaults to `'shared'`, and a
router App named for that owner already exists on GitHub from the first
fleet).

**What happens, mechanically:** `resolveSharedRouterAppReuse` checks the
**vault first** (does *this* fleet's vault already hold
`MACF_ROUTING_APP_ID`/`MACF_ROUTING_APP_KEY_B64`?), then a live GitHub
name-collision check second. On a brand-new second fleet, the vault check
finds nothing (nobody has copied the credential in yet), and the
name-collision check finds the first fleet's router App already sitting on
that name — so the outcome is `'name-taken'`: **a refusal, not a create, and
not a silent reuse.** The router App's identity for this run resolves as
unavailable; `MACF_ROUTING_APP_ID`/`MACF_ROUTING_APP_KEY` are never
published to this fleet's repos.

**This is a documented, known gap, not a bug you're expected to route
around cleverly.** DR-043 Amendment O3, in its own words: *"the scope store
where a scope's shared master and Tailscale credentials live does not
exist, so fleet #2 has nowhere to find fleet #1's shared pieces and
re-mints"* — explicitly marked **NOT YET IMPLEMENTED**. Today, the only path
is a manual, interim one:

1. Decrypt fleet #1's vault (operator-privileged, needs its age identity).
2. Copy its `MACF_ROUTING_APP_ID` / `MACF_ROUTING_APP_KEY_B64` values into
   fleet #2's vault, by hand, under the same keys.
3. Optionally set `transport.router_app_origin_fleet: <fleet-1-name>` in
   fleet #2's `fleet.yaml` — a provenance marker only; it changes no
   behavior, but it's what lets `fleet.lock`'s `scope_credentials` entry and
   `plan`'s standing notice name where the credential came from, instead of
   an unattributed local copy.
4. Re-run `apply -f fleet.yaml --vault <path> --identity-key <path>` — the
   vault check now succeeds and the shared credential is reused with zero
   new App creation.

**Or**, if you'd rather not share routing infrastructure across fleets at
all: set `transport.router_app_scope: per-fleet` in the manifest before the
first `apply` for this fleet, and it mints its own dedicated router App
(2 extra clicks, permanently isolated).

**Live-reproduced:** `macf-experiment` org's installation list carries
exactly one router App (`macf-experiment-router`), shared by the
`macf-experiment` fleet that created it first. `macf-trial` — a second
fleet in the same org, default `'shared'` scope, no
`router_app_origin_fleet` declared — has no router App of its own, no
`scope_credentials` marker in its `fleet.lock`, and (confirmed live)
`MACF_ROUTING_APP_ID`/`MACF_ROUTING_APP_KEY` absent from every one of its
repos.

### 7.4 Tailscale OAuth declared but absent — refused before gate 1

**What you did:** set `transport.tailscale_oauth_required: true` without
first putting `TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET` into the vault.

**What happens:** `checkTailscaleOauthPreflight` reads the vault (needs
`--vault`/`--identity-key`) before any consent gate opens, and refuses
outright if the declared requirement isn't satisfiable — same posture as
the age-recipient refusal in §1: a declared intent the tool cannot honor is
refused, never silently skipped and never silently proceeded-with.

**The flag only controls the loudness of the ABSENT case — it never gates
whether a PRESENT value gets used.** Confirmed directly against
`plan.ts::tsOauthItem`'s own comment: *"Vault presence is checked
UNCONDITIONALLY, regardless of `transport.tailscale_oauth_required` … the
manifest flag only changes how loudly `apply` treats an ABSENT vault; it
never gates whether a PRESENT vault value gets used."* Concretely:

- **declared `true`, vault has it →** published, same as always.
- **declared `true`, vault absent it →** refused before gate 1 (above).
- **left at the default `false`, vault happens to have it** (e.g. copied in
  by hand, or inherited from an earlier run) **→** still published — the
  flag never suppresses a value that's already there.
- **left at the default `false`, vault absent it →** an honest `'skipped'`
  leg, not `'failed'` — no refusal, but routing still won't work. §4 row 4
  is exactly this case, live-reproduced on `macf-trial`.

`agent-router.yml` needs this pair **unconditionally** to route, regardless
of what the manifest declares — the flag is purely about how the tool talks
to you about a gap, never about whether the gap matters.

### 7.5 A registry pointed at `{ type: org }` — refused

Covered fully in §6.2. The refusal fires from the manifest alone, before
any GitHub call — the DR-019 permission set this tool requests has no
organization-scoped Variables permission, so no install-scope choice could
ever fix it. Use `{ type: repo, ... }` for an org-owned fleet instead.

### 7.6 A resumed gate — App exists, install still incomplete

**What you did:** a previous `apply` run created an App for some role (gate
1 succeeded — the App and its private key are already durable in the vault
per Amendment B), but the install never completed — you cancelled (§7.7),
the process died, or you just haven't clicked Install yet.

**What happens on the next `apply`:** the confirm-before-create guard finds
the App already exists (via `fleet.lock` or a live GitHub check) and
resolves a **`resume-install`** decision — gate 1 is skipped entirely (no
second App is created; App names are globally unique and gate 1 is not free
to retry), and only gate 2 (install) reopens for that one role. Every other
already-fully-provisioned role in the fleet is untouched.

If the install page has been reopened and you pick the wrong repos or the
wrong account, `waitForInstallTimeoutMessage`'s poll distinguishes the cause
in its timeout message: `app-no-install` (nobody clicked yet),
`installed-unexpected-target` (installed, but on the wrong account — names
what it actually saw), or `unconfirmable` (GitHub was never successfully
asked at all — check your App-id/key pairing before assuming the operator
hasn't acted).

### 7.7 Cancelling an identity mid-gate

**What you did:** clicked "Cancel this identity" on the interactive
gate-2 install page instead of completing the install.

**What happens:** the wait for **that one identity** ends immediately —
nothing else in the run is affected. The App created at gate 1 (if this run
just created it) and its credential remain exactly as durable as they were
the moment before you cancelled (Amendment B: the vault write happens before
gate 2 even opens). That role's outcome for this run is reported as
`failed`, `cancelled: true`, with the message: *"cancelled by the operator
… re-run apply whenever you want to finish this identity; nothing else in
the fleet is affected by cancelling one."* Re-running `apply` later produces
exactly the §7.6 resumed-gate path for that role.

### 7.8 A partial version roll — exit 2

Not a provisioning-time path, but the sibling steady-state one:
`macf fleet upgrade --execute` (or `apply`'s own version-reconcile phase,
when `--vault`/`--identity-key` are supplied) can roll **some** but not all
discovered fleet members — busy, config-dirty, off-canonical-branch,
stale-pin, or not-yet-serving are all distinct, named skip reasons. This is
neither success nor a hard failure; see §8 for the exact exit-code (`2`)
this produces and why conflating it with either `0` or `1` was itself a
shipped defect (macf#1146/#1151) fixed by giving it its own code.

### 7.9 A properly-scoped install that's still missing the registry repo — refused

**What you did:** on the install page, correctly chose "Only select
repositories" (§7.2's check is satisfied) — but the repo set you picked
doesn't include the registry repo (only meaningful when `owner.registry`
is `{ type: repo, ... }`, §6.2).

**What happens:** this is a *different*, later check from §7.2's —
`registry-repo-coverage.ts`'s `buildRegistryRepoValidateInstall`, which asks
a narrower, live question: does *this specific App's* installation actually
cover the *one* repo it will need to read/write its own registry entry on?
This can only be checked once the App exists and is installed (an App JWT,
`GET /repos/{owner}/{repo}/installation`) — there is no manifest-only proxy
for it the way §7.5's org-registry refusal has. On a `404`, the refusal
names the exact missing `owner/repo` and tells you to add it under
"Repository access" on the App's install page and click Save — `apply`
detects the change automatically on retry, no full re-run needed.

**Why a `404` here doesn't over-claim a single cause:** GitHub returns the
identical `404` whether the repo exists but isn't in this App's selected
set, *or* the repo itself doesn't exist / was renamed. The registry repo is
never auto-created by `apply` (only each agent's own home repo is) — so
"the registry repo doesn't exist" is a genuinely reachable cause, not a
theoretical one. Where the tool can independently confirm the repo exists
(an unauthenticated `GET /repos/{owner}/{repo}` — a `200` proves existence;
a private repo's `404` is indistinguishable from "doesn't exist" to an
anonymous caller), the message narrows to the install-scope cause alone;
otherwise it says so honestly rather than presenting both as equally
likely.

**This check runs on every path that resolves a live install** — a fresh
create, a resumed install (§7.6), *and* a re-confirmed already-provisioned
role on a re-run — not only on first creation. A fleet that looked fully
provisioned on every previous run can still surface this the first time
something tries to actually read the registry through it.

---

## 8. Exit codes

### `macf bootstrap apply`

| Code | Meaning |
|---|---|
| **0** | Every hard-failure predicate is false, **and** the version-reconcile phase (if attempted) left nobody behind. |
| **1** | A **hard failure** needing operator attention: the control repo couldn't be provisioned or synced, any agent identity needs attention (`failed`/`drift`/`skipped-unverified`), the runner-ops or router App needs attention, the vault write failed, any CA leg failed, any of the six routing-secret legs `failed` (not merely `skipped`), or the version-reconcile phase **halted** (a confirmed-or-unconfirmable bad release). Checked first — a halt always reports `1` even if something else in the same run is *also* merely partial. |
| **2** | **Not** a hard failure, but the version-reconcile phase left at least one discovered fleet member un-rolled (busy / config-dirty / off-branch / stale-pin / not-yet-serving). Distinguishes "this needs a look, but nothing is broken" from a genuine `1`. |

### `macf fleet upgrade --execute`

Same three-valued shape, same rationale (mirrored from `@groundnuty/macf-core`'s
`fleet-reconcile.ts` 0/1/2 convention): **0** every fleet finished fully
green; **1** at least one fleet **halted** (a bad release — checked first);
**2** not halted, but at least one fleet left an agent behind (mixed-version
roll). A caller doing the common `[ $? -ne 0 ]` check now correctly sees
non-zero for a mixed roll too (this was the exact gap `2` was added to
close).

### `--dry-run` and read-only commands (`plan`, `status`, `manifest scaffold`)

**0** on a successfully computed/rendered result — a plan or scaffold full
of "would create" items is still a *successful run*; only a failure to even
produce the plan (bad manifest, missing file, an observer throw) is
non-zero (**1**). Under `--json`, a failure always emits a valid, non-empty
JSON `{error}` object on stdout — never empty-stdout-with-nonzero-exit.

---

## 9. Fleet lifecycle — the teardown ladder

Four separate verbs, not a `--purge` flag on one command (a deliberate
choice — see DR-043 Amendment G). Ordered by **revival cost in operator
clicks**, cumulative (`deactivate ⊂ archive ⊂ delete-apps`; `destroy` is
terminal):

| Verb | Removes | Revival cost |
|---|---|---|
| `macf fleet deactivate -f fleet.yaml` | Org/account-scope registry presence only (the CA registry leg, every agent registration, federated-CA entries) — repo-scoped state, the vault, the Apps, the repos are all untouched | `apply --vault --identity-key` — **0 browser clicks** |
| `macf fleet archive -f fleet.yaml` | + archives the control repo and every agent repo (`archived: true`, reversible via the GitHub API) | Un-archive (API) + `apply --vault --identity-key` — **0 browser clicks** |
| `macf fleet delete-apps -f fleet.yaml` | + deletes the agent GitHub App identities (frees the globally-unique names — GitHub has no REST endpoint for this; the command reports exactly which Apps still need a manual deletion click and best-effort opens the browser there) | Recreate Apps (**2 clicks/agent**) + `apply` |
| `macf fleet destroy -f fleet.yaml --destroy-repositories` | + deletes the repositories directly | Full re-provision; **history gone forever** |

**`destroy` requires all three of:** `--destroy-repositories`, typing the
exact fleet name at an interactive prompt, and
`MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES=1` in the environment. Friction
is the deliberate design, per standing operator directive: *"never — and I
repeat never — allow easy repo removal."*

**The age key is never shredded automatically.** Only `destroy` offers
`--shred-age-key --age-identity <path>`, explicit opt-in only — the one
action with no recovery whatsoever, and it also makes `deactivate`/`archive`
on this fleet permanently non-revivable (their free revival depends on the
vault staying decryptable).

**Materialize one agent from an already-provisioned fleet:**
`macf fleet deploy -f fleet.yaml --agent <role> --vault <path>
--identity-key <path>` — the gap between "GitHub side provisioned" and "a
process is actually running" (§4 row 6). Idempotent; `--force-key`/
`--force-ca` re-materialize on-disk credentials from the vault when their
fingerprint has drifted (e.g. a stale key from a destroyed-and-rebuilt
fleet) instead of refusing.

---

## 10. `fleet` health/supervision commands — not provisioning, but part of the same command family

These operate on an **already-deployed** fleet (post row-6 of §4) rather
than bringing one up, so they're out of this runbook's main flow — but
"every flag on every `bootstrap`/`fleet` command" includes them, so here is
the complete flag list for each, current as of `packages/macf/src/cli/index.ts`.
Run the bracketed `--help` for the living version.

**`macf fleet status`** [`--help`] — roster + live health for every
registered agent (mTLS `/health`, uptime, cert-expiry warnings, idle/busy).
Flags: `--json` (structured output), `--dir <path>` (project dir; default:
auto-discovery from cwd).

**`macf fleet doctor`** [`--help`] — mesh-interconnect test. Default is
non-invasive (Reachable + Accepted); `--inject` additionally routes a real
marker-bearing `/notify` to prove full deliver→process (invasive — wakes
the agent). Flags: `--json`, `--inject`, `--inject-timeout <sec>` (default
24), `--dir <path>`, `--manifest <path>` (cross-checks each manifest agent's
declared role against the discovered workspace routing label).

**`macf fleet install-cron`** [`--help`] — installs a host crontab entry
that periodically runs `fleet reconcile`. Flags: `--schedule <cron>`,
`--execute` (installs an ACTING line; default is report-only),
`--allow-restart`, `--with-routing`, `--manifest <path>`, `--no-token`
(don't bake a `GH_TOKEN` mint into the cron line), `--uninstall`, `--print`
(preview without touching crontab), `--prelude <path>`, `--log <path>`,
`--yes`, `--dir <path>`.

**`macf fleet reconcile`** [`--help`] — the desired-state watchdog: probes
actual `/health` against a desired set and launches/heals/skips accordingly.
Dry-run by default. Flags: `--execute`, `--allow-restart` (enables Tier-2
graceful-restart), `--with-routing`, `--manifest <path>`, `--state-dir
<dir>`, `--last-exit-dir <dir>`, `--paused-dir <dir>`, `--heartbeat-file
<path>`, `--json`, `--dir <path>`.

**`macf fleet resume`** [`--help`] — nudges a stalled idle agent or reports
a blocked one (never auto-answers a permission/trust prompt). Dry-run by
default. Flags: `--execute`, `--dir <path>`.

**`macf fleet upgrade`** [`--help`] — the rolling framework-version upgrade
described in §8's exit-code table. Flags: `--target <version>` (default:
npm-latest of `@groundnuty/macf`), `--fleet <names>` / `--registry <ids>`
(comma-lists, same selector space — `--registry` is the historical name),
`--execute`, `--wait` (poll for idle instead of skipping a busy agent),
`--verify-timeout <sec>` (default 120), `--force` (bypass the config-dirty
pre-flight gate — the agent's own dirt still isn't stashed), `--dir <path>`,
`-f, --file <path>` (a confirmed verify-green then records `deployed_version`
into that fleet's `fleet.lock`; omitted = unchanged).

---

## 11. Cross-references

- **[`DR-043`](decisions/DR-043-declarative-fleet-provisioning.md)** — the
  design record this runbook is the operator-facing companion to. Read it
  for *why* each field/gate/refusal exists; this document is *what to do*.
  Amendments C, D, F, G, H, I, N, O are the ones most load-bearing for the
  credential and non-happy-path content above.
- `packages/macf/src/cli/bootstrap/fleet-manifest.ts` — the manifest/lock
  schema, authoritative over §6 and over DR-043's own §D1 example (which
  predates Amendment F's removal of `transport.vault_repo` and Amendment
  O's `router_app_scope` — see the callout at the top of this document).
  `run` `--help` on any command before trusting a flag against this doc.
- `use-cases/scientific-paper-fleet.md` — a worked, narrative walkthrough of
  one specific fleet shape (science + code + writer agents), cross-checked
  against this runbook's field reference while writing it.
- **macf#878** (§4b) — the three-fleet migration to Amendment F control
  repos this runbook's §4b procedure serves; its own issue thread carries
  the fuller design-decision trail (why `manifest scaffold`/`control-repo
  init` are separate verbs, the `versions:`/`age_recipients` exclusions,
  the sequencing ruling) that this section only summarizes operationally.
