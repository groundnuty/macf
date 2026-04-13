---
paths:
  - "src/types/**/*.ts"
---

# Type Definitions

- All interfaces use `readonly` properties (immutability)
- Use Zod schemas for runtime validation, infer TypeScript types with `z.infer<>`
- Error classes extend a base `MacfError` with a unique `code` string
- Use `import type` for type-only imports (enforced by `verbatimModuleSyntax`)
