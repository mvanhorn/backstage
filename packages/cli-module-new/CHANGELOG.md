# @backstage/cli-module-new

## 0.1.0

### Minor Changes

- 329f394: Initial release of the CLI module packages. Each module provides a set of commands that can be discovered automatically by `@backstage/cli` or executed standalone.

### Patch Changes

- ebeb0d4: Updated the new frontend plugin template to use `@backstage/frontend-dev-utils` in its `dev/` entry point instead of wiring `createApp` manually. Generated plugins now get the same dev app helper setup as the built-in examples.
- Updated dependencies
  - @backstage/cli-node@0.3.0
  - @backstage/cli-common@0.2.0
