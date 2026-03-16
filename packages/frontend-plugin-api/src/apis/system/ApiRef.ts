/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { ApiRef } from './types';

/**
 * API reference configuration - holds an ID of the referenced API.
 *
 * @public
 */
export type ApiRefConfig = {
  id: string;
};

function validateId(id: string): void {
  const valid = id
    .split('.')
    .flatMap(part => part.split('-'))
    .every(part => part.match(/^[a-z][a-z0-9]*$/));
  if (!valid) {
    throw new Error(
      `API id must only contain period separated lowercase alphanum tokens with dashes, got '${id}'`,
    );
  }
}

function makeApiRef<T>(id: string): ApiRef<T> {
  const ref = {
    $$type: '@backstage/ApiRef' as const,
    version: 'v1',
    id,
    toString() {
      return `apiRef{${id}}`;
    },
  };
  Object.defineProperty(ref, 'T', {
    get(): T {
      throw new Error(`tried to read ApiRef.T of ${this}`);
    },
    enumerable: false,
  });
  return ref as unknown as ApiRef<T>;
}

/**
 * Creates a reference to an API.
 *
 * @remarks
 *
 * The `id` is a stable identifier for the API implementation. The frontend
 * system infers the owning plugin for an API from the `id`. The recommended
 * pattern is `plugin.<plugin-id>.*` (for example,
 * `plugin.catalog.entity-presentation`). This ensures that other plugins can't
 * mistakenly override your API implementation.
 *
 * The recommended way to create an API reference is:
 *
 * ```ts
 * const myApiRef = createApiRef<MyApi>().with({ id: 'plugin.my.api' });
 * ```
 *
 * For backwards compatibility, you can also pass the config directly:
 *
 * ```ts
 * const myApiRef = createApiRef<MyApi>({ id: 'plugin.my.api' });
 * ```
 *
 * @public
 */
export function createApiRef<T>(config: ApiRefConfig): ApiRef<T>;
/**
 * Creates a reference to an API.
 *
 * @remarks
 *
 * Returns a builder with a `.with()` method for providing the `id`.
 *
 * @public
 */
export function createApiRef<T>(): {
  with(config: ApiRefConfig): ApiRef<T>;
};
export function createApiRef<T>(
  config?: ApiRefConfig,
): ApiRef<T> | { with(config: ApiRefConfig): ApiRef<T> } {
  if (config) {
    validateId(config.id);
    return makeApiRef<T>(config.id);
  }
  return {
    with(withConfig: ApiRefConfig): ApiRef<T> {
      validateId(withConfig.id);
      return makeApiRef<T>(withConfig.id);
    },
  };
}
