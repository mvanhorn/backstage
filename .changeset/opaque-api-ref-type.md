---
'@backstage/frontend-plugin-api': patch
---

Added a builder form for `createApiRef` in the new frontend system and deprecated the direct `createApiRef({ ... })` call in favor of `createApiRef().with({ ... })`. The builder form now also preserves literal API ref IDs in the resulting `ApiRef` type.

`ApiRef` now also supports an explicit `pluginId`, and the `createApiRef().with({ ... })` form can use it to declare API ownership without encoding the plugin ID into the API ref ID.
