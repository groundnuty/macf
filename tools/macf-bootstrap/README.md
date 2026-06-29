# macf-bootstrap — operator-privileged GitHub-provisioning workspace

This directory is the **safety-foundation workspace template** for
`macf-bootstrap` (DR-035) — the operator-invoked tool that provisions a whole
MACF fleet's GitHub side (the per-agent GitHub Apps, their keys, installs, repos,
secrets, CA var, vault) that no CLI can create on its own.

> **P1 scope (this directory).** This is the *workspace scaffold* + the two
> structural safety rails. The provisioning **skill** itself (the brains:
> Q&A intake → manifest flow → `gh` orchestration → vault → emitted commands)
> lands in **P2** as a separate marketplace plugin. This scaffold is what makes
> the skill safe to run with no per-action prompts.

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

## How the operator tests this workspace

1. Clone this `tools/macf-bootstrap/` directory to the Mac as the bootstrap
   workspace root (the eventual delivery is a standalone repo or a
   `macf bootstrap-init` scaffold — DR-035 open question; either consumes the
   same marketplace skill).
2. Ensure the **Chrome DevTools MCP** server is available (`npx
   chrome-devtools-mcp@latest` — wired in `.mcp.json`) and **`gh` is
   authenticated as the operator's user** (`gh auth status`). This workspace
   deliberately uses user auth, not a bot token.
3. Open Claude Code in this directory and approve the project MCP server when
   prompted.
4. (P2) Run the `/macf-bootstrap` skill and follow the Q&A intake → plan
   approval → run loop. **The skill is not in P1** — this scaffold only proves
   the rails.

### Driving the operator's logged-in Chrome

`.mcp.json` ships the canonical `npx -y chrome-devtools-mcp@latest` invocation,
which by default launches its own Chrome instance. To drive the operator's
**already-logged-in** browser (so OAuth/sudo reuse existing cookies — the whole
point of "no credential handling"), the operator points the MCP at a Chrome
started with remote debugging, e.g. add `"--browser-url=http://127.0.0.1:9222"`
to the `args` (after starting Chrome with `--remote-debugging-port=9222`). See
`npx chrome-devtools-mcp@latest --help` and the upstream README
(<https://github.com/ChromeDevTools/chrome-devtools-mcp>) for `--browser-url` /
`--channel` / profile options. This connection detail is an operator-setup
choice, intentionally left out of the committed `.mcp.json`.

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
│   ├── rules/
│   │   └── macf-bootstrap-safety.md            ← the DR-035 §2 safety contract, workspace-rule form
│   └── scripts/
│       ├── check-bootstrap-url-allowlist.sh    ← browser/MCP rail (default-deny URL allowlist)
│       └── check-bootstrap-gh-guard.sh         ← Bash/gh rail (destructive-deny + create-only secret set)
├── .mcp.json                                   ← Chrome DevTools MCP server (stdio)
├── templates/
│   └── macf-app-manifest.json                  ← the DR-019 App manifest the skill submits (manifest flow)
└── README.md                                   ← this file
```

## References

- `design/decisions/DR-035-macf-bootstrap-github-provisioning-skill.md` — the full design; §2 is what this scaffold implements.
- `.claude/rules/macf-bootstrap-safety.md` — the standing safety brief.
- `packages/macf/templates/macf-app-manifest.json` — canonical source of the bundled DR-019 manifest.
