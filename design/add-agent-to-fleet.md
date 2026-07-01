# Adding an agent to an existing MACF fleet

**This runbook covers a distinct case from `macf-consumer-onboarding.md`.** That doc onboards a *new consumer project* (one agent + its whole GitHub side: App, `macf init`, registry, the v3 router's secrets, `macf doctor`). **This** doc covers wiring an **Nth agent into an already-running multi-repo fleet** — where the pain is the **cross-repo steps that must be applied in *every* repo**, and where a miss **fails silently**.

> **Read `macf-consumer-onboarding.md` first** for the per-agent GitHub-side setup (App / init / certs / registry / router secrets). This runbook does **not** duplicate those — it references them and adds the **fleet-integration** surface they don't cover. If you are standing up a whole new fleet from scratch, use `tools/macf-bootstrap/` (DR-035) instead; this runbook is for adding *one* agent to a fleet that already exists.

---

## Why this needs its own runbook

A new agent joins every few months (the **release agent** is next — it will coordinate toolkit releases). The setup splits along **two axes**, and only one of them is documented elsewhere:

| Axis | Where it lives | Documented? | Drift risk |
|---|---|---|---|
| **Once-per-agent** (App, init, certs, registry entry, workspace) | the agent's own workspace + one registry | ✅ `macf-consumer-onboarding.md` | low (it's one place; a miss fails loudly at `macf doctor`) |
| **Per-repo** (apply in *every* repo the agent touches) | N repos, N times | ❌ **nowhere** | **high — a miss fails SILENTLY on the repo you skipped** |

**The per-repo axis is the entire reason this runbook exists.** It has no single-place verification — you have to check every repo — and a missed repo produces a silent degradation, not an error. Live evidence that this drift is real *right now* (enumerated 2026-07-01):

```
$ for r in macf macf-actions macf-devops-toolkit macf-science-agent; do
    gh label list --repo groundnuty/$r --json name \
      --jq '[.[]|select(.name|test("-agent$"))|.name]|join(", ")'; done
macf:                code-agent, science-agent, auditor-agent          # ← no devops-agent
macf-actions:        code-agent, science-agent                         # ← no auditor-agent, no devops-agent
macf-devops-toolkit: devops-agent, code-agent, science-agent, auditor-agent
macf-science-agent:  code-agent, science-agent, auditor-agent          # ← no devops-agent
```

The label sets are already inconsistent across repos. That's the class of silent drift this runbook + its automation exist to eliminate.

---

## Once-per-agent steps (reference — do these once)

These are covered by `macf-consumer-onboarding.md` + `tools/macf-bootstrap/`. Do them once for the new agent; **don't duplicate the detail here** — follow those docs:

1. **App identity** — create the agent's GitHub App, install it on the repos it works (see `secrets/INDEX.md` for the per-agent App-ID/install-ID convention). *(bootstrap Step 4b/4c automates this.)*
2. **`macf init`** in the agent's workspace — App creds, `claude.sh`, certs, registry entry. *(`macf-consumer-onboarding.md §2`.)*
3. **Certs** — the agent's mTLS server cert from the project CA (`macf certs`). *(consumer-onboarding + bootstrap 4e.)*
4. **Registry entry** — the channel-server self-registers on first launch. *(consumer-onboarding §4.)*
5. **Router secrets** — the v3 routing secrets on the agent's own repo. *(consumer-onboarding; `secrets/INDEX.md`.)*
6. **`macf doctor`** — the once-per-agent verification gate. *(consumer-onboarding §6.)*

Plus **two once-per-agent steps that are NOT in the consumer doc** (add them there or here — flagged for the automation half):

7. **`~/.macf/desired-agents.yaml` entry** — the watchdog-supervision + fleet-upgrade manifest (DR-006 / DR-007 / DR-037). Without an entry, `macf fleet reconcile`/`upgrade` don't know the agent is *desired* → it's neither supervised nor upgraded. One line per agent (name / workspace / registry).
8. **OTEL resource attrs** — `gen_ai.agent.name` / `gen_ai.agent.role` in the agent's `claude.sh` (via `MACF_AGENT_NAME` / `MACF_ROUTING_LABEL`), so its telemetry lands under the right identity (devops-toolkit#114; `observability-wiring.md`). `macf init` sets these — verify they match the routing label.

---

## Per-repo steps — **the drift surface (apply in EVERY repo the agent touches)**

For **each** repo the new agent will work in or be routed on, apply **all** of the following. Missing one = a silent per-repo failure.

**The fleet's routed repos (2026-07-01):** `groundnuty/macf`, `groundnuty/macf-actions`, `groundnuty/macf-devops-toolkit`, `groundnuty/macf-science-agent`. *(Enumerate current reality before onboarding — the set grows.)*

### P1. Assignment label `<name>-agent`

The routing Action + delegation depend on the `<name>-agent` label existing on the repo. If the label is absent, an issue assigned to the new agent on that repo **can't be labeled → doesn't route**.

```bash
for r in macf macf-actions macf-devops-toolkit macf-science-agent; do
  gh label create "<name>-agent" --repo groundnuty/$r --color 0e8a16 \
    --description "Assigned to <name>-agent" 2>/dev/null || echo "$r: exists"
done
```

### P2. `MACF_TRUSTED_ACTORS` — **the #1 silent-miss**

The self-hosted-runner **origin-routing guard** (devops-toolkit#90 / macf-actions#59): the `runs-on` routes a trusted actor's CI to the self-hosted runner, everyone else to github-hosted. The trusted-actor allowlist is a **repo variable that must carry the new agent in EVERY repo with the runner**. Miss one repo and that agent's CI on that repo **silently falls back to github-hosted** (slower, and the A/B/latency assumptions break) — no error, ever.

```bash
# The allowlist is a JSON array of logins; ADD the new agent, don't replace.
# (As of 2026-07-01 it is set in NO repo — pending #90. Once #90 lands, it must be
#  in every runner repo, and every new agent must be appended to all of them.)
for r in macf macf-actions macf-devops-toolkit macf-science-agent; do
  cur=$(gh api "repos/groundnuty/$r/actions/variables/MACF_TRUSTED_ACTORS" --jq '.value' 2>/dev/null || echo '[]')
  # append "<new-agent-login>" to the JSON array, then:
  gh variable set MACF_TRUSTED_ACTORS --repo groundnuty/$r --body "<updated-json-array>"
done
```

**`MACF_TRUSTED_ACTORS` is a security-load-bearing allowlist** — each entry grants self-hosted-runner access. Treat additions with registry-grade care (see devops-toolkit#90).

### P3. (Conditional) App install on the repo

If the agent will *act* on a repo (comment / open PRs / review), its App must be **installed** on that repo (once-per-agent lists the App; the *install target set* is per-repo). Read-only routing needs only the label.

---

## Verify no step was missed — the consistency gate

The per-repo axis has no single-place check, so **assert consistency across all repos** after onboarding (the same enumeration that found the drift above):

```bash
# Every repo should show the new agent's label + its entry in MACF_TRUSTED_ACTORS.
for r in macf macf-actions macf-devops-toolkit macf-science-agent; do
  echo "== $r =="
  gh label list --repo groundnuty/$r --json name --jq '[.[]|select(.name=="<name>-agent")]|length' # expect 1
  gh api "repos/groundnuty/$r/actions/variables/MACF_TRUSTED_ACTORS" --jq '.value|fromjson|index("<login>")' 2>/dev/null # expect non-null
done
```

A `0` or `null` on any repo is a missed step. This gate is the doc-side backstop; the automation below is the real fix.

---

## The automation plan — doc is the immediate win, a `macf` command is the real fix

**A doc that says "set this var in 4 repos" is itself drift-prone** — the doc lists the repos, the repo-set grows, the doc goes stale. The durable fix is a single `macf` command that **iterates the fleet's repos** for the per-repo steps, so onboarding is one invocation, not N manual edits.

**Consultation for `@macf-code-agent[bot]`** (the CLI/framework owner — the automation half is framework territory): should the per-repo surface become a canonical subcommand? Candidate shape:

- **`macf onboard-agent <name> --repos <auto|list>`** — for each repo: ensure the `<name>-agent` label exists + append the agent to `MACF_TRUSTED_ACTORS` + (optionally) verify the App install. Idempotent (re-run = no-op where already set). Reports per-repo what it changed vs what was already correct.
- **Repo enumeration** should reuse the DR-037 discovery/registry substrate (a fleet == a registry; the routed-repo set is derivable), *not* a hand-maintained repo list — that's the same "don't build a 4th source of truth" rule (`check-before-propose §4`) DR-037 §4 applies to workspace discovery.
- **`MACF_TRUSTED_ACTORS` specifically** is a natural `macf` cross-repo setter even standalone (it's the highest-drift item): `macf trusted-actors add <login>` iterating the runner repos.

This is a **consultation, not a spec** — code-agent's call on whether/how it folds into the CLI (and whether it belongs under DR-037's distribution/fleet-command family). The doc ships now as the human-guard; the command is the structural fix that makes the doc a fallback rather than the only defense (the same Path-2 pattern as the `check-*.sh` hooks).

---

## First real test-case — the release agent

The incoming **release agent** (toolkit-release coordinator) is the near-term forcing function. **Onboard it by this runbook**, and record every gap the runbook missed as a correction back to this doc — the runbook earns its authority by surviving a real onboarding. (This mirrors the DR-035 prior-art lesson: a runbook is proven by a real run, not written ahead of one.)

---

## Cross-references

- `design/macf-consumer-onboarding.md` — the once-per-agent GitHub-side setup this runbook references (do not duplicate).
- `tools/macf-bootstrap/` (DR-035) — the automated on-ramp for a *new fleet*; some once-per-agent steps overlap.
- `groundnuty/macf-devops-toolkit#90` + `macf-actions#59` — the `MACF_TRUSTED_ACTORS` origin-routing guard (the P2 source).
- DR-006 / DR-007 / **DR-037** — the `desired-agents.yaml` manifest + the fleet-command family the automation should join.
- `secrets/INDEX.md` (macf-science-agent) — the per-agent App-ID / install-ID / login convention.
- `check-before-propose.md §4` — the "don't build a parallel source of truth" rule the automation's repo-enumeration honors.
