export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', [
      'feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'ci', 'revert', 'build', 'style',
    ]],
  },
};
