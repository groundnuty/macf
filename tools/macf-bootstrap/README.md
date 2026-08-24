# macf-bootstrap — operator-privileged fleet-provisioning workspace

This directory is the **dev source** for `macf-bootstrap` (DR-035) — a **separate
product**, delivered as the standalone `groundnuty/macf-automated-github-setup`
repo (what users clone), developed here in the macf monorepo and published to that
repo at each version (the `macf-actions` / `macf-marketplace` pattern).

> **Repositioned by DR-043 (2026-08-11, operator-ratified).** The actual
> provisioning *mechanism* — creating the per-agent GitHub Apps, their keys,
> installs, repos, secrets, CA, and the age-encrypted vault — now lives in the
> deterministic `macf bootstrap plan|apply` CLI, driven by a declarative
> `fleet.yaml` manifest (`design/decisions/DR-043-declarative-fleet-provisioning.md`;
> schema: `packages/macf/src/cli/bootstrap/fleet-manifest.ts`). **This workspace's
> skill is now an optional conversational *front-end*** to that CLI — it turns a
> Q&A interview into `fleet.yaml` and hands off, no more. It does not drive a
> browser: see `.claude/skills/macf-bootstrap/SKILL.md` for what changed and why
> most of the browser-rail detail below is now legacy (kept, per
> `groundnuty/macf#877`, because the rail files themselves haven't been removed —
> only the procedure that used to invoke them). If you'd rather hand-author
> `fleet.yaml` directly, that's equally valid; the skill exists for operators who'd
> rather answer questions.

> **Scope.** This directory carries the *workspace scaffold* + the two structural
> safety rails (P1) **and** the intake **skill** itself (P2–P5): the brains at
> `.claude/skills/macf-bootstrap/SKILL.md` (Q&A intake → write `fleet.yaml` → invoke
> `macf bootstrap plan`/`apply`) plus deterministic helper scripts
> (`.claude/scripts/bootstrap-*.sh`) and vault templates
> (`templates/vault.{sh,template.txt}`) inherited from the pre-DR-043 flow — some of
> these (the browser-rail scripts, the manifest-exchange/vault-assembly helpers) are
> no longer invoked by the current procedure but remain on disk. The scaffold is
> what makes the skill safe to run with no per-action prompts.

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
   revoke) are explicitly denied. **Currently unexercised by the skill's own
   procedure** (DR-043 moved App creation/install into the CLI's own `localhost`
   redirect + JWT-poll, which never touches `mcp__chrome-devtools__*` — see the
   skill file) — left wired rather than removed, so an operator who still drives
   the browser by hand from this workspace keeps the fence.

The fleet attribution-guard hooks (`check-gh-token.sh` et al.) are
**deliberately omitted** here — this workspace is *supposed* to act as the
operator, not a `ghs_` bot token. That omission is documented explicitly in
`settings.json`; absence here is design, not drift.

> **Why the browser rail is a hook, not a deny rule:** in Claude Code a
> permission `deny` fires *before* PreToolUse hooks and skips them, and
> `permissions.deny` cannot arg-match `mcp__*` tools. So the chrome-devtools MCP
> tools stay in `permissions.allow` and the URL policy lives entirely in the
> hook. Do not move them to `deny` — that disables the URL guard.

## Versioning + macf-framework compatibility (DR-035 §7)

`macf-bootstrap` is versioned **independently of the macf framework** — it is a
tool, not the framework, on its own cadence. Its version lives in
`.claude-plugin/plugin.json` (the macf-bootstrap line starts at `0.1.0`); it is
**not** lockstep with the `macf`/`@groundnuty/macf-channel-server` version.

Because it is not lockstep, the plugin **declares the framework range it needs**
and that declaration is **enforced** (not merely documented):

```jsonc
// .claude-plugin/plugin.json
{
  "name": "macf-bootstrap",
  "version": "0.1.0",                 // independent; NOT the framework version
  "compatibility": { "macf": ">=0.2.43" }   // the macf range this version needs
}
```

The `>=0.2.43` baseline is the framework version that ships the DR-030 fleet
commands + the 0.2.43 forensic-log / launcher this skill builds on.

**Enforcement (safe-by-refusal extends to version-skew).** The workspace runs
`macf` locally — it generates the per-project CA and emits the VM-side
`macf init` commands (DR-035 §3) — so a too-old or absent `macf` would silently
produce broken output. `bootstrap-validate-env.sh` therefore reads
`.compatibility.macf` from `plugin.json`, reads the installed `macf --version`,
and **fails loud** (critical, stops the run) when the installed macf does not
satisfy the range — with an actionable message:

> `macf-bootstrap 0.1.0 requires macf >=0.2.43; found 0.2.X; run npm i -g @groundnuty/macf@latest`

An *unparseable* or *absent* `macf --version` is treated the same way (refuse —
we never run against a framework we cannot verify). This is the same
**safe-by-refusal** posture as the deny-rails: the skill won't run against an
incompatible framework, just as it won't run in a workspace missing the safety
env (`age` / user-`gh` / the two deny-rails — see the safety model above).

## Installing

**One-time, for all use-cases** (not per project) — create the standalone workspace
repo so you can `git clone` just the bootstrap workspace. This is an **operator
action**: a scoped bot can't `gh repo create` (account-level) — the same
chicken-and-egg privilege reason macf-bootstrap itself runs *as the operator* (DR-035).
Run where `gh` is authed **as you**:

```bash
SRC=<your-macf-checkout>/tools/macf-bootstrap   # this directory
gh repo create groundnuty/macf-automated-github-setup --private \
  --description "Operator-privileged MACF fleet GitHub-provisioning workspace (DR-035)."
TMP=$(mktemp -d); cp -a "$SRC/." "$TMP/"; cd "$TMP"
git init -b main && git add -A && git commit -m "chore: macf-bootstrap workspace v0.1.0"
git remote add origin https://github.com/groundnuty/macf-automated-github-setup.git
git push -u origin main
```

Then the **operator (user) clones the product repo** and works there: `git clone https://github.com/groundnuty/macf-automated-github-setup ~/macf-automated-github-setup`.

> **This `tools/macf-bootstrap/` directory is the DEV SOURCE, not a user path.** macf-bootstrap is a **separate product** delivered as the `groundnuty/macf-automated-github-setup` repo (the unit users clone) — exactly like the routing workflow ships as `groundnuty/macf-actions` and the plugin as `groundnuty/macf-marketplace`. The source is *developed* here in the macf monorepo (so it stays in `make check` CI + lockstep with the framework it calls) and *published* to the product repo at each version. Users never clone macf or `cd` into this subdir.

To **refresh / publish a new version**, re-sync this directory's contents into the product repo and push (the create-block above is the first publish; subsequent publishes re-sync + bump — see versioning below). The `sync-bootstrap-product.mjs` helper automates this:

```bash
node packages/macf/scripts/sync-bootstrap-product.mjs --target <macf-automated-github-setup-checkout>
# then in the product checkout: git add -A && git commit && git push
```

> **Caveat — it's a true mirror.** The sync prunes target-only files (except `.git/`). So any file that belongs in the product repo (a `LICENSE`, product-specific CI) must be added to **this source** `tools/macf-bootstrap/`, NOT directly to `macf-automated-github-setup`, or the next publish deletes it.

## Versioning / using a specific version

The **distribution unit is this complete workspace** (versioned + compat-declared),
surfaced in the marketplace at its **own** version. A marketplace plugin carries
the skill + the Chrome `mcpServers` + the deny-hooks + the version + the compat
range — but **not** `permissions` (those are workspace-owned in Claude Code), so
the operator-privilege permissions travel with the workspace template, and the
skill's env-validation **refuses to run without the deny-rails**. To pin a
version, clone/check-out the workspace at its tag (or install the marketplace
entry at that version). *The marketplace registration itself is handled
separately* (the framework maintainer publishes the plugin into
`groundnuty/macf-marketplace`); this directory is the source workspace it is cut
from.

## How the operator runs this workspace

Two equally valid starting points — the skill exists only to save the operator from
hand-authoring `fleet.yaml`:

**With the intake skill (Q&A → `fleet.yaml` → CLI):**

1. The operator clones the **product repo** to wherever `macf bootstrap` will run
   (needs `gh` authenticated as the operator's **user**, `age`, and the `macf` CLI —
   no Chrome, no browser-automation MCP):
   `git clone https://github.com/groundnuty/macf-automated-github-setup`
   (NOT this `tools/macf-bootstrap/` dev-source subdir — see the note above; either
   consumes the same skill).
2. Open Claude Code in this directory.
3. Run the **`macf-bootstrap`** skill (`.claude/skills/macf-bootstrap/SKILL.md`) and
   follow its Q&A intake → `fleet.yaml` → `macf bootstrap plan` → `macf bootstrap
   apply` loop. It validates the environment first (`bootstrap-validate-env.sh`), so
   non-user `gh` / missing `age` / an incompatible `macf` version stops loud before
   any provisioning. (The script's Chrome-reachability line is a leftover
   best-effort check from the pre-DR-043 flow — it never blocks the run; ignore it.)

**Without the skill (hand-authored `fleet.yaml`):** write the manifest directly per
`packages/macf/src/cli/bootstrap/fleet-manifest.ts` / DR-043 §D1, then run
`macf bootstrap plan -f fleet.yaml` and `macf bootstrap apply -f fleet.yaml` — no
Claude Code session in this workspace is needed for this path at all.

### Legacy: driving a browser from this workspace (pre-DR-043 mechanism, no longer needed for the default flow)

The Chrome DevTools MCP wiring below (`.mcp.json`, the URL-allowlist rail) predates
DR-043 and is **not exercised by the current skill procedure** — App creation and
install now happen via the CLI's own `localhost` redirect + JWT polling, in whichever
browser the operator already has open, with no MCP involved. It is kept here (not
deleted) because the rail scripts themselves haven't been removed
(`groundnuty/macf#877` scoped that separately) and because it documents a real,
previously-hit first-run trap if this workspace is ever used to drive a browser by
hand again. Skip this section for a normal run.

Starting a debug Chrome, if you genuinely need one:

```bash
# macOS — quit Chrome first, then:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222
# verify it's listening:
curl -s http://127.0.0.1:9222/json/version
```

`.mcp.json` points the Chrome DevTools MCP at `--browser-url=http://127.0.0.1:9222`,
so it **attaches** to that Chrome rather than launching a fresh, logged-out instance.
(Override the debug URL for the env-validation probe with
`MACF_BOOTSTRAP_CHROME_URL`.) See the upstream chrome-devtools-mcp README
(<https://github.com/ChromeDevTools/chrome-devtools-mcp>) for `--browser-url` /
`--channel` / profile options if the operator's Chrome setup differs.

#### Getting a *logged-in* debug Chrome (first-run finding, `macf-automated-github-setup#1`)

The naive `--remote-debugging-port=9222` launch above only works if **no Chrome is
already running**. In practice it usually is, and the result is the single most
confusing first-run trap:

- A running Chrome is a **singleton** — a second launch with
  `--remote-debugging-port` just focuses the existing window and **ignores the
  flag** (no debug port opens).
- You **cannot** enable the debug port on an already-running instance.
- Launching with a fresh `--user-data-dir` *does* open the port, but that profile
  is **logged out** — which defeats the entire premise ("drive the operator's
  already-logged-in GitHub session, never handle credentials").

**The working path: copy the operator's logged-in profile into an isolated
`--user-data-dir`, and run the debug instance off the copy.** The real Chrome and
session are never touched; the copy is logged-in because it carries the cookies.
macOS recipe:

```bash
SRC="$HOME/Library/Application Support/Google/Chrome"      # the live profile root
COPY="$HOME/.macf-bootstrap-chrome"                         # isolated debug profile

# 1. Copy the logged-in 'Default' profile + 'Local State' (cookies/keys), excluding
#    the big, regenerable caches + history so the copy is small and clean.
mkdir -p "$COPY"
rsync -a --delete \
  --exclude 'Cache' --exclude 'Code Cache' --exclude 'GPUCache' \
  --exclude 'Service Worker' --exclude 'History*' --exclude 'Top Sites*' \
  "$SRC/Default" "$COPY/"
cp -f "$SRC/Local State" "$COPY/Local State"

# 2. A copied profile carries Singleton* lock files that make Chrome think another
#    instance owns it — remove them so the debug instance can start.
rm -f "$COPY/Default/Singleton"* "$COPY/Singleton"*

# 3. Launch the debug Chrome OFF THE COPY (the operator's real Chrome can stay open).
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir="$COPY" --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check >/dev/null 2>&1 &

# 4. Verify the port is live AND the session is logged-in (identity check via MCP:
#    navigate to https://github.com/settings/profile and confirm the operator's login).
curl -s http://127.0.0.1:9222/json/version >/dev/null && echo "debug Chrome up on :9222"

# 5. CLEAN UP at the end of the run: kill the debug instance + remove the copy.
#    (Done as part of the run's teardown — the copy holds session cookies.)
#    pkill -f -- "--user-data-dir=$COPY"   # or close the debug window
#    rm -rf "$COPY"
```

`.mcp.json` already points the MCP at `--browser-url=http://127.0.0.1:9222`, so it
**attaches** to this debug instance. **`claude-in-chrome` is NOT a substitute** —
it drives Chrome outside the `check-bootstrap-url-allowlist.sh` rail, so the
browser surface would be un-fenced.

## Override env vars (deliberate exceptions only)

| Variable | Effect |
|---|---|
| `MACF_BOOTSTRAP_SKIP_URL_GUARD=1` | Bypass the browser URL allowlist for one run. |
| `MACF_BOOTSTRAP_SKIP_GH_GUARD=1` | Bypass the gh destructive/overwrite guard for one run. |
| `MACF_BOOTSTRAP_ALLOW_OVERWRITE=1` | Permit an intended secret/variable overwrite. |

## Layout

```
tools/macf-bootstrap/
├── .claude-plugin/
│   └── plugin.json                            ← independent version + compatibility.macf range (DR-035 §7); enforced by bootstrap-validate-env.sh
├── .claude/
│   ├── settings.json                          ← operator-privilege allow + dual-surface deny + the 2 PreToolUse rails
│   ├── skills/
│   │   └── macf-bootstrap/
│   │       └── SKILL.md                        ← intake front-end (Q&A → fleet.yaml → `macf bootstrap plan`/`apply`; DR-043)
│   ├── rules/
│   │   └── macf-bootstrap-safety.md            ← the DR-035 §2 safety contract, workspace-rule form (browser-rail part now legacy — see its own top note)
│   └── scripts/
│       ├── check-bootstrap-url-allowlist.sh    ← browser/MCP rail (default-deny URL allowlist) — unexercised by the current procedure, kept wired
│       ├── bootstrap-rail-selftest.sh          ← on-request proof the URL rail BLOCKS destructive nav (exit 2) + ALLOWs provisioning
│       ├── check-bootstrap-gh-guard.sh         ← Bash/gh rail (destructive-deny + create-only secret set)
│       ├── bootstrap-validate-env.sh           ← start-of-run env validation (gh-user / age / jq / rails; the chrome check is a legacy no-op)
│       ├── bootstrap-exchange-manifest.sh      ← pre-DR-043: redeem the manifest `code` via a page read — superseded by the CLI's own localhost exchange, unused by the current procedure
│       ├── bootstrap-build-vault.sh            ← pre-DR-043 vault assembly — superseded by the CLI's `vault-write.ts`, unused by the current procedure
│       ├── bootstrap-commit-vault.sh           ← pre-DR-043: commit vault.age to an agent's science repo — superseded by the CLI's control-repo commit (DR-043 Amendment F), unused by the current procedure
│       ├── bootstrap-cleanup.sh                ← wipe the .bootstrap-work/ scratch dir (always; success + abort) — still useful if the skill's own scratch files are used
│       └── bootstrap-emit-commands.sh          ← pre-DR-043: render the VM-side macf init commands — superseded by `macf fleet deploy`, unused by the current procedure
├── .gitignore                                  ← keep scratch secrets out of git (.bootstrap-work/, *.app.json, vault*.age, age key)
├── .mcp.json                                   ← Chrome DevTools MCP server, --browser-url to the operator's Chrome
├── templates/
│   ├── macf-app-manifest.json                  ← the DR-019 App manifest the skill submits (manifest flow)
│   ├── vault.template.txt                      ← the vault plaintext shape (output #1)
│   ├── vault.sh                                ← vault accessor committed alongside vault.age (decrypt + materialize keys)
│   └── bootstrap-spec.example.json             ← example project spec for bootstrap-emit-commands.sh
└── README.md                                   ← this file
```

> **Secrets-on-disk hygiene (DR-035 §4).** The vault plaintext is never written
> to a file — it is piped to `bootstrap-build-vault.sh` on STDIN and streamed into
> `age`. The scratch dir `.bootstrap-work/` (per-agent `*.app.json` PEMs, the
> `vault.age`, the age key, the spec) is `.gitignore`d and wiped by
> `bootstrap-cleanup.sh` on both success and abort. `shred` is best-effort and a
> no-op on macOS/APFS — the real at-rest protection is FileVault; the structural
> wins are the STDIN-pipe + `.gitignore` + always-cleanup.

## References

- `design/decisions/DR-043-declarative-fleet-provisioning.md` — the current provisioning mechanism (`fleet.yaml`, `macf bootstrap plan|apply`, the reconcile model); this skill is now that DR's §D2 "optional conversational front-end."
- `design/decisions/DR-035-macf-bootstrap-github-provisioning-skill.md` — the original design + its 2026-08-11 amendment recording the DR-043 repositioning; §2 is what this scaffold still implements (the workspace safety contract).
- `design/decisions/DR-044-fleet-authority.md` — why App creation/install can never be fully automated (Decision 1) and who may run a fleet-wide command.
- `packages/macf/src/cli/bootstrap/fleet-manifest.ts` — the live `fleet.yaml` schema (authoritative over any example in a design doc).
- `.claude/rules/macf-bootstrap-safety.md` — the standing safety brief.
- `packages/macf/templates/macf-app-manifest.json` — canonical source of the bundled DR-019 manifest.
