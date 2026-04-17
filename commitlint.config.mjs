// Commit type convention for macf:
//
//   feat         — new user-visible feature
//   fix          — bug fix (no security implication)
//   security     — security fix (vulnerability, hardening) — distinct from
//                  `fix` so release notes + `git log --grep='^security'`
//                  surface them separately. See issue #88.
//   reliability  — observability / robustness hardening (audit / ultrareview
//                  findings, silent-failure fixes) — distinct from `fix`
//                  so release notes + `git log --grep='^reliability'`
//                  surface them separately. See issue #133 (precedent-
//                  matched from the `security` addition).
//   refactor     — behavior-preserving restructure
//   perf         — performance improvement
//   docs         — documentation only
//   test         — tests only
//   chore        — tooling, build, meta (non-user-facing)
//   ci           — CI / GitHub Actions changes
//   build        — build system changes
//   style        — formatting only (rare; prefer `refactor` or `chore`)
//   revert       — revert a prior commit

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', [
      'feat', 'fix', 'security', 'reliability',
      'refactor', 'perf', 'docs', 'test',
      'chore', 'ci', 'revert', 'build', 'style',
    ]],
  },
};
