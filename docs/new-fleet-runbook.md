# Runbook: provisioning a new fleet with `macf bootstrap`

**Status:** current as of `ce61014` (2026-08-13). Every command below was verified to exist on `main` at that commit; where a step is *not yet automated* this runbook says so explicitly rather than implying it works.

This is the operator-facing path for standing up a brand-new project's fleet. It assumes you are on the **Mac** (see *Why Mac-side* below).

---

## 0. What you need before starting

| Prerequisite | Why | Check |
|---|---|---|
| `gh` authenticated as the operator | the two consent gates and repo creation act as **you**, not as a bot | `gh api user -q .login` |
| An **age** keypair you own | DR-043 Amendment C: the fleet's master key is **operator-provided**, never tool-minted | `age-keygen -y <your key>` prints an `age1…` recipient |
| `node`, `age` on PATH | the CLI shells out to `age` for the vault | `node -v && age --version` |
| Org (or account) admin | creating repos + org variables | — |

> **The age key is not optional and cannot be generated for you.** `age_recipients: []` makes `apply` **refuse before consent gate 1** — deliberately, so provisioning can never produce credentials that nobody can decrypt.

---

## 1. Write `fleet.yaml`

Keep it local for the first run; `apply` commits it into the control repo it creates (see §3).

```yaml
apiVersion: macf/v0
kind: Fleet
metadata:
  name: my-project              # THE fleet name. Everything else derives from it.
owner:
  account: my-org
  type: org                     # user | org
  registry: { type: org, org: my-org }
network:
  advertise_host: <tailnet-host>
transport:
  age_recipients:
    - age1...                   # your PUBLIC half. Add the VM's key here too
                                # once the agents run there (see §7).
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: science-agent         # THE name: routing label, cert CN, registry
    profile: research           # segment, tmux session. App handle is DERIVED.
    repo: my-org/my-project-science-agent
    deploy_path: /home/ubuntu/repos/my-project-science-agent
routing:
  runner:
    runs_on: self-hosted
versions:
  macf: 0.2.56                  # desired; steered per §D6
  actions: v3.4.1
```

**Notes that save a re-run:**

- **`transport.vault_repo` no longer exists** (Amendment F). The vault lives in the control repo, derived — there is no knob, deliberately.
- **App names are globally unique across GitHub.** `<fleet>-<role>` must not already exist. Check first:
  `gh api /apps/my-project-science-agent` → a `404` means the name is free.
- Start with **one agent**. Add more in later runs; each additional agent costs two clicks.

---

## 2. Plan first — always

```bash
node packages/macf/dist/cli/index.js bootstrap plan -f ./fleet.yaml
```

Read the plan properly. Two things specifically:

- **`⚠ apply cannot action N item(s)`** — these are real gaps, not noise. The plan says plainly what approving it will *not* do (macf#854).
- **`LOW CONFIDENCE` / `unknown`** rows are honest, not broken: the identity plane needs an App JWT to confirm anything, and the API can confirm `present` but never prove `absent` (Amendment A).

---

## 3. Apply

```bash
node packages/macf/dist/cli/index.js bootstrap apply -f ./fleet.yaml
```

Order of operations, and where you come in:

1. **Control repo `<fleet>-control` created** — first mutating action, before any consent gate, so a failure costs nothing. Your `fleet.yaml` is committed into it; that copy is the GitOps record from then on.
2. **Agent repo created** — *before* gate 2, so the install page can actually list it.
3. **Consent gate 1 — you click "Create GitHub App".** The URL is printed before the browser opens; if the browser doesn't appear, open the printed URL yourself.
4. Credentials are written to an encrypted **recovery artifact before gate 2** (Amendment B) — so a crash between the gates can't lose an App you can never re-create.
5. **Consent gate 2 — you click "Install"**, selecting the agent repo (it exists by now).
6. CA minted or reused → `<SEG>_CA_CERT` written to **both** the registry and each agent repo.
7. `MACF_ROUTING_RUNS_ON` written to caller repos.
8. Vault + `fleet.lock` written to the control repo and pushed.

**Two clicks per agent. That floor is irreducible** — GitHub has no API for App creation or first install.

---

## 4. Verify

```bash
gh api /apps/<fleet>-<role> -q .id                        # App exists
gh api repos/<org>/<fleet>-control/contents/secrets --jq '.[].name'   # expect: vault.age ONLY
gh api repos/<org>/<agent-repo>/actions/variables --jq '.variables[].name'
```

`secrets/` must contain **only** `vault.age`. Recovery artifacts are local-only by design and `.gitignore`d — if you see one committed, that's a bug.

---

## 5. Managing the fleet afterwards

| Command | Does | Revival cost |
|---|---|---|
| `macf fleet status` | live health/version table | — |
| `macf fleet upgrade` | rolls agents (**dry-run by default**; `--execute` to act) | — |
| `macf fleet deactivate` | removes org-scope registry presence | `apply` — **0 clicks** |
| `macf fleet archive` | + archives the repos | unarchive + `apply` — **0 clicks** |
| `macf fleet delete-apps` | + removes App identities | **2 clicks/agent**; frees the names |
| `macf fleet destroy` | + deletes repos | full re-provision; irreversible |

**Why archive→revive is free:** the App private keys live in `vault.age`, so the Apps *and their installations* survive. Revival is pure reconciliation.

`destroy` requires **all three** of `--destroy-repositories`, typing the fleet name, and `MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES=1`. That friction is intentional.

---

## 6. Changing versions (§D6)

Edit `versions.macf` in `fleet.yaml`, then `bootstrap plan` shows the drift and names the remedy:

- **macf drift** → `macf fleet upgrade`
- **actions drift** → `macf repo-init --actions-version <pin> --force` (**not** `fleet upgrade` — it never touches a caller workflow)

> ⚠️ **Known gap (macf#907):** nothing writes `deployed_version` to `fleet.lock` yet, so the *macf* half reads `unknown` on a real fleet until `fleet upgrade` stamps it on a confirmed verify-green. The **actions** half is live today. This is called out rather than papered over — a version recorded at provisioning time would be intent masquerading as confirmation.

---

## 7. Deploying agents VM-side

`bootstrap apply` provisions the **GitHub side only**. To actually run an agent you materialize its credentials from the vault on the host that will run it — which requires an identity that can decrypt.

**Add the VM's public key to `age_recipients` and re-run apply** so the vault is encrypted to both you and the VM. Until then the vault is decryptable only on the machine holding the operator key, and the VM cannot self-materialize.

---

## Why Mac-side

Consent gate 1 redirects to `http://localhost:<port>/callback`. That listener must be on the machine whose browser you click in. Running `apply` on a remote VM means the redirect lands somewhere your browser can't reach.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `apply` refuses before gate 1 | `age_recipients` empty | supply your public key (Amendment C) |
| Gate page never opens | `open` misfired | use the printed URL — it's printed before the browser call |
| Install page can't list the repo | repo missing | fixed in #862; the repo is created before gate 2 |
| App name collision at gate 1 | name globally taken | pick another role, or `fleet delete-apps` the old fleet to free it |
| `apply` refuses the control repo as `foreign` | name mismatch or someone else's repo | check `metadata.name` in its `fleet.yaml` |
| Archived fleet won't revive | — | expected to work: `ours-archived` is revivable; un-archive is surfaced as a confirm-required plan item |
| Org variable write 422 | missing `visibility` | fixed in #868 |

---

## Design contracts worth knowing (DR-043)

- **A** — identity confirmation needs an App JWT; honest-`unknown` beats false-`present`
- **B** — a received credential reaches durable storage *before* any further gated step
- **C** — the age key is operator-provided; empty recipients = refuse
- **D** — the vault is read-only-decryptable and whole-payload-writable, never read-modify-written
- **E** — deployed-secret drift via in-Actions attestation
- **F** — per-fleet control repo; committed content is sealed-or-public only
- **G** — the teardown ladder, measured by revival cost
