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
  runner:
    runs_on: self-hosted          # → MACF_ROUTING_RUNS_ON var on every caller repo.
                                  #   Runner provisioned out-of-band (DR-003 gates);
                                  #   the manifest POINTS, it does not provision.

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

Agents already self-report deployed versions into the registry (the DR-037 machinery), so the reconciler has an observed-state source with no VM access: compare registry-reported versions against `versions.macf` / `versions.actions` → mismatch → **Confirm-then-update** → drive `macf fleet upgrade` (operational plane, §D4) with DR-037's verify-green gate (continue only on confirmed-green; HALT on bad-release or past-grace-unconfirmed). Re-running `apply` on a version-bumped manifest **is** the fleet upgrade trigger. This is reconcile-on-demand GitOps — no watching controller in v1, deliberately.

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
