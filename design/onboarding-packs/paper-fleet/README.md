# Onboarding pack: a paper fleet

These are blocks for each agent's `AGENTS.md` in a MACF fleet that writes a research paper:
- a science agent, a code agent and a writing agent;
- optionally, an HPC worker for compute.

Every agent starts with its role and the fleet's working style instead of being onboarded by hand.

**The deploy agent fills and assembles the pack** at runbook §3.4a, by interviewing the operator. The operator edits no file.

## 1. Fetch

    mkdir -p ~/macf-fleets/<PROJECT>/onboarding && cd ~/macf-fleets/<PROJECT>/onboarding
    for f in README project working-style science-agent code-agent writing-agent hpc-agent; do
      curl -fsS -o $f.md https://raw.githubusercontent.com/groundnuty/macf/main/design/onboarding-packs/paper-fleet/$f.md
    done

## 2. Interview the operator

**How to ask:**
- Never ask the operator to edit a file.
- Ask a few questions at a time, and offer the options where the answer is a choice.
- Take what the deploy inputs already give, such as the operator's login and the work repos, instead of asking again.

**What to ask:**
1. **The paper:**
   - its title and the venue;
   - one paragraph on what it is: the question, the claimed contribution, and what the experiments must show;
   - what "done" means.
2. **Dates and size:**
   - the deadlines, with time zones;
   - the page budget: main pages, references, appendix, maximum.
3. **Sources:**
   - where the proposal and its review rounds are;
   - the paper's Overleaf git URL;
   - earlier repos with reusable model-calling or harness code, or none.
4. **Compute:** the clusters and storage the fleet may use, or none. If there are some, ask whether there is an HPC worker and what its home repo is.
5. **Model API keys:** the paths of the key files. Never ask for, accept or write a key's value.
6. **The pack's choices** (see "Choices this pack makes" below): read them out and ask which to keep. Edit the blocks for any the operator changes.

**Then confirm before committing:** show the filled `project.md` and each agent's assembled `AGENTS.md`, and ask the operator to confirm or correct them.

## 3. Assemble each agent's `AGENTS.md` (runbook §3.4a)
1. **Science, code and writing:** concatenate, in this order, `project.md`, `working-style.md`, then `<role>.md`.
2. **Compute is opt-in.** Pick the project's case:
   - **No compute** (`<COMPUTE>` is "none"): delete the `<HPC_WORKER_ONLY…>` line from the code agent's text. Use no part of `hpc-agent.md`.
   - **Compute, no HPC worker:**
     - delete that line;
     - append `hpc-agent.md` to the code agent's `AGENTS.md`, from its `## Governing compute` heading to the end;
     - leave out the worker-only lines above that heading: the title, the opening paragraph and the `## You and the code agent` section.
   - **Compute and an HPC worker:** keep that line, minus its marker.
     - The worker's `AGENTS.md` is `project.md`, then only the `## Context and subagents` section of `working-style.md`, then all of `hpc-agent.md`.
     - The rest of `working-style.md` covers GitHub, A2A and merging, which the worker never does.
3. **The HPC worker is not a MACF agent.**
   - **What it gets:** a GitHub home repo (`<HPC_HOME_REPO>`) for its `AGENTS.md`.
   - **What it does not get:** no App, registry entry or routing.
   - **Where it runs:** on the code agent's host, so their sessions can message each other.
   - **Keep MACF's hooks out of its workspace** (no `macf init`, no `macf rules refresh`): the token hook blocks any `git push` made without a bot token.
4. **Where the text goes:** if the agent repo's `AGENTS.md` has a `<!-- BEGIN template-managed … -->` region, put the text below its `<!-- END template-managed -->` line, never inside it. Otherwise put it at the top.
5. **Fill every placeholder** from the interview, then check that none is left: `grep -nE '<[A-Z][A-Z_]+' AGENTS.md`. Leave the lowercase slots in the merge command (`<owner>`, `<repo>`, `<n>`, `<head-sha>`, `<message-file>`, `<verdict>`): agents fill those at run time.
6. **Commit and push** as §3.4a shows, before deploying.

## Placeholders
| placeholder | file | what goes there |
|---|---|---|
| `<PAPER_TITLE>`, `<VENUE>` | project | the title and the target venue |
| `<PAPER_SUMMARY>`, `<DONE>` | project | one paragraph each: what the paper is; what "done" means |
| `<DEADLINES>`, `<PAGE_BUDGET>` | project | the dates with time zones; main pages, references, appendix, maximum |
| `<OPERATOR_LOGIN>` | project, working-style | the operator's GitHub login (working-style names it in the merge sanction, without an `@`) |
| `<PROPOSAL_AND_REVIEWS_PATH>` | project, science | where the proposal and its review rounds live (the science agent reads it first) |
| `<WORK_REPO>` | project, science, code | the repo for code, results and logs |
| `<OVERLEAF_GIT_URL>` | project, writing | the Overleaf project's git URL |
| `<COMPUTE>` | project, hpc | the clusters and storage the fleet may use, or "none" |
| `<MODEL_KEYS>` | project | the key file paths, never the values |
| `<REUSE_REPOS>` | code | earlier repos with working model-calling or harness code; with none, delete the line |
| `<HPC_WORKER_ONLY…>` | code | a marker, not a slot: with an HPC worker, delete the marker; otherwise delete its whole line |
| `<HPC_HOME_REPO>` | hpc | the HPC worker's GitHub home repo |

## Choices this pack makes
The operator can change any of these in the interview.
1. **Agents merge their own PRs**, through the API, after a clean Gemini Argon and Codex Astra cross-review, with no peer or operator approval.
   - A code PR for an issue the science agent filed also needs science's confirmation.
   - Two things on the fleet's repos would refuse this: branch protection that requires a review, and a permission check that blocks API merges. The repos need neither.
2. **The squash message quotes a standing sanction in the operator's name:** "Standing sanction from <OPERATOR_LOGIN>: …".
3. **Whoever governs compute does it without asking the operator:** the HPC worker, or the code agent when there is none.
4. **The science and writing agents never contact each other.** The operator relays results.
5. **Cross-review models:** Codex Astra and Gemini Argon, never Opus. The writing agent uses Codex Astra for style.
6. **The HPC worker gets only the subagent rules of `working-style.md`.**

## Not yet in MACF
groundnuty/macf#1545 tracks two things that are assembled by hand above today:
- a lightweight worker member kind;
- `fleet.yaml`-configured role and capability blocks.
