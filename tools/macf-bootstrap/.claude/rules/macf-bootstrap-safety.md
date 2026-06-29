# macf-bootstrap Safety Contract

**This workspace is OPERATOR-PRIVILEGED. It acts AS the operator's GitHub
account — the deliberate inverse of the fleet's attribution discipline — and
runs with no per-action prompts. Read this before doing anything in it.**

This file is the workspace-rule form of DR-035 §2 (the safety contract). It is
the standing brief loaded every session in the `macf-bootstrap` workspace.

---

## 1. Why operator-privilege (the chicken-and-egg)

MACF fleet agents act as *scoped* GitHub Apps (`ghs_` bot installation tokens),
and the canonical rules go to great lengths to keep them from ever acting as the
human operator (`gh-token-attribution-traps.md`, the `check-gh-token.sh` hook).

**This workspace is the exception, on purpose.** You cannot use a MACF-provisioned
scoped App to *create* the MACF Apps — there is no API to create a GitHub App
except the browser manifest flow, and that runs with the operator's own
privilege, which is broader than any fleet agent has. This tool is the
stage-0→1 bootstrap that *creates* the scoped identities. So it acts as the
operator's account, with the operator's full blast radius.

The safety model is therefore NOT "attribute correctly to a bot" — it is
**"act as the operator, but be structurally unable to do anything
irreversible."**

## 2. The two structural rails (fences, not prompts)

The operator requirement is **no per-action prompts**. The blast-radius gate is
moved off per-action approval and onto **structural rails + one upfront plan
approval**. The tool acts through TWO surfaces, and BOTH are fenced — a deny on
only one leaves the operator's full blast radius open on the other:

- **Bash / `gh` surface** — `settings.json` `permissions.deny` rules +
  `.claude/scripts/check-bootstrap-gh-guard.sh` (PreToolUse on `Bash`). Blocks
  the irreversible-destructive `gh` / `gh api` verbs (delete-repo,
  transfer/rename-repo, delete secret/variable, any `gh api … DELETE`) and
  enforces **create-only** secret/variable `set` (see §3).
- **Browser / MCP surface** — `.claude/scripts/check-bootstrap-url-allowlist.sh`
  (PreToolUse on `mcp__chrome-devtools__*`). The Chrome DevTools MCP drives the
  operator's real, logged-in browser, so a destructive action done *in the
  browser* (navigating to a repo Danger Zone, `…/billing`, an App's revoke page)
  is an `mcp__chrome-devtools__*` call, **not** a `Bash` call — the gh guard is
  structurally blind to it. The URL guard is a **default-deny allowlist**: it
  permits only the manifest-flow + App-install + OAuth/sudo/2FA pages and blocks
  everything else (and the distinct destructive URLs explicitly).

**Why the browser guard is a hook, not a `permissions.deny` rule (verified, CC
2.1.195):** a permission `deny` fires BEFORE PreToolUse hooks and *skips* them,
and `permissions.deny` cannot arg-match `mcp__*` tools at all. So the
chrome-devtools MCP tools are in `permissions.allow` and the URL policy lives
entirely in the PreToolUse hook. **Never move the chrome-devtools tools to
`deny`** — that would skip the URL guard.

The deny set is acceptable *precisely because it cannot block setup*: every
denied verb/URL is one provisioning never performs. Denying them has zero
happy-path impact.

## 3. Overwrite ≠ delete

`gh secret set <name>` / `gh variable set <name>` **silently clobbers** an
existing value. That is a destructive mutation of existing state, so secret/
variable `set` is **create-only (fail-if-exists)**. A re-run, or a name
collision with a live fleet, must not silently overwrite a secret. An intended
overwrite is opt-in via `MACF_BOOTSTRAP_ALLOW_OVERWRITE=1`.

The same "never irreversibly mutate existing state" guard applies to the vault
write (DR-035 §4): if `secrets/vault.age` already exists in the science repo,
the skill fails-or-versions (never silently clobbers a prior vault), and the
push is a normal push — **never `--force`** (force-push is denied in
`settings.json`).

## 4. Plan-approve-once

After the Q&A intake the skill computes the *full* provisioning plan (these N
Apps, these repos, these secrets) and shows it **once**; the operator approves;
it then runs end-to-end with no further prompts except auth gates. The single
approval's whole safety weight rests on the operator scrutinizing it, so the
plan **highlights the blast-radius items** (touches org-wide settings; commits
to your science repo; sets N secrets) — a real gate, not a rubber stamp.

**Invariant — no per-command approval.** `Bash(*)` is pre-approved in
`settings.json`; the ONLY interactive points in a run are the **single plan
approval** (above) and the recurring **GitHub auth-gates** (§5). There are no
per-action `ask` prompts, and none must be added — the deny-rails (§2), **not**
prompts, are what fence the destructive surface. Do **not** narrow `Bash(*)`,
add an `ask` permission, or otherwise reintroduce per-command confirmation:
that would defeat the operator's no-prompt-autonomy requirement while adding no
safety the rails don't already provide (a prompt the operator clicks through is
not a fence; the deny-rail is). The safety model is "act freely, but be
structurally unable to do anything irreversible" — keep the gate structural.

## 5. Auth gates are the operator's only clicks

GitHub forces OAuth consent + **sudo-mode re-auth** (password / 2FA) for
sensitive ops, recurring every few hours. During a long run the skill hits the
gate repeatedly. "Pause → operator satisfies auth → resume" is a **first-class,
expected loop**, not an error. That is the entirety of the operator's manual
interaction.

## 6. No credential handling

The skill uses the operator's *already-authenticated* Chrome session + `gh` user
auth. It never sees, types, or stores the operator's password / 2FA. Private
keys flow from the App manifest-exchange straight into the age-encrypted vault —
never manually downloaded, never left as plaintext on disk (the `/tmp` clone +
every plaintext intermediate is shredded on completion and on abort).

## 7. The deliberate attribution-hook omission

This workspace **deliberately omits** the fleet attribution-guard hooks
(`check-gh-token.sh` et al.). A fleet agent that lost its `check-gh-token` hook
would be a bug; **here the absence is the point** — the tool acts *as the
operator*, the intentional inverse of the fleet discipline. This omission is
stated explicitly in `.claude/settings.json` (`_comment_attribution_omission`)
so it reads as deliberate design, not drift.

## 8. Never reusable as a fleet agent

This is ephemeral bootstrap tooling: no channel-server, no registry entry, no
identity App. It is not a fleet member. Do not point a fleet workspace at this
settings file, and do not copy its broad `permissions.allow` + operator-privilege
posture into any agent workspace.

## Override env vars (deliberate exceptions only)

| Variable | Effect |
|---|---|
| `MACF_BOOTSTRAP_SKIP_URL_GUARD=1` | Bypass the browser URL allowlist for one run. |
| `MACF_BOOTSTRAP_SKIP_GH_GUARD=1` | Bypass the gh destructive/overwrite guard for one run. |
| `MACF_BOOTSTRAP_ALLOW_OVERWRITE=1` | Permit an intended secret/variable overwrite. |

Each is the documented escape hatch for a deliberate, operator-decided
exception — the same structural-enforcement-plus-escape-hatch posture as the
fleet `check-*.sh` hooks.
