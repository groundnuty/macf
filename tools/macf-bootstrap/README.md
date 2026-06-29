# macf-bootstrap — operator-privileged GitHub-provisioning workspace

This directory is the **safety-foundation workspace template** for
`macf-bootstrap` (DR-035) — the operator-invoked tool that provisions a whole
MACF fleet's GitHub side (the per-agent GitHub Apps, their keys, installs, repos,
secrets, CA var, vault) that no CLI can create on its own.

> **Scope.** This directory carries both the *workspace scaffold* + the two
> structural safety rails (P1) **and** the provisioning **skill** itself (P2–P5):
> the brains at `.claude/skills/macf-bootstrap/SKILL.md` (Q&A intake → manifest
> flow → `gh` orchestration → vault → emitted commands) plus its deterministic
> helper scripts (`.claude/scripts/bootstrap-*.sh`) and vault templates
> (`templates/vault.{sh,template.txt}`). The scaffold is what makes the skill
> safe to run with no per-action prompts.

## What this workspace is

A dedicated, **operator-privileged** Claude Code workspace that runs on the
operator's personal machine (the Mac, where Chrome + the logged-in GitHub session
already are). It acts **as the operator's GitHub account** — the deliberate
inverse of the fleet's bot-attribution discipline — because creating GitHub Apps
is a chicken-and-egg that a scoped bot App cannot do (no API to create an App;
only the browser manifest flow, which needs operator privilege).

It is **not** a fleet agent: no channel-server, no registry, no identity App. It
is ephemeral bootstrap tooling. **Never reuse it as a fleet agent.**

## The safety model (read `.claude/rules/macf-bootstrap-safety.md`)

No per-action prompts; the operator's blast radius is fenced by **two structural
rails** + one upfront plan approval:

1. **Bash/`gh` rail** — `settings.json` `permissions.deny` + the
   `check-bootstrap-gh-guard.sh` PreToolUse(Bash) hook. Blocks irreversible
   destructive `gh`/`gh api` verbs and enforces **create-only** secret/variable
   `set` (overwrite ≠ delete).
2. **Browser/MCP rail** — the `check-bootstrap-url-allowlist.sh` PreToolUse hook
   on `mcp__chrome-devtools__*`. A **default-deny** URL allowlist: only the App
   manifest-flow, App-install, and OAuth/sudo/2FA pages are reachable; the
   distinct destructive GitHub URLs (danger-zone / billing / delete / transfer /
   revoke) are explicitly denied.

The fleet attribution-guard hooks (`check-gh-token.sh` et al.) are
**deliberately omitted** here — this workspace is *supposed* to act as the
operator, not a `ghs_` bot token. That omission is documented explicitly in
`settings.json`; absence here is design, not drift.

> **Why the browser rail is a hook, not a deny rule:** in Claude Code a
> permission `deny` fires *before* PreToolUse hooks and skips them, and
> `permissions.deny` cannot arg-match `mcp__*` tools. So the chrome-devtools MCP
> tools stay in `permissions.allow` and the URL policy lives entirely in the
> hook. Do not move them to `deny` — that disables the URL guard.

## How the operator runs this workspace

1. Clone this `tools/macf-bootstrap/` directory to the Mac as the bootstrap
   workspace root (the eventual delivery is a standalone repo or a
   `macf bootstrap-init` scaffold — DR-035 open question; either consumes the
   same skill).
2. **Start Chrome with remote debugging** (this is what lets the MCP drive the
   operator's *already-logged-in* session — the whole point of "no credential
   handling"):

   ```bash
   # macOS — quit Chrome first, then:
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222
   # verify it's listening:
   curl -s http://127.0.0.1:9222/json/version
   ```

   `.mcp.json` already points the MCP at this with
   `--browser-url=http://127.0.0.1:9222`, so the MCP **attaches** to that Chrome
   rather than launching a fresh, logged-out instance. Make sure `gh` is
   authenticated as the operator's **user** (`gh auth status`) — this workspace
   deliberately uses user auth, not a bot token. (Override the debug URL for the
   env-validation probe with `MACF_BOOTSTRAP_CHROME_URL`.)
3. Open Claude Code in this directory and approve the project MCP server when
   prompted.
4. Run the **`macf-bootstrap`** skill (`.claude/skills/macf-bootstrap/SKILL.md`)
   and follow its Q&A intake → plan approval → run loop. It validates the
   environment first (`bootstrap-validate-env.sh`), so a missing Chrome / non-user
   `gh` / missing `age` stops loud before any provisioning.

See the upstream chrome-devtools-mcp README
(<https://github.com/ChromeDevTools/chrome-devtools-mcp>) for `--browser-url` /
`--channel` / profile options if the operator's Chrome setup differs.

## Override env vars (deliberate exceptions only)

| Variable | Effect |
|---|---|
| `MACF_BOOTSTRAP_SKIP_URL_GUARD=1` | Bypass the browser URL allowlist for one run. |
| `MACF_BOOTSTRAP_SKIP_GH_GUARD=1` | Bypass the gh destructive/overwrite guard for one run. |
| `MACF_BOOTSTRAP_ALLOW_OVERWRITE=1` | Permit an intended secret/variable overwrite. |

## Layout

```
tools/macf-bootstrap/
├── .claude/
│   ├── settings.json                          ← operator-privilege allow + dual-surface deny + the 2 PreToolUse rails
│   ├── skills/
│   │   └── macf-bootstrap/
│   │       └── SKILL.md                        ← the orchestration skill (intake → manifest flow → gh → vault → emit)
│   ├── rules/
│   │   └── macf-bootstrap-safety.md            ← the DR-035 §2 safety contract, workspace-rule form
│   └── scripts/
│       ├── check-bootstrap-url-allowlist.sh    ← browser/MCP rail (default-deny URL allowlist)
│       ├── check-bootstrap-gh-guard.sh         ← Bash/gh rail (destructive-deny + create-only secret set)
│       ├── bootstrap-validate-env.sh           ← start-of-run env validation (gh-user / age / jq / rails / chrome)
│       ├── bootstrap-exchange-manifest.sh      ← redeem the manifest `code` → app_id + private-key PEM + secrets
│       ├── bootstrap-build-vault.sh            ← age-encrypt the assembled creds → vault.age (shreds plaintext)
│       ├── bootstrap-commit-vault.sh           ← commit vault.age to the science repo (fail-if-exists, never --force)
│       └── bootstrap-emit-commands.sh          ← render the VM-side macf init + verification commands
├── .mcp.json                                   ← Chrome DevTools MCP server, --browser-url to the operator's Chrome
├── templates/
│   ├── macf-app-manifest.json                  ← the DR-019 App manifest the skill submits (manifest flow)
│   ├── vault.template.txt                      ← the vault plaintext shape (output #1)
│   ├── vault.sh                                ← vault accessor committed alongside vault.age (decrypt + materialize keys)
│   └── bootstrap-spec.example.json             ← example project spec for bootstrap-emit-commands.sh
└── README.md                                   ← this file
```

## References

- `design/decisions/DR-035-macf-bootstrap-github-provisioning-skill.md` — the full design; §2 is what this scaffold implements.
- `.claude/rules/macf-bootstrap-safety.md` — the standing safety brief.
- `packages/macf/templates/macf-app-manifest.json` — canonical source of the bundled DR-019 manifest.
