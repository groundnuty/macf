# Deploy a MACF fleet: the working agreement between you and the operator

**You bring up a new MACF fleet by following the walkthrough:** §1–§4 of `design/fleet-deployment-runbook.md` in `groundnuty/macf`, at the release tag of the `macf` version this fleet uses.

**This prompt does not repeat the walkthrough's steps.** It says what you need before you start, who does what, how you and the operator hand work to each other, and when you are finished. **For every command, follow the walkthrough and the CLI's own output.** In this prompt, a `§` number always means a section of the walkthrough.

MACF runs several Claude Code agents as a team. Each agent has its own GitHub App and repo, and the agents coordinate through issues and PRs.

## Inputs: get them all before anything else

The operator may give some of these in their first message. **Ask the operator for every row that is still missing,** in plain conversation, a few at a time. `n/a` is a valid answer where a row does not apply. Until the operator has answered every row (never fill one from a guess), including an onboarding pack's interview, and has confirmed the read-back table, you may read the walkthrough and fetch and read the onboarding pack, but **do nothing else:** no installs, no repos, no other project.

| field | |
|---|---|
| `PROJECT` | lowercase; `<PROJECT>-<longest role>` at most 34 characters (§1.2) |
| `OWNER` | GitHub account, **and its type: `user` or `org`** |
| `OPERATOR` | the operator's GitHub login |
| `VERSION` | the `macf` release, **0.2.80 or later** (the first with `bootstrap preflight`); also `versions.macf` in the manifest. Where the walkthrough writes `0.2.80`, write this |
| work repos | repos the agents work in besides their own (`work_repos`) |
| the project | one paragraph: what it is, and what "done" means; or an onboarding pack |
| each agent | its role name and **one line on its job**; or an onboarding pack |
| the apply host | where `apply` runs (for example the operator's laptop). It needs a browser logged in to GitHub as an owner of `OWNER`: the consent pages are served on `127.0.0.1` |
| the agent host | where the agents run: "the apply host", or an ssh target with user and home directory |
| its tailnet name | the agent host's `*.ts.net` name, for `network.advertise_host`. An ssh alias is not a tailnet name |
| you run on | which of those two you are on |
| routes | two hosts only: the exact ssh command each way, including any alias or `SSH_AUTH_SOCK` |
| runner platform | the runner platform endpoint (§1.3), and whether the apply host resolves `*.ts.net` names. If not, the endpoint's tailnet IP |
| reachability | confirmed that the control repo's hosted runners (`tag:ci-runner`) and the platform's runners can reach the agent host |
| agent host ready | `claude` installed and logged in there. Two hosts: whether the agent host keeps the operator's own `gh` login (the walkthrough says it should not) |
| ready credentials | the Tailscale OAuth pair is created; the path of each existing age key (two hosts: one per host), or "generate" |

**Read all the answers back once, as a table, and get the operator's confirmation.**
- **With an onboarding pack** (for a paper fleet: `design/onboarding-packs/paper-fleet/`): fetch it from `main`, as its README §1 shows, and interview the operator for it as its README says. It replaces the project and agent rows, and its blocks go into each agent's `AGENTS.md` at §3.4a.
- **Without one:** the project paragraph and the job lines go into each agent's `AGENTS.md` at §3.4a.
- **If work repos is not `n/a`,** add a top-level `work_repos:` list to §2's manifest (§6.1).
- **If the roles are not science, code and writing,** substitute the operator's roles in every loop and name the walkthrough uses, and recompute §3.3's click count and §1.2's length cap.

## Before the first command

1. **Fetch the walkthrough at the release tag,** not from memory and not from `main`. Write the version out:

       curl -fsS --create-dirs -o ~/macf-fleets/<PROJECT>/runbook-v<VERSION>.md https://raw.githubusercontent.com/groundnuty/macf/v<VERSION>/design/fleet-deployment-runbook.md

   Read §1–§4 completely, including the boxes at the top of §1. When a step fails, read the reference sections it points to.
2. **Install `macf@<VERSION>`:**
   - **On a shared machine** (other fleets in `tmux ls`, `crontab -l` or `~/repos`): into a private prefix (`npm install -g --prefix ~/.macf-cli/<VERSION> @groundnuty/macf@<VERSION>`). Never replace the global one, and record this as a deliberate deviation.
   - **Otherwise:** globally, as §1.1 says. Ask first; installs are the operator's (see "Who does what").
3. **Write `~/macf-fleets/<PROJECT>/env.sh` on each machine you use.**
   - **Why:** each of your commands starts a new shell, so nothing you export or unset survives.
   - **What it holds, in order:** first a loop that unsets every inherited `MACF_*` variable, then §1.2's exports, then the private-prefix PATH line where it applies.
   - **Use it everywhere:** start every command with `. ~/macf-fleets/<PROJECT>/env.sh &&`, including over ssh.
   - **Check once:** in one command, confirm that `macf --version` prints `<VERSION>` and that `env | grep '^MACF_'` prints nothing.
4. **Write the project name and the version out literally** in every path and URL. A fresh shell has neither as a variable until env.sh is sourced.
5. **Then follow §1–§4,** including the preflight at the start of §3.
   - Go on only when it ends `preflight: ready` (exit 0).
   - Fix each `missing` or `wrong` line, or hand its printed fix to the operator (see "Who does what").
   - Show each `unknown` line to the operator and log their answer.

## Who does what

**You run each of these on the host the walkthrough marks for it:**
- every command that does not need the operator's browser, terminal, login or decision;
- `bootstrap plan`, `apply --dry-run` and `bootstrap status`;
- `fleet deploy`;
- the §4 checks;
- `install-cron`, in a login shell on the agent host, because the cron line records that shell's PATH (§3.6). Over ssh: `ssh <agent-host> "bash -lc '. ~/macf-fleets/<PROJECT>/env.sh && cd <workspace> && macf fleet install-cron …'"`.

**The operator does:**
- **Anything that needs sudo, a password, a browser or a login:**
  - `gh auth login` and `gh auth refresh`;
  - the `claude` login;
  - §1.1's `gh` token extension install on the agent host;
  - installing a missing tool.

  Ask before installing anything yourself.
- **Every `bootstrap apply` without `--dry-run`.** It opens their browser.
  - **The script:** write `~/macf-fleets/<PROJECT>/apply-<n>.sh`. In order, it:
    1. starts `#!/usr/bin/env bash`;
    2. sources env.sh;
    3. `cd`s to the fleet directory;
    4. sets `set -o pipefail`;
    5. runs `macf … 2>&1 | tee apply-<n>.log`;
    6. appends `apply exit=<code>` to the log.

    Then `chmod +x` it.
  - **Why `2>&1`:** the confirmation, the consent-gate prompts and every `▶ ACTION NEEDED` line go to stderr.
  - **Ask them to run it by its full path on the apply host.** Long command lines break when pasted. The log lets you follow the run while it happens.
- **The consent pages and the confirmation** (§3.3 steps 1–5). Before the first apply, tell them what the terminal will ask.
- **`secrets.env`:**
  1. You run `secrets template`.
  2. You give the operator the runner platform endpoint, by name or by IP (§1.1).
  3. They fill all three keys (§1.3) in one edit.
  4. Never open the file afterwards; check it with preflight's `--secrets-file`.
- **The first launch (§3.5)** in their own terminal on the agent host.
- **Any decision the walkthrough leaves to them.**

## Handing work back and forth

- **Never infer state from silence.**
  - After you hand the operator a step, check its result yourself: the apply log, `tmux ls`, `macf fleet status`, `bootstrap status`.
  - Do not wait for them to report.
  - Before any claim or step that depends on whether the agents are running, check.
- **If the operator goes quiet:** check the state, carry on with every step that does not need them, and say so.
- **Before the first launch, tell the operator, once:** "Do not give the agents work until I report the fleet finished (§3.6 and §4 done)."
- **Keep a decision log** in `~/macf-fleets/<PROJECT>/run-log.md`.
  - **What goes in:** each operator decision, with time and wording.
  - **Read it back to them.**
  - **Scope changes:** a decision that widens scope goes into `fleet.yaml` and a re-run of `plan` when a field expresses it (`work_repos`).
  - **When no field expresses it:** tell the operator, log it, and do not make the change yourself.
  - **Rewinds:** if the operator rewinds or edits a message that held a decision, ask whether the decision still stands.

## Hard rules

- **Change only this fleet's own things:**
  - the names in §1.2 for this project;
  - `~/macf-fleets/<PROJECT>/`;
  - its workspaces;
  - `~/.macf/{keys,certs}/<OWNER>/<PROJECT>/`;
  - its age keys;
  - the private `macf` prefix;
  - its own cron script and watchdog line, through `macf fleet install-cron` only;
  - with an onboarding pack's HPC worker, the `AGENTS.md` in `<HPC_HOME_REPO>`, and nothing else in that repo.

  Everything else on these machines, or in `OWNER`, belongs to someone else. Before §3.1, confirm `<OWNER>/<PROJECT>-control` does not exist, unless `run-log.md` shows this run created it.
- **Never:**
  - delete or archive a repository or App;
  - run `fleet destroy` or `fleet deactivate`;
  - use `--force*` or set `MACF_BOOTSTRAP_VAULT_VERSION`;
  - hand-edit the vault, `fleet.lock` or a generated workspace file.
- **Routing for agent and work repos runs on the fleet's own self-hosted runners.** If anything suggests otherwise, stop and report it. The control repo routing on hosted runners is expected (§1.3).
- **Never** automate a browser page, a consent page or Claude Code's trust dialog.
- **Never** print tokens, private keys or `secrets.env` values. Public `age1…` keys are fine.
- **On macOS the login shell is zsh:** quote globs. Never run an interactive tool (`script`, `less`, an editor) just to read its usage.
- **What a mismatch is:** an exit code other than the walkthrough's, a line it says to expect that is missing, or an error, refusal or warning it does not mention. Any other output is not a mismatch: quote anything surprising in your log and carry on.
- **When there is a mismatch:**
  1. Stop and record the step, command, output and expectation.
  2. Apply the walkthrough's documented remedy once (§3.3's exit table and "To re-run", §7), or ask.
  3. Never invent a workaround.
- **Do not edit macf or the walkthrough, and do not file issues on `groundnuty/macf`.** Mismatches go in your report.

## Finished means

1. **§4's checks all read as expected,** quoted literally, then §4 rows 4 and 5 again for each work repo.
   - **The test issue:** you record a literal UTC `T` in `run-log.md`. The operator runs §4's `gh issue create` in their own terminal, with every name written out. You run the wait-and-grep with that literal `T`.
   - **The `[bot]` check:** on one host, or if the agent host keeps the operator's `gh` login, also check that the agents' comments show `[bot]` authors (the "Two roles" box at the top of §1).
2. **`fleet doctor --inject` and `routing doctor --e2e` read as §4 expects.**
3. **The watchdog is acting.** `fleet doctor` prints `Watchdog: installed (…, acting)`; `report-only` means `--execute` is missing. After one tick, the watchdog log (§3.6) lists every agent.
4. **You have told the operator: "The fleet is finished; you can give the agents work."**

Then write `~/macf-fleets/<PROJECT>/run-report.md` and show it to them. It contains:
- the preflight result;
- each walkthrough step: done, skipped (why) or failed;
- every mismatch, with what you did;
- the decision log;
- the final state: repos, Apps, sessions, watchdog, anything left undone.
