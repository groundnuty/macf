# DR-043: Declarative fleet provisioning — fleet.yaml, plan/apply reconciliation, vault as store of record

**Status:** Accepted (operator-ratified 2026-08-11; science-authored from the operator design dialogue)
**Date:** 2026-08-11
**Trigger:** Operator direction after DR-035 field experience. `macf-bootstrap` (DR-035) proved the provisioning flow end-to-end but is an LLM-driven *skill* — the operator wants a **deterministic, programmatic CLI** that provisions (and later *converges*) a fleet from a **declarative manifest**: *"the initial bootstrap should just accept a YAML configuration file … an early attempt at GitOps: it expresses our desired state, the tool reconciles it."* The skill's own artifacts show the convergence already happening organically: it grew `templates/bootstrap-spec.example.json` — a de-facto fleet spec assembled from Q&A. This DR formalizes that spec into a first-class manifest and inverts the skill/mechanism relationship: **deterministic CLI core, optional conversational front-end.**

## Context — what DR-035 taught (the lessons this design encodes)

The skill (`tools/macf-bootstrap/.claude/skills/macf-bootstrap/SKILL.md`) accumulated the field lessons; each maps to a structural element here:

| DR-035 field lesson | Consequence in this design |
|---|---|
| Name-vs-handle conflation is the #1 provisioning trap (macf#791 — the icsoc routing outage) | Manifest carries **only `role`**; the App handle `<project>-<role>` is *derived*, never a writable field — the trap becomes unrepresentable |
| **The initial App install is browser-only** (no REST API creates an installation; `PUT /user/installations/{id}/repositories/{id}` only extends an existing one) | The human floor is **two interactions per App** (manifest *Create* click + install flow). This *corrects DR-035's original table row* claiming installation is API-able — see the DR-035 amendment |
| `macf-routing` is account-shared; duplicate-create fails **silently** (bounce, no `?code=`) | `shared:` section + account-level detection (JWT against the known app_id from prior state) — reuse, never re-create |
| The CA cert must land in **two places** (registry var + per-repo var, macf#806; drops to one when macf-actions#66 lands) | Encoded in the apply plan, not operator memory |
| Secret value formats (raw PEM vs base64 asymmetry) fail routing silently | Formats live in code — a CLI's structural win over skill prose |
| The routing plane must be `macf repo-init`-generated, never hand-templated (macf#797/#805/#806) | `apply` shells out to `repo-init` with the full fleet — born-correct configs |
| Create-only guard; overwrite is explicit opt-in | Generalized into the three-verb reconcile policy (§D3) |
| GitHub auth gates recur (~hourly sudo/2FA); pause→resume is first-class | `apply` is resumable/idempotent mid-run — a second argument for the lockfile |
| Logged-in **debug** Chrome requires a profile-copy dance (first-run finding) | Eliminated: the CLI never drives a browser (§D2) — the operator clicks in their *normal* browser |
| Vault: age-encrypted, committed, key out-of-band, plaintext never on disk | Inherited wholesale and **promoted to store-of-record** (§D5) |
| `repo_provenance: template` vs `overleaf-mirror` | Per-agent `provenance` field |

## Decision

### D1 — `fleet.yaml`: a declarative manifest, and the config/lock/vault triad

A fleet is declared in one committable, **secret-free-by-construction** manifest. Provisioning state splits Terraform-style into a triad — because App IDs and keys are *outputs* of provisioning, not inputs:

| Artifact | Holds | Written by |
|---|---|---|
| `fleet.yaml` | **Desired state** — roles, repos, versions, topology. No secrets, no IDs | Operator (or the DR-035 skill as intake front-end) |
| `fleet.lock` | **Observed non-secret state** — app_ids, install_ids, deployed versions, fingerprints | `macf bootstrap apply` |
| `secrets/vault.age` | **Every secret value** the fleet needs to exist (§D5) | `apply` (write-through) |

`fleet.yaml` + `fleet.lock` live committed in the fleet's science/coordination repo — that repo **is** the GitOps repo.

#### Schema (v0)

```yaml
apiVersion: macf/v0
kind: Fleet
metadata:
  name: icsoc-2026                # project == fleet (DR-037); ICSOC_2026 seg derived

versions:                         # GitOps steering (§D6): desired versions,
  macf: 0.2.44                    #   reconciled against registry-reported deployed
  actions: v3.4.1                 #   versions; router pin re-applied by repo-init

owner:
  account: groundnuty
  type: user                      # user | org → manifest-form URL + registry default
  registry: { type: profile, user: groundnuty }   # matches RegistryConfigSchema

network:
  advertise_host: orzech-dev-agents.tail491af.ts.net

transport:
  vault_repo: groundnuty/icsoc-2026-science-agent   # where vault.age is committed
  age_recipients: []              # existing age1… key(s), or [] → mint + hand off
                                  # (§D5 multi-recipient: operator key + VM key, macf#852)

defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019            # the canonical App permission set

agents:
  - role: science-agent           # THE name: routing label, cert CN, registry seg,
    profile: research             #   tmux session, agent-config key (DR-032).
    repo: groundnuty/icsoc-2026-science-agent      # App handle is DERIVED.
    deploy_path: /home/ubuntu/repos/agh/icsoc-2026-science-agent
  - role: code-agent
    profile: code
    repo: groundnuty/icsoc-2026-experiment
    deploy_path: /home/ubuntu/repos/agh/icsoc-2026-experiment
  - role: writer-agent
    profile: paper-latex
    repo: groundnuty/icsoc-2026
    provenance: mirror            # pre-existing dir (e.g. Overleaf); default template
    deploy_path: /home/ubuntu/repos/papers/icsoc-2026

routing:
  runner:                         # Amendment H, corrected by Amendment J.
                                  # AUTHORITATIVE FIELD LIST: FleetRoutingRunnerSchema
                                  # in packages/macf/src/cli/bootstrap/fleet-manifest.ts
    runs_on: self-hosted            # declaring `self-hosted` is what makes a missing
                                    #   --runner-token a REFUSAL (Amendment H.1)
    labels: [self-hosted, macf-vm]  # CROSS-CHECK against what pick-runner emits —
                                    #   not the value that decides usability (macf#950)
    warm: 1                         # latency posture; 1 per DR-009 §7.4 (macf#964)
                                  # Gates self-hosted eligibility via
                                  # MACF_TRUSTED_ACTORS (NOT MACF_ROUTING_RUNS_ON,
                                  # a v1 relic the v3 router never reads — macf#923).

collaborators:                    # cross-fleet guests (DR-036 / DR-041)
  - project: ppam-2026
    registry: { type: profile, user: groundnuty }
    ca_bundle: bundles/ppam-2026-ca.pem   # DR-041 D1c v1 static; v2 → endpoint
                                  # reconciles: UNION into <SEG>_FEDERATED_CAS
                                  # (DR-041 Amendment B — never override)

shared:                           # account-level, cross-fleet — detect + reuse
  routing_app: macf-routing
  ts_oauth: operator-supplied     # referenced, never stored in the manifest

trust:
  ca: per-project                 # applied to BOTH targets (registry + per-repo
  federated_cas: []               #   var, macf#806) until macf-actions#66 lands
```

### D2 — Deterministic CLI core; the browser reduced to consent clicks in the operator's own browser

`macf bootstrap plan -f fleet.yaml` / `macf bootstrap apply` replace the skill as the *mechanism*. The two GitHub consent gates that cannot be API'd are reduced to clicks in the operator's **normal** browser — the CLI never drives a browser at all:

1. **App creation** — the App Manifest flow with a **localhost redirect**: the CLI sets the manifest's `redirect_url` to `http://localhost:<port>/callback`, serves a self-submitting form, opens the browser; the operator clicks **Create**; GitHub redirects to localhost with the temporary `code`; the CLI exchanges it (`POST /app-manifests/{code}/conversions`) and receives app_id, client id/secret, webhook secret, **and the private-key PEM**.
2. **Initial App installation** — the CLI opens the install page; the operator selects repos and clicks **Install**; the CLI **captures the result API-side by polling `GET /app/installations` with the App's own JWT** (it holds the PEM from step 1) — no reading the redirect URL off a page, hence no debug Chrome, no profile-copy, no Chrome DevTools MCP, no URL-allowlist rail (deterministic code cannot wander off-script; the rail existed because an LLM was driving).

Everything else — repos from template, installs *extension* (API-able), secrets/vars, `repo-init`, CA, vault — is plain `gh`/REST, ordered by the plan.

**The DR-035 skill is repositioned, not retired:** it becomes an optional conversational **front-end that writes `fleet.yaml`** (intake for operators who don't want to hand-author it) and then invokes the CLI core. Brains demoted to front-end; mechanism promoted to code.

### D3 — Reconcile policy: three verbs, no prune ("play it safe")

`apply` is a reconciliation, not a script. Per the operator's direction, the mismatch policy is deliberately conservative:

| Observed vs desired | Verb |
|---|---|
| Missing (agent, repo, install, secret, var, routing workflow) | **Create** — automatic, after the single plan approval |
| Present but mismatched (wrong pin, CA-issuer drift, version behind) | **Confirm-then-update** — report + ask; never silently mutate |
| Present but absent from the manifest (extra agent, stray repo) | **Report-only** — never delete. Agent deletion is explicitly out of scope |

Adding an agent to a live fleet is therefore just the Create verb firing for one agent's slice — and since *extending* an existing installation IS API-able, post-day-0 growth needs no browser beyond the new agent's own two clicks.

### D4 — Two planes, two reconcilers, one manifest (DR-037 alignment)

The manifest spans DR-037's two planes; the tooling must respect the privilege split:

- **GitHub/identity plane** (Apps, repos, installs, secrets, routing wiring) → reconciled by `macf bootstrap`, **Mac-side, operator-privileged** — the only place consent clicks can happen (the DR-035 chicken-and-egg: scoped Apps cannot create Apps).
- **Operational plane** (version roll, config surface) → reconciled by `macf fleet upgrade`, **VM-side, agent-privileged** — the machinery DR-037 already ratified, including the verify-green three-outcome gate.

Both read the same `fleet.yaml`; neither reaches across its privilege boundary.

### D5 — The vault is the fleet's credential **store of record** (operator-confirmed)

Elevated from DR-035's "bootstrap transport" to an operational invariant: **all credentials load-bearing for the fleet's existence and operations live in `vault.age`** — per-agent App private keys + client secrets + webhook secrets, install IDs, the shared `macf-routing` creds, the routing-client cert/key, TS OAuth, and the **CA key** (DR-035 already made the vault the durable CA-key store — `certs init`'s registry backup is skipped in the bootstrap flow for exactly this reason).

- **Write-through rule:** every reconcile verb that mints or receives a credential (add-agent, routing-client re-mint, CA ceremony, TS OAuth rotation) writes it into the vault **in the same apply**; the updated `vault.age` commit is part of apply's output. Vault git history = credential history (normal pushes, never `--force`).
- **Multi-recipient encryption (new requirement; operator-confirmed 2026-08-11):** re-runs must *read* the previous vault (reuse `macf-routing`, the CA key). `vault.age` therefore encrypts to **both** the operator's key and the VM key (age natively supports multi-recipient). The single-recipient v1 vault is upgraded on first converge.
- **Fingerprint pairing:** the registry holds the *fingerprint* (readable), the vault holds the *value* (sealed), the lock holds the mapping. Detected drift (clobbered repo secret, orphaned routing cert per the DR-010 amendment) is remediated by **re-materializing from the vault** — no re-mint, no browser.
- **Agents never decrypt.** Values are handled only by the deterministic CLI (Mac) and `vault.sh` (VM); secrets never transit an LLM context. The CLI core *strengthens* this vs the skill: the LLM's only remaining input is the secret-free manifest.
- **Disaster recovery falls out for free:** private repo + age key ⇒ the fleet's entire GitHub-side credential set re-materializes on a fresh VM.

### D6 — `versions:` makes the manifest the GitOps steering input for fleet upgrades

`versions:` declares desired state for **two different planes**, and they must not be conflated — they have different observability sources AND different remedies (corrected 2026-08-13, macf#906; the original text attributed both to `macf fleet upgrade`, which owns neither for the actions pin):

| field | observed from | remedy |
|---|---|---|
| `versions.macf` | the agent's self-reported deployed version (registry / `/health`, the DR-037 machinery — no VM access needed) | **`macf fleet upgrade`** (operational plane, §D4) under DR-037's verify-green gate — continue only on confirmed-green; HALT on bad-release or past-grace-unconfirmed (Amendment C refines: continue on a positively-confirmed LOCAL cause such as `stale-pin`) |
| `versions.actions` | **each caller repo's `.github/workflows/agent-router.yml` `uses:` pin** — NOT registry-reported; the registry has no actions-version concept | **`macf repo-init`** (re-pins, resolving `v3` → the latest immutable tag). `macf fleet upgrade` never touches a caller workflow. Drift detector: the `routing doctor` freshness check (macf#872) |

A mismatch on either is **Confirm-then-update** (§D3), surfaced by `plan` as its own item kind per plane. `apply` **names the remedy and refuses to run it** — provisioning is not software deployment, and a plan that showed a version drift as actionable would overstate what approving it does (the macf#854 false-consent shape). Re-running `plan` on a version-bumped manifest is how the drift becomes visible; the named command is what closes it. An agent whose version cannot be observed reports **`unknown` for that agent alone** — never a guessed match, never contaminating a peer's verdict (Amendment A's floor, per-subject).

This is reconcile-on-demand GitOps — no watching controller in v1, deliberately.

## Design invariants (each earned by an incident)

1. **Write-only artifact ⇒ registry fingerprint at write time.** GitHub secrets cannot be read back, so any credential written to a write-only surface records a fingerprint in the registry *in the same operation*, or it is invisible to reconciliation forever (generalizes the DR-010 amendment / silent-fallback Instance 16 pattern).
2. **UNION-never-override** for `federated_cas` (DR-041 Amendment B) — a re-run cannot half-federate a fleet.
3. **Handle derivation, never declaration** — only `role` exists in the manifest (macf#791).
4. **Create / confirm-mutate / report-extra, no prune** (§D3).
5. **No plaintext secrets on disk or in LLM context** — STDIN-piped vault assembly, `.gitignore`d scratch, wipe-on-abort (inherited from DR-035).

## Day-2 use-case catalog (planned; not all built now)

| Use case | Mechanism | Status |
|---|---|---|
| Add agent to a live fleet | Create-verb slice; install-extension API + 2 clicks for the new App | Design-covered, v1 |
| Routing re-pin / router drift | repo-init re-run under Confirm | Design-covered, v1 |
| Runner re-point | `MACF_ROUTING_RUNS_ON` var reconcile | Design-covered, v1 |
| Fleet version roll | §D6 → DR-037 machinery | Design-covered; wiring is day-2 |
| Federate with a collaborator fleet | `collaborators:` → `<SEG>_FEDERATED_CAS` UNION + guest routing entries (macf-actions#67) | Design-covered; v2 endpoint-sourced bundles per DR-041 D1c |
| Secret clobbered / cert orphaned | Fingerprint drift → re-materialize from vault | Design-covered, v1 |
| Fleet re-materialization (DR) | Clone + age key + vault.sh | Falls out of §D5 |
| Agent deletion | — | **Out of scope** (operator: no foreseen use) |
| CA rotation as a manifest field | — | Out: rotation stays an operator ceremony (DR-010 amendment); the reconciler *detects* incomplete rotation via fingerprints |
| App permission-set upgrade | GitHub forces a browser approval | Report + emit link only |

## Rollout + acceptance validation (operator calls, 2026-08-11)

- **First `apply` target: the next new fleet.**
- **Plan-only retrofit of the two existing fleets** (substrate `macf` + `icsoc-2026`) is the reconciler's **acceptance test**: write their `fleet.yaml`, run `plan` in report-only mode; it must reproduce known drift (e.g. version skew, pin drift) while mutating nothing.
- **DR-035 skill: kept as the conversational front-end** (intake → writes `fleet.yaml` → invokes the CLI core), per the operator's call.

## Ownership / build split

- **Design (this DR + schema):** science.
- **Implementation:** code-agent — CLI core (`plan`/`apply`, localhost exchange, JWT install-polling, lock/vault write-through), preceded by a **spike verifying the two load-bearing mechanics**: (a) manifest→localhost redirect exchange end-to-end on a personal account; (b) `GET /app/installations` JWT-polling capture of a browser-performed install.
- **Ratification:** operator (Proposed→Accepted).

## References

- DR-035 (+ its 2026-08-11 amendment — skill repositioned as front-end; install-API row corrected) · DR-037 (two planes; fleet upgrade; verify-green) · DR-041 (+ Amendment B — federation, UNION) · DR-019 (App permission set) · DR-030/DR-038 (install-set) · DR-032 (naming; macf#791) · DR-010 amendment / silent-fallback Instance 16 (write-only fingerprints) · DR-003 (runner gates)
- macf#797/#804/#805/#806 (born-correct routing plane; two-place CA) · macf-actions#66/#67 · `tools/macf-bootstrap/templates/bootstrap-spec.example.json` (the organically-emerged spec this formalizes)

## Amendment A (2026-08-11, #838 Slice-1 acceptance) — plan-time observability split & credential-bearing identity confirmation

**Trigger:** the Slice-1 acceptance run (#838) surfaced a mis-specified observability assumption in this DR, plus one refuted mechanism. Verified facts (code-agent, 2026-08-11): `GET /user/installations` requires a GitHub-App **user-to-server** token — it 403s on both bot installation tokens (`ghs_`) *and* the operator's normal `gh auth login` token (`gho_`), so no ambient auth the flows actually hold can enumerate App installations. The **only** read that *confirms* an App/install exists on GitHub now is the per-agent **PEM→App-JWT→`GET /app/installations`** call (proved live by spike #837). Workspace-file presence (`settings.local.json`) and registry agent-var presence are **inference dressed as observation** (the `silent-fallback-hazards.md` Instance-16 presence-by-proxy shape) — rejected as identity-plane sources.

**A1 — the observability split.** `plan`'s obligations divide along GitHub's own credential design:
- **Credential-free planes** — repo existence, the CA var at both two-place legs, the routing runner var, registry-scope vars: read **live, always** (operator-ambient `gh`).
- **Credential-bearing plane** — App/install existence: confirmable **only** with the agent's PEM. The PEMs' canonical home is the vault (§D5 store of record; Mac-side decryptable per the multi-recipient decision), so `plan` **with vault access** (or explicit key paths) confirms live via PEM→JWT; `plan` **without** stays honest-`unknown` with a how-to-do-better hint. Never silently absent, never inferred.

**A2 — lock precedence (general principle).** `fleet.lock` is authoritative **only for what cannot be re-derived from reality** (fingerprints of write-only artifacts). Every live-readable plane is read live; the lock is a *fallback labeled unverified* ("as recorded by prior apply"), **never an override**. A lock-vs-live conflict (e.g. lock `app_id` ≠ JWT-confirmed id — App deleted + recreated) is drift: emit `update` + `confirm_required`, never silently resolve. A lock-seeding `adopt` step as the *primary* identity source is **rejected** — a lock seeded once and never re-checked is itself presence-by-proxy.

**A3 — the §Rollout acceptance criterion, refined.** The plan-only retrofit validates the **credential-free planes** — satisfied 2026-08-11: live `macf` substrate leg (all repos + registry CA + all 4 per-repo CA → `NOOP`, zero mutation, exit 0) + testbed leg (shared-repo model → loud parse rejection by the uniqueness invariant). **Slice 1 accepted on this contract.** Identity-plane confirmation is **Slice-2 scope** (the vault-aware observer of A1), and the same PEM→JWT read is reused at the mutation boundary as `apply`'s confirm-before-create guard.

**A4 — epistemic floor.** The identity-plane API can confirm `present` but can never prove `absent` (an installation can live outside the enumerable scope). Missing-after-read stays `unknown`. The plan's honest-`unknown`-over-false-`present` posture is normative for every future observer surface.

**References:** #838 (acceptance evidence + the refuted `/user/installations` mechanism) · #837 (PEM→JWT proof) · #839 (Slice 1a) · `silent-fallback-hazards.md` Instance 16 (presence-by-proxy).

## Amendment B (2026-08-11, #838 Slice-2b increment 5) — §D5 requires per-receipt credential durability

**Trigger:** the `apply` orchestrator (increment 5a) revealed that §D5's "writes it into the vault *in the same apply*" is ambiguous, and the natural batch-at-loop-end reading violates the store-of-record property. Between "operator clicks Create for agent N" (App now exists on GitHub, consent given, effectively irreversible) and the post-loop vault write, agent N's private key lives **only in process memory** — and **gate 2 parks a multi-minute operator-wait inside that window**. A process death, ctrl-C, escaped exception, or a failed final vault write (the #847 nit-1 `age`-failure path) orphans every already-created App with an automation-captured credential set that is painful (manual, per-App) to recover. Same-apply-batching satisfies §D5's letter and defeats its point.

**Clarification (tightens §D5, does not replace it):** *A received credential MUST reach durable, operator-recoverable storage before the apply proceeds to any further fallible or operator-gated step* — before gate 2, before the next agent. The store-of-record property **is** crash-safety; a window where a created-on-GitHub App's key is memory-only is the exact durability hole the vault exists to close. Batch-compose-at-end remains fine for assembling the *final* `vault.age` — it must simply not be the *first* moment the credential is durable.

**This does NOT reopen the decrypt-merge-reencrypt path** (increment-4's deliberate scope-out stands). The contract is "durable before the next gate," satisfiable with today's single-shot `writeVault`: the happy path still composes the final vault from in-memory plaintext at loop end, plus a **per-agent encrypted recovery artifact** written the moment the manifest exchange returns credentials (multi-recipient, its own path so no clobber) — write-only insurance, never read on the happy path, deleted on successful compose, the durable recoverable record on a crash. Never composed *from* (memory is the compose source), so no merge/decrypt is needed. Any lighter mechanism that still makes the credential durable-before-gate-2 is acceptable — the invariant is the contract, not the artifact.

**Required regardless:** (1) the #847 `unlink`-on-encrypt-failure fix — a failed final compose must not strand a corrupt vault atop the recovery artifacts; (2) a documented recovery procedure for the "App created, not yet in final vault" state (re-run `apply` → confirm-before-create short-circuits the existing App → recover creds from the per-agent artifact).

**Operational corollary (first-run blast radius):** the first live provision runs **one agent at a time** (single-agent `fleet.yaml`, re-run per agent) — single-App blast radius, any failure recoverable by deleting exactly one thing. Independent of the durability mechanism; correct posture for a pipeline's first-ever touch of real GitHub state.

**References:** #838 (the orchestrator that surfaced it) · #847 (the `age`-failure path this compounds) · §D5 (the invariant tightened) · Design invariant 5.

## Amendment C (2026-08-11, #838 increment 5a) — age-recipient is operator-provided, never tool-minted; §D1 `null` = refuse

**Trigger:** the `apply` orchestrator (#850) surfaced that §D1's `age_recipient: null` → "mint + hand off" is not just unimplemented but **wrong to implement**, and the implementation correctly *refuses* (pre-flight before consent gate 1) instead.

**Ruling — supersedes the §D1 schema comment `age_recipient: null → mint + hand off`:**

The age **private** key decrypts the entire store-of-record vault — the per-project CA key and every agent's App private key (§D5). It is therefore the fleet's **master secret**. §D1's original "mint + hand off" has the *provisioning tool* generate and print that master key. The correct posture — consistent with the vault-custody invariant this project has held throughout (secrets in operator custody; the tool handles public material only) — is **operator-provided**: the operator runs `age-keygen` out-of-band, only the **public recipient** enters `fleet.yaml`, and the private half never touches the provisioning tool.

- **`transport.age_recipient` unconfigured on a CREATE path = hard refuse, BEFORE gate 1 opens.** Opening consent gate 1 with no recipient mints a real GitHub App whose credential provably cannot be persisted — Amendment B's durability hole, with consent already spent. The pre-flight that refuses this is what makes the "hole closed" claim true (`apply-fleet.ts`'s `wouldCreateWithNoRecipient`). `null` therefore means **error-and-refuse**, not auto-mint.
- **Auto-minting is dropped from the contract**, not deferred as a feature. (If a future convenience path ever mints an age key, it must do so with a loud master-key-custody warning and explicit operator opt-in — but the canonical path is operator-provided.)

**Multi-recipient consequence (honoring Amendment B) — landed in #853, ahead of the first provision.** Amendment B requires the vault to be readable by **both** the VM key (so `vault.sh` decrypts at runtime) and the operator key (so a Mac-side reconcile/re-run can read the prior vault — the CA key + macf-routing creds live only there). Two **distinct** recipients cannot be expressed by a singular recipient field, so `transport` carries a **recipients list** (`transport.age_recipients: [<operator-pub>, <vm-pub>]`; `[]` = none minted yet → the create-path pre-flight refuses). Originally scoped for the reconcile-enabling increment, it was pulled forward to **#853 and merged before the first live provision** on a monotonic-cost argument: with no fleet yet provisioned it is a schema edit, whereas after fleets exist it is a live-vault migration — and landing it early means the first run exercises the canonical schema. The array is deliberately **not** `.min(1)` at the schema level: `[]` must parse so the refusal fires at the `wouldCreateWithNoRecipient` pre-flight (the layer that can explain why an empty recipient set is fatal on a create path), not as an opaque schema-length error. Note the second recipient (the VM key) needs the VM to have generated its own age keypair first — an operator/devops bootstrap step, gating a *real* fleet but not the sandbox. The weaker "one key held in two places" alternative is explicitly not preferred: two distinct keys is the robust store-of-record posture and is what Amendment B intends.

**First-run operational note:** the operator mints the age key out-of-band and sets the recipient to a key **the operator holds on the machine where `apply` runs** (option (b) on #850), provisioning one agent at a time. The VM key is a **runtime** requirement (`vault.sh` decrypting at agent start) and joins `age_recipients` when agents actually run — it is *not* the first-run recipient. Corrected against the first live provision (#854): `apply` runs Mac-side (§D4; gate 1's localhost redirect must land in the operator's browser), so the Amendment-B recovery artifact is written — and would be recovered — **there**. A VM-held sole recipient would leave the operator unable to decrypt an artifact sitting on their own machine, making the durability guarantee unusable in exactly the scenario it exists for. The live run used the operator's Mac key, which is precisely why it demonstrated the Amendment-C custody property (the driving agent provably could not decrypt what it created) instead of breaking it.

**References:** #850 (the orchestrator + the refusal) · §D1 (the schema comment superseded) · Amendment B (the multi-recipient requirement this makes the schema honor) · §D5 (the vault as master-secret-bearing store of record).

## Amendment D (2026-08-11, #838/#854 — after the first live provision) — the vault-access model for reconciliation

**Trigger:** the first live provision (#854 — `macf-experiment`, one agent) succeeded and **verified Amendments B + C in production** (durable-before-gate-2 logged before gate 2; the recovery artifact operator-key-only, so the provisioning agent drove the whole run *provably unable to decrypt the fleet's master secrets* — the custody boundary demonstrated, not merely asserted). It also surfaced the keystone reconciliation blocker: **nothing can READ the vault.** Increment 4 scoped out decrypt-merge-reencrypt and Amendment B routed around it, but reconciliation is *defined* as reading prior state (the Amendment-A vault-aware observer needs PEMs out of the vault; add-agent needs the existing CA key + `macf-routing` creds; §D5 re-materialize-from-vault IS a vault read; A2 drift is computed but unconsumed).

**Ruling — the vault's access model:** the vault is **read-only-decryptable into memory** and **whole-payload-writable single-shot**, and is **NEVER read-modify-written in place.** There is deliberately **no decrypt-merge-reencrypt primitive.**

- **Reads** decrypt an existing `vault.age` to a plaintext `VaultPayload` in memory — for the vault-aware observer (mint JWTs → live-confirm identity, Amendment A's confirm tier) and for re-materialization (§D5 / DR-010 / silent-fallback Instance 16 — read a secret's value, re-write it to the clobbered out-of-band copy).
- **Writes** always produce a *fresh full* `vault.age` from a fully-assembled in-memory payload via the existing single-shot `writeVault` (prior vault versioned aside by the clobber guard, never mutated). **add-agent does NOT force in-place RMW:** its "merge" is `{...priorAgentsReadFromVault, newAgent}` on the *typed plaintext struct*, then a whole-payload write — the merge is in the payload, never on ciphertext. Every write stays on the one Amendment-B-clean path.

**Custody boundary preserved through reconcile (extends Amendment C).** The vault decryptor is the **operator-privileged bootstrap CLI holding the operator's age key** (§D4 Mac-side plane) — never an agent context. Reading the vault into the CLI's memory does not breach "agents never decrypt": an *agent* pulling the vault into its LLM context would; the operator's CLI on the operator's machine with the operator's key does not. Consequence: the **real-fleet vault read is operator-gated** (only the operator-key holder can run it — exactly as #854 showed the building agent could not decrypt); code-agent tests the read/merge logic against **synthetic age keys + a synthetic vault**, and the real reconcile is an operator-run exercise.

**Reconciliation phasing (blessed on #838):**

| Phase | Work | Tier |
|---|---|---|
| **1** | `apply` names every plan verb it cannot action, **loudly, at approve-time AND in the summary** | closes the #854 silent-skip (plan promised 7, apply delivered 3) — a plan-approve-once gate that shows N and delivers <N manufactures false consent. **Warn, not refuse** — the refuse/warn discriminator: refuse only on irreversible harm / false consent (Amendment C's recipient case); warn when merely incomplete-but-honest (this) |
| **2** | Repo creation from `role_template`; CA ceremony (both two-place legs; CA key → vault); `MACF_ROUTING_RUNS_ON`; then whole-fleet provision one fresh agent at a time | **Amendment A honest-unknown tier** — idempotency is lock-based (trust the lock, don't re-create); needs no vault read (each agent is a fresh provision) |
| **3** | **Vault read** → vault-aware observer + read-only decrypt (this Amendment's model) | lifts phase 2 into **Amendment A's confirm tier** (live identity confirm + drift) |
| **4** | Reconcile verbs: drift → `update`+`confirm_required` (A2); add-agent; re-materialize-from-vault (§D5) | the reconciliation capability |
| **5** | Day-2: `versions:` steering (§D6), `collaborators:` federation, DR-035 skill as `fleet.yaml` front-end | design-covered, deferred by choice |

The phasing maps onto Amendment A's two observability tiers: phase 2 operates in honest-unknown (no PEM → lock-recorded-unverified); phase 3's vault read supplies the PEM → the confirm tier. Phase 2 must not over-reach for live-verified idempotency — that is phase 3 by construction.

**Two blockers gating a REAL fleet (not the sandbox):** (1) **#848** — `vault.sh` sources decrypted content via `eval`; a non-evaluating `KEY=VALUE` parser removes the injection surface the write-side guard (`buildVaultPlaintext`) exists to cover — two independent layers, the durable fix flagged in the #847 review. (2) the **VM age key as the second `age_recipients` entry** — #853 landed the list shape; the VM key itself requires the VM to have generated its keypair (operator/devops step), and reconcile-from-either-plane depends on it.

**References:** #854 (first live provision + the two defects) · #838 (the phasing thread) · §D5 (store of record) · Amendment A (two-tier observability) · Amendment B (durable-before-gate-2, the RMW-avoidance this generalizes) · Amendment C (operator-custody, extended here through reconcile) · #848 (vault.sh eval→parse).

## Amendment E (2026-08-12, #855 — operator-proposed) — deployed-secret drift detection via in-Actions attestation

**Trigger:** operator-proposed (via #855). §D5 / Design invariant 1 mandated a *write-time fingerprint* for every write-only artifact, but never specified how drift is **detected** for a write-only *GitHub secret* — and as built it cannot be: you cannot recompute a secret's fingerprint from outside, so a recorded fingerprint has nothing to compare against ("a fingerprint you can't recompute detects nothing"). #799 (a routing-client cert orphaned by a CA rotation — still *present* and *well-formed*, just signed by the old CA, invisible for weeks) is exactly this class (silent-fallback Instance 16). The DR-010 issuer-recording only *looked* like detection: it compares the *recorded* issuer against the current CA, which assumes the deployed secret still matches what we recorded — the assumption #799 broke.

**The reframe:** the vault/lock records **intended** value; drift detection also needs **deployed** reality; drift is the difference, so both sides are required. A vault read (even phase 3's) structurally *cannot* see a clobbered GitHub secret — it only recalls intent. **Inside a GitHub Actions run the secret IS readable**, so an agent-repo workflow observes the deployed value and publishes a comparable signal to a readable Actions *variable*; `macf routing doctor` / `fleet doctor` (DR-030) compare attested-vs-recorded. This is the missing *read side* of Design invariant 1 for deployed secrets.

**Ruling (settled on #855 after code-agent's buildability pushback corrected the first pass):**

- **Prerequisite — record a fingerprint for each *deployed* write-only secret at `gh secret set` time.** The `fleet.lock` fingerprints built in #847 (`app_private_key`/`client_secret`/`webhook_secret`) are **vault-only** — never deployed to GitHub, so never attestable; the attestable surface (`ROUTING_CLIENT_CERT`/`_KEY`) had **no recorded fingerprint at all**. The two sets are disjoint: this is not a migration of the vault fingerprints but a **new recorded surface** for deployed secrets — Design invariant 1 applied to the surface it was written for but whose wiring stopped at the vault. (An earlier framing of mine — "migrate the vault fingerprints to stay comparable" — was wrong on this fact; corrected on #855.)

- **Attest the RESULT-INVARIANT, typed per secret-kind — not the bytes.** This is the Instance-16 lesson turned on itself (verify the positive invariant on the *correct* signal, never infer from byte-sameness):
  - **Certs → semantic attestation:** a workflow asserts **chain-validates-against-the-current-CA + not-expired** (`openssl verify -CAfile <SEG>_CA_CERT` + `x509 -checkend`). This is the mechanism that actually catches #799, whose *bytes were unchanged* while validity changed under a rotated CA. Its output is a **non-secret property** (`{valid, expires, issuer_cn}`) — safe to publish raw, so **no salt / no HMAC / no byte-canonicalization**. This is the primary, load-bearing path, and it has zero salt coupling. (The DR-010 `<SEG>_ROUTING_CLIENT_CERT_ISSUER` readable var is the precedent + home for the recorded-issuer side; attestation supplies the deployed side it lacked.)
  - **Opaque secrets → HMAC-under-a-per-fleet-salt digest.** Off the critical path (the #799 mechanism needs no salt) but adopted as the default on the *don't-force-a-per-secret-entropy-judgment* argument — the current set is all high-entropy, but bare-sha256 makes a future low-entropy addition silently unsafe. Canonical digest input = **"the exact bytes GitHub stores"** (the raw-PEM `certs.ts` vs base64 `#799`-staging divergence is a real silent mis-compare), pinned via `printf '%s'` (never `echo` — the newline caveat one layer deeper).

- **Freshness is part of the compared state.** An attestation is only as fresh as its last run; a stale attestation trusted as current is *itself* the silent-fallback class being closed. The doctor treats "attestation older than threshold" as **honest-unknown** ("cannot confirm current state"), never silent trust — emit the run-timestamp alongside the signal and compare it.

- **All-mismatch vs single-mismatch discrimination (design-in).** A salt/canonicalization divergence makes **every** opaque digest mismatch at once, reading identically to "whole fleet clobbered." The doctor treats **all-opaque-mismatch as a salt/canonicalization fault** and **single-mismatch as real drift**, or the first salt rotation fires a fleet-wide false alarm. The salt is itself an un-attestable write-only secret — acceptable *only because* its failure mode is exactly that loud all-mismatch; stated explicitly, not left implicit.

- **Trust surface + placement.** The attestation workflow reads secrets → trust-sensitive, hardened like `agent-router` (pinned action SHAs, minimal `permissions:`, digest written via API not echoed). The HMAC-salt makes the *published* opaque digest non-sensitive, so a masking failure isn't a leak — trust surface and digest form protect each other. It is a **signal source feeding** `routing doctor` / `fleet doctor`, not a new command. **Gates a real fleet, not the sandbox** (alongside #848 + the VM-key second recipient); runs parallel to the reconciliation arc, feeding phase 4's drift verbs.

**Detection ≠ remediation.** This makes drift visible continuously + cheaply and reaches the deployed-secret surface a vault read can't; remediation (re-materialize from the vault) still needs the real value (phase 3/4). Since #799 was a *detection* failure, this is the more valuable half.

**References:** #855 (the proposal + the buildability correction) · #799 (the worked failure) · `silent-fallback-hazards.md` Instance 16 · DR-010 amendment (the issuer-recording this completes) · §D5 + Design invariant 1 (the read-side this supplies) · DR-030 (`fleet doctor`) · Amendment D (the reconciliation arc this runs parallel to).

## Amendment F (2026-08-12, #857 — operator-proposed) — the per-fleet control-plane repo

**Trigger:** operator-proposed (via #857). §D1 as ratified says *"`fleet.yaml` + `fleet.lock` live committed in the fleet's science/coordination repo — that repo IS the GitOps repo."* But that is an **agent's** repo, and the fleet's science agent has **write** access to it — a privilege inversion: a fleet agent can rewrite its own desired-state manifest, and (with `transport.vault_repo` typically the same repo) can delete/truncate/clobber the sealed `vault.age`. It cannot *decrypt* the vault (Amendment C holds), but it can destroy the store of record. The first live provision (#854) made `fleet.lock`/`vault.age` real artifacts, so this is concrete, not theoretical.

**The unifying frame:** Amendments B/C/D put the fleet's master secrets outside the agent's **READ** scope (the agent can't decrypt what it provisions); this puts the control plane outside the agent's **WRITE** scope too. *The managed must not control its management* — in both directions. This completes the custody arc rather than contradicting it.

**Ruling — a per-fleet control-plane repo:**

- **One control repo per fleet, `<fleet>-control` (derived, not registry-pointed), operator-owned, NO fleet agent granted write.** It holds the GitOps state (`fleet.yaml` + `fleet.lock`), the sealed `vault.age`, the scheduled validation workflows, and the servicing toolkit. Discovery is deterministic derivation from the fleet name (no lookup, no drift surface). Because the name is *computed*, bootstrap **must detect a pre-existing `<fleet>-control` and fail loud** (someone else's repo, or a same-named retired fleet's leftover) rather than silently adopt it — confirm-before-create's shape at the repo layer.

- **Per-fleet, not shared — the lifecycle argument is the decider** (not access control, which a shared no-agent-write repo could also meet). Fleets are ephemeral; a per-fleet repo archives *with* its fleet in one action, so repo count is bounded by *live* fleets and retirement is clean. A shared repo accumulates dead fleets' state permanently with no per-fleet cleanup, and GitHub has no path-scoped permissions.

- **The invariant, at the right granularity (corrected from the #857 first pass, which stated it too broadly to coexist with its own mechanism):**
  - **git-committed content → sealed-or-public ONLY:** `vault.age` (encrypted), `fleet.yaml`/`fleet.lock` (secret-free), workflows, attested non-secret signals. This is the load-bearing invariant — it is what makes the sealed vault safe to commit *anywhere*. **The age private key and any plaintext secret NEVER appear in committed content.**
  - **Actions secrets → a separate, explicitly-permitted category, constrained to READ-ONLY credentials** (the control App's key — see below). Never the age key, never a fleet-agent credential, never a write-scoped token.
  - The two protections stay independent: **agent-clobber** is blocked by operator-only *write*; **repo-compromise** is blocked by the age key being *absent* (it stays with the operator-privileged CLI decryptor, Amendment D). Co-locating the age key collapses both — forbidden.

- **The scheduled doctors run under an account-shared, read-only control-plane App.** `fleet doctor` / `routing doctor` (DR-030) run *in* the control repo on a cadence and need a **non-agent** identity to read the registry, reach agents, and read agent-repo attested signals (#855). This is a **dedicated read-only App** (`metadata`/`contents`/`actions_variables`/`actions` all *read*), and — following the `macf-routing` pattern — **one per account, detected-and-reused**, NOT per-fleet: the install-extension asymmetry (creating an installation is browser-only, but `PUT /user/installations/{id}/repositories/{id}` extends an existing one by API) means 2 consent clicks *once ever*, then every later fleet extends the installation to its repos with zero clicks. A routing identity must not grow control-plane read scope, so it is dedicated, not `macf-routing` reused. Residual, stated explicitly: an account-shared read App can read *all* fleets' control planes — acceptable (read-only, operator's own account), noted not accidental.

- **The attestation workflows (#855) run in the AGENT/caller repos, not here.** A workflow can only attest a secret it can read, and the deployed write-only secrets (`ROUTING_CLIENT_CERT`/`_KEY`) live in the caller repos where the router reads them. So attestation runs there and publishes non-secret attested signals; the control repo's doctors **consume** those signals. The control plane therefore never holds a raw fleet secret.

- **`transport.vault_repo` is REMOVED; the vault always lives in the control repo.** Keeping it explicit re-introduces the exact misconfiguration this amendment kills (point the vault at an agent repo). Make the bad state unrepresentable — the vault location is derived from the control repo, no knob. (This also structurally kills the #854 "wrote `vault.age`/`fleet.lock` to `/tmp`" problem: those paths derive from manifest location today — operator-remembered — and a fixed control-repo home makes the correct location structural.)

- **Bootstrap ordering — the control repo is provisioning step 0**, and its creation is the **first mutating step** (a failure aborts before any consent is spent). Run #1 takes a **local** `fleet.yaml` (operator-authored bootstrap *input*); apply derives `<fleet>-control`, creates it, and **commits the manifest into it as its first act** (the GitOps *record*); subsequent runs read the committed copy. This resolves the mild chicken-and-egg (the manifest lives in the control repo, but you need the manifest to know the fleet name) and folds into #854 §2's repo-creation work — the control repo is simply the first repo bootstrap creates, via the same create-from-template machinery.

- **Fleet retirement (day-2 use case) — the other half of the lifecycle the per-fleet argument rests on.** Retirement is **deliberate and operator-gated, orthogonal to §D3's no-prune** (which governs *reconcile* not to auto-delete; retirement is an explicit operator act). The sequence: uninstall/revoke the per-agent Apps, delete the registry vars, **archive** (not delete — keep the audit trail) the control repo; optionally destroy the age key to render the archived `vault.age` permanently sealed. Per-fleet-repo is what makes this one clean archive instead of surgery on shared state.

**§D1 amendment:** the ratified line "*that repo IS the GitOps repo*" is superseded — the **`<fleet>-control` repo** is the GitOps repo, and it is deliberately *not* a fleet member's repo.

**References:** §D1 (the line superseded) · Amendments B/C/D (the READ-scope custody this extends to WRITE scope) · #854 (first provision; the `/tmp` path problem this fixes) · #855 (attestation — runs in agent repos, consumed here) · DR-030 (the doctors this schedules) · DR-032 (agent naming, collision-free with `<fleet>-control`) · §D2 (the two-interactions-per-App property the account-shared App preserves).

## Amendment G (2026-08-12, #867 — operator-proposed) — the fleet teardown ladder

**Trigger:** operator-proposed. Amendment F named retirement as a day-2 use case in one sentence; this is its structure. The operator rejected the original "`retire` + `--purge` flag" framing on two counts — *retire* names an intent not an action, and a destructive flag on a safe verb puts wildly different blast radii one typo apart — and reframed teardown as a **ladder whose rungs are distinguished by what REVIVAL costs in operator clicks** (App/repo creation-deletion being exactly the human-gated steps).

**The load-bearing property (§D5 paying off in a direction it wasn't built for):** because the App private keys live in `vault.age`, the Apps AND their installations **survive** the first two rungs — so revival is pure reconciliation with zero consent gates. A store-of-record built for reconcile durability turns out to make fleet revival free. This is what makes the operator's "archive now, redeploy months later" requirement already true rather than something to build.

### The ladder (four verbs, not a flag)

| Verb | Removes | Revival cost |
|---|---|---|
| **`deactivate`** | the fleet's **org/account-scope registry presence** — the `<SEG>_CA_CERT` registry leg, the `<SEG>_AGENT_<AGENT-SEG>` registrations, `<SEG>_FEDERATED_CAS` | `apply` — **0 clicks** |
| **`archive`** | + archives the control + agent repos | un-archive (API) + `apply` — **0 clicks** |
| **`delete-apps`** | + deletes the agent GitHub App identities (frees the globally-unique names) | recreate Apps (**2 clicks/agent**, App creation browser-only) + `apply` |
| **`destroy`** | + deletes the repositories | full re-provision; **history gone forever** |

Separate verbs, never a `--purge` flag — the same make-the-bad-state-unrepresentable principle as removing `transport.vault_repo` and deriving the App handle. `macf fleet archive` and `macf fleet destroy` cannot be confused; `--archive` vs `--purge` can.

### `deactivate` is *deregistration*, not housekeeping (operator correction, 2026-08-12)

The rung targets **org/account-scope entries ONLY** — never repo-scoped variables/secrets, which travel with an archived repo, harm nothing sitting there, and whose deletion is busywork that only makes revival more expensive. The essence: **removing the registry presence is what makes a fleet inactive**, because the registry is how agents are discovered and how routing resolves a target — remove it and the fleet stops being *addressable* while every durable artifact survives. `deactivate ↔ reactivate` names exactly that reversibility. Revival re-derives the org-scope entries from `fleet.yaml` + `vault.age` — §D5 again.

### The rungs are cumulative — **chosen for coherence, NOT forced by a constraint**

`deactivate ⊂ archive ⊂ delete-apps`; `destroy` is terminal (deletes repos directly — archiving something you're about to delete is pointless). The nesting is a *design choice*: an archived-but-still-registered fleet is **incoherent** — the registry would advertise addressable agents whose repos are frozen read-only, so routing keeps resolving targets that can't accept work. It is recorded as chosen-for-coherence deliberately: a rationale anchored to a *removable* constraint (an earlier draft claimed read-only "forces" clean-before-archive) collapses the moment someone re-checks the constraint and finds it inapplicable — and then the nesting reads as arbitrary. `deactivate` and `archive` are in fact **order-independent** on the teardown path (deactivate touches org scope, archive touches repos — no ordering dependency); the read-only fact binds only **revival** (un-archive must precede any `apply` write).

**Cumulative rungs REQUIRE per-action idempotency (added 2026-08-13, macf#917/#918 — a gap in this amendment as originally written).** If rung N re-executes rung N−1's actions, every one of those actions must be safely repeatable. This amendment mandated the re-execution (`deactivate ⊂ archive ⊂ delete-apps`) and omitted the property that makes it safe, and the omission surfaced on the first live walk of the documented order: `delete-apps` re-archived repos `archive` had already archived, and GitHub refuses `PATCH` on an archived repo — *including its own settings* — so the ladder 403'd on its second rung. Each rung passed CI because **each was only ever tested in isolation; the sequence an operator actually runs was never driven.** Unit coverage was complete and the walk was still broken, because the defect lived only in the transition between rungs.

**The required shape, and it is not error-catching.** Idempotency here is established by **reading the result-invariant first** — `checkMeta(repo).archived === true` → skip, the mutating call never issued — never by catching the failure. Catching is wrong on two counts: a blanket `403` swallows genuine permission failures, and GitHub returns **the same 403 for "archived" and for "insufficient permission,"** so classifying from the error response is *guessing at cause, not asserting it* (the same distinction as Amendment C's unreadable-pin rule and `silent-fallback-hazards.md` Instance 17's proxy-vs-invariant). Message-matching is worse still: it breaks silently the moment the provider rewords.

**Skip only on a CONFIRMED positive; an inconclusive read attempts the action.** The guard's polarity is load-bearing: a redundant mutation is harmless, whereas a wrongly-skipped one is a silent no-op that reports success. Honest-unknown must resolve toward *attempt* here — the opposite polarity is how an "idempotency guard" quietly becomes under-execution.

**Testing consequence:** a cumulative ladder must be covered by a **sequence test that walks the documented order end to end** (and re-runs each rung a second time), not only by per-rung unit tests. Per-rung coverage cannot see a transition defect by construction.

### Amendment G AMENDS Amendment F's ownership rule — `archived → foreign` becomes name-match-discriminated

Amendment F's shipped `classifyControlRepoOwnership` refuses an archived control repo as `foreign` *before any content check*. That was correct when archiving meant only "retired, done" — but the ladder makes archive a **reversible state of a live fleet**, so archived-ness stops being a valid discriminator, and the shipped rule would make `archive → apply` **refuse the fleet's own control repo** — the ladder's central promise (free revival) unreachable, with the worst failure mode: an operator archives expecting to revive and discovers months later the tool rejects its own repo. The fix discriminates on **name-match, not archived-ness**:

- `archived` + `fleet.yaml` parses + `metadata.name` **matches** → **`ours-archived`** (revivable);
- `archived` + missing/unparseable/mismatched `fleet.yaml` → **`foreign`** (unchanged — the case the original rule actually protects: someone else's `<fleet>-control` or a name collision, which won't carry our `metadata.name`, still fails closed);
- everything else unchanged.

Reads work on archived repos (read-only ≠ unreadable), so the content check is available. **`apply` must NOT silently un-archive** an `ours-archived` repo: un-archiving reverses a state the operator deliberately set, so it is surfaced as its own **confirm-required plan item** (plan-approve-once governs it). This stays in the "free revival" tier — an approval keystroke + an API PATCH is zero *consent-gate* clicks (no browser round-trip).

### Shared rails (all four verbs)

- **Inventory shown + confirmed before any mutation** (the DR-035 §4 plan-approve-once shape), with irreversible items called out separately from recoverable ones.
- **Never scan-and-delete by name pattern — EXACT-KEY targeting only, and this is the design's highest-stakes instance of the rail.** The target set is derived from `fleet.yaml` + `fleet.lock` by exact key, never by `<PROJECT>_`-prefix sweep — because `deactivate`'s targets are **org/account-scope entries in a namespace shared with every other fleet**, so a prefix sweep could delete *another live fleet's registration*, not merely a same-named repo.
- **Refuse a foreign control repo** (reuse the name-match `classifyControlRepoOwnership` above) — teardown cannot be aimed at another fleet's control plane.
- **Report what could not be done**, never exit green — if App deletion needs a browser, name which Apps remain and where to click (silence here is the #854 shape in its worse direction).
- **Explicitly NOT reconcile** — §D3's no-prune governs *reconcile*; these are deliberate operator acts on a named fleet, which is why they are separate verbs, not plan verbs.

**Correction (2026-08-13, macf#903) — the registration-key formula, and why it is pinned by test.** This amendment originally wrote the agent-registration variable as `MACF_<PROJECT>_AGENT_<NAME>`. That is **wrong**: the authority is `@groundnuty/macf-core`'s `createRegistry` (`registry.ts`), which computes `${toVariableSegment(project)}_AGENT_${toVariableSegment(agentName)}` — **no separate `MACF_` prefix is ever prepended**. Verified three ways: the writer's source, and the live registry (`MACF_AGENT_CODE_AGENT`, `ICSOC_2026_AGENT_CODE_AGENT`, `PPAM_2026_AGENT_SCIENCE_AGENT`). The mistaken form names `MACF_ICSOC_2026_AGENT_…` for a non-substrate fleet, which exists nowhere.

**The failure it would have caused is the reason this note exists:** `deactivate` built from the prose would compute keys matching nothing, delete nothing, and **report success** — silent under-deletion on the verb whose entire job is deletion, leaving a fleet addressable while telling the operator it was torn down. Note the shape: this amendment escalated *exact-key targeting* to a first-class rail so a prefix sweep could not destroy another fleet's registration — and then specified the target by a **remembered formula instead of the writer's derivation**, which is `silent-fallback-hazards.md` **Instance 20**'s class (subject named by convention rather than resolved from the authority) committed inside the specification written to prevent it. Over-deletion and under-deletion are the same defect facing opposite directions.

**Rule this establishes for target formulas generally:** a DR sentence is a *description* of a writer; **the writer is the authority, and where they disagree the DR is wrong by definition.** Implementations MUST pin such formulas against the real writer in test (as `macf#903` does) rather than re-derive them from prose.

### `destroy` — friction is the feature

Per the operator ("never — and I repeat never — allow easy repo removal"): `destroy` exists for the create→archive→delete end-to-end test, not routine use. Stack the acknowledgments: an explicit `--destroy-repositories` flag (implied by nothing), typing the **fleet name** to confirm, an environment acknowledgment (e.g. `MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES=1`), and the full inventory shown first with irreversible items called out separately.

### The age key

Only `destroy` offers to shred the age key (cryptographic erasure of any surviving vault copy), explicit opt-in only — the single action with no recovery whatsoever, and note it also renders `deactivate`/`archive` unrevivable, since the vault is what makes those free.

### Fact-stability + two build-time confirmations

The revival-cost gradient rests entirely on **verified** facts (Apps survive via the vault; unarchive is API-automatable; App *creation* is browser-only, fixing the 2-clicks/agent *recreation* cost). Two facts remain **build-time confirmations that refine mechanism, not the ladder**: (1) whether Actions variables/secrets stay *readable* on an archived repo — affects only how deep `plan` observes *within* an archived fleet, not the recognition (which keys on the `archived` repo flag, always readable); (2) whether App *deletion* has a REST path or is browser-only — affects only whether the `delete-apps` *action* needs clicks to execute, never the revival cost.

### Enables #869

A repeatable live-smoke (the live-contract-verification class flagged on #868) needs a **disposable target**; the teardown ladder is what makes the create→verify→teardown loop cheap enough to run.

**References:** Amendment F (retirement-as-day-2, now structured here; its `archived → foreign` ownership rule amended) · §D3 (no-prune governs reconcile, not deliberate teardown) · §D5 (the store-of-record that makes revival free) · #854 (report-what-couldn't-be-done) · #868 (live-run findings) · #869 (live-smoke, which this enables).


## Amendment H (2026-08-13, #922/#923/#924 — operator directive) — the runner is DECLARED, not merely pointed at; and the router reads `MACF_TRUSTED_ACTORS`

**Two corrections in one, because the second replaces the field the first got wrong.**

### H1 — the variable: `MACF_TRUSTED_ACTORS`, never `MACF_ROUTING_RUNS_ON`

§D1's original runner block instructed `apply` to write `MACF_ROUTING_RUNS_ON`. **The v3 router never reads it.** Verified against the router source: `grep 'vars\.MACF_' .github/workflows/agent-router.yml` returns **exactly one** hit — `MACF_TRUSTED_ACTORS` — and `MACF_ROUTING_RUNS_ON` appears nowhere in v3 (`git log --all -S` finds it only on the legacy `refs/tags/v1` SSH-routing line). This DR carried a v1-era name into a v3 world; the writer is the authority (Amendment G's correction rule, macf#904) and the DR was wrong.

**The error was conceptual, not just a wrong identifier.** `runs_on` modelled the control as a *runner selector*; the router has none. Self-hosted eligibility is gated by a **trusted-actors allowlist** — an authorization decision, not a placement one: `pick-runner` compares `github.actor` against `MACF_TRUSTED_ACTORS` and emits either `"ubuntu-latest"` or `["self-hosted","macf-vm"]`.

**The failure mode was silent cost**, which is why it survived: an unset variable is not an error — routing simply falls through to GitHub-hosted, on every `issues`/`issue_comment`/`pull_request`/`pull_request_review` event, drawing down quota and billing beyond it on **private** repos, while the paid-for self-hosted runner sat idle. Nothing surfaces that but an invoice.

**Value format (verified three ways, all of which matter):** `<fleet>-<role>[bot]`, **space-separated**. Every entry carries the `[bot]` suffix — the router compares directly against `github.actor` with no in-workflow append. A JSON array silently matches nothing.

### H2 — the runner is DECLARED in the manifest and registered by `deploy` (supersedes "the manifest POINTS, it does not provision")

**Operator directive (2026-08-13):** *"I would expect that I can specify the runner details in our configuration … and all the mechanics should do it in one deterministic run … it should be done in one apply."* The prior boundary produced a two-run flow requiring the operator to hand-sequence `apply → register runner → apply again`; the tool surfaced an ordering constraint and made a human resolve it. That is overruled.

**Why a strictly-single `apply` is not achievable — and what the requirement really demands.** The fleet spans two machines by physical necessity: consent gate 1's localhost redirect must reach the **operator's browser** (pinning `apply` to the Mac, §D2/§D4), while the workspace, the on-disk App key, and the runner service must exist on the **VM** (pinning `deploy` there). Runner registration is likewise two-sided — the token is mintable via API from anywhere, but `config.sh` plus a supervised service must execute on the machine that will run jobs. So:

**`macf fleet deploy` owns runner registration.** It already runs VM-side, already holds credentials, and is **already mandatory before any agent runs** — so this adds **zero new operator steps**, no hand-sequencing, and no improvisation. Rejected: having `apply` SSH into the VM (one *invocation*, but permanently widens what the Mac-side provisioner can reach, for no reduction in operator touches — Amendments C/D are worth more than a command-count optimisation).

**Scope narrowed by operator clarification (2026-08-13):** *"We assume that the runner is deployed, always, somewhere, that it's running, and all we have to do is to register it. Our scope is not deploying runners. Our scope is just pointing our configuration to the existing runner."* So **runner deployment and lifecycle are explicitly OUT of scope**; the fleet points at a runner that already exists. This changes who needs a registration step at all:

| fleet owner | registration | why |
|---|---|---|
| **org** (e.g. `macf-experiment`) | **none — a no-op** | an org-level runner already serves **every repo in the org**; there is nothing per-repo to register |
| **user account** (e.g. `groundnuty/*`) | **`deploy` registers per repo** | a user account **cannot hold account-level runners**, so repo-scoping is forced |

The DR must not imply every fleet needs a registration step — for the org case, the entire remaining job is writing `MACF_TRUSTED_ACTORS`, which `apply` already does.

**The detection invariant is "a runner is USABLE BY THIS REPO" — not "a runner exists."** Two failure directions, both real:
- Querying only `repos/<repo>/actions/runners` misses **org-level** runners (they live at `orgs/<org>/actions/runners`), so an org fleet with a perfectly good runner reads `total_count: 0` → gate says absent → trust variable skipped → **hosted fallback bills on private repos**. This is macf#922/#923's cost bug reintroduced by an incomplete check (found live, macf#924).
- But an org runner's **runner group may be restricted to selected repositories**, so a runner can exist, be online, and still never claim this repo's jobs. Asserting mere existence would write the trust variable for an unusable runner — the same proxy-vs-invariant mistake in the opposite direction.

So detection considers **repo-level runners plus org-level runners whose group visibility admits this repo**. Where adding the repo to a runner group is required, that is an **org-admin action the tool NAMES and hands over**, never attempts (the `delete-apps` pattern: report what it cannot do, with the exact step).

**Why the conservative default is right — the failure modes are asymmetric.** Writing the trust variable with no usable runner makes routing jobs queue for a runner that never claims them: **the fleet silently stops coordinating.** Skipping it when a runner does exist causes a hosted fallback: **it costs money, but routing works.** The conservative default therefore fails toward *functional-but-costly*, which is the correct direction — so the fix for a missed runner is to make **detection complete**, never to relax the gate. That makes the honest-unknown path load-bearing: when scope-completeness is genuinely unreadable (e.g. no permission to enumerate org runner groups), the tool **skips LOUDLY and actionably** — naming the scope it could not read and the operator command that settles it — never silently, since a silent skip is indistinguishable from "no runner exists," which is how this class keeps regenerating.

**Requirements on the flow:**

1. **Confirm by result-invariant, never by exit code.** `config.sh` exiting 0 is not evidence of an online runner — assert against `GET /repos/{owner}/{repo}/actions/runners` that the expected runner is present and online (Instance 17 / Amendment C / macf#918's lesson).
2. **`MACF_TRUSTED_ACTORS` is written only after that confirmation** — register-before-route, never optimistically.
3. **`apply` states the pending step** rather than silently deferring it: its report names the unregistered runner and `deploy` as the command that completes it (§D3/macf#854 — a green run must never imply a capability that does not exist).
4. **Reuse is detect-and-reuse, never re-register** — the operator's intent is fleet-agnostic shared routing runners, so a declared runner already present and online is **adopted**, matching the shared `macf-routing` App pattern.

**Scope constraint (a GitHub fact, not a choice):** a **user account cannot hold account-level runners**, so every `groundnuty/*` fleet is **repo-scoped by necessity**; only an org-owned fleet can share one org runner across all its repos. Per-repo runner declaration is deferred — fleet-level first, per the operator.

**References:** #922/#923 (the wrong variable + its silent cost) · #924 (the operator directive + the two-sided constraint) · §D1 (runner block replaced) · §D2/§D4 (why the Mac/VM split is physical) · Amendments C/D (the privilege separation preserved) · #914 (`fleet deploy`, the host-side command this extends).

### H.1 — who confirms the registration: the token is POLICY, detection is TIMING (2026-08-13, #929/#931)

Amendment H says the runner is *declared* and then registered. It does not say **who confirms the registration**, and the answer is not obvious: `macf bootstrap apply` accepts a `--runner-token` (or `MACF_BOOTSTRAP_RUNNER_TOKEN`), so it is tempting to treat the token's presence as evidence that a runner exists. It is not.

**A registration token is unverifiable by `apply`.** No API validates it, reveals its scope, or proves a runner will follow, and it cannot be redeemed remotely (`config.sh` must run on the host that will serve jobs). Accepting it as evidence would assert an **unverifiable proxy in place of a verifiable invariant** — `silent-fallback-hazards.md` Instance 17's shape, aimed at the register-before-route gate.

So the two jobs are split:

- **The token decides POLICY.** It gates whether provisioning is attempted at all: a manifest that declares `routing.runner` with **no token supplied is a refusal**, naming the flag, the env var, and the command that mints a fresh token. Same posture as an unconfigured `age_recipients` (Amendment C) — a declared intent the tool cannot honour is refused, never silently skipped.
- **Detection decides TIMING.** `MACF_TRUSTED_ACTORS` is written **only** when `checkRunnerUsableByRepo` confirms a runner usable by that repo, with a bounded poll (consent gate 2's `waitForAppInstallation` shape) so a runner coming up during the deploy window still lands in one command. Token supplied but no runner confirmed → **not written**, reported plainly, converges on re-run.

**Why the conservative default is directionally correct, not merely cautious:** `MACF_TRUSTED_ACTORS` is the switch, not a hint. Verified against `macf-actions` `origin/main` — `pick-runner` checks exactly three things (not-a-fork, var non-empty, actor trusted) and **never consults runner existence**; nothing downstream re-evaluates it. Set it with no matching runner and every routed job emits self-hosted labels and queues to timeout: no fallback, no self-heal, the fleet silently stops coordinating. A hosted fallback merely costs metered minutes while routing keeps working.

**The two outcomes are encoded distinctly**, so the difference reaches the exit code, the summary and `--json` together: no-token → `failed` → exit 1 (an error the operator must fix); poll-exhausted → `skipped` → exit 0 (a not-yet that a re-run resolves).

**Known gap (not design):** the refusal currently fires at the routing step, after both consent gates. Nothing is lost — the fleet still provisions and a re-run completes it — but the error is knowable before the first click, and the registration token the operator then fetches expires in an hour. A pre-flight beside `runBootstrapApply`'s macf#913 XOR refusal closes it.

## Amendment I (2026-08-16, #939 — operator premise withdrawn) — the fleet CALLS a runner-provisioning contract; H2's out-of-scope clause is replaced

**Trigger.** H2 narrowed scope on an operator clarification — *"We assume that the runner is deployed, always, somewhere… Our scope is not deploying runners."* **That premise rested on runners being reusable across repos, and they are not.** Operator, 2026-08-16: *"The explicit statement in Amendment H was because I was pretty sure that we can reuse runners. Apparently we cannot. Hence there needs to be a little step while deploying the fleet that will actually call something that will provision the runners."*

**The GitHub fact, verified — and it is about REGISTRATION, not machines.** `groundnuty` is a **User** account (`gh api users/groundnuty --jq .type` → `User`), so no organization-level runner tier exists (`gh api orgs/groundnuty/actions/runners` → `404`), and repository-level runners are dedicated to a single repository. But the live fleet shows one VM serving four repos under the *same runner name* — `macf-vm-orzech-dev-agents` appears under both `groundnuty/macf` and `groundnuty/macf-science-agent`. So the **machine is already shared; the registration is what cannot be**. Consequence: a new fleet is not hard-blocked (a manual `config.sh` on the existing VM still works), but every new fleet repo needs a registration that something must create.

### I1 — the fleet calls a CONTRACT, never implementation objects

The runner platform (`groundnuty/runner-platform`: `charts/runner`, `bin/runnerctl`) exposes `provision` / `destroy` / `status` / `list`, taking three fields in **fleet vocabulary** — `repo`, `labels`, `warm`. Nothing a caller touches names the implementation.

**The vocabulary matters more than the transport, and that is the load-bearing property.** The platform has already changed implementation once (scale-sets → webhook mode) and may be deleted entirely if agent channel-servers become reachable without a tailnet join (DR-009 §10 option (c)). A caller that applied implementation objects directly would break on both. **The contract is what we promise not to change; everything behind it is free.** Properties the fleet may rely on: idempotent-by-name (so `provision` is callable unconditionally, with no does-it-exist dance), symmetric destroy, and stable exit codes.

### I2 — the runner step belongs to `apply`, non-fatally; H2's `deploy` placement is retired

**H2's argument dissolved rather than being overruled.** It assigned registration to `deploy` because *"`config.sh` plus a supervised service must execute on the machine that will run jobs."* Under the contract the thing that runs jobs is a pod the controller creates, so provisioning is an API call from anywhere and the two-sided machine split no longer applies to the runner half. **But removing the reason for a placement reopens the question rather than answering it**, and two considerations decide it:

- **Symmetry with teardown → fleet-lifecycle ownership.** The contract is symmetric (`provision`/`destroy`) and Amendment G's ladder gains the destroy side (I3). If `deploy` created while the ladder destroyed, create and destroy would live in different commands — exactly the asymmetry Amendment G's symmetric-destroy property exists to prevent.
- **Credential and dependency scope → non-fatal.** The contract needs a Kubernetes credential and cluster reachability, neither of which `apply` requires today. Wiring it **inline-and-fatal** would make fleet provisioning depend on the runner platform being up, even though every GitHub-side step would have succeeded — a new coupling in the direction the operator has been trimming (*"the runner tier must not depend on the observability tier"*; the symmetric case is that fleet provisioning must not depend on the runner tier).

**So `apply` calls the contract, non-fatally — and H.1 already supplies the failure semantics, which is the evidence the placement is right.** A failed `provision` (cluster down, unauthorised, contract error) is reported loudly and does not abort the run; `checkRunnerUsableByRepo` then finds no runner, `MACF_TRUSTED_ACTORS` stays unwritten, routing falls back to hosted — costly, working, converging on the next `apply`. **No new failure semantics are invented**, because the policy/timing split already covers "a runner that isn't there yet." `deploy` keeps nothing of the runner half.

**The bootstrap credential is NOT fleet state, so it is not an exception to the config/lock/vault triad — it is outside its scope.** The `runner-bootstrap` ServiceAccount is **shared infrastructure**: one cluster, one namespace-scoped token, every fleet. Placing it in per-fleet vaults would copy a single credential into N vaults and create N rotation sites for it. It is machine-level configuration of the shape `KUBECONFIG` already has. Recorded this way deliberately — as *not fleet state* rather than as *an exception* — so it cannot be cited as precedent for putting genuine fleet secrets outside the vault.

### I3 — Amendment G gains the runner rung, at `deactivate`, with a MANDATORY ordering

**The rung is `deactivate`, and the contract is what moved it there.** Amendment G orders rungs by **revival cost in operator clicks**. Under the VM/token model, destroying a runner meant a human SSHing in to re-run `config.sh` — expensive to reverse, so it would have sat high on the ladder. Under the contract, re-provisioning is an API call and the controller mints its own registration tokens: **zero operator clicks**. An operation changes rungs when its reversal cost changes, which is precisely why revival-cost was chosen as the axis over "how destructive it feels."

This is also consistent with the *reason* for the operator's org-scope-only narrowing of `deactivate`: repo-scoped GitHub state was excluded because it persists harmlessly and deleting it only makes revival costlier. A runner does **not** persist harmlessly — it holds a warm pod and consumes cluster resources — so that exclusion's rationale does not extend to it.

**MANDATORY ORDER: unset `MACF_TRUSTED_ACTORS` FIRST, then `runnerctl destroy`.** (Raised by `macf-devops-agent[bot]` on #939; the amendment would have shipped without it.) `pick-runner` never consults runner existence, so the two orders fail in opposite directions:

| order | window | consequence |
|---|---|---|
| **unset → destroy** | variable clear, runner still exists | jobs route hosted — **costs metered minutes, keeps working** |
| destroy → unset | runner gone, variable still points at it | **every routed job queues to timeout** — and if the second step fails, the window never closes |

The wrong order does not merely open a transient gap: **on partial failure it is permanent**, leaving a fleet that is deactivated *and silently broken* rather than deactivated *and dormant*. This is Amendment H's asymmetry applied to teardown, and it must be stated as a requirement rather than left to the implementer — both orders look equally reasonable to anyone not holding `pick-runner`'s behaviour in mind.

**It also makes `deactivate` symmetric with `apply` for the same reason:** `apply` writes the variable only *after* confirming a usable runner; `deactivate` clears it *before* removing one. One principle, two directions.

### I4 — H.1 is unchanged, and one ordering constraint on wiring

**H.1 survives intact.** `checkRunnerUsableByRepo` asserts against GitHub and is indifferent to who created the runner, so the token-is-policy / detection-is-timing split is untouched by the contract.

**`macf#934` must land BEFORE `apply` calls `provision --labels`.** The gate resolves presence and visibility but never compares labels; today that gap is masked by the convention that every runner carries `macf-vm`. A caller-supplied `--labels` is precisely the mechanism that unmasks it — wiring the call first would take a latent gap and hand it a trigger.


### I5 — "terminal" means `destroy` skips ARCHIVING, not everything below it (2026-08-16, #939)

I3 gave the ladder its runner rung at `deactivate`. Amendment G, however, states `deactivate ⊂ archive ⊂ delete-apps`; **`destroy` is terminal** — so `archive` and `delete-apps` inherit the rung, and **`destroy` inherits nothing.** Traced through, that produces a specific and ironic outcome:

- variable never unset, runner never destroyed, repos deleted → **no stall** (no repo, no jobs), but the **runner is orphaned** — a scale set for a repository that no longer exists;
- so **the one verb whose entire purpose is to leave nothing behind is the only rung that cannot reclaim a runner**, which is precisely the teardown-incompleteness I3 exists to close.

**And the obvious fix, applied alone, is worse than the leak.** Adding runner-destroy to `destroy` without the ordering opens the stall door there: a partial repo-deletion failure would strand a live repo with `MACF_TRUSTED_ACTORS` set and no runner — converting a resource leak into a silent coordination death, the wrong side of Amendment H's asymmetry. **The rung and its ordering must land in the same change.**

**Correction:** *terminal* means `destroy` **skips the archiving step** — for G's stated reason, that archiving something about to be deleted is pointless — and **not** that it skips the rungs below it. `destroy` performs `deactivate`'s work in its mandatory order (unset `MACF_TRUSTED_ACTORS`, then `runnerctl destroy`), then deletes Apps and repositories.

**The orphan's blast radius is plausibly cross-fleet, and is UNVERIFIED (`macf-devops-agent[bot]`, #939).** Characterising it as "an idle warm pod" may understate it: with `warm: 1` the RunnerDeployment keeps a pod alive and the controller keeps attempting to **register it against a repository that no longer exists**, using the *platform's* App credential. If that produces repeated failed registrations, the leak is a **rate-limit surface shared by every other fleet on the platform**, not wasted CPU in one namespace — which would raise this from tidiness to a cross-tenant concern. Recorded as *expected-but-unverified* rather than asserted: there is no cluster yet, and devops owns confirming it at canary and reporting either way. **The severity is open; the correction above is not contingent on it.**

**It is cheaply detectable in the meantime.** Every object the platform creates carries `app.kubernetes.io/managed-by=runner-platform` and a `runner-platform.io/repo` annotation holding the un-sanitised repo, and the list endpoint selects on that label and returns the annotation. So an orphan is one call away from being listed *with the dead repo's name attached*, and reconciling that list against live repos is a comparison rather than an investigation — a reasonable thing for `macf fleet doctor` to fold in later, requiring no new mechanism.

**Why this recurred:** the ladder's **composition semantics** were stated compactly — `⊂` for three rungs and one word, *terminal*, for the fourth — and the compact form was ambiguous about exactly the case that mattered. Same class as macf#917, where `⊂` mandated re-execution without stating the idempotency it requires. A ladder's *joins* need as much specification as its rungs; both defects lived in the composition rather than in any step.

**References:** #939 (this amendment) · H2 (the clause replaced) · H.1 (confirmed unchanged) · Amendment G (the ladder gaining the rung) · #934 (the ordering dependency) · `macf-devops-toolkit` DR-009 §10.3 (the mechanical justification: *"it can destroy one, which the VM path cannot do at all"*).


## Amendment J (2026-08-18, #942) — Amendment H's manifest example did not parse; the DR cites the schema rather than copying it

**Trigger.** `#942` was filed — by me — claiming `name`/`scope` were **fossils in the manifest** left over from the withdrawn detect-and-reuse premise. Reading the schema overturned that: they were never in it. `FleetRoutingRunnerSchema` is `runs_on` + optional `labels`, `.strict()`. **The drifted artifact was this DR.**

**The concrete defect was worse than a stale list — the example did not parse.** Amendment H's manifest sample declared `scope:` and `name:` (both rejected by `.strict()`) and omitted `runs_on` (required). An operator copying the DR's own example got a parse failure on three counts. Examples are the most-copied part of a design document, which makes a non-parsing one the most directly harmful form of drift.

### J1 — the field list lives in the schema; this DR names it

The example above now carries only fields that exist, and points at **`FleetRoutingRunnerSchema`** as the authority for *which fields exist*. The DR explains **semantics**; the code holds the **enumeration**.

**This is a rule, not a one-off fix.** A document that *enumerates* a schema will diverge from it, because two copies of one list have nothing keeping them equal — and no one re-reads a DR against code that moved. A document that *names* the schema cannot diverge. So: **reasoning in prose, inventory in code, prose references inventory.** Same move as replacing a magic `32` with a relation (`#951`), and as *"integrate at the state surface, not at the credential"* (`#943`) — do not duplicate the thing, reference it.

The limit, stated honestly: a citation can rot if the symbol is renamed. That failure is **loud** — a reader following `FleetRoutingRunnerSchema` and not finding it knows immediately that something moved — whereas a stale enumeration reads as current and authoritative. Trading a silent failure for a noisy one is the whole trade.

*(Where prose genuinely needs the values — an operator consulting a list without opening TypeScript — the answer is not careful copying but a test that reads the constant and asserts the doc contains it. The discriminator: **is the enumeration the content, or an illustration of it?** Illustration → reference. Content → assert. Two live instances of the content case exist outside this DR: `coordination.md`'s sandbox list and `observability-wiring.md`'s OTEL set, the latter documenting its own defect — *"CI does not enforce the lockstep — keep it manually."*)*

### J2 — the three fields, and what each actually does

- **`runs_on`** — required. Declaring `self-hosted` is precisely what makes a missing `--runner-token` a **refusal** (Amendment H.1's policy gate). H described the runner as "declared" without naming the field the gate keys on, so a reader could not connect the two.
- **`labels`** — optional, and **a cross-check, not a source.** Post-`#950` the router's emitted constant (`ROUTER_EMITTED_LABELS`) is the source of truth for runner usability; a manifest declaring labels that are not a superset is **rejected at parse**. So **the manifest declares labels it does not control** — counterintuitive enough that leaving it unstated invites someone to "fix" the gate to read from the manifest, which is the exact inversion `#934` closed.
- **`warm`** — optional, defaulting to **1** per DR-009 §7.4 (*"latency above all; `warm: 1` is mandatory, not a default to tune"*); `0` is meaningful only for a fleet declared dormant. Added in `#964` **together with its registration as un-actioned** in `planItemApplyCoverage`, because `apply` does not yet call the provisioning contract (`#943`): a silently-unenforced `warm` would have reproduced `#957`'s *"desired state accepted, recorded, reported converged, not enforced"* deliberately. The warning renders on every `plan` and stops on its own when `#943` wires it.

### J3 — `scope` stays absent, and the reason is not "we removed it"

On a **User account** `scope` can only ever be `repo` — private accounts cannot hold account-level runners at all — so it is not merely single-valued, it is **meaningless** on the topology that is the design centre. **A field with one legal value is not a choice; it is a knob whose only use is getting it wrong.** Same reason `transport.vault_repo` was removed in Amendment F.

Re-add it when an org-owned fleet makes the choice real — not on a "for completeness" pass. Stating the reason here is what prevents that pass: an unstated exclusion gets re-added, and an exclusion stated with a *false* reason gets **reversed**, which is worse because the reversal looks like a correction.
