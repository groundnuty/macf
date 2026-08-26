# `fleet.yaml` manifest reconciliation audit (2026-08)

**Status: IN PROGRESS — verdicts marked TBD are not yet evidenced.**

**Purpose:** the design intent of `macf bootstrap apply` is Kubernetes-style
reconciliation — a controller that compares each declared field against live
state and converges. This audit asks, per field of `FleetManifestSchema`:
*does that actually happen?*

**Method:** every verdict below is evidenced by a **code path** — `file:line`
where the field is read and what is done with the value. Doc comments are
never evidence; where a doc comment claims more than the code does, that
mismatch is recorded as its own finding (§4).

**Verdicts:**

| verdict | meaning |
|---|---|
| **RECONCILED** | live state is observed and converged toward the declaration |
| **WRITE-ONCE** | applied at creation, never re-checked; drift invisible afterwards |
| **DECLARATIVE-ONLY** | read into a decision but never compared to reality |
| **INERT** | parsed and consumed nowhere |

---

## 1. The table

| # | field | verdict | evidence |
|---|---|---|---|
| 1 | `apiVersion` | TBD | |
| 2 | `kind` | TBD | |
| 3 | `metadata.name` | TBD | |
| 4 | `versions.macf` | TBD | |
| 5 | `versions.actions` | TBD | |
| 6 | `owner.account` | TBD | |
| 7 | `owner.type` | TBD | |
| 8 | `owner.registry` | TBD | |
| 9 | `network.advertise_host` | TBD | |
| 10 | `transport.age_recipients` | TBD | |
| 11 | `transport.tailscale_oauth_required` | TBD | |
| 12 | `transport.router_app_scope` | TBD | |
| 13 | `transport.router_app_origin_fleet` | TBD | |
| 14 | `defaults.role_template` | TBD | |
| 15 | `defaults.app_manifest` | TBD | |
| 16 | `agents[].role` | TBD | |
| 17 | `agents[].profile` | TBD | |
| 18 | `agents[].repo` | TBD | |
| 19 | `agents[].deploy_path` | TBD | |
| 20 | `agents[].provenance` | TBD | |
| 21 | `routing.runner.runs_on` | TBD | |
| 22 | `routing.runner.labels` | TBD | |
| 23 | `routing.runner.warm` | TBD | |
| 24 | `collaborators[]` (array presence) | TBD | |
| 25 | `collaborators[].project` | TBD | |
| 26 | `collaborators[].registry` | TBD | |
| 27 | `collaborators[].ca_bundle` | TBD | |
| 28 | `shared.routing_app` | TBD | |
| 29 | `shared.ts_oauth` | TBD | |
| 30 | `trust.ca` | TBD | |
| 31 | `trust.federated_cas` | TBD | |

## 2. INERT fields

TBD

## 3. `versions:` traced

TBD

## 4. Doc comments that claim more than the code does

TBD

## 5. Undetermined

TBD
