# `fleet.yaml` manifest reconciliation audit (2026-08)

**Purpose.** The design intent of `macf bootstrap apply` is Kubernetes-style
reconciliation — a controller that compares each declared field against live
state and converges toward it. This audit asks, per field of
`FleetManifestSchema`: *does that actually happen?*

**Method.** Every verdict below is evidenced by a **code path** —
`file:line` where the field is read, and what is done with the value. Doc
comments are never evidence; where a doc comment claims more than the code
does, that mismatch is recorded separately (§4). All `file:line` references
are against `main` at `1b52117` (2026-08-26) and were read directly while
writing this audit; none propagate from another document. In particular,
`bootstrap/manifest-scaffold.ts` carries its own field-by-field audit table
— it is **not** cited as evidence anywhere here, because it answers a
different question ("is this observable from GitHub?") than this one ("does
`apply` reconcile it?").

Paths are relative to `packages/macf/src/` unless stated otherwise.

## Verdicts

| verdict | meaning |
|---|---|
| **RECONCILED** | live state is observed and converged toward the declaration |
| **WRITE-ONCE** | applied to live state, never compared back; drift invisible afterwards |
| **DECLARATIVE-ONLY** | read into a decision inside the tool, never applied to live state and never compared to it |
| **INERT** | parsed and consumed nowhere |

Two conventions, stated up front so the rows are consistent:

- **One verdict per field, taken from the `apply` path.** Where `plan`
  behaves differently from `apply` (it does, materially, for
  `versions.macf`), that appears in the evidence column, not as a second
  verdict.
- **WRITE-ONCE covers "written blind," not only "written at creation."**
  Some fields are re-sent on every run without ever being read back. The
  operator-facing consequence — drift is invisible — is identical, so they
  share the verdict; the evidence column says which shape applies.

## The `status` column

The second column answers a distinct question the same traversal can
answer: **is this field's LIVE value reported by `macf bootstrap status`?**
(`reported` / `not reported` / `unobservable-by-design`). A controller needs
both halves per field — the ability to *read* live state and the ability to
*converge* toward the declaration. The interesting cells are the mismatches.

`unobservable-by-design` marks fields with no separable live counterpart to
read (document-format literals, address-like locators), not gaps.
`bootstrap status` is a **GitHub-plane** observer by design — it holds no
agent client certificate, so agent-runtime facts are deliberately out of
scope (`status.ts:277`, `RUNTIME_UNOBSERVABLE_NOTE`, which redirects to
`macf fleet status`). Host-filesystem facts are likewise outside its plane;
where that is the reason for `not reported`, the row says so.

---

## 1. The table

| # | field | verdict | live value in `bootstrap status`? | evidence (code path) |
|---|---|---|---|---|
| 1 | `apiVersion` | **DECLARATIVE-ONLY** | unobservable-by-design | `z.literal('macf/v0')`, `bootstrap/fleet-manifest.ts:352`; accepts or rejects the document in `parseFleetManifest` (`:474`). Real behaviour — a wrong value is a parse failure — but never compared to anything live. |
| 2 | `kind` | **DECLARATIVE-ONLY** | unobservable-by-design | `z.literal('Fleet')`, `bootstrap/fleet-manifest.ts:353`. Same shape as `apiVersion`. |
| 3 | `metadata.name` | **RECONCILED** | reported | Derives the App handle (`fleet-manifest.ts:590` `deriveAppHandle`), the control-repo name (`:631`), the router-carrying repo set (`:648`) and `MACF_TRUSTED_ACTORS` (`:616`). The derived handle is compared against **live** GitHub installations: `apply-agent.ts:856` / `:1343` build `ExpectedIdentity{appSlug}`, and `identity-confirm.ts:225` filters live installs by `i.appSlug === expected.appSlug`. Control repo presence observed at `observer.ts:1291`, converged by `apply-fleet.ts` (`provisionControlRepo`). Status renders the derived handle + observed presence per agent (`status.ts:174`, `:233`). |
| 4 | `versions.macf` | **RECONCILED** (upward only) | reported — **but the value shown is `fleet.lock`'s record, not a live host read** (`status.ts:184` ← `observer.ts:1250`) | See §3. Apply's roll observes the agent's live `/health` version (`macf-core/src/fleet-upgrade.ts:574,583-587`); `plan`'s picture of the same field is lock-derived (`observer.ts:1250`). |
| 5 | `versions.actions` | **RECONCILED** | reported (live) | Live read of each router-carrying repo's committed `agent-router.yml` pin: `observer.ts:1234` `readCallerActionsPin(agent.repo)`, `:1298` for the control repo. Compared and converged: `apply-repo-init.ts:170-178` `resolveActionsPinReconcile` returns `force: observedPin !== declaredActions`; call sites `apply-fleet.ts:1196` (control repo) and `:1487` (per agent) force-rewrite the workflow. Bidirectional — a *newer* pin than declared is also rewritten. |
| 6 | `owner.account` | **RECONCILED** | not reported (echoed as part of the declared control-repo name at `status.ts:233`; the live install's owner login is not rendered) | `apply-agent.ts:856` / `:1343` set `ExpectedIdentity{accountLogin}`; `identity-confirm.ts:225` filters live installations by `i.accountLogin === expected.accountLogin`. Also drives the org-install listing at `observer.ts:1223` and `app-presence.ts:232`. |
| 7 | `owner.type` | **DECLARATIVE-ONLY** | not reported | Branches only, never compared: `app-presence.ts:231`, `observer.ts:1223`, `app-identity-removal.ts:125`, `manifest-flow-server.ts:92` all test `=== 'org'` to pick an API path or a settings URL. Nothing observes whether the account really is an org. A misdeclared `type: user` on a real org silently degrades observability to a "GitHub exposes no …" message (`app-presence.ts:258`) rather than erroring. |
| 8 | `owner.registry` | **RECONCILED** (repo variant); refusal-only otherwise | unobservable-by-design as a value; it is the *address* every reported registry read uses (`bootstrap-status.ts:113`) | The locator for every registry read/write (`observer.ts:1259`, `apply-fleet.ts:1900`, `teardown.ts:245/437`). For `type: 'repo'` it produces a genuine live check: `registry-repo-coverage.ts:235` `requiredRegistryRepoCoverage` feeds `checkRepoInAppInstallation`, and consent gate 2 instructs + re-polls until the live App installation covers that repo. `type: 'org'` is refused pre-flight (`registry-scope-preflight.ts:105-108`); `type: 'local'` is refused (`fleet-deploy.ts:474`, `apply-repo-init.ts:85`). What is reconciled is the *installation's coverage of the declared registry repo* — not "the fleet's registry is where the manifest says," which has no live counterpart. |
| 9 | `network.advertise_host` | **WRITE-ONCE** | **reported** (`status.ts:414` renders `${info.host}:${info.port}` from the live registry entry) | `fleet-deploy.ts:1229` passes it as `advertiseHost` into `initAgent`, which writes it into the workspace launcher/config. Never read back, never compared. Re-sent on every deploy-phase run (`force: true`, `fleet-deploy.ts:1242`), so a workspace-local edit is overwritten — but the **registered** host (what peers actually dial) is never compared to the declaration. See §2.1 for the invisible drift. **Sharpest mismatch cell in the table:** the live value is already on screen in `status`, and the read that produces it (`observer.ts:1058` `readAgentRegistryInfo`) is already wired — it is simply never diffed against the declaration. |
| 10 | `transport.age_recipients` | **RECONCILED** (grow-only, count-only) | reported (count only) | `plan.ts:1928` `vaultRecipientsItem(manifest.transport.age_recipients.length, observed.vaultRecipients)`; `apply-fleet.ts:2574` / `:2599` `reconcileVaultRecipients` re-encrypts when the vault has **fewer** stanzas than declared, and **refuses** the shrink direction (`apply-fleet.ts:2500`, `:2656`). An empty list refuses before consent gate 1 (`apply-ca.ts:257`, `apply-fleet.ts:1023`, `vault-write.ts:839`). Status: `status.ts:258` pairs `declaredCount` with `observed.vaultRecipients`. **Compares stanza COUNT, not identity** — `age`'s header cannot reveal recipient identity without per-key decryption, and `plan.ts:1668` words the match as "count-only" accordingly. |
| 11 | `transport.tailscale_oauth_required` | **DECLARATIVE-ONLY** | not reported | `commands/bootstrap-apply.ts:2463` `checkTailscaleOauthPreflight(...)`; `apply-fleet.ts:2146`; `plan.ts:1875` `tsOauthItem`. The flag is compared against **the supplied vault/flags** — whether a credential *source* was provided — never against live state. Per `apply-fleet.ts:2109-2122` the vault read is now unconditional, so the flag's sole remaining job is deciding whether *absence* refuses. The deployed `TS_OAUTH_*` Actions secrets are never read back. |
| 12 | `transport.router_app_scope` | **DECLARATIVE-ONLY** | not reported | `apply-fleet.ts:1773`, `commands/bootstrap-apply.ts:379`, `apply-runner-ops.ts:210`, `plan.ts:1865`. Selects which handle `deriveRouterAppHandle` produces and whether `resolveSharedRouterAppReuse` runs. The scope *value* is never compared to reality: nothing detects that a fleet now declaring `per-fleet` is still operating on a shared App from a prior run. (The handle it selects *is* then confirmed live, via the same `identity-confirm` path as any other identity — that is the handle being reconciled, not the scope.) |
| 13 | `transport.router_app_origin_fleet` | **WRITE-ONCE** | not reported (`FleetStatusView`, `status.ts:149-159`, has no `scope_credentials` member) | `apply-fleet.ts:1870` `writeScopeCredentialMarker(ROUTER_APP_ROLE, manifest.transport.router_app_origin_fleet)` records it into `fleet.lock`'s `scope_credentials`; `plan.ts:1896` surfaces it. Recorded, never verified — the named fleet could be renamed, deleted, or never have been the real source. The schema's own doc is honest about this (`fleet-manifest.ts:522-527`: "Provenance ONLY — nothing in this codebase reads this field to change behaviour"). |
| 14 | `defaults.role_template` | **WRITE-ONCE** | not reported | `apply-repo-init.ts:463` — `const template = agent.provenance === 'mirror' ? undefined : manifest.defaults.role_template` — feeds `repo-create.ts::ensureAgentRepo`'s `gh repo create --template`. Consulted **only when the repo is created**; for a `reused` repo the value is never looked at again. See §2.2 for the invisible drift. |
| 15 | `defaults.app_manifest` | **INERT** | not reported | Zero reads. Only occurrences outside the schema (`fleet-manifest.ts:194`) are in `manifest-scaffold.ts`'s own prose. See §2. |
| 16 | `agents[].role` | **RECONCILED** | reported | Derives the per-agent App handle (`fleet-manifest.ts:590`), compared against the live App slug at `identity-confirm.ts:225` via `apply-agent.ts:856`. Keys `observed.agents` (`observer.ts:1250`) and `fleet.lock`'s `agents[]`. Charset + uniqueness + the double-prefix trap are enforced at parse (`fleet-manifest.ts:380-418`). Observed-but-undeclared roles are surfaced as `report-extra` and never pruned (`plan.ts:1986`; `status.ts:221` `extraLockAgents`) — deliberate no-prune, so that direction is *surfaced* rather than converged. |
| 17 | `agents[].profile` | **INERT** | not reported | Zero reads. See §2. |
| 18 | `agents[].repo` | **RECONCILED** | reported | `plan.ts:901` `repoItem` reads live presence (`obs?.repo`, from `observer.ts`); `apply-fleet.ts` converges via `ensureAgentRepo` (create) and the archived-repo path (`plan.ts:1601` `agentRepoArchivedItem` + `agentRepoOptions:{confirmUnarchive:true}` at `commands/bootstrap-apply.ts`'s `resolveMutateDeps`). Uniqueness enforced at parse (`fleet-manifest.ts:410`). Status renders `repoPresence` (`status.ts:179`). |
| 19 | `agents[].deploy_path` | **RECONCILED** (host-local, conditional) | not reported — host-filesystem fact, outside `status`'s GitHub plane | `apply-deploy.ts:95` `resolvePath(agent.deploy_path)` → `deployAgent` materializes the workspace there; `remaining-deploy.ts:157-171` observes `existsSync(deployPath)` **and its parent** to report what is still undeployed and to distinguish "not deployed" from "belongs to another host". Conditional: the deploy phase only runs when both `--vault` and `--identity-key` were supplied, and only converges paths on the host running `apply`. |
| 20 | `agents[].provenance` | **DECLARATIVE-ONLY** | not reported | `apply-repo-init.ts:463` only — it selects the creation branch (`mirror` ⇒ no template ⇒ blank repo; otherwise `defaults.role_template`). Nothing observes whether a repo actually *is* a mirror or a template clone, and like `role_template` the field is a no-op once the repo exists. |
| 21 | `routing.runner.runs_on` | **RECONCILED** | reported (`status.ts:250-253` renders observed `runnerRegistered` / `runnerHandover` / `runnerDetail`; note `runsOn` itself, `:248`, is the declared value echoed back) | **The issue's premise holds only for the early pre-flight.** `apply-routing.ts:426-430` `checkRunnerTokenPreflight` *is* flag-only — but its own doc scopes it correctly ("This ADDS an early check; it does not move the authority"), and the authority is elsewhere: `apply-routing.ts:857` / `:866` call `deps.checkRunnerUsableByRepo(repo)` — the live per-repo read at `observer.ts:885` — wired to the real function at `commands/bootstrap-apply.ts:945`. A repo with no usable runner becomes a `'failed'` leg that fails the run. Convergence: `apply-fleet.ts:1713-1746` calls `provisionRunner` for every confirmed repo when `runs_on === 'self-hosted'`. |
| 22 | `routing.runner.labels` | **DECLARATIVE-ONLY** | not reported | Two consumers, neither a live comparison. (a) Parse-time cross-check against the **hard-coded** `ROUTER_EMITTED_LABELS` (`fleet-manifest.ts:432-449`) — a check against a constant, not against reality. (b) `apply-fleet.ts:1733` passes them into `provisionRunner`. The live usability check deliberately ignores the declared value and tests against the same hard-coded constant (`observer.ts:406`, `:426`). Non-authoritative **by design**, and the schema doc says so honestly (`fleet-manifest.ts:240-251`). Judgment call — see §7. |
| 23 | `routing.runner.warm` | **WRITE-ONCE** | not reported — `status.ts:249` echoes the **declared** value; `:457` labels the line `ROUTING (declared runs_on=…, warm=…)` | `apply-fleet.ts:1734` reads it and passes it to `provisionRunner` on **every** run; `plan.ts:1949` `runnerWarmItem` carries verb `'write-always'`, which `plan.ts`'s own `PlanVerb` doc defines as the kinds that "have NO live comparison against reality at all … because nothing was ever read." See §2.3. |
| 24 | `collaborators[]` (array presence) | **DECLARATIVE-ONLY** | not reported | `plan.ts:512` — `if (manifest.collaborators !== undefined && manifest.collaborators.length > 0)` pushes one `skipped_sections` entry with reason `'reconcile not implemented in v1'` (`plan.ts:501`). That is the only consumption anywhere. |
| 25 | `collaborators[].project` | **INERT** | not reported | `FleetCollaborator` has **zero** references outside `fleet-manifest.ts` and tests. Only the array's length is ever read. |
| 26 | `collaborators[].registry` | **INERT** | not reported | Same. |
| 27 | `collaborators[].ca_bundle` | **INERT** | not reported | Same. |
| 28 | `shared.routing_app` | **INERT** | not reported | `manifest.shared` has zero reads; `FleetShared` has zero references outside the schema and tests. |
| 29 | `shared.ts_oauth` | **INERT** | not reported | Same. |
| 30 | `trust.ca` | **INERT** | not reported | `manifest.trust` has zero reads; `FleetTrust` has zero references outside the schema and tests. |
| 31 | `trust.federated_cas` | **INERT** | not reported | Same. `teardown.ts:163` builds a `federatedCasVariableName(fleetName)` target derived from the **fleet name**, never from this list. |

> **Post-audit update (2026-08).** Rows 30-31 (`trust.ca` / `trust.federated_cas`)
> describe the schema AT `1b52117`, this audit's evidence baseline — they are
> pinned history, not live status. **groundnuty/macf#1205 (merged after this
> audit, before either row was acted on) removed `trust:` from
> `FleetManifestSchema` entirely** and made declaring it a loud parse-time
> refusal (`fleet-manifest.ts::rejectDeclaredTrust`) rather than a silent
> accept — a stronger disclosure than the `skippedSections` mechanism §2's
> own recommendation (below) proposes for the other seven rows. A
> `FleetManifest` value can no longer carry a `trust` key at all.
>
> **groundnuty/macf#1355 extended `plan.ts`'s `skippedSections` mechanism —
> already covering `collaborators[]` (row 24) — to `shared` (rows 28-29,
> same presence-gated shape: silent unless declared).** Rows 15/17
> (`defaults.app_manifest` / `agents[].profile`) and 25-27
> (`collaborators[].project` / `.registry` / `.ca_bundle`) remain OPEN —
> `#1355` deliberately did NOT push an entry for rows 15/17, because both
> are REQUIRED schema fields (no `.optional()` on either path): every
> schema-valid manifest declares them unconditionally, so a presence-gated
> entry can never be silent about "undeclared" and an unconditional one
> would violate the SAME "declaring none is byte-identical to today"
> contract `shared`'s presence-gating exists to honor — it would read as a
> permanent catalogue entry, not a disclosure about a particular manifest.
> Closing rows 15/17 honestly needs a schema change FIRST — make each
> `.optional()` (one notch weaker than #1205's outright removal of
> `trust:`), THEN presence-gate exactly like `shared` — or removal,
> mirroring #1205's precedent for a field with the same zero-consumer
> shape. Rows 25-27 stay genuinely INERT for the same reason they always
> were: `#1355`, like the original `collaborators[]` mechanism, discloses
> the ARRAY's presence, not each element field.

---

## 2. INERT fields — read this section first

**Nine of thirty-one fields are consumed nowhere.** An operator can set any
of them, commit them, and re-run `apply` to no effect whatsoever. Each is
either a bug or a field to remove. Two of the three affected sections
(`shared:`, `trust:`) were **not** in the evidence that prompted this
audit — they were found by grepping the exported *type* names rather than
the field names, which is the check that catches a field passed as a
parameter rather than reached through `manifest.`.

| field | evidence of non-consumption |
|---|---|
| `defaults.app_manifest` | Declared `fleet-manifest.ts:194`. Zero reads in `src/`. |
| `agents[].profile` | Declared `fleet-manifest.ts:212`. Zero reads in `src/`. |
| `collaborators[].project` | `FleetCollaborator` (`fleet-manifest.ts:461`) — zero references outside schema/tests. |
| `collaborators[].registry` | Same. |
| `collaborators[].ca_bundle` | Same. |
| `shared.routing_app` | `FleetShared` (`:462`) — zero references; `manifest.shared` — zero reads. |
| `shared.ts_oauth` | Same. |
| `trust.ca` | `FleetTrust` (`:463`) — zero references; `manifest.trust` — zero reads. |
| `trust.federated_cas` | Same. |

Note the asymmetry in how honestly each is presented. `FleetSharedSchema`'s
doc (`fleet-manifest.ts:298-322`) states plainly that it is "STILL
unconsumed" — an operator reading the schema is warned. `FleetTrustSchema`
(`:330-339`), `FleetDefaultsSchema` (`:191-196`) and `agents[].profile`
(`:212`) carry **no such warning**; `trust`'s only doc comment
(`:364-368`) actively implies the opposite (§4.1). The three sections with
no warning are the ones most likely to be set in good faith.

`collaborators[]` sits between the categories: its *presence* changes
`plan`'s output (a `skipped_sections` line), so an operator who declares it
gets a visible acknowledgement that it is not reconciled — but the three
fields inside it are read by nothing.

### 2.1 `network.advertise_host` — what drift is invisible

The declaration is written into each workspace at deploy time and never
compared to what the agent actually registered. If an agent's registry entry
carries a different host — because it was deployed before the manifest
changed, because a prior `macf init` set a different value, or because the
host moved — peers keep dialling the registered address, `apply` reports
nothing, and the manifest still reads converged.

The gap is a diff, not a read: `observer.ts:1058` `readAgentRegistryInfo`
already returns the registered `host`, and `bootstrap status` already
prints it (`status.ts:414`). Nothing compares the two values.

### 2.2 `defaults.role_template` — what drift is invisible

The template is consulted only on repo **creation** (`apply-repo-init.ts:463`
→ `ensureAgentRepo`). Change `role_template` in the manifest and re-run
`apply`: nothing happens to any existing repo, and `plan` renders
`repo … noop` because the repo *exists* — which is the only question that
item asks (`plan.ts:901-910`). The fleet silently keeps whatever template it
was born from. `agents[].provenance` has the same creation-only scope.

### 2.3 `routing.runner.warm` — what drift is invisible

`warm` is re-sent to the runner-provisioning contract on every run and never
read back. A platform that ignores it, or a runner pool that has since
scaled to zero, is indistinguishable from one honouring the declaration —
`plan` renders the identical `write-always` line either way, by
construction. `plan.ts`'s own `PlanVerb` doc is explicit that this verb
"carries zero signal while LOOKING covered," and cites a live
fault-injection sweep that found exactly this class. The same applies to
`routing.runner.labels`, which rides the same `provisionRunner` call.

---

## 3. `versions:` traced

Amendment L makes `versions:` authoritative — `apply` converges the fleet
toward it. The two subfields converge by **different mechanisms with
different trustworthiness**, and the asymmetry is the finding.

### 3.1 `versions.actions` — genuinely reconciled

- **Observation is live.** `observer.ts:1234` calls
  `readCallerActionsPin(agent.repo)` — a read of the pin committed in that
  repo's `.github/workflows/agent-router.yml`. The control repo gets the
  same read at `:1298`. Per-repo, not one representative repo.
- **Comparison is direct.** `apply-repo-init.ts:170-178`:
  `force: observedPin !== declaredActions`.
- **Convergence is unconditional in both directions.** `apply-fleet.ts:1196`
  and `:1487` force-rewrite the workflow whenever the pin differs —
  including when the live pin is *newer* than the declaration.
- **Honest floor.** An unreadable pin degrades to a low-confidence `create`
  (`plan.ts:1785`-region), never to `noop`; the write is still attempted.

This is the shape the rest of the manifest is measured against.

### 3.2 `versions.macf` — reconciled at apply, but self-referential at plan, and one-directional

Three separate facts, which are easy to conflate:

**(a) `apply` does observe live state.** `apply-version.ts:175`
`runApplyVersionPhase` calls `upgradeFleets` (macf-core) with the
manifest-declared target. `macf-core/src/fleet-upgrade.ts:574` reads
`runningVersion` from the agent's **live `/health`** response, and `:582-587`
classifies each member `offline` / `at-target` / `behind`. Only `behind`
members roll (`:994`). So the convergence loop is anchored to the running
process, not to bookkeeping.

**(b) `plan`'s view of the same field is anchored to `apply`'s own
bookkeeping.** `plan.ts:1721` `macfVersionItem` compares the declaration
against `obs.deployedVersion`, and `observer.ts:1250` sets that from
`lockEntry?.deployed_version` — `fleet.lock` **only**. `observer.ts:1189`
says so in as many words, and contrasts it with `actionsPin` at `:1198`
("by contrast, genuinely IS a live read"). The lock's value is written by
`macf-core/src/fleet-upgrade.ts:1125`
(`recordDeployedVersion(agent, plan.fleet, green.version)`) — from a
verified-green health read, so it is not fabricated, but it is only updated
**when a roll actually happened**. If nothing rolled, the lock keeps its
previous value indefinitely.

The consequence: the plan an operator reads and approves can render
`version … noop` for an agent whose host does not match the declaration —
because the last recorded roll matched. The subsequent `apply` would in fact
notice and roll it (via (a)), so this is a **disclosure** gap rather than a
convergence gap: the operator approves a plan that understates what is about
to happen. `bootstrap status` inherits the same lock-sourced value
(`status.ts:184`) and presents it in a column headed `VERSION`, with no
indication that it is a record rather than an observation.

**(c) Convergence is one-directional.**
`macf-core/src/fleet-upgrade.ts:584-585` —
`if (compareSemver(runningVersion, targetVersion) >= 0) disposition = 'at-target'`.
A host running a version **newer** than the manifest declares is classified
`at-target` and never touched. `versions.actions` has no such asymmetry (it
force-rewrites any difference). So a fleet cannot be pinned *down* to a
declared macf version by `apply`; it can only be brought *up* to it.

**(d) Two silent exits.** A member whose `/health` is unreachable is
`offline` (`:583`) and is skipped, not rolled — and an offline agent's
lock entry is not refreshed either, so both the convergence and the record
stall together. Separately, the whole phase is a graceful no-op when no
matching workspace exists on the host running `apply`
(`apply-version.ts:35`, `unreachable: true`) — which is the normal case
for any agent that lives on a different machine.

**Verdict.** `versions.actions`: RECONCILED, no reservations.
`versions.macf`: RECONCILED at `apply`, but (i) only upward, (ii) only for
agents both discoverable and online from the host running `apply`, and
(iii) with `plan` and `status` both reporting a *recorded* value rather than
the *live* one. Drift that is silently permanent under this design: a host
manually upgraded past the declared version, and any agent that is offline
or off-host at every `apply`.

---

## 4. Doc comments that claim more than the code does

### 4.1 `trust:` — a gating relationship that does not exist

`fleet-manifest.ts:364-368`:

> *"Optional-with-default (macf#839 review nit 5): a MACF fleet always needs
> a CA, so an omitted `trust:` section must NOT gate the CA plan items off —
> it defaults to the only v0 mode, per-project, with no federation
> declared."*

The comment describes a gating relationship between `trust:` and the CA plan
items, and a default that exists to keep that gate open. **No code reads
`manifest.trust` at all** — `FleetTrust` has zero references outside the
schema. The CA items are not gated on `trust:` in either direction, so the
default has no effect. A reader checking whether `trust:` is wired up finds
a comment reasoning carefully about its downstream behaviour, and stops
looking. This is the most consequential mismatch in the file, because
`trust.federated_cas` is exactly the sort of security-relevant list an
operator would expect to be enforced.

### 4.2 `collaborators:` — present tense for unbuilt behaviour

`fleet-manifest.ts:284-289`:

> *"Reconciles as a UNION into `<SEG>_FEDERATED_CAS` — never an override
> (DR-041 Amendment B). Slice 1a parses this section but does not reconcile
> it (day-2 …)."*

Sentence one asserts present-tense reconciliation; sentence three retracts
it. The retraction is accurate and the ordering is a reader-trap rather than
a falsehood — but a reader who stops at the first sentence has been told the
opposite of the truth.

### 4.3 `routing.runner.warm` — "Enforced" in bold, retracted in the next sentence

`fleet-manifest.ts:263-272` opens **"Enforced as of groundnuty/macf#943"**
and then concedes *"'Enforced' means 'apply sends it on every call,' not
'the contract is guaranteed to obey it'"*, and notes `plan` still classifies
it `'write-always'`. The retraction is unusually honest; the bolded claim
that precedes it is what a skimming reader carries away. Same shape as 4.2.

### 4.4 The absent caveat is itself the defect

`agents[].profile` (`fleet-manifest.ts:212`) and `FleetDefaultsSchema`
(`:191-196`, containing `app_manifest`) carry **no doc comment at all**.
Both are inert. In a file where nearly every other field has a paragraph of
rationale, silence reads as "ordinary," not as "unconsumed" —
`FleetSharedSchema`'s explicit "STILL unconsumed" is the model these should
follow. An inert field in a heavily-documented schema looks alive precisely
*because* the surrounding documentation is good.

### 4.5 Docs that are accurate, recorded so they are not re-audited

- `FleetVersionsSchema` (`:52-57`) correctly names `fleet.lock` as the
  source for the `macf` half and "a live read" for the `actions` half —
  the asymmetry in §3 is documented, not hidden.
- `routing.runner.labels` (`:240-251`) correctly states it is a cross-check,
  "never the value that decides what a live runner needs to carry."
- `ROUTER_EMITTED_LABELS` (`:219-234`) correctly explains why the expected
  label set is hard-coded rather than manifest-driven.
- `ScopeCredentialMarkerSchema` (`:528`) correctly states "nothing in this
  codebase reads this field to change behaviour."
- `checkRunnerTokenPreflight` (`apply-routing.ts:400-410`) correctly scopes
  itself: *"This ADDS an early check; it does not move the authority."*
  Reading only the function body (the evidence cited in the issue) without
  its doc or its call graph would misclassify row 21.

---

## 5. Fields whose verdict could not be fully determined

Stated as unknowns rather than guessed.

1. **Whether the runner platform honours `routing.runner.labels` and
   `routing.runner.warm`.** Both are POSTed to an external contract endpoint
   (`runner-platform.ts::provisionRunner`, endpoint from
   `MACF_RUNNER_PLATFORM_ENDPOINT`) whose implementation is not in this
   repository. This audit can establish that the values are sent and never
   read back — it cannot establish what happens to them afterwards. The
   verdicts for rows 22 and 23 are scoped to this repo accordingly.

2. **Whether `agents[].provenance` has any live counterpart.**
   `manifest-scaffold.ts:88` asserts "no live signal distinguishes
   template-clone vs mirror-remote provenance after the fact." GitHub's repo
   API does expose a `template_repository` field, so the assertion may be
   too strong — but this audit did not test it against a live repo, and the
   verdict for row 20 (DECLARATIVE-ONLY) does not depend on the answer.

3. **The `profile` registry variant of `owner.registry`.** The `repo`
   variant has a live coverage check and the `org`/`local` variants have
   explicit refusals; no variant-specific handling was found for `profile`
   beyond its use as a locator. Row 8's verdict is driven by the `repo`
   variant and says so.

4. **Ordering of `checkTailscaleOauthPreflight` relative to consent gate 1.**
   The field's doc (`fleet-manifest.ts:100-131`) claims it "refuses BEFORE
   consent gate 1." The call site exists (`commands/bootstrap-apply.ts:2463`)
   but this audit did not trace the surrounding control flow to confirm the
   ordering. Row 11's verdict does not depend on it.

---

## 6. Verification

Docs-only change — `git diff --stat origin/main` reports exactly one file
changed, this one. Commands run from the worktree at `1b52117`:

```
$ make -f dev.mk lint
✖ 1 problem (0 errors, 1 warning)
  apply-deploy.ts 96:5  warning  Unused eslint-disable directive

$ devbox run -- npx vitest run --root packages/macf
 Test Files  193 passed (193)
      Tests  4847 passed | 2 skipped (4849)
```

The single lint warning is pre-existing on `main` and is in a file this
change does not touch.

**One environment note worth recording**, since it presented as a code
failure and is not one: a freshly-created worktree that has not run
`make -f dev.mk install` fails **106 of 193 test files at import** with
`Cannot find package 'undici' imported from packages/macf-core/src/proxy-fetch.ts`.
`undici` is a declared dependency (`packages/macf-core/package.json:36`)
that is simply absent until `npm ci` runs. The suite-level failures are
collection errors, not assertions — the run above is after `install`.

---

## 7. Judgment calls

Recorded so a reviewer can disagree with the reasoning rather than only with
the verdict.

1. **`routing.runner.labels` → DECLARATIVE-ONLY rather than WRITE-ONCE.**
   The field has both a decision-only consumer (the parse-time cross-check
   against a hard-coded constant) and a write-through consumer
   (`provisionRunner`). Classified by the framing the field's own contract
   establishes — it is explicitly *not* authoritative for the live check —
   with the unverified write-through stated in the row. A reviewer preferring
   WRITE-ONCE would not be wrong; the evidence for both is in the row.

2. **Identifier fields → RECONCILED on the strength of their DERIVED
   identity, not the name itself.** This covers `metadata.name` (row 3),
   `agents[].role` (row 16) and `owner.registry` (row 8) together, because
   they share one shape: what `apply` compares against live state is the
   thing the field *derives* — an App handle, a control-repo name, an
   installation's repo coverage — never the declared string as such.
   Renaming any of them does not converge the existing fleet; it makes
   `apply` hunt for a different identity and provision a new one, leaving
   the old one behind (`§D3` no-prune). RECONCILED here means "the derived
   identity is asserted against reality and driven toward existing," which
   is the strongest sense available for a field that is an *address*. A
   stricter reading — that an address cannot be reconciled at all — would
   move all three to DECLARATIVE-ONLY; that reading is defensible and the
   evidence for it is in the rows. For `owner.registry` there is a further
   scope limit: only the `repo` variant produces a live comparison at all
   (`org` and `local` are refusals), and the row says so.

3. **`apiVersion` / `kind` → DECLARATIVE-ONLY, not INERT.** They accept or
   reject the document, which is real behaviour. Folding them into the INERT
   list would dilute the section that matters most.

4. **WRITE-ONCE covers blind re-writes.** `routing.runner.warm` is sent on
   every run, not once at creation. It shares the verdict with true
   write-once fields because the operator-facing consequence — nothing ever
   reads it back, so drift is invisible — is the same. The distinction is
   preserved in the evidence column.

5. **`routing.runner.runs_on` → RECONCILED, contradicting the evidence that
   prompted this audit.** `apply-routing.ts:426-430` is flag-only as
   reported, but it is a pre-flight, not the gate: the authority is the live
   `checkRunnerUsableByRepo` call at `:857`/`:866`, and `provisionRunner`
   at `apply-fleet.ts:1713-1746` is the convergence. The narrower question
   the originating issue raises — whether that early refusal should itself
   observe rather than trust the flag — is a real design question and is
   untouched by this verdict.
