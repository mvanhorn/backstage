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

import { OpaqueType } from '@internal/opaque';
import { CatalogModelOp } from './operations';
import { JsonObject } from '@backstage/types';

// #region CatalogModelExtension

/**
 * An opaque type that represents a set of catalog model extensions.
 *
 * @alpha
 */
export interface CatalogModelExtension {
  readonly $$type: '@backstage/CatalogModelExtension';
  /**
   * A human readable identifying name for this model extension. Used in logging
   * and similar.
   */
  readonly modelName: string;
}

/**
 * The opaque type that represents a catalog model extension.
 *
 * @internal
 * @remarks
 *
 * Model extensions are essentially an array of operations. Several such model
 * extensions are merged together to form a final outcome.
 */
export const OpaqueCatalogModelExtension = OpaqueType.create<{
  public: CatalogModelExtension;
  versions: {
    readonly version: 'v1';
    readonly modelName: string;
    readonly ops: Array<CatalogModelOp>;
  };
}>({
  type: '@backstage/CatalogModelExtension',
  versions: ['v1'],
});

// #endregion

// #region CatalogModel

/**
 * The opaque type that represents a compiled catalog model.
 *
 * @internal
 */
export const OpaqueCatalogModel = OpaqueType.create<{
  public: CatalogModel;
  versions: {
    readonly version: 'v1';
    getKind(
      options:
        | { kind: string; apiVersion: string; type?: string }
        | { kind: string; apiVersion: string; spec: { type?: string } },
    ): CatalogModelKind | undefined;
    getRelations(kind: string): CatalogModelRelation[] | undefined;
    readonly ops: Array<CatalogModelOp>;
  };
}>({
  type: '@backstage/CatalogModel',
  versions: ['v1'],
});

/**
 * A compiled catalog model.
 *
 * @alpha
 */
export interface CatalogModel {
  readonly $$type: '@backstage/CatalogModel';

  /**
   * All of the ops that were used to build this model, in the order they were
   * applied.
   */
  ops: ReadonlyArray<CatalogModelOp>;

  /**
   * Look up a kind in the model.
   *
   * @returns The kind if found, or `undefined` if no matching kind exists.
   * @throws TypeError if the kind exists in the model, but not for this apiVersion or type.
   */
  getKind(
    options:
      | { kind: string; apiVersion: string; type?: string }
      | { kind: string; apiVersion: string; spec: { type?: string } },
  ): CatalogModelKind | undefined;
  /**
   * Look up all relations that originate from a given kind.
   *
   * @param kind - The kind name, e.g. "Component".
   * @returns The relations originating from the kind, or `undefined` if the
   *   kind is not known.
   */
  getRelations(kind: string): CatalogModelRelation[] | undefined;
}

// #endregion

// #region CatalogModelKind

/**
 * A compiled catalog model kind.
 *
 * @alpha
 */
export interface CatalogModelKind {
  /**
   * The API version(s) of the kind that this schema applies to, e.g.
   * "backstage.io/v1alpha1".
   */
  apiVersions: string[];

  /**
   * The names used for this kind.
   */
  names: {
    /**
     * The name of the kind with proper casing, e.g. "Component".
     */
    kind: string;

    /**
     * The singular form of the kind name, e.g. "component".
     */
    singular: string;

    /**
     * The plural form of the kind name, e.g. "components".
     */
    plural: string;
  };

  /**
   * The relation fields declared for this kind, with full dot-separated paths
   * into the entity (e.g. "spec.owner").
   */
  relationFields: Array<{
    /**
     * The full dot-separated path to the field in the entity, e.g. "spec.owner".
     */
    path: string;
    /**
     * The relation type that this field generates, e.g. "ownedBy".
     */
    relation: string;
    /**
     * The default kind for parsing shorthand entity refs.
     */
    defaultKind?: string;
    /**
     * The default namespace for parsing shorthand entity refs.
     */
    defaultNamespace?: 'inherit' | 'default';
    /**
     * The kinds that are allowed as targets for this relation field.
     */
    allowedKinds?: string[];
  }>;

  /**
   * The JSON schema of the kind.
   *
   * @remarks
   *
   * This can be used for validation of entities. Note that it is up to the
   * caller to ensure that the kind and apiVersion match what you are validating
   * against.
   */
  jsonSchema: JsonObject;
}

// #endregion

// #region CatalogModelRelation

/**
 * A compiled catalog model relation.
 *
 * @alpha
 */
export interface CatalogModelRelation {
  /**
   * The kinds that this relation can originate from.
   */
  fromKind: string[];
  /**
   * The kinds that this relation can point to.
   */
  toKind: string[];
  /**
   * A human-readable comment describing the relation.
   */
  comment: string;
  /**
   * The forward direction of this relation.
   */
  forward: {
    type: string;
    singular: string;
    plural: string;
  };
  /**
   * The reverse direction of this relation.
   */
  reverse: {
    type: string;
    singular: string;
    plural: string;
  };
}

// #endregion
