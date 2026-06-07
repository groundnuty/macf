# MACF — Multi-Agent Coordination Framework

> Multiple Claude Code agents collaborating on software projects through GitHub as the coordination substrate.

MACF is a framework for running several Claude Code sessions in parallel — each with a specialized role (orchestrator, implementer, writer, etc.) — and coordinating them through standard GitHub primitives: issues, pull requests, labels, and a reusable routing workflow. No custom coordination layer, no black-box message bus, no proprietary protocol. If your team can read a GitHub issue thread, they can understand what the agents are doing and why.

## How it works

Each agent is a long-running Claude Code session in a `tmux` window on a VM. Agents don't talk directly by default — they talk through GitHub:

- **Task assignment**: an operator (or another agent) opens an issue with the assignee's label (e.g. `code-agent`). A GitHub Actions workflow ([`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions)) delivers the notification into the target agent's Claude Code session.
- **Discussion + clarification**: agents @mention each other in issue comments; the routing workflow forwards those mentions to the right tmux session. Threads are visible to operators and persist after work completes.
- **Implementation + review**: agents open PRs referencing the issue, other agents review in the issue thread, the author merges after LGTM. Same discipline as a human team.
- **Identity + attribution**: each agent has its own GitHub App; actions and comments are attributed to the App (`macf-code-agent[bot]`, `macf-science-agent[bot]`, etc.). Full audit trail in git blame and GitHub's event log.
- **Operator intervention**: any operator can attach to any agent's tmux session via Tailscale SSH (e.g., `ssh ubuntu@<host>` over the tailnet, then `tmux attach -t <project>@<agent>`), or prompt an agent directly from a phone via [Claude Remote](https://claude.com/product/claude-code) (mobile / web). Standard remote-VM admin + canonical Claude Code session access — NOT MACF coordination infrastructure (routing fires structurally regardless of operator presence).

Design note: agents have **asymmetric contexts**. The orchestrator (typically a "science-agent") runs with a 1M-token context window and curates the broad project understanding across sessions. Worker agents (code, writing) run with 200K and take focused tasks. This lets the orchestrator stay grounded in project-level goals without being consumed by implementation-detail noise — and costs less total tokens than running everyone at 1M.

## Why it works — with proofs

### Evidence 1: the framework dogfoods itself

MACF's own development happens through MACF. The maintainers open issues, agents pick them up, write PRs, review each other's work, merge after LGTM. Over the 2026-04-17 through 2026-05-01 development period, agents merged **162 PRs** developing the framework — including a full security-audit-and-fix cycle where the `code-agent` audited its own codebase, filed issues for the bugs it found, and shipped fixes.

If the framework works for the agents building the framework, it works for real project work.

### Evidence 2: agents correct each other + surface real value from discussion

Four concrete examples where peer discussion produced better outcomes than any single agent's first proposal could have:

**[#80](https://github.com/groundnuty/macf/issues/80) — agent found a real security bug in the design it was implementing.** The code-agent audited the challenge-response authentication protocol against the design doc and discovered that the server wrote a challenge value and then read back what it had just written — with no comparison to what the client submitted. The supposedly-secure protocol was trivially bypassable. The agent filed the bug as P0 and shipped the fix itself.

**[#112](https://github.com/groundnuty/macf/issues/112) — architectural pushback led to a better design than the initial proposal.** Code-agent suggested a quick workaround for a crypto-parameter upgrade. Science-agent rejected it with an "eternal-debt" argument — the quick fix would leave existing deployments stuck on the old, weaker configuration forever. The agents negotiated a third approach that automatically migrates every deployment on next use. Harder to implement; actually solves the problem.

**[#144](https://github.com/groundnuty/macf/issues/144) — multi-round collaborative refinement of a design.** Science-agent proposed four variants. Code-agent picked one and pointed out a bootstrap limitation science-agent hadn't considered. Science-agent responded with an edge case the chosen approach didn't cover. Code-agent extended the design to handle three different operator states at once. Each round produced a design measurably better than the one before it.

**[#121](https://github.com/groundnuty/macf/issues/121) — rules the agents wrote for themselves started enforcing themselves.** The agents had just codified a rule ("the reporter of an issue closes it, not the assignee"). On the next issue, code-agent violated the rule (asked science-agent to close). Science-agent pushed back citing the rule, code-agent acknowledged, closed it themselves. The discipline system the agents built for themselves started to self-enforce.

More: closed [issues](https://github.com/groundnuty/macf/issues?q=is%3Aissue+state%3Aclosed) and [PRs](https://github.com/groundnuty/macf/pulls?q=is%3Apr+state%3Aclosed) show the general texture of agent collaboration.

### Evidence 3: empirical predecessor

Before MACF, the same architecture ran as a 2-agent proof of concept called [Claude Plan Composer (CPC)](https://github.com/groundnuty/claude-plan-composer). 11 days in production on a scientific-workflow project:

- 128 issues processed, 175 PRs merged
- 6.8M output tokens generated; 10.26B cache-read tokens (the **1,511:1 cache-read-to-output ratio** is the empirical signature of multi-agent context-re-reading — agents re-read ~1,500 tokens of context for every token they generate)
- **1.18× multi-agent overhead** (cost of 2 agents vs 1 for the same work)
- **22.7% token savings** vs running both agents at symmetric max context

MACF generalizes that PoC into an N-agent framework with typed roles, cross-repo coordination, and proper security primitives.

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  Operator                                                           │
│  (terminal, phone via Claude Remote, GitHub web UI, gh CLI)         │
└────────┬─────────────────────────────────────────────┬──────────────┘
         │ Tailscale SSH                               │ Web UI / gh CLI
         │ (VM admin: tmux attach / inspect logs;      │ (issues, comments,
         │  not part of MACF routing)                  │  labels, reviews, PRs)
         ▼                                             ▼
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│  Agent host                      │   │  GitHub                          │
│                                  │   │                                  │
│  tmux session: <project>@<agent> │   │  ┌────────────────────────────┐  │
│  (canonical naming, structural   │   │  │ Issues / PRs / threads     │  │
│   from claude.sh self-wrap;      │   │  │ (coordination surface)     │  │
│   v0.2.10+)                      │   │  └─────────────┬──────────────┘  │
│                                  │   │                │ webhook         │
│  ┌────────────────────────────┐  │   │                ▼                 │
│  │ Agent (Claude Code session)│  │   │  ┌────────────────────────────┐  │
│  │   + macf-agent plugin      │  │   │  │ groundnuty/macf-actions    │  │
│  │   + channel server (mTLS): │  │   │  │ Reusable routing workflow  │  │
│  │     POST /notify  ◄────────┼──┼───┼──┤  route-by-config           │  │
│  │     POST /sign             │  │   │  │  route-by-label            │  │
│  │     GET  /health           │  │   │  │  route-by-mention          │  │
│  │   + PreToolUse hooks:      │  │   │  │  route-by-ci-completion    │  │
│  │     check-gh-token.sh      │  │   │  │  route-by-pr-review-state  │  │
│  │     check-mention-routing  │  │   │  └─────────────┬──────────────┘  │
│  │       (Check A + Check B)  │  │   │                │ resolves        │
│  └────────────────────────────┘  │   │                │ recipient via   │
│  ┌────────────────────────────┐  │   │                ▼                 │
│  │ Agent (Claude Code session)│  │   │  ┌────────────────────────────┐  │
│  │   + plugin + channel server│  │   │  │ Repo Variables             │  │
│  │   + hooks (same as above)  │  │   │  │ (agent registry:           │  │
│  └────────────────────────────┘  │   │  │  host/port/instance_id)    │  │
│            ...                   │   │  └────────────────────────────┘  │
│                                  │   │                                  │
│  Per-project CA                  │   │  ┌────────────────────────────┐  │
│    (~/.macf/certs/<project>/)    │   │  │ GitHub Apps                │  │
│  Per-agent cert + key            │   │  │ (per-agent identity, 7     │  │
│    (.macf/certs/) signed by CA   │   │  │  perms per DR-019)         │  │
│                                  │   │  └────────────────────────────┘  │
└──────────────────────────────────┘   └──────────────────────────────────┘
```

**Routing transport:** the routing-Action workflow (running on a GitHub Actions runner) makes a `curl --cert ... --key ... --cacert ...` POST against the recipient agent's channel server `/notify` endpoint. **mTLS-only — no SSH for routing in canonical MACF** (`macf-actions@v3+`). The channel server rejects any client cert not signed by the project CA.

> **Routing-stage carve-out.** Stage 3 (`macf-actions@v3`, mTLS) is canonical for **new** consumer projects. The established **substrate / CV fleet** (`groundnuty/macf`, `macf-science-agent`, `macf-devops-toolkit`, …) deliberately stays on the **v1.x SSH/tmux routing primitive** (`macf-actions@v1.3.x`, latest **`v1.3.4`**) per the 2026-04-27 operator directive. The two stages don't interoperate — an agent joining the CV fleet must pin `@v1.3.x` to match, **not** `@v3`. See [`design/macf-consumer-onboarding.md`](design/macf-consumer-onboarding.md) §"Routing-stage carve-out".

**On SSH:** Tailscale SSH is for the operator's standard VM admin (attach to a tmux pane, inspect a log, intervene mid-prompt) — NOT MACF coordination infrastructure. Routing fires structurally via the workflow + mTLS regardless of whether any operator is SSH'd in.

Key primitives:

- **`macf` CLI** — workspace setup, cert management, agent registration, permission doctor (`macf init` / `update` / `doctor`)
- **`macf-agent` plugin** (distributed via [`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace)) — in-session skills (`/macf-status`, `/macf-peers`, `/macf-ping`, `/macf-issues`), agent identity templates, SessionStart + Stop hooks
- **Channel server** ([`@groundnuty/macf-channel-server`](https://www.npmjs.com/package/@groundnuty/macf-channel-server)) — per-agent HTTPS server with mTLS. Spawned as MCP stdio child by the plugin on session start. Endpoints: `POST /notify` (inbound coordination), `GET /health` (peer ping), `POST /sign` (cert signing per [DR-010](design/decisions/DR-010-cert-signing.md))
- **`groundnuty/macf-actions`** — reusable routing workflow with 5 route-by-* jobs, consumed by every coordination repo via `uses:`. Latest `v3.3.0` ships `route-by-pr-review-state` (Path-2 LGTM-routing defense per [#39](https://github.com/groundnuty/macf-actions/issues/39))
- **GitHub Apps** — per-agent identity, permissions-scoped per [DR-019](design/decisions/DR-019-app-permissions.md) (7 required permissions enforced via `macf doctor`)
- **Shared CA + per-agent certs** — mTLS between agents (Stage 3 transport)
- **PreToolUse hooks** (Path-2 structural enforcement): attribution-trap defense ([#140](https://github.com/groundnuty/macf/issues/140) — `check-gh-token.sh`), mention-routing-hygiene Check A + Check B ([#244](https://github.com/groundnuty/macf/issues/244) + [#272](https://github.com/groundnuty/macf/issues/272) — `check-mention-routing.sh`)
- **Canonical tmux session naming** — `<project>@<agent>`, enforced structurally by `claude.sh` self-wrap as of v0.2.10 ([#313](https://github.com/groundnuty/macf/issues/313))

## Setup

Requires: Ubuntu VM with Tailscale, Node.js 22+, devbox, `gh` CLI.

### 1. Create GitHub Apps (one per agent)

Each agent needs its own GitHub App for identity and authentication. Use the permission template at [`templates/macf-app-manifest.json`](templates/macf-app-manifest.json) — it matches the 7 permissions codified in [DR-019](design/decisions/DR-019-app-permissions.md).

Install each App on the coordination repo(s) and the agent's workspace repo.

### 2. Install the CLI

```bash
git clone https://github.com/groundnuty/macf.git ~/repos/groundnuty/macf
cd ~/repos/groundnuty/macf
devbox run -- npm ci
devbox run -- npm run build
npm link    # or add dist/cli/index.js to PATH
```

### 3. Initialize a workspace for each agent

`PROJECT-NAME` below is a short identifier shared by all agents in one swarm (e.g., `macf`, `cv`); all per-agent registry variables get this as a prefix, so it's how agents discover their peers.

```bash
cd ~/repos/<owner>/<agent-workspace>
macf init \
  --project <PROJECT-NAME> \
  --role code-agent \
  --app-id <APP_ID> \
  --install-id <INSTALL_ID> \
  --key-path /path/to/app-key.pem \
  --registry-type repo --registry-repo <owner>/<coordination-repo>
```

`macf init` creates `.macf/` (config, certs, plugin), writes a `claude.sh` launcher with fail-loud token helpers, and registers the agent's endpoint in the repo's variables.

### 4. Initialize the coordination repo

```bash
cd ~/repos/<owner>/<coordination-repo>
macf repo-init \
  --repo <owner>/<coordination-repo> \
  --agents code-agent,science-agent,writing-agent
```

Sets up `.github/agent-config.json`, the routing workflow (`routing.yml` consuming `groundnuty/macf-actions`), labels (`code-agent`, `in-progress`, `in-review`, `blocked`, etc.), and required secrets/variables.

### 5. Launch agents

```bash
# On the VM (via Tailscale SSH)
tmux new-session -d -s project-name -n code-agent \
  "cd ~/repos/<owner>/code-agent-workspace && ./claude.sh"
tmux new-window -t project-name -n science-agent \
  "cd ~/repos/<owner>/science-agent-workspace && ./claude.sh"
tmux attach -t project-name
```

Agents are now running, registered, and listening for routed issues.

## Usage

### Assigning work

File an issue on the coordination repo, apply the assignee's label:

```bash
gh issue create --repo <owner>/<repo> \
  --title "feat: implement X" \
  --label "code-agent" \
  --body "Acceptance criteria:
  - [ ] X works for case A
  - [ ] tests cover A, B, C
  @macf-code-agent[bot]"
```

The routing workflow fires, delivers the notification into `code-agent`'s tmux session. The agent sees the prompt, reads the issue, starts work.

### Discussion + intervention

Any comment on the issue that @mentions an agent routes to that agent. Example: science-agent reviewing code-agent's PR:

```bash
gh issue comment <N> --repo <owner>/<repo> \
  --body "@macf-code-agent[bot] LGTM on approach, one nit: <detail>."
```

The operator can attach to any agent's tmux window at any time (`tmux attach -t <project>:<agent>`) and prompt it directly — no special handoff, it's a Claude Code session.

### Operational tooling

- `macf status --dir <workspace>` — agent registration + peer health
- `macf peers --dir <workspace>` — table of registered peers with mTLS ping
- `macf doctor --dir <workspace>` — verify App token permissions match DR-019
- `macf certs rotate --dir <workspace>` — rotate peer mTLS cert
- `macf self-update` — pull origin/main + rebuild linked CLI (for dev installs)
- `macf update --dir <workspace>` — refresh rules, scripts, plugin, auto-migrate CA key if needed

### Project board

We maintain a GitHub [Projects board](https://github.com/groundnuty/macf/projects) tracking design decisions, implementation phases, and research items. Adding a new repo to a project typically takes two steps: add it via the Projects UI, then `macf repo-init` so routing events also populate the board.

## First-user docs

The [`docs/`](docs/) directory is the first-user surface — 7 docs covering quickstart + concepts + features + use-cases + troubleshooting + FAQ + glossary. Suggested reading order in [`docs/README.md`](docs/README.md):

- **[`docs/quickstart.md`](docs/quickstart.md)** — bootstrap your first agent in ~30 minutes (hands-on tutorial)
- **[`docs/concepts.md`](docs/concepts.md)** — what MACF is + how it works + why the design is shaped this way (with DR citations)
- **[`docs/use-cases.md`](docs/use-cases.md)** — when to use, when not to, comparison to academic + open-source peers
- **[`docs/features.md`](docs/features.md)** — concrete v0.2.10 inventory (CLI, hooks, routing jobs, channel-server endpoints)
- **[`docs/troubleshooting.md`](docs/troubleshooting.md)** — failure modes catalogued
- **[`docs/faq.md`](docs/faq.md)** — common questions with concrete answers
- **[`docs/glossary.md`](docs/glossary.md)** — term lookup with canonical-artifact pointers

## Deeper reading

- **[Design Decisions (23)](design/decisions/)** — architecturally-significant choices with rationale. Entry points: [DR-004 mTLS](design/decisions/DR-004-authentication-mtls.md), [DR-010 cert signing](design/decisions/DR-010-cert-signing.md), [DR-011 CA key backup](design/decisions/DR-011-ca-key-backup.md), [DR-019 App permissions](design/decisions/DR-019-app-permissions.md), [DR-022 channel-server-npm-npx](design/decisions/DR-022-channel-server-npm-npx.md), [DR-023 stage3-hook-mcp-tool-architecture](design/decisions/DR-023-stage3-hook-mcp-tool-architecture.md).
- **[Phase specs (7)](design/phases/)** — P1 channel server → P7 agent templates. Each phase maps to a concrete implementation slice.
- **[Research corpus (16)](research/)** — literature reviews, empirical analysis, comparison to prior multi-agent work.
- **[`coordination.md`](packages/macf/plugin/rules/coordination.md)** — canonical cross-cutting rules distributed to every agent workspace. Single source of truth; `macf rules refresh` propagates updates.
- **[`design/macf-consumer-onboarding.md`](design/macf-consumer-onboarding.md)** — full consumer-bootstrap reference (deeper than quickstart).
- **[`CHANGELOG.md`](CHANGELOG.md)** — per-release notes. Keep-a-Changelog format.

## Related repositories

MACF spans three repos, each with a distinct lifecycle:

- **[`groundnuty/macf`](https://github.com/groundnuty/macf)** (this repo) — CLI, design decisions, phase specs, research, plugin source, and the `coordination.md` rule-set. Ships the `macf` command.
- **[`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions)** — reusable GitHub Actions workflow that routes issue / comment / PR / check-suite / pull_request_review events to agents' tmux sessions (Stage 2) or to their channel endpoints (Stage 3, mTLS). Consumed via `uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3` in coordination repos. Latest tag `v3.3.0` ships `route-by-pr-review-state` (LGTM-routing structural defense).
- **[`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace)** — Claude Code plugin marketplace hosting the `macf-agent` plugin (skills: `/macf-status`, `/macf-peers`, `/macf-ping`, `/macf-issues`; agent identity templates; hooks). `macf init` / `macf update` fetch the plugin at a pinned tag into `<workspace>/.macf/plugin/`; `claude.sh` loads it via `--plugin-dir`.

Releases are tag-versioned per repo; consumers pin to major tags (`@v3` for Stage-3 routing, currently at `v3.3.0`; the substrate/CV fleet pins the v1.x primitive at `v1.3.4`) and to exact versions for the plugin (currently `0.2.35`). Design rationale in [DR-013](design/decisions/DR-013-plugin-versioning.md).

## Status

- **Latest CLI release**: [`v0.2.35`](CHANGELOG.md) (2026-06-05) — see `CHANGELOG.md` for the v0.2.10→v0.2.35 arc (A2A, hardening queue, receipt-observable routing)
- **Phases P1–P7**: shipped and on main
- **Routing transport**: mTLS HTTPS POST `/notify` via `macf-actions@v3.3.0`. Includes `route-by-pr-review-state` Path-2 LGTM-handoff defense. SSH-based routing was an earlier generation (Stage 2; gone from active code in `macf-actions@v3+`)
- **Security hardening**: PBKDF2 at OWASP 2023 levels, clientAuth EKU enforcement, attribution-trap PreToolUse hook (structural, not behavioral), `/sign` challenge verification, schema-validated payloads. Plus `check-mention-routing.sh` Check A (must-have-mention) + Check B (must-not-leak) hooks structurally enforcing `coordination.md §Communication 2` + `mention-routing-hygiene.md §5`
- **Operator reliability**: stale-dist detection + `macf self-update`, E2E suite running post-merge + daily cron on the CLI repo, auto-opened issues on drift, `claude.sh` self-wraps in canonical tmux session per v0.2.10 (`MACF_NO_TMUX_WRAP=1` opt-out)
- **CV deployment** (first external project using MACF): operational. cv-architect + cv-project-archaeologist on `groundnuty/academic-resume` + `groundnuty/cv-project-archaeologist`. Latest cv-e2e-test rehearsal #13b (2026-04-30) reached 10/11 PASS empirically validating the LGTM-routing structural defense
- **Research paper**: drafting; target venues ASE NIER / ESEM 2026. ACMM (Anderson, IBM Research, 2026-04-10, arXiv:2604.09388) is the first published peer in MACF's adjacent space, on an orthogonal axis (feedback-loop topology vs silent-fallback hazard class)

## Contributing

Contributions welcome. File an issue first to discuss scope for anything beyond a small fix. PR ergonomics:

- Run `make -f dev.mk check` before opening a PR (install + typecheck + lint + test)
- Follow commit-type conventions in [`commitlint.config.mjs`](commitlint.config.mjs) (`feat`, `fix`, `security`, `reliability`, `refactor`, `perf`, `docs`, `test`, `chore`, `ci`, `revert`, `build`, `style`)
- Reference the issue in the PR body as `Refs #N` (not `Closes #N` — see [coordination.md Issue Lifecycle](packages/macf/plugin/rules/coordination.md))
- One agent per issue; don't work on issues labeled for another agent

## License

License TBD (intent: MIT — `LICENSE` file to be added by the repo owner).

## Appendix — example configs

Real files, taken from a live deployment. Identifiers and IP addresses replaced with placeholders.

### `agent-config.json` (in the coordination repo's `.github/` directory)

Populated by `macf repo-init`. Read by the routing workflow (`groundnuty/macf-actions@v3`) to identify which agents this repo coordinates.

```json
{
  "agents": {
    "code-agent":    { "app_name": "macf-code-agent" },
    "science-agent": { "app_name": "macf-science-agent" }
  },
  "label_to_status": {
    "in-progress": "In Progress",
    "in-review":   "In Review",
    "blocked":     "Blocked"
  }
}
```

Field notes:

- `app_name` (required) — the GitHub App slug. Used to compute the bot username `<app_name>[bot]` for `@mention` matching + as the registry-key prefix when looking up the agent's address (`MACF_<PROJECT_UPPER>_AGENT_<NAME_UPPER>` repo Variable).
- `label_to_status` — maps status labels to Projects-V2 board column names.

**Address resolution.** The recipient agent's `host` + `port` are NOT in this config — they're in the **registry** (per [DR-007](design/decisions/DR-007-port-assignment.md): registry is the single source of truth for `host`/`port`/`instance_id`). The channel server self-registers via `gh variable set MACF_<PROJECT>_AGENT_<NAME>` on session start; the routing-Action reads the variable to resolve the recipient's address before firing the mTLS POST.

**v1.x-era fields ignored in v3.** Pre-v2.0 routing-Action versions used SSH+tmux delivery and required `host`, `port`, `tmux_session`, `tmux_window`, `tmux_bin`, `ssh_user`, `ssh_key_secret`, `workspace_dir` per agent in this file. v3+ ignores all of them — the registry-driven mTLS path doesn't need them. If a config has these fields from a pre-v3 era, they're harmless leftovers (just ignored) but `macf repo-init` regenerates the canonical v3 shape on next run.

### `claude.sh` (at workspace root)

Launcher script written by `macf init` and refreshed by `macf update`. **Managed — do not edit directly.** Template lives in [`src/cli/claude-sh.ts`](src/cli/claude-sh.ts).

```bash
#!/usr/bin/env bash
set -euo pipefail

# MACF Agent Launcher: code-agent
# This file is managed by `macf`. Do not edit directly — edits are
# overwritten on the next `macf update`. The template lives at
# groundnuty/macf:src/cli/claude-sh.ts.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export MACF_AGENT_NAME="code-agent"
export MACF_PROJECT="project-name"
export MACF_AGENT_TYPE="permanent"
export MACF_AGENT_ROLE="code-agent"
export APP_ID="<YOUR_APP_ID>"
export INSTALL_ID="<YOUR_INSTALL_ID>"
export KEY_PATH=".github-app-key.pem"
export MACF_CA_CERT="$HOME/.macf/certs/project-name/ca-cert.pem"
export MACF_CA_KEY="$HOME/.macf/certs/project-name/ca-key.pem"
export MACF_AGENT_CERT="$SCRIPT_DIR/.macf/certs/agent-cert.pem"
export MACF_AGENT_KEY="$SCRIPT_DIR/.macf/certs/agent-key.pem"
export MACF_LOG_PATH="$SCRIPT_DIR/.macf/logs/channel.log"
export MACF_DEBUG="${MACF_DEBUG:-false}"

# Bot token generation — fail loud. The helper validates the ghs_ prefix
# and surfaces diagnostics (clock drift, bad key, wrong App/install ID).
# Do NOT inline the bare CLI here — without pipefail, a failed fetch piped
# through jq would succeed, GH_TOKEN would become "null", and Claude Code
# would silently fall back to stored `gh auth login` as the user. See
# coordination.md Token & Git Hygiene.
GH_TOKEN=$("$SCRIPT_DIR/.claude/scripts/macf-gh-token.sh" \
    --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || {
  echo "FATAL: bot token generation failed — see stderr above." >&2
  exit 1
}
export GH_TOKEN

export GIT_AUTHOR_NAME="code-agent[bot]"
export GIT_COMMITTER_NAME="code-agent[bot]"

echo "Starting code-agent..."
exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"
```

What this launcher handles:

- **Identity exports** — `APP_ID`, `INSTALL_ID`, `KEY_PATH` read from `.macf/macf-agent.json`
- **Cert paths** — per-project CA at `~/.macf/certs/<project>/`, per-workspace agent cert under `.macf/certs/`
- **Fail-loud token refresh** — the `macf-gh-token.sh` helper validates the `ghs_` token prefix; if it fails, the launcher exits rather than letting Claude Code silently fall back to a user token
- **Plugin loading** — `--plugin-dir` points at the version pinned by `macf init`, so new CLI versions don't break older agent sessions until `macf update` runs

### Observability (optional, opt-in)

MACF emits OpenTelemetry telemetry (traces, metrics, logs) when configured — opt-in via a single env var. With observability wired, every `/notify`, `/sign`, peer ping produces a span; counters track per-agent per-type notification volume; structured logs flow alongside. Spec: [DR-021](design/decisions/DR-021-otel-instrumentation.md).

**Enable:**

```bash
# Per-launch (operator's shell, before ./claude.sh):
export OTEL_EXPORTER_OTLP_ENDPOINT="http://<your-collector-host>:14318"
./claude.sh

# Or template-time (bakes the default into claude.sh on macf init / update):
MACF_OTEL_ENDPOINT="http://<your-collector-host>:14318" macf update
```

The 4-layer endpoint resolution per v0.2.10 (`macf#313`) cascades: runtime `OTEL_EXPORTER_OTLP_ENDPOINT` env var > runtime `MACF_OTEL_ENDPOINT` env var > `.claude/settings.local.json` `.env.MACF_OTEL_ENDPOINT` > template-time bake.

**Disable:**

```bash
MACF_OTEL_DISABLED=1 macf update    # omits the entire OTel block from claude.sh
```

**Observability stack — where to set up the collector + dashboards:**

`groundnuty/macf-devops-toolkit` ships the canonical observability stack — k3d cluster + Helm-deployed Tempo (traces) + Prometheus / Mimir (metrics) + Loki (logs) + Grafana (dashboards) + central OTel Collector. Read the runbook + design rationale there:

- **[`macf-devops-toolkit:docs/observability-bundle-setup.md`](https://github.com/groundnuty/macf-devops-toolkit/blob/main/docs/observability-bundle-setup.md)** — operator runbook for wiring `.github/workflows/observability-snapshot.yml` end-to-end (Tailscale OAuth + cluster VM access + per-issue/PR observability bundles)
- **[`macf-devops-toolkit:design/DR-001-argocd-gitops-for-observability-spike.md`](https://github.com/groundnuty/macf-devops-toolkit/blob/main/design/DR-001-argocd-gitops-for-observability-spike.md)** — design rationale for the GitOps-managed observability cluster
- **[`macf-devops-toolkit:design/DR-002-observability-artifact-bundles.md`](https://github.com/groundnuty/macf-devops-toolkit/blob/main/design/DR-002-observability-artifact-bundles.md)** — design rationale for per-issue/PR observability bundles attached to the coordination thread
- **[`macf-devops-toolkit:environments/macf/`](https://github.com/groundnuty/macf-devops-toolkit/tree/main/environments/macf)** — k3d cluster config + helper scripts (`make pf-grafana` / `make pf-tempo` for port-forwarded UI access; `hack/observability-snapshot.sh` for snapshot bundles)
- **[`macf-devops-toolkit:CLAUDE.md`](https://github.com/groundnuty/macf-devops-toolkit/blob/main/CLAUDE.md)** — endpoint reference (canonical `:14318` host-port-mapped via k3d serverlb to the central-collector LoadBalancer)

**Endpoint convention** (per `macf-devops-toolkit:CLAUDE.md`): the canonical k3d cluster's stable OTLP HTTP endpoint is `http://127.0.0.1:14318` (host-port-mapped serverlb). The pre-2026-04-25 compose-stack default `:4318` is retired (caused 34min of zero-telemetry on CV agents — see [`macf#282`](https://github.com/groundnuty/macf/issues/282) + [`macf#283`](https://github.com/groundnuty/macf/pull/283)).

**Operator-side check that telemetry is flowing:**

```bash
# Verify trace ingestion (after running an agent for ~30s):
make pf-tempo  # in macf-devops-toolkit; port-forwards Tempo to :13200
curl -s "http://127.0.0.1:13200/api/search?tags=service.name%3Dmacf-agent-<name>" | jq '.traces | length'
# Expected: > 0 (each /notify or /sign produces a span)

# Verify metric ingestion (Grafana):
make pf-grafana  # port-forwards Grafana to :3000
# Browse: macf_notify_received_total{macf_agent="<name>"} should show non-zero counter
```

**OTel temporality** (per [`macf#281`](https://github.com/groundnuty/macf/issues/281) Phase 2, v0.2.9+): channel-server uses **DELTA** temporality on counters — process restarts produce independent delta points (collector aggregates by series identity to reconstruct cumulative). Robust to N-process / restart topologies. Pre-v0.2.9 used CUMULATIVE which broke `rate()` / `increase()` queries across process restarts.
