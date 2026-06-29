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

---

## Step 2 — Q&A intake (gather the project spec)

The skill is **generic** — any project, any N agents. Ask the operator
**interactively** for the spec it cannot infer. These are spec-gathering
questions, **not** per-action approvals:

1. **Project name** (e.g. `icsoc-2026`). Derive `<PROJECT_SEG>` = uppercased,
   hyphens→underscores (used for the `<PROJECT_SEG>_CA_CERT` variable + registry keys).
2. **For each agent** (repeat until the operator says done):
   - role/routing label (`science-agent`, `code-agent`, `writer-agent`, …)
   - agent name (the App name + attribution identity, e.g. `icsoc-2026-code-agent`)
   - GitHub repo (`owner/repo`) — created from the template
   - VM deploy path (where the operator will `git clone` + `macf init` on the VM)
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

GITHUB APPS (create via manifest flow + install):
  - <name>  → install on <repo> + <registry target>        ×N
  - macf-routing  → install on <registry target> (Org variables: Read only)

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
for every agent App **and** the `macf-routing` App. The manifest to submit is
`$CLAUDE_PROJECT_DIR/templates/macf-app-manifest.json` (the DR-019 permission set;
for `macf-routing`, narrow it to `Organization variables: Read` only).

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

### 4c. Install each App on its repos / org (`gh` / REST)

After exchange, install each App on its agent repo(s) **and** on the registry
target (so the channel server can self-register). App install is API-able; do it
via `gh api` (NOT the browser). Resolve the installation id and record it into the
spec (`install_id`). (If a step needs the App-install confirmation page, that URL
is on the allowlist — but prefer the API.)

### 4d. Set routing secrets + CA var + org settings (`gh secret/variable set`)

Set the 6 routing secrets per repo and the `<PROJECT_SEG>_CA_CERT` variable on the
registry target with `gh secret set` / `gh variable set`. The gh guard enforces
**create-only** — a name that already exists is blocked (overwrite ≠ delete); if
an overwrite is genuinely intended, the operator opts in with
`MACF_BOOTSTRAP_ALLOW_OVERWRITE=1`.

### 4e. Generate the per-project CA (Mac-side) + upload the CA cert var

```bash
# From any workspace already wired for the project, or per the certs flow:
macf certs init        # creates the CA + uploads <PROJECT_SEG>_CA_CERT
```

Put the **CA private key** (base64) into the vault plaintext (Step 4f). The CA
cert variable upload is part of `macf certs init`; verify it landed.

### 4f. Build + commit the vault

Assemble the plaintext per `templates/vault.template.txt` from every
`./.bootstrap-work/<name>.app.json`, the `macf-routing` creds, the 6 routing
secrets, and the CA key (base64-encode PEMs/certs/keys). Write it to
`./.bootstrap-work/vault.plain`. Then:

```bash
# Encrypt (mint a keypair if no --recipient; shreds the plaintext on success):
"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-build-vault.sh" \
  --in ./.bootstrap-work/vault.plain \
  --out ./.bootstrap-work/vault.age \
  --key-out ./.bootstrap-work/vault-age-key.txt   # omit --recipient → fresh keypair

# Commit into the science repo (fail-if-exists; never --force; shreds the /tmp clone):
"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-commit-vault.sh" \
  --repo <science-repo> \
  --vault ./.bootstrap-work/vault.age \
  --accessor "$CLAUDE_PROJECT_DIR/templates/vault.sh" \
  --template "$CLAUDE_PROJECT_DIR/templates/vault.template.txt"
```

Tell the operator the **age private key path** (`./.bootstrap-work/vault-age-key.txt`)
— they scp it to the VM out-of-band (the vault.age rides in via git; the key does
not). After commit, shred any remaining plaintext intermediates in
`./.bootstrap-work/` (the build/commit scripts shred their own; remove the rest).

---

## Step 5 — Emit the outputs (definition-of-done)

```bash
"$CLAUDE_PROJECT_DIR/.claude/scripts/bootstrap-emit-commands.sh" \
  --spec ./.bootstrap-work/spec.json
```

This prints **output #2** (the VM-side `git clone` + `macf init` per agent, IDs
substituted) and **output #3** (the verification commands: `macf fleet status` /
`macf routing doctor` / `macf fleet doctor --inject`, plus setup asserts that the
Apps exist + are installed and the secrets are present). Output #1 (the vault) was
committed in Step 4f.

Hand the operator: (a) the emitted command list, (b) the age key path to scp, and
(c) a one-line summary (N Apps created, N repos, vault committed to <science repo>).

---

## Reminders

- **No per-command approval.** `Bash(*)` is pre-approved; the only interactive
  points are the single plan approval (Step 3) + GitHub auth gates (Step 4). The
  deny-rails — not prompts — fence the destructive surface. Do not ask the operator
  to approve individual `gh`/MCP calls.
- **Never** run a destructive GitHub op (delete/transfer/rename repo, delete
  secret, `gh api … DELETE`, force-push) — the rails block them; don't try to
  route around them. An intended exception is the operator's call via the documented
  override env var.
- **No plaintext left behind.** Keys flow manifest-exchange → vault. Shred
  intermediates. The build/commit scripts already shred their own.
