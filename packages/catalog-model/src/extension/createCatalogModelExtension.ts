/*
 * Copyright 2026 The Backstage Authors
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

import {
  CatalogModelExtensionBuilder,
  createCatalogModelExtensionBuilder,
} from './createCatalogModelExtensionBuilder';
import { CatalogModelExtension } from './types';

/**
 * Creates a catalog model extension using a builder pattern.
 *
 * @alpha
 * @remarks
 *
 * Plugins can create such catalog model extensions to declare various
 * contributions to the overall catalog model, and registering them with the
 * catalog which then forms a complete picture out of them.
 */
export function createCatalogModelExtension(
  modelName: string,
  model: (model: CatalogModelExtensionBuilder) => void,
): CatalogModelExtension {
  const builder = createCatalogModelExtensionBuilder({ modelName });
  model(builder);
  return builder.build();
}
