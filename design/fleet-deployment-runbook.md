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
DR-043's own §D1 example, which predates Amendments F and O. Where a fact could not be confirmed from source or a live run, it is
marked **unverified** rather than guessed.

---

## 1. Before you start

This section and the next three are one worked example, meant to be followed top to bottom while typing. It brings up a three-agent fleet for a project called `$PROJECT`: a **science agent**, a **code agent** and a **paper agent**. Every name is derived from `$PROJECT`, so you set it once and copy the commands as they are.

**Two machines take part.**

- **Your Mac** runs `macf bootstrap apply`. It talks to GitHub as you, and it opens the consent pages in your browser. The pages are served on `127.0.0.1`, so the browser must be on the same machine.
- **The VM** runs the agents. It must be on your tailnet, because the agents are reached at its tailnet name.

> **What has and has not been run end to end.**
>
> **Run, on `macf-trial` on 2026-10-17 (0.2.72–0.2.75), with its Apps, repos and runners kept:**
> - `fleet deploy` for three agents;
> - a `fleet reconcile` cold start;
> - `fleet doctor --inject`;
> - routing by label and by mention through the control repo (GitHub-hosted runners joined to the tailnet), and by CI completion on an agent repo's own runner;
> - agent-to-agent messages;
> - an upgrade, both halves: `fleet upgrade` of the agents to 0.2.74, then the recording `apply` on the Mac;
> - `routing.runner.trusted_actors`: that apply added the operator's login to `MACF_TRUSTED_ACTORS` on every agent repo;
> - `install-cron` (0.2.75): installed, its line run as cron runs it (from `$HOME`, empty environment) through a real reconcile, then uninstalled, leaving another fleet's watchdog line untouched.
>
> **Not yet run end to end:**
> - the consent pages and App creation, including `router_app_scope: per-fleet`;
> - label or mention routing on a self-hosted agent repo (the last check in §4);
> - apply requesting runners from the runner platform;
> - the router acting on a label or comment you make yourself (the last check in §4);
> - a cron tick after a real reboot;
> - the first launch by hand (§3.5);
> - a VM with no GitHub login.
>
> These are covered by tests only, so following this section is their first live run.
>
> **Organisation:** the walkthrough assumes an org that already hosts a fleet (`macf-experiment`). A brand-new org takes the same steps, but none has been brought up end to end (§6a).

### 1.1 Tools

| Needed | Mac | VM |
|---|---|---|
| Node.js 22.12 or later | ✓ | ✓ |
| `macf` at the fleet's version, installed globally: `npm install -g @groundnuty/macf@0.2.79`. If that needs `sudo`, first run `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH` in your shell profile | ✓ | ✓ |
| `gh` with the token extension, `Link-/gh-token`. Every App token is minted with `gh token generate` | `gh extension install Link-/gh-token` | from the Mac: `gh auth token \| ssh $VM_SSH 'GH_TOKEN=$(cat) gh extension install Link-/gh-token'` (the install needs a token once; the extension itself needs none) |
| `gh auth login` as an **owner of the org**, with the `workflow` and `admin:org` scopes (add them with `gh auth refresh -h github.com -s workflow,admin:org`). For a personal account, see the box below | ✓ | **no:** never log in as yourself on the VM, or an agent whose token fails falls back to your account (`gh-token-attribution-traps.md` mode 4) |
| `git` able to push to GitHub over HTTPS (`gh auth setup-git`) | ✓ | — (agents push with their own App tokens) |
| `age` (`brew install age` on the Mac, `sudo apt install age` on Ubuntu) | ✓ | ✓ |
| A browser logged in to GitHub as an owner of the org | ✓ | — |
| On the tailnet (`tailscale status`) | ✓ (apply calls the runner platform) | ✓ |
| `tmux`, `bash` 4 or later, `crontab` | — | ✓ |
| `claude` 2.1.80 or later, logged in once (run `claude`, log in, exit) | — | ✓ |

Nothing checks these up front. A missing tool fails at the step that needs it, for example `Failed to spawn "age" — is it on PATH?`.

**The machine that runs `apply` must resolve tailnet names.** `apply` calls the runner platform at a `*.ts.net` name. Either turn MagicDNS on for that machine, or put the runner platform's tailnet IP address in `MACF_RUNNER_PLATFORM_ENDPOINT` (§1.3). To tell which you need, run `curl -sS -m 10 -o /dev/null -w '%{http_code}\n' <endpoint>` once with the name and once with the IP. A timeout by name and `200` by IP means names do not resolve there.

> **If the owner is a personal account.** Everything below works for a user as well as an org, with these differences:
> - **Manifest:** set `owner.type: user` (§2 shows `type: org`). Keep `registry` as `{ type: repo, … }`, the control repo.
> - **`gh` scopes:** `workflow` is still needed. `admin:org` is read only by the org-level checks (org installations, org-level runners), which do not apply to a user, so you can leave it out.
> - **Consent page:** `https://github.com/settings/apps/new`, not the organisation's page.
> - **Runners:** a personal account has no account-level runners; registration is per repo. The runner platform does it for you. If you ever need a token yourself, use `gh api -X POST /repos/<owner>/<repo>/actions/runners/registration-token --jq .token`. The CLI's own hint names the `/orgs/<org>/…` endpoint, which a user cannot use.
> - **Weaker plan checks:** for a user there is no org listing, so the plan checks App presence by the predicted name only. It cannot see an App's install scope, so the "only selected repositories" check is not run in the plan. Look at the install page yourself.

### 1.2 Names

Set these in **every** shell you use, on the Mac and on the VM. Edit the values; leave the rest:

```bash
export PROJECT=myproj            # lowercase letters, digits and dashes; at most 20 characters
export OWNER=macf-experiment     # the GitHub org that will own the fleet
export OPERATOR=groundnuty       # your own GitHub login
export VM_HOST=orzech-dev-agents.tail491af.ts.net   # the VM's tailnet name
export VM_SSH=ubuntu@$VM_HOST    # how the Mac reaches the VM over ssh
export VM_HOME=/home/ubuntu      # the VM user's home directory
export FLEET_DIR=~/macf-fleets/$PROJECT
export MAC_AGE_KEY=~/.config/macf/mac-age-key.txt   # on the Mac (§1.3)
export VM_AGE_KEY=~/.config/macf/vm-age-key.txt     # on the VM (§1.3)
[ ${#PROJECT} -le 20 ] || echo "PROJECT is too long (${#PROJECT} > 20)"
```

**Why 20.** GitHub caps App names at 34 characters, and `$PROJECT-science-agent` and `$PROJECT-writing-agent` are the longest names this fleet creates. apply refuses an over-long name before any consent page opens.

**Everything else is derived:**

| Thing | Name |
|---|---|
| Control repo (holds the manifest, the vault and the registry) | `$OWNER/$PROJECT-control` |
| Agent repos, created from the template | `$OWNER/$PROJECT-science-agent`, `…-code-agent`, `…-writing-agent` |
| GitHub Apps, one pair of consent pages each | `$PROJECT-science-agent`, `$PROJECT-code-agent`, `$PROJECT-writing-agent`, `$PROJECT-runner-ops`, `$PROJECT-router` |
| Bot logins | `$PROJECT-<role>[bot]` |
| Issue labels that assign work | `science-agent`, `code-agent`, `writing-agent` |
| tmux sessions on the VM | `$PROJECT@science-agent`, `$PROJECT@code-agent`, `$PROJECT@writing-agent` |
| Registry variables on the control repo | `<SEG>_AGENT_<ROLE>` and `<SEG>_CA_CERT`, where `<SEG>` is `$PROJECT` in capitals with `-` turned into `_` |

### 1.3 Credentials you supply

No tool can mint these. Gather them before the first `apply`.

**1. An age key on each machine.** The fleet's vault holds every App's private key and the CA key, encrypted to both keys: to the Mac's, so later applies can read it, and to the VM's, so deploy can. If you already have keys from another fleet, point `MAC_AGE_KEY` and `VM_AGE_KEY` at them. Otherwise generate them:

```bash
# on the Mac
mkdir -p ~/.config/macf && age-keygen -o $MAC_AGE_KEY
# on the VM
mkdir -p ~/.config/macf && age-keygen -o $VM_AGE_KEY
```

Keep both private files safe. Without one of them, nobody (you included) can decrypt the vault again (Amendment C). An empty `age_recipients` list is refused before any App is created; it never means "skip encryption".

**2. The operator secrets file.** It is one file on the Mac, and it is never committed:

```bash
mkdir -p $FLEET_DIR && cd $FLEET_DIR
macf bootstrap secrets template --out secrets.env
```

**You fill in all three keys yourself, including the runner platform endpoint, and leave the rest blank.** Nobody edits the file after you; an edit that re-creates it drops lines.

| Key | Value | Why it is needed |
|---|---|---|
| `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID`, `MACF_BOOTSTRAP_TS_OAUTH_SECRET` | A Tailscale OAuth client with write access to auth keys, allowed to create keys tagged `tag:ci-runner` | The control repo routes on GitHub-hosted runners, which join the tailnet to reach the agents (§7.4). GitHub cannot show a stored value back to you: reuse the pair only if you kept a copy, otherwise generate one under Tailscale admin console → Settings → OAuth clients. |
| `MACF_RUNNER_PLATFORM_ENDPOINT` | `http://orzech-dev-agents-monitoring.tail491af.ts.net:8088` | apply asks this runner platform for one self-hosted runner per agent repo, and waits for them. Without it, no runner is created and routing jobs wait for one forever (§6.6). When it is set, **`--runner-token` is not needed**: do not fetch a token. Use the platform's tailnet IP here if names do not resolve (§1.1). |

---

## 2. The manifest

`fleet.yaml` is the only file you write. Get the VM's public age key first: on the VM, run `age-keygen -y $VM_AGE_KEY`. Then, on the Mac:

```bash
export VM_AGE=age1…              # paste the line the VM printed
cd $FLEET_DIR
cat > fleet.yaml <<EOF
apiVersion: macf/v0
kind: Fleet
metadata:
  name: $PROJECT
owner:
  account: $OWNER
  type: org
  registry: { type: repo, owner: $OWNER, repo: $PROJECT-control }
network:
  advertise_host: $VM_HOST
transport:
  router_app_scope: per-fleet
  age_recipients:
    - $(age-keygen -y $MAC_AGE_KEY)
    - $VM_AGE
routing:
  runner:
    runs_on: self-hosted
    labels: [self-hosted, macf-vm]
    warm: 1
    trusted_actors: [$OPERATOR]
defaults:
  role_template: groundnuty/agentic-repo-template
agents:
  - role: science-agent
    repo: $OWNER/$PROJECT-science-agent
    deploy_path: $VM_HOME/repos/$PROJECT/$PROJECT-science-agent
  - role: code-agent
    repo: $OWNER/$PROJECT-code-agent
    deploy_path: $VM_HOME/repos/$PROJECT/$PROJECT-code-agent
  - role: writing-agent
    repo: $OWNER/$PROJECT-writing-agent
    deploy_path: $VM_HOME/repos/$PROJECT/$PROJECT-writing-agent
versions:
  macf: 0.2.79
  actions: v3.6.3
EOF
```

**Why each part is there.**

- **`registry: { type: repo, … $PROJECT-control }`.** The control repo is the fleet's registry. This is the form that works for an org; `{ type: org }` is refused (§7.5), and for an org, `{ type: profile, user: <org> }` points at `<org>/<org>`, a repo apply never creates (§6.2).
- **`router_app_scope: per-fleet`.** The fleet gets its own router App, `$PROJECT-router`, at the cost of two more clicks. The default, `shared`, reuses one `<org>-router` App across every fleet in the org. That works only if this fleet's vault already holds the router's key, so in an org that already hosts a fleet the run ends `name-taken` and the fleet cannot route (§7.3).
- **Both `age_recipients` from the start.** Adding the VM's key later works, but costs an extra apply with `--vault` and `--identity-key` to re-encrypt.
- **`routing.runner`.** Every routing job on the agent repos runs on the fleet's own runner, never on GitHub-hosted minutes. A job with no runner waits; it never falls back (§6.5).
- **`trusted_actors: [$OPERATOR]`** (new in 0.2.74). On a self-hosted repo, the router acts only for listed actors. Without your login there, your own labels, comments and reviews on the agent repos reach no agent, because only the agent bots are listed by default. List every human who will give the agents work.
- **`role_template`.** Each agent repo is created from this template. The agent's role file is `AGENTS.md`, which you write at §3.4a. The template ships no `CLAUDE.md`.
- **`work_repos`.** Optional `work_repos:` lists shared repos where the agents do the work. Each is routed exactly like a home repo (caller, labels, routing secrets, runner, trusted actors), and every agent's App is installed on it.
- **`writing-agent` is the paper agent.** A role name is free-form: it sets the App, bot, label and session names, and nothing else. No role selects a persona; the agent's job comes from its `AGENTS.md`. `writing-agent` is the paper role exercised end to end. `role: paper-agent` behaves identically, apart from the names and one informational line in `macf doctor`.
- **`deploy_path` under `~/repos`.** `fleet reconcile` looks for workspaces under `~/repos`, down to four levels deep.
- **`versions`.** It pins every workspace to `macf` 0.2.79 and every router caller to `macf-actions` v3.6.3.

**Left out deliberately:**
- `agents[].profile` and `defaults.app_manifest` are accepted but consumed nowhere.
- `transport.tailscale_oauth_required` only changes how loudly a missing pair is reported, and the secrets file supplies the pair anyway.

Every other field, with its default, is in §6.

---

## 3. Provision and deploy

### 3.1 Check the plan (changes nothing)

```bash
cd $FLEET_DIR
macf bootstrap plan -f fleet.yaml --secrets-file secrets.env
```

**Expect:**
- `repo … CREATE` for the three agent repos. The control repo has no row; apply creates it first;
- `app … CREATE` and `install … CREATE` for each agent;
- `runner_ops … $PROJECT-runner-ops CREATE` and `router_app … $PROJECT-router CREATE`;
- `runner_platform … resolved via the per-fleet operator secrets file`;
- `Operator interaction: up to 5 Apps to create → up to 5 "Create GitHub App" clicks + 5 install flows`.

If `runner_platform` reads `not resolved`, the endpoint is missing from `secrets.env`.

### 3.2 Dry run (changes nothing)

```bash
macf bootstrap apply -f fleet.yaml --secrets-file secrets.env --dry-run
```

It prints each App it would create, with its permissions and its install link. This is the last point at which a mistake costs no clicks.

### 3.3 Run apply

```bash
cd $FLEET_DIR
macf bootstrap apply -f fleet.yaml --secrets-file secrets.env
```

A first run takes neither `--vault` nor `--identity-key`, because no vault exists yet. It also says early on that no runner registration token was supplied, and that this is fine when the runner platform is configured. Do not fetch a token: apply waits for the runners it requests from the platform. What follows (steps 3 and 4 are the clicks):

1. You see the plan again. Answer the confirmation prompt with `yes`; anything else aborts.
2. apply creates `$OWNER/$PROJECT-control` first, then each agent repo (from the template) just before that agent's consent pages.
3. **Consent gate 1, once per App.** The terminal says `press Enter to open the browser`. A local page opens and forwards you to GitHub. **Click "Create GitHub App".** There is nothing to copy back.
4. **Consent gate 2, once per App.** The install page opens. **Choose "Only select repositories", select exactly the repos the terminal lists, and click Install.** Never choose "All repositories"; apply refuses that install (§7.2). The repos per App:
   - each agent's App gets its own repo plus `$PROJECT-control`;
   - `$PROJECT-runner-ops` gets the three agent repos;
   - `$PROJECT-router` gets `$PROJECT-control` only.
5. **Steps 3 and 4 repeat in this order,** 10 clicks in all, and each page waits up to 10 minutes for you:
   1. the science, code and writing agents;
   2. `$PROJECT-runner-ops`;
   3. then a pause while apply requests a runner for each agent repo and waits up to 10 minutes for them to come up. As each one appears, it writes `MACF_TRUSTED_ACTORS` (the three bots and your login) on that repo;
   4. `$PROJECT-router`.
6. **Then, without you:**
   - it mints the CA and the routing-client certificate;
   - it writes every routing secret on every repo;
   - it commits the vault (`secrets/vault.age`) and `fleet.lock` to the control repo.
7. The deploy phase is skipped: `deploying needs --vault + --identity-key`. apply then prints a `macf fleet deploy` command per agent for the host that will run it. That is the same procedure as §3.4, which deploys the agents on the VM.

**Read the summary at the end.** The exit code tells you where you are:

| Exit | Meaning | What to do |
|---|---|---|
| `0` | Everything is in place | Go to §3.4 |
| `2` | Finished, but something is still partial. The likeliest case on a first run is a runner that took longer than 10 minutes, shown as `Not finished: … cannot route yet` | Re-run as below once `macf bootstrap status` shows the runner |
| `1` | A leg failed, and the summary names it | Fix the cause, then re-run as below |

**Two lines on the Mac are expected and change no exit code:**
- `Version reconcile: could not attempt … (driver-unresolved)`, on every run, because the agents' workspaces are on the VM;
- on a run with the vault flags, one deploy line per agent saying `this host cannot create …` for its `/home/…` path.

**To re-run, from `$FLEET_DIR`:**

```bash
cd $FLEET_DIR
gh repo clone $OWNER/$PROJECT-control control 2>/dev/null || git -C control pull
macf bootstrap apply -f fleet.yaml --secrets-file secrets.env --vault control/secrets/vault.age --identity-key $MAC_AGE_KEY
```

- **Always pass both flags,** even if `control/secrets/vault.age` does not exist yet.
- **`--identity-key` lets the re-run use an App you already created.** It decrypts the copy apply saved right after each "Create GitHub App" click, so a re-run doesn't open that App's creation page again.
- **A re-run repeats only what is missing.**

### 3.4 Deploy the agents

**a. Give each agent its job.** The template ships no `CLAUDE.md`, and a new agent repo has no instruction file yet, so until you write one the three agents differ only in name. The file is `AGENTS.md`: Claude Code 2.1.277 and later reads it, and a `CLAUDE.md` next to it would hide it. macf never writes `AGENTS.md`, so your text survives every update. Write it on the Mac before deploying, so each workspace clones your version:

```bash
mkdir -p $FLEET_DIR/repos
for r in science-agent code-agent writing-agent; do gh repo clone $OWNER/$PROJECT-$r $FLEET_DIR/repos/$r; done
# Create or edit $FLEET_DIR/repos/<role>/AGENTS.md: one paragraph on the project, one on this agent's job
# (science: research, design and review; code: implementation in its repo; writing: the paper). Then:
for r in science-agent code-agent writing-agent; do
  git -C $FLEET_DIR/repos/$r add AGENTS.md && git -C $FLEET_DIR/repos/$r commit -m "docs: describe this agent's job" && git -C $FLEET_DIR/repos/$r push
done
```

- **Where in the file:** if `AGENTS.md` already has a `<!-- BEGIN template-managed … -->` region, write below its `<!-- END template-managed -->` line, never inside it. If there is no such region, write the paragraphs at the top.
- **Do not run the template's `.claude/init.sh` on an agent repo or workspace.** It moves every always-on rule out of `.claude/rules/` into `AGENTS.md`, macf's rules included, and `macf update` cannot refresh them there. On one live fleet it did this to the writing agent.

**b. Copy the manifest and vault to the VM.** Deploy reads `fleet.yaml` and `secrets/vault.age` from the control repo's layout:

```bash
# on the Mac
cd $FLEET_DIR
gh repo clone $OWNER/$PROJECT-control control 2>/dev/null || git -C control pull
ssh $VM_SSH "mkdir -p macf-fleets/$PROJECT/control/secrets"
scp control/fleet.yaml $VM_SSH:macf-fleets/$PROJECT/control/
scp control/secrets/vault.age $VM_SSH:macf-fleets/$PROJECT/control/secrets/
```

**c. Deploy, on the VM:**

```bash
for r in science-agent code-agent writing-agent; do
  macf fleet deploy --agent $r -f ~/macf-fleets/$PROJECT/control/fleet.yaml --identity-key $VM_AGE_KEY
done
```

**What deploy does for each role:**
1. clones the repo into its `deploy_path`;
2. writes the App key to `~/.macf/keys/$OWNER/$PROJECT/<role>.pem` (mode 0600), and the fleet's CA certificate **and CA key** to `~/.macf/certs/$OWNER/$PROJECT/`;
3. runs `macf init`, pinned to `versions.macf`.

**`--vault` is not needed.** It defaults to `<fleet.yaml dir>/secrets/vault.age`, which is why step b keeps that layout.

**A warning is expected:** `.claude/rules/pr-discipline.md has no macf managed header`. The template ships its own copy of that rule, and macf leaves it alone.

**Re-running is safe.** An existing workspace is not cloned again.

### 3.5 First launch (one dialog per agent)

On the VM, start each agent once by hand:

```bash
cd $VM_HOME/repos/$PROJECT/$PROJECT-science-agent && ./claude.sh
```

`claude.sh` opens the tmux session `$PROJECT@science-agent` and starts Claude Code, **only when you start it from a terminal that is not inside tmux.** From inside tmux it runs in the current pane, and `tmux ls` will not list the session. Because the folder is new, Claude Code first asks whether you trust it. The question reads `Is this a project you created or one you trust?`, and the first option is a "No" option, highlighted.

1. **Select "Yes, I trust this folder"** (down arrow, then Enter).
2. The next prompt, about development channels, is answered for you.
3. When the input box (`❯`) appears, **detach with Ctrl-b, then d.** The agent keeps running.
4. Repeat for `$PROJECT-code-agent` and `$PROJECT-writing-agent`.

**Only you can answer the trust check.** macf never types into it, and `fleet reconcile` reports an agent waiting there as `BLOCKED` (exit 3) rather than answering. On its first start, each agent registers and picks up any issue already labelled for it.

**Do not assign the agents work until §3.6 and §4 are done.**

### 3.6 Reboot recovery

Cron brings the fleet back after a reboot or a crash. Tell it which agents should be running, then install the line from any of the fleet's workspaces. Run this in an ordinary login shell where `node`, `claude`, `gh` and `tmux` all work, because the line records that shell's `PATH` for cron:

```bash
cat > ~/macf-fleets/$PROJECT/desired-agents.yaml <<EOF
agents:
  - agent: science-agent
    workspace: $VM_HOME/repos/$PROJECT/$PROJECT-science-agent
  - agent: code-agent
    workspace: $VM_HOME/repos/$PROJECT/$PROJECT-code-agent
  - agent: writing-agent
    workspace: $VM_HOME/repos/$PROJECT/$PROJECT-writing-agent
EOF
cd $VM_HOME/repos/$PROJECT/$PROJECT-science-agent
macf fleet install-cron --execute --manifest ~/macf-fleets/$PROJECT/desired-agents.yaml --print   # look first
macf fleet install-cron --execute --manifest ~/macf-fleets/$PROJECT/desired-agents.yaml --yes
```

**It is safe while the agents are working.** `install-cron` only adds a crontab line; it does not touch a running session. Later ticks act only as listed below.

**It refuses if no `macf` is on PATH, or if that `macf` is not the version you are running.** The refusal names the `npm install -g` to run.

**Every 10 minutes, cron runs `macf fleet reconcile` for this fleet:**
- an agent with no session is launched;
- a session that has stopped answering is nudged;
- an agent waiting at a prompt only you can answer is reported, never typed into.

**After a reboot, allow up to 10 minutes.** Recovery waits for the first tick.

**Check after one tick.** Run `tail ~/.macf/watchdog.log`. The last reconcile should list your three agents.

**The line belongs to this fleet only.** It runs a small script, `~/.macf/cron/$OWNER__$PROJECT.sh`, which holds the PATH, the token mint and the reconcile command. Other fleets' watchdog lines and scripts are left as they are.

**Two flags change what it does:**
- **Without `--execute`,** the line only reports.
- **Add `--allow-restart`** to also let it restart an agent that stays unreachable.

---

## 4. Check it works

Run these after §3.5. Each row answers a different question, and none implies another. A fleet can finish a clean `apply` and still fail rows 4 to 6.

**On the Mac, first refresh the clone:** `cd $FLEET_DIR && git -C control pull`.

| # | Component | How to check | Expect |
|---|---|---|---|
| 1 | **Apps and identities in the vault** | `macf bootstrap status -f control/fleet.yaml --vault control/secrets/vault.age --identity-key $MAC_AGE_KEY` | Per role: APP and INSTALL read `present (<id>)` and VAULT reads `6/6 fields`. `trusted actors:` lists the three bots and your login. Without the vault flags, VAULT reads `not read this run`, which is not a failure. |
| 2 | **Control repo** | `gh api repos/$OWNER/$PROJECT-control/contents/fleet.lock --jq .name` | `fleet.lock` |
| 3 | **CA and routing-client certificate** | `gh variable list -R $OWNER/$PROJECT-control \| grep CA_CERT`, then `gh secret list -R $OWNER/$PROJECT-code-agent \| grep ROUTING_CLIENT` | `<SEG>_CA_CERT` on the control repo only (per-repo copies are no longer written); `ROUTING_CLIENT_CERT` and `ROUTING_CLIENT_KEY` |
| 4 | **Routing secrets** | `gh secret list -R <repo>` for each agent repo and the control repo | `MACF_ROUTING_APP_ID`, `MACF_ROUTING_APP_KEY`, `ROUTING_CLIENT_CERT`, `ROUTING_CLIENT_KEY`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `MACF_ROUTING_BUNDLE` |
| 5 | **Runners and trusted actors** | `gh api repos/$OWNER/$PROJECT-code-agent/actions/runners --jq .total_count`, then `gh variable get MACF_TRUSTED_ACTORS -R $OWNER/$PROJECT-code-agent`, for each agent repo | At least `1`; the three bots and your login |
| 6 | **Agents running** | On the VM, in any of the fleet's workspaces: `macf fleet status` | Three agents online |

**Then prove delivery.** On the VM, in any of the fleet's workspaces:

```bash
macf fleet doctor --inject
```

**It is safe while the agents are working.** `--inject` sends each agent one probe message, the same way a routed `@mention` arrives. The message reads `fleet-doctor --inject probe (run_id=…) — no action needed`. The agent's session takes it as its next turn and acknowledges it. A busy agent queues it, so its ✓ may come late; no ✓ within the wait means unconfirmed, not deaf.

**Expect `HEALTHY`, and a ✓ in the `PROCESSED` column for all three agents.** `PROCESSED` means each agent's session consumed a real injected message, not only that the server accepted it.

**Then prove routing through GitHub.** From the code agent's workspace:

```bash
cd $VM_HOME/repos/$PROJECT/$PROJECT-code-agent
macf routing doctor --e2e --target-repo $OWNER/$PROJECT-control --recipient science-agent --mode label
```

**Expect three `[ok]` lines.** The middle one reads `Routed issue #N to science-agent via mTLS POST (HTTP 200)`, and the probe issue is closed afterwards. A red line names the stage where delivery stopped.

**Last, prove it works for you.** As yourself, on the Mac, open an issue on an agent repo, then read the router's log for it:

```bash
T=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh issue create -R $OWNER/$PROJECT-code-agent -l code-agent -t "hello from $OPERATOR" \
  -b "Reply to me once to say you received this; take no other action."
until RUN=$(gh run list -R $OWNER/$PROJECT-code-agent -w agent-router.yml -e issues --created ">=$T" -L 1 \
    --json databaseId --jq '.[0].databaseId // empty') && [ -n "$RUN" ]; do sleep 5; done
gh run watch "$RUN" -R $OWNER/$PROJECT-code-agent > /dev/null
gh run view $RUN -R $OWNER/$PROJECT-code-agent --log | grep -E 'Routed issue #[0-9]+ to code-agent|not listed in the MACF_TRUSTED_ACTORS'
```

**Expect the `Routed issue … to code-agent` line, and no `not listed` line.** This is the check that `trusted_actors` works: before 0.2.74, the router refused this issue, because you are not one of the fleet's bots. The code agent's reply on the issue, addressed to `@$OPERATOR`, follows within a few minutes.

**From here on, give agents work** by opening an issue in `$OWNER/$PROJECT-control` (or in an agent's own repo) with the agent's label, for example `code-agent`. To reach one agent in a comment, start a line with `@$PROJECT-code-agent[bot]`. Agents reach you by starting a line with `@$OPERATOR`, and GitHub notifies you.

### Upgrading the fleet later

1. **On the VM, roll the agents:**

   ```bash
   npm install -g @groundnuty/macf@<new>
   cd $VM_HOME/repos/$PROJECT/$PROJECT-science-agent && macf fleet upgrade --fleet $PROJECT --target <new> --execute --wait
   ```

   **Expect `GREEN on <new>` for each agent.** Upgrade to the newest release only: each agent's step runs `macf update`, which pins the newest release whatever `--target` says (§10). Each workspace is left with `.gitignore`, `.claude/audit.log` and `claude.sh` changed; ask its agent to commit them. They do not block the next upgrade.
2. **On the Mac, record the version.** Run `npm install -g @groundnuty/macf@<new>` first, because an older Mac CLI would regenerate the router callers with its older generator. Then set `versions.macf` in `$FLEET_DIR/fleet.yaml`, and run:

   ```bash
   cd $FLEET_DIR && git -C control pull
   macf bootstrap apply -f fleet.yaml --secrets-file secrets.env --vault control/secrets/vault.age --identity-key $MAC_AGE_KEY
   ```

   That commits the version to the control repo; when `versions.actions` changed, it also re-pins every router caller. Expect the `Version reconcile: … (driver-unresolved)` line from §3.3: the Mac has no agent workspaces, so apply's own roll has nothing to do there.
3. **Copy the new files to the VM,** exactly as in §3.4 step b. That step starts with the pull, so the VM gets the versions apply just committed. A later `fleet deploy` then installs the same version.

To take a fleet down, see §9.

---

## 4a. Adding an agent to an already-provisioned fleet

> **`MACF_TRUSTED_ACTORS` follows the manifest.** On every repo the value is the
> fleet's agent bots (`<fleet>-<role>[bot]`) followed by any logins in
> `routing.runner.trusted_actors`. `apply` reconciles it: where a repo holds a
> different value, `plan` reports an `update` and `apply` rewrites it after one
> confirmation (`--yes` confirms), so adding an agent widens every existing repo
> in the same run (`reconcileTrustedActors`, `apply-routing.ts`; macf#1319). A
> login added by hand outside the manifest is removed by the next `apply`; to keep
> one, list it under `routing.runner.trusted_actors`.

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

### Adding a work repo later

Adding a `work_repos:` entry is one more run of apply with `--vault` and `--identity-key`, plus one "Save" click on the install page of each agent App whose install must grow to cover it. One run completes it when you click the "Save" pages while apply waits; otherwise re-run apply.

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
   self-hosted` (§6.5) and its runner-platform endpoint resolves (§6.6),
   `apply` requests the new repo's runner from the platform and waits up to
   10 minutes for it before writing `MACF_TRUSTED_ACTORS`. No runner token is
   needed for that wait; a token only makes `apply` also wait for a runner it
   did not request itself:

   ```bash
   macf bootstrap apply -f fleet.yaml --secrets-file secrets.env \
     --vault <path> --identity-key <path>
   ```

   Approve the plan. The run drives, in order: the new agent's own gate 1 +
   gate 2 (§3.3 steps 3–4) — **then**, only once every agent identity is
   confirmed, it reopens gate 2 for each fleet-level App step 2 flagged.
   **Click "Save" on each one** — never "Install" again, the App already
   exists — and the CLI polls the same way gate 2 always does (10-minute
   budget, same cancel/resume semantics as §7.6/§7.7: a cancelled or timed-
   out widen is safe to retry, a re-run reopens only whatever is still
   stale). **Then run the same `apply` command once more.** The "Save" page
   opens after this run has already asked for the new repo's runner, so only
   a re-run asks again and writes `MACF_TRUSTED_ACTORS`. Control-repo labels for the new role are created automatically as
   part of this same run's control-repo sync — no separate click for that
   (verified in step 4 of "Verify," below).

4. **Deploy the new agent's workspace** — §3.4, unchanged by anything above.

### What you'll actually hit if you skip step 2, or click too slowly

**The new agent's own self-hosted runner never comes up, while its siblings
already show a healthy count.** Because the manifest declares
`routing.runner.runs_on: self-hosted` and `apply` requested the new repo's runner
from the platform, it waits for that runner, narrating progress as it goes (e.g. `waiting for the
runner requested THIS run to become usable for "<owner>/<new-agent-repo>" …
45s/600s elapsed; runner platform reports 0 available`). If the underlying
platform confirms a genuinely terminal state — not a startup delay, one that
plain polling will never clear — `apply`'s printed summary carries this
exact reason text for that repo:

    role/repo "<owner>/<new-agent-repo>": the runner-provisioning platform reports a TERMINAL
    failure for this repo's runner — FailedUpdateRegistrationToken (Updating registration
    token failed). This is not a startup delay; polling will not clear it. MACF_TRUSTED_ACTORS
    was NOT written. This repo cannot route until it is written: its routing jobs wait for a
    self-hosted runner and never fall back to a GitHub-hosted one. It is written once the
    underlying provisioning problem is fixed (commonly: the fleet's GitHub App is not
    installed on the repo owner, so no registration token can be minted) and
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
# that is provisioning latency; if it stays 0, or check 3 shows no variable, re-run apply
# with --vault/--identity-key)

# 3. Routing is live for the new repo.
gh variable get MACF_TRUSTED_ACTORS --repo <owner>/<new-agent-repo>
# expect: non-empty, lists every agent bot login plus any routing.runner.trusted_actors

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
| `versions.macf` / `versions.actions` | optional (whole `versions:` block) | omitted → no GitOps steering target; `apply` doesn't reconcile version drift for either plane | §D6/Amendment L: `versions.macf` is reconciled by `macf fleet upgrade` under a verify-green gate. `apply` force-rewrites a diverging `agent-router.yml` pin itself (`apply-repo-init.ts`), and its version phase runs the `fleet upgrade` roll, only over workspaces on the host running `apply` (`apply-version.ts`; §7.8). |
| `owner.account` | required | — | the GitHub org or user login that owns the fleet |
| `owner.type` | required | — | `user` \| `org` — shapes the manifest-form URL and interacts with the router-App scope derivation (§6.5) |
| `owner.registry` | required | — | see §6.2 |
| `network.advertise_host` | required | — | the tailnet hostname other agents use to reach this fleet's channel servers; consumed by `macf fleet deploy` (`advertiseHost`) |
| `transport.age_recipients` | required (array; `.min(0)`, **not** `.min(1)`) | `[]` is the create-path REFUSAL trigger, never "skip minting" — see §1.3 | operator-supplied public keys only, never a private key, never tool-minted (Amendment C) |
| `transport.tailscale_oauth_required` | optional | `false` | declares that this fleet's router needs `TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET`; when `true` and none of the flags, env, the secrets file or the vault supplies the pair, `apply` refuses **before gate 1** rather than spend a click on a fleet that can't route (§7.4) |
| `transport.router_app_scope` | optional | `'shared'` | `'shared'` (one router App per **owner scope**, reused across every fleet on that account) vs `'per-fleet'` (a dedicated router App for this fleet alone). For a new fleet in an org that already hosts a fleet, `'per-fleet'` is the path that works without copying another fleet's router credentials — see §6.5, §7.3 |
| `transport.age_recipients_narrowing_override` | optional | omitted | a non-empty string that acknowledges removing a recipient from an existing vault's `age_recipients`; without it `apply` refuses to narrow the set (`bootstrap-apply.ts`, `apply-fleet.ts`) |
| `transport.router_app_origin_fleet` | optional | omitted | provenance-only: names which fleet's vault this fleet's copy of a shared router credential came from. Purely a marker — declaring it changes no behavior; see §7.3 |
| `transport.runner_platform_endpoint` | optional | omitted | the LOWEST-precedence, narrowest tier of the runner-platform endpoint resolution — an escape hatch for a fleet that genuinely needs a different runner-provisioning platform than its scope's shared one, not the intended common path. A VARIABLE, never a secret — safe to commit to `fleet.yaml`. See §1 + §6.5 (groundnuty/macf#1211) |
| `defaults.role_template` | required | — | the GitHub template repo new agent repos are cloned from |
| `defaults.app_manifest` | optional | — | **accepted by the schema but UNCONSUMED anywhere downstream today** (verified: zero non-schema, non-fixture references in source). Every real fleet uses the literal `dr-019` by convention; the DR-019 permission set is hardcoded in `app-manifest.ts` regardless of what this field says. Write `dr-019`; nothing currently reads it. |
| `agents[]` | required, `.min(1)` | — | see §6.3 |
| `work_repos[]` | optional | omitted → no work repos | `owner/repo` entries for shared repos the agents work in. Each owner must be `owner.account` (a private App installs only on the account that owns it); an entry equal to an agent repo or the control repo, or listed twice, is refused at parse time. `apply` creates an absent one private and blank, reuses a present one, routes it like a home repo, and adds it to every agent App's install set. Not a workspace: no deploy, no `fleet.lock` entry. Removing one from the manifest deletes nothing. |
| `routing.runner` | optional (whole `routing:` block) | **omitted → routing runs on GitHub-hosted runners and `MACF_TRUSTED_ACTORS` is never written** | §7.1; `plan` prints a per-repo line saying so. See §6.5 for the sub-fields. |
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
| `profile` | optional | — | **accepted by the schema but currently UNCONSUMED anywhere in `apply`/`deploy`.** Real fixtures show it is not a function of `role` (`science-agent` → `research`, but also `runner-ops` → `code` in one worked example) — write something meaningful for a human reader; nothing downstream reads it today. |
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
| `trusted_actors` | optional | omitted → agent bots only | GitHub logins (humans, or extra bots) appended after the fleet's own agent bots in `MACF_TRUSTED_ACTORS` (0.2.74); the trusted-actors reconcile keeps them. An actor not listed is refused at `pick-runner` on a repo whose caller declares `runner-runs-on: self-hosted`. |

**Two independent mechanisms both gate on this block, and satisfying one
does not satisfy the other (§7.1's "silent cost" made concrete):**

1. **`MACF_TRUSTED_ACTORS`** — the trust-allowlist variable `pick-runner`
   reads. Written **only after** `apply` confirms a usable runner exists
   (register-before-route, DR-043 Amendment H.1). For each repo whose runner
   `apply` requested from the runner platform this run, `apply` waits up to 10
   minutes for GitHub to see it, with or without `--runner-token`; if it is still
   not visible, the leg is `pending` and the run exits 2. For any other repo,
   `apply` checks once if no token was given, or waits up to 10 minutes if one
   was (`apply-fleet.ts`, `apply-routing.ts`; #1195, #1212). Under `macf-actions` v3.6.2, a caller
   that declares `runner-runs-on: self-hosted` never falls back to a hosted
   runner: with no runner its jobs queue, and an unlisted actor is refused at
   `pick-runner`.
2. **The runner-provisioning contract** (its endpoint resolved per §6.6's
   six-tier chain, DR-043 Amendment I,
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


### 6.5.1 `routing.control_repo_runs_on` — the control repo's runner class (opt-in)

```yaml
routing:
  runner:
    runs_on: self-hosted
  control_repo_runs_on: self-hosted
```

| Field | Required? | Default | Notes |
|---|---|---|---|
| `control_repo_runs_on` | optional | **omitted → the control repo routes on a GitHub-hosted (metered) runner** | the only accepted value is `self-hosted`, and only when `routing.runner.runs_on` is also `self-hosted`; any other combination is refused at parse. |

**Why this is separate from `routing.runner.runs_on`.** The control repo is
the fleet's coordination surface (DR-043 Amendment M2): every agent App is
installed there and its routing table lists the whole fleet, so **every
cross-agent message routes through it**. Declaring agent repos self-hosted
does NOT move the control repo. It keeps routing hosted until this field
says otherwise, so existing self-hosted fleets are unchanged by the field's
existence.

**What `apply` does when it is declared:** writes `runner-runs-on:
self-hosted` into the control repo's generated router caller, provisions a
runner for the control repo through the **same** runner-platform contract as
agent repos (§6.5 mechanism 2), and writes `MACF_TRUSTED_ACTORS` on the
control repo with every fleet bot, through the same register-before-route
gate (§6.5 mechanism 1).

**What `plan` reports:** a `routing:<fleet>:control-runner` row, emitted only
when the field is declared. It is `update` while the caller input, the
trusted-actors variable or a usable runner is missing, and its reason ends
*"routing through the control repo FAILS or queues — it does not fall back
to a hosted runner."* Declared self-hosted never silently runs hosted.

**Hosted, by contrast, needs the Tailscale pair** to reach the agents, so
when this field is omitted the control repo's `router_caller_secrets` row
requires `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET`. On GitHub Free those must
be **repository** secrets: organisation secrets do not reach a private repo,
and plan reports them as withheld.

### 6.6 Environment variables the bootstrap path honors

| Variable | Read by | Effect |
|---|---|---|
| `MACF_BOOTSTRAP_RUNNER_TOKEN` | `bootstrap apply` | Fallback for `--runner-token` when the flag is omitted. CLI flag wins on conflict. |
| `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID` | `bootstrap apply` | Fallback for `--ts-oauth-client-id`. CLI flag wins on conflict. |
| `MACF_BOOTSTRAP_TS_OAUTH_SECRET` | `bootstrap apply` | Fallback for `--ts-oauth-secret`. CLI flag wins on conflict. |
| `MACF_BOOTSTRAP_VAULT_VERSION` (`=1`) | `bootstrap apply`, `vault-write.ts` | Changes an existing `secrets/vault.age` from fail-loud-on-clobber to version-aside-and-write (a timestamped sibling file, never an in-place overwrite). Default: fail loud. |
| `MACF_RUNNER_PLATFORM_ENDPOINT` | `apply-fleet.ts`'s runner-provisioning call, `macf bootstrap plan` (Amendment I, groundnuty/macf#1211) | The `groundnuty/runner-platform` tailnet HTTP endpoint — the env tier of a six-tier resolution (`runner-platform.ts:331-347`): explicit flag → this env var → the operator secrets file, fleet then scope (`--secrets-file`, `--scope-secrets-file`) → the `owner.registry` scope's Actions variable of the SAME name, read from the registry repo's variable endpoint (for `registry: type: repo`, the control repo) → `transport.runner_platform_endpoint` in `fleet.yaml` → unconfigured. For a new fleet the secrets file is the simplest source, because the control repo does not exist before the first `apply`. Has **no baked-in default** (unlike `api.github.com`) since it names one operator's private tailnet address — every tier can be absent; nothing is ever guessed. Nothing resolved → every provision call reports `'not-configured'`, non-fatally, and `plan` names the gap before you approve `apply`. |
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
| `bootstrap plan`, `bootstrap status`, `bootstrap apply`, `bootstrap manifest scaffold` | `--vault <path>` and `--identity-key <path>` are **together-or-neither** | Enforced (`checkVaultFlagsComplete`): giving exactly one without the other is a refusal, not a silent degrade to the vault-free default — this is deliberate: a half-given pair usually means the operator forgot the second flag, not that they intended vault-free operation. |
| `fleet deploy` | `--identity-key <path>` is **required**; `--vault <path>` is optional | `--vault` defaults to `<fleet.yaml dir>/secrets/vault.age`; `--identity-key` alone is accepted (`commands/fleet-deploy.ts`). |
| `fleet destroy` | `--age-identity <path>` is **required when** `--shred-age-key` is given (not required otherwise) | `--shred-age-key` alone doesn't refuse at the flag level, but the shred step has nothing to act on without a path — always pass both together. |
| `fleet destroy` | `--destroy-repositories`, the interactive fleet-name confirmation, **and** `MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES=1` are **all three required** | Missing any one refuses the run — none of the three is optional or implied by either of the others (§9). |
| `bootstrap apply` | `--runner-token <token>` (or `MACF_BOOTSTRAP_RUNNER_TOKEN`) is **advised when** the manifest declares `routing.runner.runs_on: self-hosted` | Not required: without it `apply` prints a warning before gate 1 and every leg still runs. For each repo whose runner `apply` requested from the runner platform this run, it waits up to 10 minutes with or without a token; for any other repo, it checks once without a token, or waits up to 10 minutes with one. A `pending` leg exits 2; a `failed` leg exits 1 (§6.5, §8). |
| `bootstrap apply` | `--ts-oauth-client-id` and `--ts-oauth-secret` are **mutually required** — supplying one without the other is refused before the manifest is even parsed. Both are **required when** the manifest declares `transport.tailscale_oauth_required: true` and neither env, the secrets file nor the vault supplies the pair. |
| `bootstrap manifest scaffold` | `--owner`, `--fleet`, and at least one `--agent role=owner/repo` are all `requiredOption`s; `--vault`/`--identity-key` follow the same together-or-neither rule as the row above | The three required options have no defaults at all (commander refuses to run without them); the vault pair is optional but paired. |

No other command in `packages/macf/src/cli/index.ts`'s `bootstrap`/`fleet`
families was found to have a cross-flag requirement beyond these rows
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

### 7.1 A fleet with no `routing:` block declared — routing runs hosted

**What you did:** omitted `routing:` entirely (or declared it with a
`runs_on` value other than the literal `self-hosted`).

**What happens:** `apply-fleet.ts` gates the entire `MACF_TRUSTED_ACTORS`
write on `manifest.routing?.runner !== undefined &&
manifest.routing.runner.runs_on === 'self-hosted'`. When that's false, the
write is skipped, and routing runs on GitHub-hosted runners. `plan`
prints a per-repo line saying so, with a billing note and the
`routing.runner.runs_on: self-hosted` remedy (`plan.ts`; #1497).

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

**Fix:** declare the `routing.runner` block from §6.5 (`macf-trial` does), then
re-run `apply`. With the runner platform resolved (§6.6), apply requests the runners and waits for them.

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

**Or**, set `transport.router_app_scope: per-fleet` in the manifest before the
first `apply` for this fleet. It mints its own dedicated router App, at a cost
of two more browser clicks, and is permanently isolated. For a new fleet in an
org that already has `<owner>-router`, this is the supported path.

### 7.4 Tailscale OAuth declared but absent — refused before gate 1

**What you did:** set `transport.tailscale_oauth_required: true` without
supplying `TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET` — by flags
(`--ts-oauth-client-id`/`--ts-oauth-secret`), env, the secrets file, or the
vault.

**What happens:** `checkTailscaleOauthPreflight` runs before any consent gate
opens (the vault is read only when `--vault`/`--identity-key` are given), and
refuses outright if the declared requirement isn't satisfiable — same posture as
the age-recipient refusal in §1.3: a declared intent the tool cannot honor is
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
  leg, not `'failed'` — no refusal, but a hosted-runner route still won't work.

The pair is needed only by routing jobs that run on GitHub-hosted runners
(`macf-actions` v3.6.2; a self-hosted pick skips the tailnet join). Those are
the control repo, unless `routing.control_repo_runs_on: self-hosted`, plus every
repo of a fleet without `routing.runner`. The flag is purely about how the tool
talks to you about a gap, never about whether the gap matters.

### 7.5 A registry pointed at `{ type: org }` — refused

Covered fully in §6.2. The refusal fires from the manifest alone, before
any GitHub call — the DR-019 permission set this tool requests has no
organization-scoped Variables permission, so no install-scope choice could
ever fix it. Use `{ type: repo, ... }` for an org-owned fleet instead.

### 7.6 A resumed gate — App exists, install still incomplete

**What you did:** a previous `apply` run created an App for some role (gate
1 succeeded — the App and its private key are already durable in the per-agent
recovery artifact `~/.config/macf/recovery/<fleet>/<role>.age`, per Amendment B), but the install never completed — you cancelled (§7.7),
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
the moment before you cancelled (Amendment B: the recovery artifact
`~/.config/macf/recovery/<fleet>/<role>.age` is written before gate 2 even
opens; the vault is written once per run, later). That role's outcome for this run is reported as
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
never auto-created by `apply`, unless it is the fleet's control repo, which
`apply` creates first (otherwise only each agent's own home repo is) — so
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
| **1** | A **hard failure** needing operator attention: the control repo couldn't be provisioned or synced, any agent identity needs attention (`failed`/`drift`/`skipped-unverified`), the runner-ops or router App needs attention, the vault write failed, any CA leg failed, any of the six routing-secret legs `failed` (not merely `skipped`), a `MACF_TRUSTED_ACTORS` leg or the routing bundle `failed`, any routing-client leg failed, the control repo is missing labels it needs to route, an `actions_pin` that `could-not-attempt` (e.g. a re-run without the vault flags while `versions:` is declared), any deploy-phase `failed`, a work repo that could not be created or initialised (`Work repos:` in the summary names it), or the version-reconcile phase **halted** (a confirmed-or-unconfirmable bad release). Checked first — a halt always reports `1` even if something else in the same run is *also* merely partial. |
| **2** | **Not** a hard failure, but the run is unfinished: the version-reconcile phase left at least one discovered fleet member un-rolled (busy / config-dirty / off-branch / stale-pin / not-yet-serving), the control repo's labels are usable but not all confirmed yet, a work repo's labels are still waiting for an agent App's install to cover it, or its runner and routing for the runner-ops App's install to cover it (click "Save" on the install page and re-run), or a repo's `MACF_TRUSTED_ACTORS` leg ended `pending` because its runner is not visible yet (the summary prints a `Not finished:` line naming the repos). Distinguishes "this needs a look, but nothing is broken" from a genuine `1`. |

### `macf fleet upgrade --execute`

Same three-valued shape, same rationale (mirrored from `@groundnuty/macf-core`'s
`fleet-reconcile.ts` 0/1/2 convention): **0** every fleet finished fully
green; **1** at least one fleet **halted** (a bad release — checked first);
**2** not halted, but at least one fleet left an agent behind (mixed-version
roll). A caller doing the common `[ $? -ne 0 ]` check now correctly sees
non-zero for a mixed roll too (this was the exact gap `2` was added to
close).

### `macf fleet reconcile`

**0** nothing to do; **1** an action was taken or is needed (a first cold start
is `1`); **2** a setup or probe error (bad manifest, probe threw); **3** a launch
failed, or an agent waits at a prompt only the operator can answer
(`macf-core/src/fleet-reconcile.ts`).

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
`--allow-restart`, `--with-routing` (a no-op), `--manifest <path>`, `--no-token`
(don't bake a `GH_TOKEN` mint into the cron line), `--uninstall`, `--print`
(preview without touching crontab), `--prelude <path>`, `--log <path>`,
`--yes`, `--dir <path>`. The line runs a per-fleet script,
`~/.macf/cron/<owner>__<project>.sh`, which holds the PATH, the token mint and the
reconcile command, because Ubuntu's cron caps a command at 1000 characters. The script
sets the installing shell's `PATH`, runs the
absolute path of the global `macf`, and passes `--dir <workspace>`. The line carries the
marker `# macf-watchdog (DR-006) [fleet=<owner>/<project>]`, and install and
uninstall touch only that fleet's line. It refuses (exit 2) if no `macf` is on
PATH, if that `macf` is not the version of the CLI you are running (#1508), if
PATH is empty, or if the log or script path on the line contains `%`, or if the line passes 900 characters. There is no
`@reboot` line, so recovery after a reboot waits for the first tick.

**`macf fleet reconcile`** [`--help`] — the desired-state watchdog: probes
actual `/health` against a desired set and launches/heals/skips accordingly.
Dry-run by default. Exit `0` nothing to do, `1` acted or action needed, `2`
setup or probe error, `3` a launch failed or an agent waits at an operator-only
prompt (§8). Flags: `--execute`, `--allow-restart` (enables Tier-2
graceful-restart), `--with-routing`, `--manifest <path>`, `--state-dir
<dir>`, `--last-exit-dir <dir>`, `--paused-dir <dir>`, `--heartbeat-file
<path>`, `--json`, `--dir <path>`.

**`macf fleet resume`** [`--help`] — nudges a stalled idle agent or reports
a blocked one (never auto-answers a permission/trust prompt). Dry-run by
default. Flags: `--execute`, `--dir <path>`.

**`macf fleet upgrade`** [`--help`] — the rolling framework-version upgrade
described in §8's exit-code table. Flags: `--target <version>` (default:
npm-latest of `@groundnuty/macf`; each agent's step runs `macf update --yes` through the
`macf` on PATH, which pins npm-latest, so upgrade to the latest release), `--fleet <names>` / `--registry <ids>`
(comma-lists, same selector space — `--registry` is the historical name),
`--execute`, `--wait` (poll for idle instead of skipping a busy agent),
`--verify-timeout <sec>` (default 120), `--force` (bypass the branch and config-dirty
pre-flight gates — the agent's own dirt still isn't stashed), `--dir <path>`,
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
  O's `router_app_scope`).
  `run` `--help` on any command before trusting a flag against this doc.
- `use-cases/scientific-paper-fleet.md` — a worked, narrative walkthrough of
  one specific fleet shape (science + code + writer agents), cross-checked
  against this runbook's field reference while writing it.
- **macf#878** (§4b) — the three-fleet migration to Amendment F control
  repos this runbook's §4b procedure serves; its own issue thread carries
  the fuller design-decision trail (why `manifest scaffold`/`control-repo
  init` are separate verbs, the `versions:`/`age_recipients` exclusions,
  the sequencing ruling) that this section only summarizes operationally.
