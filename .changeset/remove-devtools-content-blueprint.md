---
'@backstage/plugin-catalog-unprocessed-entities': patch
'@backstage/plugin-devtools': patch
'@backstage/plugin-devtools-react': minor
---

Removed the deprecated `DevToolsContentBlueprint` from `@backstage/plugin-devtools-react`. DevTools pages in the new frontend system now use `SubPageBlueprint` tabs instead, and the catalog unprocessed entities alpha extension now attaches to DevTools as a subpage.
