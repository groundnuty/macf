# Run `make -f dev.mk check` before every PR

## Applies to

The `groundnuty/macf` repo — code-agent, and any worker producing a PR against
the framework source.

## Rule

Before opening or updating a PR, run the full local gate:

    make -f dev.mk check

It installs, typechecks, lints, and runs the unit suite across all three
packages (macf / macf-channel-server / macf-core). A PR that hasn't passed this
gate locally is not ready for review — CI will catch it, but burning a review
round-trip on a lint error is avoidable friction.

If you `npm link`ed the CLI and then changed source, also run
`make -f dev.mk build` so `dist/` isn't stale (otherwise the linked CLI runs
yesterday's code).

## Rationale

This SPECIALIZES the universal pr-discipline rules (which say "tests must pass")
with the MACF-repo-specific command + devbox/Makefile workflow. It is a tier-2
project rule, not universal: a fresh non-MACF deployment has no `dev.mk` and
must not receive it (which is exactly why the `macf init` seed is generic and
this concrete rule lives only in MACF's own `project-rules/`).
