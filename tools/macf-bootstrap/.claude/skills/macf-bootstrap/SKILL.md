---
name: macf-bootstrap
description: Provision a whole MACF fleet's GitHub side (per-agent GitHub Apps + keys + installs, repos from the role template, routing secrets, per-project CA, and the age-encrypted vault) by driving the operator's own logged-in Chrome + gh AS the operator. Invoke to onboard a new MACF fleet (any project, any number of agents) — it does everything except the VM-side git clone / macf init, which it emits as a command list. Operator-privileged; run only in the dedicated macf-bootstrap workspace (DR-035).
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, mcp__chrome-devtools__navigate_page, mcp__chrome-devtools__new_page, mcp__chrome-devtools__list_pages, mcp__chrome-devtools__take_snapshot, mcp__chrome-devtools__take_screenshot, mcp__chrome-devtools__click, mcp__chrome-devtools__fill, mcp__chrome-devtools__evaluate_script
---

# macf-bootstrap — provision a MACF fleet's GitHub side

You are running in the **operator-privileged `macf-bootstrap` workspace** (DR-035).
You act **AS the operator's GitHub account** — the deliberate inverse of the fleet
attribution discipline — because creating GitHub Apps is a chicken-and-egg a
scoped bot App cannot do. Read `.claude/rules/macf-bootstrap-safety.md` first; the
two structural rails (Bash/gh deny + browser URL allowlist) and the plan-approve-once
gate are what make running with **no per-action prompts** safe.

> **Helper scripts** live at `$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-*.sh`.
> The deterministic work (manifest exchange, vault build/commit, command emit, env
> validation) is in those scripts — call them; don't re-implement them inline.

Follow this procedure **in order**.

> **⚠ PREREQ — `$CLAUDE_PROJECT_DIR` must be set.** Every helper below is invoked
> as `"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-*.sh"`. If `CLAUDE_PROJECT_DIR`
> is **unset** the path collapses to `/.claude/scripts/...` and the very first
> command dies with **exit 127** (first-run finding,
> `macf-automated-github-setup#1`). Claude Code normally exports it, but if you
> launched outside the harness (or `list_pages`/a hook reports it empty), export it
> first:
>
> ```bash
> export CLAUDE_PROJECT_DIR="$(pwd)"   # the macf-bootstrap workspace root
> ```

---

## Step 1 — Validate the environment (best-effort; stop loud on a critical gap)

```bash
"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-validate-env.sh"
```

This checks: `gh` authenticated as a **USER** token (NOT a `ghs_` bot — this
workspace must act as the operator); `age` + `age-keygen` present (the vault is
age-encrypted); `jq` present; both deny-rails present. A non-zero exit is a
CRITICAL gap — **stop and report it to the operator**; do not proceed. A Chrome
remote-debugging warning is best-effort (the MCP connection is verified when you
first drive the browser in Step 4) — note it but continue.

Also confirm the chrome-devtools MCP is connected by listing open pages:

- `mcp__chrome-devtools__list_pages` — if it errors, the MCP isn't attached.
  Tell the operator to start Chrome with `--remote-debugging-port=9222` and that
  `.mcp.json` points the MCP at `--browser-url=http://127.0.0.1:9222` (see README).

> **Getting a *logged-in* debug Chrome is non-obvious** (first-run finding,
> `macf-automated-github-setup#1`): a running Chrome **ignores**
> `--remote-debugging-port` (it's a singleton — a second launch just focuses the
> existing window), you can't enable the port on a live instance, and launching a
> fresh `--user-data-dir` gives a **logged-out** profile — defeating the whole
> "act as the already-logged-in operator" premise. The working path is to **copy
> the operator's logged-in Chrome profile** into an isolated `--user-data-dir` and
> launch the debug instance off the copy (real session untouched, copy logged-in).
> The exact rsync recipe is in **README.md → "Getting a logged-in debug Chrome"**.
> (`claude-in-chrome` is *not* a substitute — it drives Chrome outside the
> `check-bootstrap-url-allowlist.sh` rail.)

---

## Step 2 — Q&A intake (gather the project spec)

The skill is **generic** — any project, any N agents. Ask the operator
**interactively** for the spec it cannot infer. These are spec-gathering
questions, **not** per-action approvals:

1. **Project name** (e.g. `icsoc-2026`). Derive `<PROJECT_SEG>` = uppercased,
   hyphens→underscores (used for the `<PROJECT_SEG>_CA_CERT` variable + registry keys).
2. **For each agent** (repeat until the operator says done). **Per DR-032, TWO names are distinct — conflating them is the #1 provisioning trap (macf#791):**
   - **name = routing label** — the bare `<role>-agent`, e.g. `code-agent` (**CLEAN, no project prefix**). This one value is the agent's `macf init --name`, its `routing_label`, its cert **CN**, its registry-var segment, its tmux session, **and its `agent-config.json` key**. It must be `<role>-agent` and nothing else.
   - **GitHub App handle** — `<project>-<role>-agent`, e.g. `icsoc-2026-code-agent`. GitHub App names are globally unique, so **only the App** carries the `<project>-` prefix. Derive it as `<project>-<name>`; use it **only** for the App (Step 4b) and its key file. **Never feed it back as the agent `name`.**
   - GitHub repo (`owner/repo`) — created from the template
   - VM deploy path (where the operator will `git clone` + `macf init` + `macf repo-init` on the VM)

   > **⚠ Why this is load-bearing (verified 2026-07-05 — the icsoc routing outage, macf#791/#805/#806):** the previous form said the agent name *was* the App name (`icsoc-2026-code-agent`). That double-prefix silently breaks routing: the registry var becomes `<PROJECT_SEG>_AGENT_<PROJECT_SEG>_CODE_AGENT`, the tmux session doubles, and — the silent killer — `agent-config.json`'s key stops matching the issue's `<role>-agent` label, so `route-by-label` skips with `exit 0` ("not an agent label") and **nothing routes, with no error anywhere**. Keep `name` = bare `<role>-agent`. See DR-032 (+ its consumer-fleet-naming amendment) for the canonical rule.
3. **Registry** — scope (`profile` / `org` / `repo`) + target (the profile user,
   org name, or `owner/repo`).
4. **Advertise host** — the tailnet FQDN the channel servers advertise (e.g.
   `orzech-dev-agents.tail491af.ts.net`), or `127.0.0.1` for same-host-only.
5. **Science / coordination repo** — the repo the vault is committed into (the
   secure Mac→VM transport, DR-035 §6). Usually one of the agent repos.
6. **age recipient** (optional) — an existing `age1...` public key to encrypt the
   vault to. If none, the skill mints a fresh keypair and hands you the private
   key to scp to the VM.

Record the answers as a spec JSON shaped like
`templates/bootstrap-spec.example.json` (you fill in the `app_id`/`install_id`
fields as you create each App in Step 4). Write it to a working file, e.g.
`./.bootstrap-work/spec.json`.

---

## Step 3 — Plan-approve-once (blast-radius highlighted)

Compute the **full** provisioning plan from the spec and present it to the
operator **once**, with the blast-radius items called out. Get **one** approval.
After it, run end-to-end with **no further prompts except GitHub auth gates**.

Present a plan like:

```
macf-bootstrap plan for project <PROJECT>:

REPOS (create from groundnuty/agentic-repo-template, private):
  - <repo>  (role profile: <research|code|paper-latex>)   ×N

GITHUB APPS (per-agent: create via manifest flow + install):
  - <name>  → install on <repo> + <registry target>        ×N
  - macf-routing  → SHARED (one per registry/account, NOT per project): REUSE the
    existing one if present (it usually is, from a prior fleet); create only on the
    first-ever fleet. (variables:read only; already installed on <registry target>)

SECRETS / VARIABLES (create-only; never overwrite):
  - per repo: MACF_ROUTING_APP_ID/KEY, ROUTING_CLIENT_CERT/KEY,
    TS_OAUTH_CLIENT_ID/SECRET                              ⚠ touches repo secrets
  - <PROJECT_SEG>_CA_CERT variable on <registry target>    ⚠ touches org/profile settings

CA:  generate the per-project CA Mac-side (macf certs init) → CA key into the vault.

VAULT:  age-encrypt every cred → commit secrets/vault.age to <science repo>
        ⚠ commits to your science repo (a normal push, never --force; fail-if-exists)

⚠ BLAST RADIUS: this acts AS YOUR GitHub account, creates N Apps + N repos,
  sets the secrets above, and pushes a commit to <science repo>. Destructive ops
  are fenced (deny rails). Approve to run end-to-end (auth gates will still pause).
```

Wait for the explicit approval before Step 4.

---

## Step 4 — Execute (gh-first hybrid; browser ONLY for App creation + auth gates)

Run autonomously after the plan approval. The **only** interactive pauses are
GitHub auth gates (OAuth consent / sudo-mode re-auth / 2FA) — these recur every
few hours; **pause → let the operator satisfy the gate → resume** is a first-class,
expected loop, not an error. Don't try to type the operator's password/2FA.

### 4a. Create the repos from the role template (`gh`, no browser)

For each agent:

```bash
gh repo create <owner>/<repo> --template groundnuty/agentic-repo-template --private
```

Note: the **role profile** (`research`/`code`/`paper-latex`) is applied VM-side
by the template's `./.claude/init.sh <profile>` (it needs `jq` + the profile's
prerequisites on the VM) — the emitted command list (Step 5) reminds the operator,
since profile-apply runs in the cloned workspace, not here. (Confirm the template
repo name/slug with the operator if `agentic-repo-template` 404s.)

### 4b. Create each App via the manifest flow (browser — chrome-devtools MCP)

This is the **one genuinely GUI-only step** (no `gh app create` exists). Repeat
for every agent App. The manifest to submit is
`$CLAUDE_PROJECT_DIR/templates/macf-app-manifest.json` (the DR-019 permission set).

> **`macf-routing` is SHARED — reuse, don't create.** It's one routing App per
> registry/account (the channel servers' registry reader), NOT per project, so the
> operator almost always already has it from a prior fleet. App names are GLOBALLY
> unique, so a duplicate `macf-routing` create silently *fails* — GitHub bounces to
> `/settings/apps` with **no `?code=`** (looks like a successful click). Detect it
> FIRST with `gh api /apps/<slug>` — which DOES work, contrary to this doc's
> earlier claim that it "404s for every private App" (measured 2026-08-13,
> both auth types, both directions — macf#910):
>
> | auth | App EXISTS | App ABSENT |
> |---|---|---|
> | operator `gh` login | `200` + slug | `404` |
> | bot installation token | `403` "Resource not accessible by integration" | `404` |
>
> **An existing App never 404s.** So read it strictly: **only a `404` means the
> name is free**; a `403` is the positive signal that the name is TAKEN (easy to
> skim past as permission noise) and anything else is taken-or-unknown — never
> treat a non-404 as free. For certainty independent of auth context, mint a JWT
> against the known `app_id` (`confirmAppInstallation`, macf#841) or read
> `https://github.com/settings/apps`. If it
> exists, reuse its `app_id` + existing private key (the operator supplies the key)
> and just confirm it's installed on the registry target. Only run the manifest flow
> for `macf-routing` on a brand-new account that has never hosted a MACF fleet.

The GitHub create-from-manifest flow + how to capture the redirect `code`:

1. **Build the manifest parameter** — read the manifest template, set its `name`
   (e.g. the agent name), and a `redirect_url` you can read back (the value is not
   load-bearing — you read the redirect URL off the page, no callback server). The
   manifest is submitted as a form POST; the simplest robust approach is a tiny
   self-submitting HTML form posted to the manifest-create endpoint:
   - **Personal account:** `https://github.com/settings/apps/new`
   - **Org:** `https://github.com/organizations/<org>/settings/apps/new`

2. **Navigate + submit** (chrome-devtools MCP):
   - `mcp__chrome-devtools__navigate_page` with `url` = the manifest-create page
     (the URL allowlist permits `…/settings/apps/new`). To pass the manifest, you
     can `mcp__chrome-devtools__evaluate_script` a function that injects a
     `<form method="post" action="…/settings/apps/new">` with a hidden
     `manifest` input set to the JSON string, then submits it. (GitHub renders the
     pre-filled "Create GitHub App" confirmation page.)
   - `mcp__chrome-devtools__take_snapshot` to find the **"Create GitHub App"**
     button's `uid`, then `mcp__chrome-devtools__click` it.

3. **Capture the redirect `code`** — after Create, GitHub redirects to the
   manifest `redirect_url` carrying `?code=<temp>`. Read the **current page URL**
   directly (no callback server):
   - `mcp__chrome-devtools__evaluate_script` with
     `function = "() => window.location.href"` → parse the `code` query param; **or**
   - `mcp__chrome-devtools__list_pages` → read the active page's `url` field.

4. **Redeem the code** for the App's creds (this also returns the **private key**
   — no manual download):

   ```bash
   "$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-exchange-manifest.sh" <code> \
     --out ./.bootstrap-work/<name>.app.json
   ```

   The JSON has `app_id, name, slug, client_id, client_secret, webhook_secret,
   pem`. Record `app_id` into the spec; keep the `*.app.json` for the vault.

If an auth/sudo/2FA gate appears (`/login`, `/sessions/two-factor`, `/sudo`),
**pause and ask the operator to complete it**, then continue.

### 4c. Install each App on its repos + registry (browser — the install flow)

After exchange, install each App on its agent repo(s) **and** on the registry
target (so the agent can self-register its host:port into the registry variables).

> **The INITIAL install is browser-only — there is NO REST API to create it.**
> (`PUT /user/installations/{id}/repositories/{id}` only *adds repos to an existing
> installation*; it cannot do the first install, and the user-token install
> endpoints need a `read:user` scope the bootstrap token lacks → 403.) So drive the
> install flow with the chrome-devtools MCP: navigate to
> `https://github.com/settings/apps/<slug>/installations` (allowlisted) → **Install**
> → on the permissions page choose **"Only select repositories"** → add the agent
> repo **and** the registry target → **Install**. GitHub redirects to
> `…/settings/installations/<install_id>` — read `install_id` from that URL into the
> spec. (The repo picker filters async; set its value via a React-style `input`
> event, then click the filtered item.) Verify each install with the App's own JWT:
> mint an installation token and `GET /installation/repositories`.

### 4d. Set routing secrets + CA var + org settings (`gh secret/variable set`)

Set the 6 routing secrets **per agent repo**. Their VALUE FORMATS (per the
`macf-actions/agent-router.yml` consumer) matter — wrong format fails routing
*silently*:

| secret | value |
|---|---|
| `MACF_ROUTING_APP_ID` | the `macf-routing` App id (raw) |
| `MACF_ROUTING_APP_KEY` | **raw PEM** of the macf-routing key (fed to `actions/create-github-app-token`) |
| `ROUTING_CLIENT_CERT` | **base64** of `routing-action-cert.pem` |
| `ROUTING_CLIENT_KEY` | **base64** of `routing-action-key.pem` |
| `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` | operator-supplied Tailscale OAuth (raw) |

Watch the asymmetry: the **vault** stores the app key + client cert/key base64'd
(the `*_B64` vars), but the **repo secret** `MACF_ROUTING_APP_KEY` is **raw PEM** —
only the two `ROUTING_CLIENT_*` repo secrets are base64. The gh guard
enforces **create-only** — an existing name is blocked (overwrite ≠ delete); an
intended overwrite is opt-in via `MACF_BOOTSTRAP_ALLOW_OVERWRITE=1`.

**⚠ The CA cert goes in TWO places — both required (macf#806).** `macf certs init`
(Step 4e) uploads `<PROJECT_SEG>_CA_CERT` to the **registry target** (CA backup +
discovery). But the v3 router reads the CA it trusts for the mTLS `route-by-label`
POST from a **repo variable on each agent's OWN repo** (`vars[<PROJECT_SEG>_CA_CERT]`),
NOT from the registry. So after Step 4e, ALSO set `<PROJECT_SEG>_CA_CERT` as a **repo
variable on every agent repo** — it is a public cert, so a variable, NOT a secret:

    gh variable set <PROJECT_SEG>_CA_CERT --repo <owner>/<agent-repo> < <ca-cert.pem>

Skipping this is invisible until an issue is routed: `route-by-label` then fails
`CA-cert var empty — check <PROJECT>_CA_CERT is set` (hard exit 1) or silently
no-delivers. This was the second half of the icsoc-2026 outage. (The durable fix —
the router reading the CA from the registry so no per-repo copy is needed — is
macf-actions#66; until it lands, the repo var is required on every agent repo.)

### 4e. Generate the per-project CA + routing-client cert (Mac-side)

`macf certs init` / `issue-routing-client` auto-discover the project from a wired
`macf-agent.json` — which a fresh bootstrap does NOT have on the Mac. So first write
a **minimal CA workspace** at `./.bootstrap-work/ca-workspace/.macf/macf-agent.json`
pointing `macf` at one already-created agent App (for the registry-write token). The
field names match the `MacfAgentConfigSchema` (`agent_name`/`agent_role`, NOT
`name`/`role`); include a `versions` stub so the CLI doesn't warn "legacy config":

```jsonc
{
  "project": "<project>",
  "agent_name": "<any agent name>", "agent_role": "<its role>",
  "agent_type": "permanent",
  "registry": { "type": "profile", "user": "<user>" },   // must match the spec's registry
  "github_app": { "app_id": "<an agent app_id>", "install_id": "<its install_id>",
                  "key_path": "<that agent's .pem, beside this file>" },
  "advertise_host": "<advertise_host>",
  "versions": { "cli": "*", "plugin": "*", "actions": "*" }  // stub: silences the legacy-config warning
}
```

(For an `org` registry use `{ "type": "org", "org": "<org>" }`; for `repo`,
`{ "type": "repo", "owner": "<owner>", "repo": "<repo>" }` — see the CLI's
`RegistryConfigSchema`.) Then, with `--dir` at that workspace:

```bash
# CA: writes ~/.macf/certs/<project>/ca-{cert,key}.pem + uploads <PROJECT_SEG>_CA_CERT.
# certs init prompts for a passphrase to back the key up to the registry (encrypted);
# pipe empty to SKIP it — the vault is the durable CA-key store (DR-035). NOTE: skipping
# the encrypted registry backup means `macf certs recover` won't work for this project.
echo "" | macf certs init --dir ./.bootstrap-work/ca-workspace

# Routing client cert -> ROUTING_CLIENT_CERT/KEY (Step 4d). --out-dir writes the PEMs;
# stdout ALSO prints the key, so redirect stdout to /dev/null to keep it off-transcript.
macf certs issue-routing-client --dir ./.bootstrap-work/ca-workspace \
  --out-dir ./.bootstrap-work/routing-client >/dev/null
```

Put the **CA key + cert** (base64) into the vault (Step 4f); the CA cert variable
upload is part of `macf certs init` — verify it landed (`gh variable list`). Do NOT
run `macf certs init` on the VM later (it would mint a new CA + clobber the
variable) — `vault.sh` materializes the CA there and agents `macf certs rotate`.

### 4f. Build + commit the vault

Assemble the plaintext per `templates/vault.template.txt` from every
`./.bootstrap-work/<name>.app.json`, the `macf-routing` creds, the 6 routing
secrets, and the CA key (base64-encode PEMs/certs/keys), and **PIPE it straight
into `bootstrap-build-vault.sh` on STDIN — do NOT write a `vault.plain` file.**
The script streams STDIN into `age`, so the plaintext is never materialized on
disk (secure-by-construction). The per-agent `*.app.json` files are the only
plaintext that touches disk in this flow; they are `.gitignore`d and wiped by
`bootstrap-cleanup.sh` (Step 7).

```bash
# Assemble the vault plaintext and PIPE it to build-vault on STDIN (no vault.plain).
# This brace-group is illustrative — fill in INSTALL_ID (from spec.json), the
# macf-routing creds, the 6 routing secrets, and the base64 CA key/cert the same
# way, matching templates/vault.template.txt.
{
  for f in ./.bootstrap-work/*.app.json; do
    name="$(jq -r .name "$f" | tr 'a-z-' 'A-Z_')"
    printf 'MACF_AGENT_%s_APP_ID="%s"\n'          "$name" "$(jq -r .app_id "$f")"
    printf 'MACF_AGENT_%s_CLIENT_ID="%s"\n'       "$name" "$(jq -r .client_id "$f")"
    printf 'MACF_AGENT_%s_CLIENT_SECRET="%s"\n'   "$name" "$(jq -r .client_secret "$f")"
    printf 'MACF_AGENT_%s_WEBHOOK_SECRET="%s"\n'  "$name" "$(jq -r .webhook_secret "$f")"
    printf 'MACF_AGENT_%s_PRIVATE_KEY_B64="%s"\n' "$name" "$(jq -r .pem "$f" | base64 | tr -d '\n')"
  done
  # + MACF_AGENT_<name>_INSTALL_ID per agent (from spec.json)
  # + MACF_ROUTING_APP_ID / MACF_ROUTING_APP_KEY_B64
  # + the 6 routing secrets + MACF_<PROJECT>_CA_KEY_B64 / _CA_CERT_B64
} | "$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-build-vault.sh" \
      --out ./.bootstrap-work/vault.age \
      --key-out ./.bootstrap-work/vault-age-key.txt   # omit --recipient → fresh keypair

# Commit into the science repo (fail-if-exists; never --force; wipes the /tmp clone):
"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-commit-vault.sh" \
  --repo <science-repo> \
  --vault ./.bootstrap-work/vault.age \
  --accessor "$CLAUDE_PROJECT_DIR/templates/vault.sh" \
  --template "$CLAUDE_PROJECT_DIR/templates/vault.template.txt"
```

The age private-key handoff + scratch-dir wipe are Steps 6 and 7 (after the
outputs are emitted) — the key must survive until the operator confirms the scp,
then it is shredded.

---

## Step 5 — Emit the outputs (definition-of-done)

```bash
"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-emit-commands.sh" \
  --spec ./.bootstrap-work/spec.json
```

This prints **output #2** (the VM-side per-agent setup — `git clone` + `macf init`
+ `macf certs rotate` + **`macf repo-init`** (the routing plane) + the
**`<PROJECT_SEG>_CA_CERT` repo-variable set**, IDs substituted) and **output #3**
(the verification commands: `macf fleet status` / `macf routing doctor` /
`macf fleet doctor --inject`, plus setup asserts that the Apps exist + are
installed and the secrets are present). Output #1 (the vault) was committed in
Step 4f.

> **The routing plane MUST be `macf repo-init`, not hand-authored (macf#797/#805/#806).**
> The bootstrap-generated `agent-router.yml` + `agent-config.json` were the source
> of every consumer-fleet routing outage this class produced, so the emit runs
> `macf repo-init --project <P> --agents <FULL-FLEET> --actions-version v3 …` in
> each repo, generating them **born-correct**:
>
> - **router** — the full `permissions:` block (missing it = `startup_failure`,
>   nothing routes) + an **immutable `@vX.Y.Z` pin** (repo-init resolves `v3` to
>   the latest full tag; no silent behavioral drift) — macf#797/#804.
> - **`agent-config.json`** — the **whole fleet** (every agent, so
>   `route-by-mention` / `route-by-pr-review-state` resolve any of them, not just
>   the local agent), **keyed by the routing label** (`code-agent`), each entry's
>   **`app_name` = the App handle `<project>-<role>-agent`** (e.g.
>   `icsoc-2026-code-agent`) **without** a `[bot]` suffix (the router appends it; a
>   baked-in `[bot]` double-bots and breaks resolution) — macf#805/#806.
> - **CA repo-var** — the v3 router reads the CA it trusts for the mTLS POST from
>   `vars[<PROJECT_SEG>_CA_CERT]` on the caller repo, NOT the registry, so the emit
>   sets it per agent repo from the vault-materialized CA cert — macf#806.
>
> `--agents` is the **full comma-joined fleet** passed to repo-init in EVERY repo,
> so every repo's config lists the whole fleet.

Hand the operator: (a) the emitted command list, (b) the age key path to scp
(handed off + shredded in Step 6), and (c) a one-line summary (N Apps created, N
repos, vault committed to <science repo>).

---

## Step 6 — Hand off the age private key, then shred it

The vault rides to the VM via `git` (encrypted — safe in a private repo); its
**age decryption key goes out-of-band**. Do NOT leave the key in the scratch dir.

1. Surface the key path to the operator and ask them to copy it to the VM:

   ```
   age decryption key:  ./.bootstrap-work/vault-age-key.txt
   scp it to the VM out-of-band, e.g.:
     scp ./.bootstrap-work/vault-age-key.txt <vm>:~/.macf/<project>-vault-age-key.txt
   Tell me once the key is on the VM and I'll shred it from this workspace.
   ```

2. **Wait for the operator to confirm the handoff.** This is one of the few
   expected interactive pauses (like the auth gates) — not a per-action approval.

3. Once confirmed, the key is removed by the Step 7 scratch-dir wipe (it lives in
   `./.bootstrap-work/`). Run Step 7 now — that shreds the key along with the rest.

---

## Step 7 — Always wipe the scratch dir (success AND abort)

```bash
"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-cleanup.sh"
```

This shred-removes the **entire** `./.bootstrap-work/` — every `*.app.json` PEM,
any `vault.plain`, `vault.age`, the `vault-age-key.txt`, and `spec.json`. It is
idempotent and safe to call repeatedly.

**Run it ALWAYS** — on the success path (after the Step 6 key handoff is
confirmed) AND on any abort/error. If you orchestrate the run inside a single
long Bash block, register it as an EXIT trap up front so an interrupt still
cleans up:

```bash
trap '"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-cleanup.sh"' EXIT
```

> **Accurate at-rest note (do not overclaim).** `shred` is best-effort and a
> **no-op on macOS/APFS** (copy-on-write never overwrites in place). The real
> at-rest protection on the operator's Mac is **FileVault**. What this tool
> guarantees structurally is: the plaintext vault is never written to disk (Step
> 4f pipes it on STDIN), nothing secret is ever committed (`.gitignore`), and the
> scratch dir is wiped on both success and abort (this step). Those are the
> load-bearing protections — not shred.

---

## Optional — rail self-test (prove the URL guard actually fires)

When the operator asks for **live proof** that the browser rail blocks destructive
navigation (or before a first run on a new machine), run the one-shot self-test. It
feeds the `check-bootstrap-url-allowlist.sh` hook synthetic PreToolUse payloads and
asserts it **BLOCKS (exit 2)** a denylisted URL and **ALLOWS (exit 0)** a
provisioning URL — positive evidence the guard works, **without** weakening it and
**without** driving the real browser:

```bash
"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-rail-selftest.sh"
# → ✓ BLOCKED  /settings/apps/<slug>/advanced (revoke/delete/transfer)
# → ✓ BLOCKED  …/billing
# → ✓ ALLOWED  …/settings/apps/new (manifest create)
# exit 0 = rail healthy; non-zero = a case behaved wrong (STOP — the rail is broken).
```

**Live variant** (the strongest proof, when a debug Chrome is attached): attempt to
navigate the MCP to a denylisted page — the PreToolUse hook intercepts the
`mcp__chrome-devtools__navigate_page` call and blocks it before Chrome moves:

```text
mcp__chrome-devtools__navigate_page url=https://github.com/<owner>/<repo>/settings#danger-zone
→ BLOCKED by macf-bootstrap URL guard: destructive GitHub surface.
```

Either way you get a concrete BLOCKED line in the transcript. Do **not** set
`MACF_BOOTSTRAP_SKIP_URL_GUARD=1` during the self-test — that would bypass the very
rail you're proving.

## Gotcha — `ssh -n` silently discards a heredoc

If you (or the operator) hand-write a remote VM step that pipes a heredoc into ssh
— e.g. running the emitted command list remotely — **do NOT use `ssh -n`**. The
`-n` flag redirects stdin from `/dev/null`, so the heredoc body is **silently
discarded**: the remote `bash -s` reads EOF immediately, runs nothing, and ssh
exits **0** (a clean-looking no-op — a first-run-class silent failure). Canonical
form omits `-n`:

```bash
# WRONG — -n discards the heredoc; remote runs nothing, exits 0 (looks fine):
ssh -n <vm> 'bash -s' <<'REMOTE'
  source ~/secrets/vault.sh
REMOTE

# RIGHT — no -n; the heredoc reaches the remote shell's stdin:
ssh <vm> 'bash -s' <<'REMOTE'
  source ~/secrets/vault.sh
REMOTE
```

---

## Reminders

- **No per-command approval.** `Bash(*)` is pre-approved; the only interactive
  points are the single plan approval (Step 3), the GitHub auth gates (Step 4),
  and the age-key handoff confirmation (Step 6). The deny-rails — not prompts —
  fence the destructive surface. Do not ask the operator to approve individual
  `gh`/MCP calls.
- **Never** run a destructive GitHub op (delete/transfer/rename repo, delete
  secret, `gh api … DELETE`, force-push) — the rails block them; don't try to
  route around them. An intended exception is the operator's call via the documented
  override env var.
- **No plaintext vault on disk by construction.** The assembled plaintext is
  piped to `bootstrap-build-vault.sh` on STDIN — never written as `vault.plain`.
  The per-agent `*.app.json` PEMs are the only plaintext on disk; they are
  `.gitignore`d and wiped by `bootstrap-cleanup.sh` (Step 7), which runs on
  success AND abort. `shred` is best-effort (no-op on macOS/APFS); FileVault is
  the real at-rest protection.
