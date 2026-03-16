---
'@backstage/plugin-app': patch
---

Updated the `PageLayout` swap to render the `PluginHeader` for single-page plugins when `showHeader` is enabled, and to pass a clickable `titleLink` resolved from the plugin's root route ref.
