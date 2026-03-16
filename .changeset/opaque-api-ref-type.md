---
'@backstage/frontend-plugin-api': minor
---

**BREAKING**: The `ApiRef` type is now an opaque type with a `$$type` discriminator field and `readonly` properties. This means that `ApiRef` instances can no longer be created as plain object literals. Use `createApiRef` to create API references.

Added a new builder pattern for creating API references: `createApiRef<MyApi>().with({ id: 'plugin.my.api' })`. The existing `createApiRef<MyApi>({ id: 'plugin.my.api' })` pattern continues to work.
