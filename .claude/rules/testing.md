---
paths:
  - "test/**/*.ts"
---

# Testing

- All unit tests are static (no API calls) — mock MCP SDK and node:crypto responses
- E2E tests in `test/e2e/` are excluded from default vitest run (require real mTLS certificates)
- Test file naming: `{module}.test.ts`
- Use `describe`/`it` blocks with descriptive names
- Coverage thresholds: 80% lines, functions, branches (configured in vitest.config.ts)
- CLI code is excluded from coverage
