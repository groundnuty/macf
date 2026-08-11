# DR-035: macf-bootstrap — operator-privileged GitHub-provisioning skill (the un-CLI-able fleet setup)

**Status:** Accepted (ratified by operator 2026-06-29)
**Date:** 2026-06-29
**Trigger:** Operator-requested. Every MACF fleet onboarding (see `use-cases/scientific-paper-fleet.md`, `design/macf-consumer-onboarding.md`) requires **manual GitHub GUI work no CLI can do** — creating the per-agent GitHub Apps, downloading their keys, installing them on repos/org. Automate it as a **versioned, marketplace-distributed skill** that drives the *operator's own* logged-in Chrome + `gh` to provision a whole fleet's GitHub side, leaving the operator only the VM-side `git clone` / `macf init` and the unavoidable auth clicks. Design driven by the operator + code-agent (the 2026-06-29 design dialogue); routed to science for canonical-record review + operator ratification. Prior art: science's `macf-science-agent/context/vnc-browser-setup.md` (the VM-side attempt), `macf-science-agent/scripts/setup/SETUP.md` (manifest-flow steps), and the existing `macf-science-agent/secrets/vault.{age,sh,template.txt}` vault.

> **`[DECIDE]` plugin name:** `macf-bootstrap` (recommended — it bootstraps a fleet's GitHub side *from nothing*, breaking the chicken-and-egg that scoped Apps can't create the Apps; distinct from per-agent `macf init`/`update`) vs `macf-setup`. Used as `macf-bootstrap` throughout; code-agent + science both recommend it; operator confirms.

## Context — the GUI gap, and the chicken-and-egg

MACF's CLI (`macf`, `gh`) covers almost everything: certs, registry, `init`, `repo-init`, secrets/variables. The **irreducible GUI-only surface** is small but blocking:

| Onboarding step | CLI-able? |
|---|---|
| Create a GitHub App | **No** — no API to *create* an App; only the browser **manifest flow** |
| Download the App private key | **No** GUI download — but the manifest exchange *returns* it (see below) |
| Install an App on repos/org | API-able (`gh`/REST) |
| Create repos (from template), secrets, variables, CA var | `gh` / `macf` |

The manual GUI work has been the friction point in every onboarding. It also has a **chicken-and-egg**: you can't use a MACF-provisioned (scoped bot) App to *create* the MACF Apps — the bootstrapping must run with **broader privilege than any fleet agent has**. That is the structural reason this tool acts **as the operator's account**, not as a scoped App — the deliberate inverse of the fleet's attribution discipline (`gh-token-attribution-traps.md`), justified because it is the stage-0→1 bootstrap that *creates* the scoped identities.

**The lever — the GitHub App Manifest flow.** MACF ships `packages/macf/templates/macf-app-manifest.json` (the DR-019 permission set). GitHub's create-from-manifest flow: submit the manifest to a form → GitHub shows a *pre-filled* "Create GitHub App" page → **Create** → redirect carrying a temporary `code` → exchange via `POST /app-manifests/{code}/conversions` → returns **app_id, client id/secret, webhook secret, and the private-key PEM**. This collapses App creation to *submit-form → click Create → capture redirect-`code` → API-exchange*, and **eliminates the manual key-download** (the key comes back in the exchange).

**Prior art to reuse, not reinvent.** Science already built the VM-side version (`vnc-browser-setup.md`: TigerVNC + Xfce + Chrome on the VM, watched via VNC) — it worked but fought the headless environment (X11-auth failures, Snap-Chromium cgroup issues, DBus/xstartup fragility). This DR **inverts it to the operator's Mac** (where Chrome + the logged-in session already are), deleting that whole problem set. Science's `secrets/vault.{age,sh,template.txt}` is the vault pattern; `scripts/setup/SETUP.md` already documents the manifest-flow response.

## Decision

Ship **`macf-bootstrap`** — a **separate marketplace plugin** (its own version, NOT folded into the fleet's `macf-agent` plugin) providing an operator-invoked skill that provisions a MACF fleet's entire GitHub side. It runs in a dedicated, operator-privileged Claude Code workspace on the operator's personal machine, drives the operator's authenticated Chrome (via the Chrome DevTools MCP) + `gh`, and produces a three-part handoff.

### 1. Skill + workspace split (load-bearing)

A Claude Code skill is *versioned instructions (+ helper scripts)* — it carries the **procedure**, not the **environment**. The three things that make this work + keep it safe are **workspace** config a skill cannot itself install or enforce:

- the **Chrome DevTools MCP** connection (`.mcp.json` / settings — skills don't install MCP servers);
- **operator-privilege + no-prompt autonomy** (`permissions.allow` breadth + no confirmation gates);
- the **destructive-deny rails** (`settings.json` deny-rules + a PreToolUse guard).

So `macf-bootstrap` is **skill (brains) + thin workspace template (body)**:
- the **skill** (marketplace plugin, versioned) — intake → manifest flow → `gh` orchestration → vault → emit commands; it **best-effort *validates*** the environment at start (is chrome-devtools connected? are the deny-rails present? is `gh` authed as a user? — stop loud if not) even though it cannot *enforce* it;
- the **workspace** (the operator's dedicated `macf-automated-github-setup` repo, or a `macf bootstrap-init` scaffold) — wires the Chrome MCP + the operator-privilege permissions + the deny rails.

The dedicated repo the operator described **is** that workspace; it loads the marketplace skill. **The repo is project-independent** — a run is scoped purely by the project named in the prompt (no per-project config baked into the repo).

### 2. Safety contract (operator-privilege without recklessness)

Acting **as the operator's account** has the operator's full blast radius (every repo, org settings, deletes). "No per-action prompts" (operator requirement) is preserved by moving the gate off per-action onto structural rails + one upfront approval — **not** a hard project-namespace confinement (rejected: it conflicts with project-independence):

1. **Plan-approve-once — with blast-radius highlighted.** After the Q&A intake the skill computes the *full* provisioning plan (these N Apps, these repos, these secrets) and shows it **once**; the operator approves the plan; it then runs end-to-end with **no further prompts** except auth gates. One approval at the top, not N clicks. Because the single approval's whole safety weight rests on the operator actually scrutinizing it, the plan **highlights the blast-radius items** (touches org-wide settings; commits to your science repo; sets N secrets) so the one approval is a real gate, not a rubber stamp on a long list.
2. **Surgical destructive-deny (so it never breaks automation) — across BOTH surfaces.** Provisioning is *all* create/install/configure, so denying only the irreversible-destructive verbs has **zero happy-path impact**: deny **delete-repo, transfer/rename-org, billing, remove member/collaborator, delete *or overwrite* an *existing* secret, revoke an *existing* App.** Critically, the tool acts as the operator through **two surfaces**, and the rail must fence **both** — a deny covering only one leaves the operator's full blast radius open on the other:
   - **Bash/`gh` surface** — `settings.json` deny-rules + a PreToolUse(Bash) hook (the established `check-*.sh` pattern). Covers the `gh`/CLI destructive verbs.
   - **Browser/MCP surface (the hole a Bash hook does NOT cover — caught in science's #655 review).** The Chrome DevTools MCP drives the operator's *real, logged-in* browser, so a destructive action done *in the browser* (navigate to a repo Danger Zone, `…/settings`, `…/billing`, an App's revoke page) is an **`mcp__chrome-devtools__*` tool call, not a Bash call** — the Bash rail is structurally blind to it. So the browser is fenced with a **URL/action allowlist on the Chrome MCP navigate/click calls**: *allow* the manifest-flow form + the OAuth/sudo gate pages + the specific install/settings pages provisioning needs; *deny* `/settings/…/danger`, `/billing`, delete/transfer/revoke URLs. Procedural fencing ("browser only for App-creation + auth") is **not** sufficient alone for an operator-blast-radius tool.
   - **Overwrite ≠ delete.** `gh secret set <name>` on an existing name *silently clobbers* — so secret-set is **create-only (fail-if-exists)**; an intended overwrite needs explicit operator confirmation. A re-run or a name collision with a live fleet must not silently overwrite a secret.

   (Operator-confirmed: the deny set is acceptable *because* it cannot block setup — every denied verb is one provisioning never performs.)
3. **No credential handling.** The skill uses the operator's *already-authenticated* Chrome session + `gh` user auth — it never sees or stores the operator's password/2FA.

**Auth gates remain the operator's only clicks.** GitHub forces OAuth consent + **sudo-mode re-auth** (password/2FA) for sensitive ops, recurring every few hours — so during a long run the skill hits the gate **repeatedly**. "Pause → operator satisfies auth → resume" is a **first-class, expected loop**, not an error. That is the entirety of the operator's manual interaction.

### 3. Architecture — `gh`-first hybrid, browser only where forced

Even in "drive Chrome" mode, the robust split is **`gh`/API first (as the operator), browser only for the genuinely GUI-only** — pure browser automation is brittle (GitHub DOM changes break selectors):

- **`gh` / REST (as operator):** create repos *from the `agentic-repo-template`* (`gh repo create --template`), install Apps, set the 6 routing secrets + `<PROJECT>_CA_CERT` var + org allowlist settings.
- **Chrome DevTools MCP (the operator's real, logged-in browser):** App *creation* via the manifest flow (submit form → click Create → **read the post-redirect URL** to extract `code`, no callback server needed), and traversing OAuth/sudo gates.
- **`macf` CLI:** generate the per-project CA + emit the VM-side `macf init` commands.

This keeps the brittle browser surface to the one thing with no API (App *creation*) + the auth gates.

### 4. Capabilities (generic — driven by Q&A intake)

Not project-scoped: it sets up **any project, any number of agents**. The skill **interviews the operator** for the spec it can't infer (project name, each agent's role/repo/**VM deploy path**, registry scope, advertise-host), then:
1. creates the GitHub repos from `agentic-repo-template` (+ applies the role profile);
2. creates the N agent Apps + the `macf-routing` App via the manifest flow;
3. installs the Apps on their repos/org;
4. sets the routing secrets + CA var + org settings;
5. generates the per-project CA (Mac-side; uploads the `<PROJECT>_CA_CERT` var; CA key → vault);
6. builds the **age-encrypted vault** and **commits it to the project's science repo** (clone to `/tmp`, drop `secrets/vault.age` + `vault.sh` + template, commit, push) — **non-destructively**: if `vault.age` already exists it **fails-or-versions** (never silently clobbers a prior vault), and the push is a **normal push, never `--force`** (a re-run must not damage the existing science repo — the same "never irreversibly mutate existing state" guard as the deny rail, applied to the repo write). **Secure-cleanup:** the keys exist *decrypted* in the `/tmp` clone during vault construction, so the skill **shreds the `/tmp` workspace + every plaintext intermediate** on completion (and on abort) — a secrets tool leaves no plaintext on disk.

### 5. The three outputs (a run's definition-of-done)

1. **An age-encrypted vault** (science's `secrets/vault.{age,sh,template.txt}` pattern), committed encrypted into the project's **science repo**, holding every generated cred: per-agent `{app_id, install_id, private-key PEM, client_id/secret, webhook_secret}` ×N + the `macf-routing` App creds + the 6 routing secrets + the CA key. Keys flow straight from the manifest-exchange into the vault — never manually downloaded.
2. **A filled-in `macf` command list** — the VM-side `git clone …` + `macf init …` per agent, every `--app-id`/`--install-id`/`--app-key`/`--registry-*` substituted.
3. **Verification command(s)** — the `use-cases` §fleet-health trio (`macf fleet status` / `routing doctor` / `fleet doctor`) + setup-specific asserts (the Apps exist + are installed; secrets present).

### 6. Two-machine handoff

The work splits across the operator's two machines, and the **encrypted vault is the secure Mac→VM transport**:
- **Mac (the skill, as operator):** everything account/GUI/repo-level (steps 1–6 above) → vault committed (encrypted) to the science repo.
- **VM (the operator runs the emitted commands):** `git clone` the science repo (gets `vault.age`) + run the `macf init` commands (which read creds from the decrypted vault) + run the verification. The **vault.age rides in via `git`** (encrypted — safe in a private repo); the **age decryption key goes out-of-band via `scp`**.

The skill does **the whole project except the final VM `git clone` / `macf init`** (operator-confirmed scope).

### 7. Versioning + distribution

`macf-bootstrap` is its **own marketplace plugin with its own version**, on an **independent cadence** from the framework (it's a tool, not the framework). Distributed via `groundnuty/macf-marketplace` like the `macf-agent` plugin, but installed only into the operator's bootstrap workspace — never into fleet agents.

#### Amendment (2026-06-29) — independent version, declared + ENFORCED compatibility, marketplace-vs-workspace split (P6)

The §7 intent above is implemented as follows.

- **Independent versioning (confirmed, implemented).** `macf-bootstrap` carries its **own** version in `.claude-plugin/plugin.json` (`"version"`), starting the line at **`0.1.0`** — **NOT lockstep** with the macf framework / `@groundnuty/macf-channel-server` version. A framework bump does not bump macf-bootstrap and vice-versa.

- **Compatibility declaration + enforcement.** Because the two versions float independently, the plugin **declares the framework range it requires** — `compatibility.macf` as a semver range (`">=0.2.43"`: the framework version that ships the DR-030 fleet commands + the 0.2.43 forensic-log/launcher this skill builds on). This is a **new manifest key** — no prior plugin.json (`macf-agent`) had a compatibility/requires field, so `compatibility.macf` is introduced here as the convention. The declaration is **enforced, not just documented**: the workspace runs `macf` locally (CA generation + emitting the VM-side `macf init` commands — §3), so `bootstrap-validate-env.sh` reads `.compatibility.macf` from `plugin.json`, reads the installed `macf --version`, and **stops the run loud (critical)** when the installed macf does not satisfy the range — actionable message (`macf-bootstrap 0.1.0 requires macf >=0.2.43; found 0.2.X; run npm i -g @groundnuty/macf@latest`). An *absent* or *unparseable* `macf --version` is refused identically (we never run against a framework we cannot verify). A small bash semver compare (mirroring `@groundnuty/macf-core` `compareSemver`: `x.y.z`, optional leading `v`, unparseable ⇒ `0.0.0`/oldest) backs the check; the bootstrap scripts are bash and don't import the TS core. This extends the §2 **safe-by-refusal** property to cover **version-skew**.

- **The marketplace-plugin nuance (why the distribution unit is the whole workspace).** A Claude Code **marketplace plugin** can carry the **skill + the Chrome `mcpServers` + the deny-hooks + the version + the compatibility range** — but it **cannot carry `permissions`** (in Claude Code, `permissions` are owned by the *workspace* settings, not by a plugin manifest). So the **operator-privilege permissions** (the broad `permissions.allow`, the destructive `permissions.deny` set) **travel with the workspace template**, not the plugin. The skill itself closes this gap behaviorally: its env-validation **refuses to run unless the deny-rails are present** (§2.2 — `check-bootstrap-{gh-guard,url-allowlist}.sh` + `settings.json`), so a skill loaded into a workspace lacking the safety env stops loud rather than acting operator-privileged without fences. The consequence: the **distribution unit is the complete workspace** (versioned + compat-declared), surfaced in the marketplace at its own version — not a bare skill that could be dropped into an unfenced workspace. (The marketplace *registration* — publishing this workspace as a plugin into `groundnuty/macf-marketplace` at its version — is performed separately by the framework maintainer; this `tools/macf-bootstrap/` directory is the source workspace it is cut from.)

#### Amendment (2026-06-29) — separate product, develop-in-monorepo / publish-to-its-own-repo ("Option B", macf#657)

The "distribution unit is the whole workspace" point above is realized as a **separate product**, not a path users consume from inside the macf repo. Operator decision 2026-06-29 ("Option B").

- **macf-bootstrap is a separate PRODUCT** — delivered as the standalone repo **`groundnuty/macf-automated-github-setup`** (the unit the operator clones into the bootstrap workspace), **NOT** a path inside `groundnuty/macf`. Same precedent as the framework's other develop-here / ship-elsewhere units: the routing workflow (`groundnuty/macf-actions`) and the agent plugin (`groundnuty/macf-marketplace`).

- **Source is developed in the monorepo, published at each version.** The dev source lives at **`tools/macf-bootstrap/`** in this repo — which keeps the bootstrap tests inside `make check` and keeps the workspace in lockstep with the framework it calls (`macf certs init` / `macf init` for CA + VM-side command emission, and the §7 `compatibility.macf` gate). It is **published** to the product repo by **`packages/macf/scripts/sync-bootstrap-product.mjs`** — a self-contained Node mirror (`--target <product-checkout>`, `--check` verify gate, default source `tools/macf-bootstrap/`) that copies every file mode-preserving, prunes target-only files (true mirror), never touches the target's `.git/`, and excludes runtime scratch (`.bootstrap-work/`) + any stray secret (`*.app.json` / `vault*.age` / `vault-age-key.txt` / `vault.plain`) as defense-in-depth. This is the same shape as `sync-marketplace-plugin.mjs` (the `plugin/` → marketplace sync), so the two products publish identically. **Caveat (same as the marketplace precedent):** because it is a *true mirror* (prunes target-only files, except `.git/`), any file that should live in the product repo — a `LICENSE`, product-specific CI — must be added to the **source** `tools/macf-bootstrap/`, NOT directly to `macf-automated-github-setup`, or the next publish prunes it.

- **Independent version + enforced `compatibility.macf` carry over unchanged** from the amendment above: the product repo's `.claude-plugin/plugin.json` keeps its own version (line starts at `0.1.0`, not lockstep with the framework) and the enforced `compatibility.macf` semver range. The publish helper mirrors that manifest verbatim along with the rest of the workspace.

- **First publish is an operator action; subsequent publishes are helper + push.** A scoped fleet bot cannot `gh repo create` (the same chicken-and-egg this whole DR addresses), so the **initial** creation of `groundnuty/macf-automated-github-setup` is an operator step. After the repo exists, each release is just `sync-bootstrap-product.mjs --target <checkout>` + commit + push (the `--check` mode is the drift gate, available to wire into `publish.yml` alongside the macf#605 marketplace gate — noted as a follow-up).

## Build-split

- **science** — this DR (canonical-record review + the safety-contract shape).
- **code-agent** — the `macf-bootstrap` marketplace plugin (the skill + helper scripts), the workspace scaffold (`.mcp.json` Chrome MCP + permissions + deny-rails, or a `macf bootstrap-init` command), the manifest-flow + vault helper logic, and any `macf` CLI seams it needs.
- **dependency** — the **Chrome DevTools MCP** server (already in the permission set); the `agentic-repo-template` repo (role profiles).

## Boundaries (what it does NOT do)

- Does not run the VM-side `git clone` / `macf init` (different machine; emits the commands instead).
- Does not perform any destructive GitHub op (structural deny).
- Does not handle the operator's login credentials (uses the already-authenticated session).
- Is not a fleet member (no channel-server, registry, or identity App) — it is ephemeral bootstrap tooling.
- Is not a general TUI-automation framework — strictly the GitHub-provisioning allowlist.
- **The workspace DELIBERATELY omits the fleet attribution-guard hooks** (`check-gh-token.sh` et al.) — it acts *as the operator*, the intentional inverse of the fleet discipline (`gh-token-attribution-traps.md`). This omission MUST be an **explicit, documented** config (a header in the workspace settings), and the workspace marked **operator-privileged, never reusable as a fleet agent** — so it reads as deliberate design, not drift. (A fleet agent that lost its `check-gh-token` hook would be a bug; here the absence is the point — but only when stated.)

## Consequences

- **Onboarding's manual GUI step is automated** down to a Q&A intake + a one-time plan approval + the unavoidable auth clicks.
- **A deliberate operator-privilege exception** is introduced — isolated to ephemeral bootstrap tooling, structurally fenced by the destructive-deny rails, and documented as the inverse of the fleet attribution discipline (it *creates* the scoped identities).
- **A new distributable + its safety model** join the catalog (sibling to DR-033's allowlist-only auto-responder contract + DR-022 marketplace distribution).
- **The recipes become executable** — `use-cases/scientific-paper-fleet.md` / `macf-consumer-onboarding.md` define *what*; `macf-bootstrap` executes the GitHub side of that *what*.

## Open questions

- **`[DECIDE]` name** — `macf-bootstrap` vs `macf-setup` (header).
- **CA handling** — Mac-side `macf certs init` with the CA key carried in the vault to the VM (recommended — keeps "agent does everything except VM init"), vs CA created VM-side (adds a VM step). Spec'd as Mac-side-into-vault unless the operator prefers otherwise.
- **Workspace delivery** — a standalone dedicated repo the operator clones, vs a `macf bootstrap-init` scaffold command that writes the workspace. (Either consumes the same marketplace skill.)
- **Autonomy of the account-level `gh` steps** — confirmed the skill performs them directly (as operator), emitting only the VM-workspace `macf init` commands.

## Routing note (route-now-vs-backlog)

Design-now (capture while the dialogue is fresh — done). Build sequences behind the in-flight unattended-operation family (`#641`/`#642`/`#645`); the Chrome-MCP dependency + the safety-rails are the prerequisites. Operator's final sequencing call.

## References

- `use-cases/scientific-paper-fleet.md`, `design/macf-consumer-onboarding.md` — the recipes this skill executes.
- `macf-science-agent/context/vnc-browser-setup.md` — the VM-side prior attempt (what to *not* repeat).
- `macf-science-agent/scripts/setup/SETUP.md` — manifest-flow steps already written down.
- `macf-science-agent/secrets/vault.{age,sh,template.txt}` — the vault pattern (output #1).
- `packages/macf/templates/macf-app-manifest.json` — the DR-019 manifest (the create-from-manifest lever).
- DR-033 (interactive-prompt auto-responder) — sibling allowlist-only / never-destructive safety contract.
- DR-022 (channel-server-npm-npx) — marketplace distribution model.
- DR-019 — the App permission set the manifest encodes.

## Amendment (2026-08-11, DR-043) — CLI-core repositioning + install-API correction

**DR-043 inverts this DR's skill/mechanism relationship.** The provisioning *mechanism* moves to a deterministic CLI core (`macf bootstrap plan|apply` driven by a declarative `fleet.yaml`); this DR's skill is **repositioned as an optional conversational front-end** that gathers intake, writes `fleet.yaml`, and invokes the CLI core. The skill's field lessons (name-vs-handle trap, shared `macf-routing`, two-place CA, secret value formats, born-correct `repo-init`, vault construction, auth-gate pause/resume) are carried into DR-043 as schema constraints and reconcile invariants — see DR-043's lessons table.

**Correction to the §Context table:** the row "Install an App on repos/org — API-able (`gh`/REST)" is **wrong for the *initial* installation**, as this skill's own Step 4c later established: no REST API creates an installation (`PUT /user/installations/{id}/repositories/{id}` only *extends* an existing one; the user-token install endpoints 403 without `read:user`). The true API-able subset is *extending* an existing installation's repo set. The human floor per App is therefore **two** browser interactions (manifest *Create* + initial *Install*), not one. DR-043 §D2 reduces both to clicks in the operator's normal browser (localhost redirect exchange + App-JWT installation polling — no debug Chrome, no Chrome-MCP).

**The vault is promoted from bootstrap transport to the fleet's credential store of record** (DR-043 §D5): operationally maintained, write-through on every credential-minting reconcile, multi-recipient (operator + VM keys), agents never decrypt.
