---
'@backstage/frontend-plugin-api': patch
---

Added a builder form for `createApiRef` in the new frontend system and deprecated the direct `createApiRef({ ... })` call in favor of `createApiRef().with({ ... })`.

`ApiRef` and `ApiRefConfig` now also support an explicit `pluginId`, making it possible to declare API ownership without encoding the plugin ID into the API ref ID.
