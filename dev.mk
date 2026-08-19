.PHONY: install check test lint typecheck build clean test-e2e test-integration install-hooks \
	release-bump release-check release-marketplace release-cli release-verify release release-dry \
	dr-citations-state dr-citations-diff

install:
	devbox run -- npm ci

# CI gate — installs deps, type-checks (no emit), lints, runs tests.
# Does NOT emit dist/ — validation doesn't need an artifact and the
# extra tsc emit adds ~8s to every CI run. Use `make -f dev.mk build`
# for emit. See #127 for the rename rationale.
check: install typecheck lint test

# Type-check only (no emit). Fast; safe for editors and pre-commit
# hooks. Formerly named `build` — renamed per #127 because it doesn't
# produce a build artifact. Routed through npm workspaces so the
# tsconfig.json lives next to the package (post #206 monorepo convert).
typecheck:
	devbox run -- npm run typecheck --workspaces --if-present

# Real compile — emits dist/ via tsc config, then stamps
# dist/.build-info.json via the npm postbuild hook so stale-dist
# detection has data to work with (#144). Must go through
# `npm run build`, not bare `npx tsc`, or the postbuild hook won't
# fire. Needed when installing the CLI globally (`npm link`) or
# publishing; the dist/ that npm-link consumes must be rebuilt after
# source changes. See #127 for the hard-to-debug failure mode
# surfaced during the #125 / #126 EKU rollout step 2.
build:
	devbox run -- npm run build --workspaces --if-present

lint:
	devbox run -- npm run lint --workspaces --if-present

test:
	devbox run -- npm run test --workspaces --if-present

test-e2e:
	devbox run -- npm run test:e2e --workspaces --if-present

# Integration tests that require external runtime deps beyond what
# `make check` assumes — currently just `test:integration` on
# macf-channel-server, which spawns a Python subprocess with the
# official `a2a-sdk` to triangulate AgentCard parsing (macf#376).
# Devbox-Python is mandatory; the venv is cached under
# `node_modules/.cache/a2a-python-venv` so subsequent runs are fast.
# Gated out of `make check` because the first-run pip-install adds
# ~10s + a hard devbox-python dependency that the regular check flow
# shouldn't need.
test-integration:
	devbox run -- npm run test:integration --workspaces --if-present

clean:
	rm -rf packages/*/dist packages/*/coverage coverage

# Wire the repo-local commit-msg hook that runs commitlint against
# every local commit. One-time per clone; sets `core.hooksPath` to
# `.githooks/` so the hook is picked up going forward. Closes the
# loop on #158 (three commitlint violations in a week caught on CI
# rather than locally). Opt-in by design — operators who use their
# own shared hook infrastructure (global hooksPath, husky, etc.) can
# skip this step; CI keeps enforcing as a backstop.
install-hooks:
	git config core.hooksPath .githooks
	@echo "Installed commit-msg hook. Future commits will run commitlint locally before landing."

# ---------------------------------------------------------------------------
# Release orchestration (macf#766) — codifies the hand-orchestrated ~8-step
# release sequence (bump 3 package.json + inter-dep + lockfile + CHANGELOG ->
# check -> build -> marketplace sync/bump/tag -> push CLI bump + tag ->
# poll publish.yml -> verify npm) run by hand for v0.2.48 through v0.2.52.
# Thin wrappers around `packages/macf/scripts/release.sh` — see that script
# for the guards (CHANGELOG-heading presence, version-greater-than-current,
# idempotent tag-exists checks, fast-forward check on main, DR-022
# Amendment L no-retry-same-version on publish failure).
#
# Component targets allow partial re-runs (e.g. re-run just
# `release-marketplace` after a transient clone/push failure, without
# redoing the bump). `release` is the full end-to-end aggregate; `release-dry`
# runs the same aggregate under --dry-run, which is FULLY side-effect-free
# (no file writes, no commits, no pushes, no tags, no publish) — a safe
# preview before committing to a real cut.
#
# Usage:
#   make -f dev.mk release VERSION=0.2.53          # full release, end to end
#   make -f dev.mk release-dry VERSION=0.2.53       # safe preview, mutates nothing
#   make -f dev.mk release-marketplace VERSION=0.2.53   # partial re-run
#
# VERSION is required on every release-* target (fails loud if empty).
# ---------------------------------------------------------------------------
RELEASE_SH := packages/macf/scripts/release.sh

release-bump:
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make -f dev.mk release-bump VERSION=0.2.53"; exit 1; }
	bash $(RELEASE_SH) bump $(VERSION)

release-check:
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make -f dev.mk release-check VERSION=0.2.53"; exit 1; }
	bash $(RELEASE_SH) check $(VERSION)

release-marketplace:
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make -f dev.mk release-marketplace VERSION=0.2.53"; exit 1; }
	bash $(RELEASE_SH) marketplace $(VERSION)

release-cli:
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make -f dev.mk release-cli VERSION=0.2.53"; exit 1; }
	bash $(RELEASE_SH) cli $(VERSION)

release-verify:
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make -f dev.mk release-verify VERSION=0.2.53"; exit 1; }
	bash $(RELEASE_SH) verify $(VERSION)

release:
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make -f dev.mk release VERSION=0.2.53"; exit 1; }
	bash $(RELEASE_SH) all $(VERSION)

release-dry:
	@test -n "$(VERSION)" || { echo "VERSION is required, e.g. make -f dev.mk release-dry VERSION=0.2.53"; exit 1; }
	MACF_RELEASE_DRY_RUN=1 bash $(RELEASE_SH) all $(VERSION)

# ---------------------------------------------------------------------------
# DR-citation enforcement (groundnuty/macf#998) — local convenience wrappers
# around packages/macf/scripts/check-dr-citations{,-diff}.sh. See those
# scripts' headers for the convention + semantics. Not part of `check:` —
# the diff check needs a base ref to compare against, which a bare local
# run doesn't have a canonical default for (unlike `check:`, which is
# meaningful with zero arguments). Wired into CI instead: `ci.yml`'s
# `dr-citations` job runs both on every pull_request.
# ---------------------------------------------------------------------------
HEAD ?= HEAD

dr-citations-state:
	bash packages/macf/scripts/check-dr-citations.sh

dr-citations-diff:
	@test -n "$(BASE)" || { echo "BASE is required, e.g. make -f dev.mk dr-citations-diff BASE=origin/main"; exit 1; }
	bash packages/macf/scripts/check-dr-citations-diff.sh "$(BASE)" "$(HEAD)"
