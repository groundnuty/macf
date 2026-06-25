# Use-Case Recipe: Scientific-Paper Research Fleet

**Goal:** stand up a 3-agent fleet that runs a research study and writes it up as
a paper — a **science-agent coordinator**, a **code-agent** doing the experimental
labor, and a **writer-agent** producing the manuscript.

**Worked example (used throughout):** the `icsoc-2026` fleet.

> **⚠ This recipe is a draft to be *followed and critiqued*.** Decision points
> that are genuinely yours are marked **`[DECIDE]`**; spots most likely to be
> rough are marked **`[WATCH]`**. When you hit friction, that's an onboarding
> bug — note it and we harden the recipe + tooling (this is how `macf#530`'s
> `--app-key` fix happened).

---

## 1. The fleet at a glance

| Agent (name) | Role label | Home workspace | GitHub repo | Template profile | What it does |
|---|---|---|---|---|---|
| `icsoc-2026-science-agent` | `science-agent` | `/home/ubuntu/repos/agh/icsoc-2026-science-agent` | `groundnuty/icsoc-2026-science-agent` | **`research`** | Designs the study, files work for code + writer, reviews PRs, writes research notes, owns the findings |
| `icsoc-2026-code-agent` | `code-agent` | `/home/ubuntu/repos/agh/icsoc-2026-experiment` | `groundnuty/icsoc-2026-experiment` | **`code`** | Implements + runs experiments, produces results/figures, opens PRs |
| `icsoc-2026-writer-agent` | `writer-agent` | `/home/ubuntu/repos/papers/icsoc-2026` | `groundnuty/icsoc-2026` | **`paper-latex`** | Writes the LaTeX manuscript from science's findings |

Two configuration layers stack on each home repo:

1. **Role layer** — `groundnuty/agentic-repo-template` (`./.claude/init.sh <profile>`): the Claude Code persona for the *kind of work* (research / code / paper-latex) — settings, rules, skills, CLAUDE.md.
2. **Coordination layer** — `macf init`: makes the workspace a MACF *agent* — a GitHub-App identity, the channel server, the registry entry, the routing wiring, and the cross-agent coordination rules (`coordination.md`, `delegation-template.md`).

They are **complementary**: the role layer says *how this agent thinks about its work*; the coordination layer says *how it talks to its peers*.

### Topology `[DECIDE]`

- **One MACF project**: `icsoc-2026`.
- **One shared registry**: Profile scope on the `groundnuty/groundnuty` profile repo (per `macf#529`/DR-006 — `groundnuty` is a user account, so Profile mode is the single fleet registry).
- **Delegation is cross-repo, by label**: science files an issue on the *target's* repo (an experiment task → `groundnuty/icsoc-2026-experiment` labeled `code-agent`; a write-up task → `groundnuty/icsoc-2026` labeled `writer-agent`); the per-repo router wakes the assignee.
  - *Alternative:* a single dedicated coordination repo (e.g. `groundnuty/icsoc-2026-science-agent`) where **all** issues live and each agent works against the others' repos via PRs. Simpler routing (one workflow), but mixes the science home with the board. **Tell me which you prefer** — the per-repo model below mirrors how the agents' work naturally lives in their own repos.

---

## 2. Prerequisites (operator, one-time)

- [ ] **`macf` CLI ≥ 0.2.37** — `npm i -g @groundnuty/macf@latest`; verify `macf --version` shows `0.2.37` (this is the release that ships `--app-key` ingestion + the auditor commands; older versions hand-`cp` keys and lack profile-registry fixes).
- [ ] **Three GitHub Apps**, one per agent (attribution-distinct — each agent posts as itself). **This is the one step with no `gh` CLI — App create + install is web/passkey only** (there is no `gh app create`). Create each from the manifest at `packages/macf/templates/macf-app-manifest.json` (DR-019 permission set) → `https://github.com/settings/apps/new`. For each App: note the **App ID**, **install it** on that agent's repo(s) + on `groundnuty/groundnuty` (the registry), and **download its private key** (`.pem`).
  - `[WATCH]` Naming: name the Apps `icsoc-2026-science-agent` / `icsoc-2026-code-agent` / `icsoc-2026-writer-agent` so attribution in issues/PRs reads clearly.
- [ ] **The `groundnuty/groundnuty` profile repo exists** (it does) and each agent's App is **installed on it** with `actions_variables:write`, so the channel server can self-register into the fleet registry.
- [ ] **`agentic-repo-template` access** — you own it; you'll "Use this template" three times.
- [ ] Decide the **routing stage** — see §5 `[DECIDE]`.

---

## 3. Per-agent setup (repeat for all three)

The three steps are identical in shape; only the **profile**, **role**, **home path**, **repo**, and **App creds** change per the table in §1. Worked here for the **science-agent**.

### 3a. Create the home repo from the role template

```bash
# Create the repo FROM the template — gh CLI, no web UI:
gh repo create groundnuty/icsoc-2026-science-agent \
  --template groundnuty/agentic-repo-template --private
# Clone it to the agent's home path:
gh repo clone groundnuty/icsoc-2026-science-agent \
  /home/ubuntu/repos/agh/icsoc-2026-science-agent
cd /home/ubuntu/repos/agh/icsoc-2026-science-agent

# Apply the role profile (science → research; code → code; writer → paper-latex):
./.claude/init.sh research
```

`init.sh` merges the profile into `.claude/settings.json`, copies role rules into `.claude/rules/`, vendors skills, appends to `.claude/CLAUDE.md`, then removes `.claude/profiles/` + `.claude/init.sh`. (Requires `jq`; the `research`/`paper-latex` profiles want the Scholar Gateway connector and — for `paper-latex` — a LaTeX distribution.)

### 3b. Create + install the agent's GitHub App, download the key

Per §2. You now have, for this agent: `APP_ID`, `INSTALL_ID`, and a downloaded `*.pem`.

### 3c. `macf init` — add the coordination layer

```bash
macf init \
  --project icsoc-2026 \
  --role science-agent \
  --name icsoc-2026-science-agent \
  --app-id <APP_ID> \
  --install-id <INSTALL_ID> \
  --app-key ~/Downloads/icsoc-2026-science-agent.private-key.pem \
  --registry-type profile --registry-user groundnuty \
  --advertise-host orzech-dev-agents.tail491af.ts.net \
  --dir /home/ubuntu/repos/agh/icsoc-2026-science-agent
```

- `--app-key` **ingests** the downloaded key to `~/.macf/keys/icsoc-2026-science-agent.pem` (`chmod 600`) and fails loud now if it's missing (`macf#530`) — no manual `cp`.
- `--registry-type profile --registry-user groundnuty` → the fleet shares the `groundnuty/groundnuty` registry.
- `--advertise-host` → the tailnet FQDN so a GitHub-hosted router can reach the channel server (use `127.0.0.1` **only** if you'll never route from a cloud runner — see §5).

`[WATCH]` **Run order — template first, then `macf init`.** Both write `.claude/settings.json` + `.claude/rules/`. `macf init`'s settings-writer is merge-preserving (keeps operator/template entries, adds the MACF hooks/permissions/sandbox blocks), so `init.sh` → `macf init` should layer cleanly. **This ordering is the single most likely place to find a conflict — please verify after running that both the template's rules and `coordination.md`/`delegation-template.md`/`gh-token`-hook are present in `.claude/`, and that `.claude/settings.json` has both the template's permissions and MACF's hooks.**

### 3d. Verify the agent

```bash
cd /home/ubuntu/repos/agh/icsoc-2026-science-agent
macf doctor                 # App-token permissions vs DR-019
./.claude/scripts/macf-whoami.sh   # should print "bot installation token" (ghs_), not your user
ls .macf/macf-agent.json .macf/plugin claude.sh   # workspace wired
./claude.sh                 # launches the agent (Claude Code, role config + MACF plugin)
```

### Per-agent quick reference

| Agent | `--role` | `--name` | profile | `--dir` |
|---|---|---|---|---|
| science | `science-agent` | `icsoc-2026-science-agent` | `research` | `/home/ubuntu/repos/agh/icsoc-2026-science-agent` |
| code | `code-agent` | `icsoc-2026-code-agent` | `code` | `/home/ubuntu/repos/agh/icsoc-2026-experiment` |
| writer | `writer-agent` | `icsoc-2026-writer-agent` | `paper-latex` | `/home/ubuntu/repos/papers/icsoc-2026` |

*(All three: `--project icsoc-2026 --registry-type profile --registry-user groundnuty --advertise-host orzech-dev-agents.tail491af.ts.net`, plus each agent's own `--app-id/--install-id/--app-key`.)*

### 3e. Every command in order — one agent (science-agent), copy-paste

```bash
# 1. Repo from template (gh CLI)
gh repo create groundnuty/icsoc-2026-science-agent \
  --template groundnuty/agentic-repo-template --private
gh repo clone groundnuty/icsoc-2026-science-agent \
  /home/ubuntu/repos/agh/icsoc-2026-science-agent
cd /home/ubuntu/repos/agh/icsoc-2026-science-agent

# 2. Role profile (template script)
./.claude/init.sh research

# 3. App create + install  —  WEB / passkey, NO gh CLI
#    github.com/settings/apps/new  (perms from packages/macf/templates/macf-app-manifest.json)
#    → install on groundnuty/icsoc-2026-science-agent AND groundnuty/groundnuty
#    → download the .pem → note APP_ID, INSTALL_ID

# 4. MACF coordination layer
macf init \
  --project icsoc-2026 --role science-agent --name icsoc-2026-science-agent \
  --app-id <APP_ID> --install-id <INSTALL_ID> \
  --app-key ~/Downloads/icsoc-2026-science-agent.private-key.pem \
  --registry-type profile --registry-user groundnuty \
  --advertise-host orzech-dev-agents.tail491af.ts.net \
  --dir /home/ubuntu/repos/agh/icsoc-2026-science-agent

# 5. Routing scaffolding on the repo (labels + agent-router workflow + agent-config).
#    --actions-version v3 = Stage-3 (see §5). Needs a bot token with repo write.
#    Creates the assignment labels (science-agent/code-agent/writer-agent) + status
#    labels + .github/agent-router.yml@v3 + .github/agent-config.json.
GH_TOKEN=<bot-token> macf repo-init \
  --repo groundnuty/icsoc-2026-science-agent \
  --actions-version v3 \
  --agents science-agent,code-agent,writer-agent \
  --dir /home/ubuntu/repos/agh/icsoc-2026-science-agent

# 6. Verify
macf doctor && ./.claude/scripts/macf-whoami.sh && ./claude.sh
```

Repeat steps 1–6 for **code-agent** (`code` profile · repo `groundnuty/icsoc-2026-experiment` · dir `/home/ubuntu/repos/agh/icsoc-2026-experiment`) and **writer-agent** (`paper-latex` · repo `groundnuty/icsoc-2026` · dir `/home/ubuntu/repos/papers/icsoc-2026`).

> **Labels-only alternative (incremental start, no routing yet):** if you skip routing on day one (§5), you don't need `macf repo-init`'s workflow — but you still need the **assignment labels** so science can label delegation issues. Create them per repo with:
> ```bash
> for L in science-agent code-agent writer-agent; do
>   gh label create "$L" --repo groundnuty/icsoc-2026-experiment --color 0e8a16 --force
> done
> gh label create in-progress --repo groundnuty/icsoc-2026-experiment --color fbca04 --force
> gh label create in-review   --repo groundnuty/icsoc-2026-experiment --color 1d76db --force
> gh label create blocked      --repo groundnuty/icsoc-2026-experiment --color b60205 --force
> ```
> `[WATCH]` Confirm whether `macf repo-init --agents …` already creates the assignment labels (it creates the status labels for sure) — if so this block is redundant when you run repo-init.

---

## 4. How the fleet coordinates (the loop)

The roles and the delegation discipline come from `coordination.md` + `delegation-template.md` (distributed into every workspace by `macf init`). The flow:

1. **Science designs + delegates.** Science files a well-specified issue (the 6-section delegation template) on the target repo with the assignee label:
   - experiment task → `groundnuty/icsoc-2026-experiment`, label `code-agent`
   - write-up task → `groundnuty/icsoc-2026`, label `writer-agent`
2. **Code does the labor.** Code-agent picks up its labelled issue, runs the experiment in its repo, opens a PR, `@mention`s science for review.
3. **Science reviews + the implementer merges.** Honest peer review in the issue thread; LGTM → code merges (merge-by-implementer). The cross-agent review is the *point* — it catches what one agent misses (see `docs/use-cases.md` for empirical witnesses).
4. **Findings → paper.** Once results stabilise, science hands the writer a findings packet (issue on `groundnuty/icsoc-2026`, label `writer-agent`); the writer drafts the LaTeX manuscript, cites the results, and PRs sections back for science's review.
5. **Reporter owns closure** throughout (whoever filed the issue closes it after verifying) — keeps the board honest.

---

## 5. Routing — waking an agent on `@mention` `[DECIDE]`

Coordination (issues/PRs) works the moment the Apps + repos exist. **Routing** is the layer that *wakes* the target agent when it's `@mention`ed, instead of it only seeing the work on its next manual launch. Two paths:

- **Stage-3 mTLS channels — canonical for new projects.** Each agent runs a channel server (an MCP stdio child of its `claude.sh`, per DR-002); the per-repo `agent-router.yml@v3` resolves the agent's `host:port` from the registry and delivers over mTLS. Prerequisites (the heavier part — and the same ones the `icsoc` fleet's sibling, the `macf-auditor`, is finishing): a shared **CA + per-agent server cert**, a minimal-scope **`MACF_ROUTING` App** installed on `groundnuty/groundnuty` (to read the registry), and `macf repo-init` on each repo to scaffold the `@v3` router. Follow `design/macf-consumer-onboarding.md` §routing for the canonical steps. The per-repo routing **secrets** (per `macf#529` — Profile registry, secrets stay per-repo) go in via gh CLI on each agent repo:
  ```bash
  gh secret set MACF_ROUTING_APP_ID  --repo groundnuty/icsoc-2026-experiment --body "<routing-app-id>"
  gh secret set MACF_ROUTING_APP_KEY --repo groundnuty/icsoc-2026-experiment < macf-routing.private-key.pem
  gh secret set ROUTING_CLIENT_CERT  --repo groundnuty/icsoc-2026-experiment < routing-client.crt
  gh secret set ROUTING_CLIENT_KEY   --repo groundnuty/icsoc-2026-experiment < routing-client.key
  ```
  (Repeat per repo; the client cert/key come from the shared CA devops provisions.)
- **Incremental start (recommended for day one):** stand the fleet up *without* automated routing first — Apps + repos + role config + `macf init` (§3), coordinate via issues, and let each agent pick up its queue on launch / `SessionStart`. Add Stage-3 routing once the cert/CA + `MACF_ROUTING` App are in place. This de-risks the first run and isolates the (currently-being-polished) Stage-3 setup from the rest.

**`[DECIDE]` Tell me which you want the recipe to lead with** — the full Stage-3 path inline, or the incremental start with Stage-3 as a follow-on section. (Given Stage-3 onboarding is exactly what we're polishing this week, I've written §3 to be stage-agnostic so either works.)

---

## 6. Rough edges to expect (feedback hooks)

These are the spots I most expect you to hit friction — please confirm or correct each:

1. **Template × `macf init` settings merge** (§3c `[WATCH]`) — do both layers' `.claude/settings.json` + `.claude/rules/` survive? Any clobber?
2. **Three Apps is a lot of passkey work.** Is per-agent-App right, or do you want a shared App across the fleet (loses per-agent attribution — probably not, but your call)?
3. **Project name `icsoc-2026`** — does `macf init` accept the hyphen/digits, and what registry-variable key does it derive (`MACF_ICSOC_2026_AGENT_…`)?
4. **`writer-agent` role label** — the macf plugin ships a `writing-agent` identity template, not `writer-agent`; here the identity comes from the `paper-latex` *template* profile instead, and `writer-agent` is just the routing label. Confirm that's what you want, or align the name.
5. **Profile prerequisites** — Scholar Gateway connector (research/paper), LaTeX (`paper-latex`) — present on the host?
6. **`--advertise-host`** — is `orzech-dev-agents.tail491af.ts.net` right for all three (same VM), and is `127.0.0.1` fine if you'll drive them locally without a cloud runner?

---

## 7. References

- `design/macf-consumer-onboarding.md` — the generic bootstrap this recipe specialises.
- `.claude/rules/coordination.md`, `.claude/rules/delegation-template.md` — the coordination discipline.
- `packages/macf/templates/macf-app-manifest.json` + **DR-019** — the GitHub App permission set.
- **DR-006** / `macf#529` — registry scope (Profile mode for user accounts).
- `macf#530` — `--app-key` key ingestion.
- [`groundnuty/agentic-repo-template`](https://github.com/groundnuty/agentic-repo-template) — the role profiles (`research` / `code` / `paper-latex`).
- `docs/use-cases.md` — when multi-agent coordination is worth it (the *should-I*, vs this *how-to*).
