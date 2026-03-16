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
  opDeclareAnnotationV1Schema,
  OpDeclareAnnotationV1,
} from './declareAnnotation';
import { opDeclareKindV1Schema, OpDeclareKindV1 } from './declareKind';
import { opDeclareLabelV1Schema, OpDeclareLabelV1 } from './declareLabel';
import { opDeclareTagV1Schema, OpDeclareTagV1 } from './declareTag';
import {
  opDeclareKindVersionV1Schema,
  OpDeclareKindVersionV1,
} from './declareKindVersion';
import {
  opDeclareRelationV1Schema,
  OpDeclareRelationV1,
} from './declareRelation';
import { opUpdateKindV1Schema, OpUpdateKindV1 } from './updateKind';
import {
  opUpdateKindVersionV1Schema,
  OpUpdateKindVersionV1,
} from './updateKindVersion';
import { opUpdateRelationV1Schema, OpUpdateRelationV1 } from './updateRelation';

export type {
  OpDeclareAnnotationV1,
  OpDeclareKindV1,
  OpDeclareLabelV1,
  OpDeclareTagV1,
  OpDeclareKindVersionV1,
  OpDeclareRelationV1,
  OpUpdateKindV1,
  OpUpdateKindVersionV1,
  OpUpdateRelationV1,
};

export type CatalogModelOp =
  | OpDeclareAnnotationV1
  | OpDeclareKindV1
  | OpDeclareLabelV1
  | OpDeclareTagV1
  | OpDeclareKindVersionV1
  | OpDeclareRelationV1
  | OpUpdateKindV1
  | OpUpdateKindVersionV1
  | OpUpdateRelationV1;

/**
 * Descriptor for a catalog model operation, mapping it to its parser.
 */
export interface CatalogModelOpDescriptor<T extends CatalogModelOp> {
  op: T['op'];
  order: number;
  parse: (data: unknown) => T;
}

/**
 * A mapping from each operation's `op` string to its descriptor, containing
 * the `op` literal and a `parse` function that validates unknown data into the
 * corresponding operation type.
 */
export const ops: {
  [K in CatalogModelOp['op']]: CatalogModelOpDescriptor<
    Extract<CatalogModelOp, { op: K }>
  >;
} = {
  'declareAnnotation.v1': {
    op: 'declareAnnotation.v1',
    order: 0,
    parse: data => opDeclareAnnotationV1Schema.parse(data),
  },
  'declareLabel.v1': {
    op: 'declareLabel.v1',
    order: 1,
    parse: data => opDeclareLabelV1Schema.parse(data),
  },
  'declareTag.v1': {
    op: 'declareTag.v1',
    order: 2,
    parse: data => opDeclareTagV1Schema.parse(data),
  },
  'declareKind.v1': {
    op: 'declareKind.v1',
    order: 3,
    parse: data => opDeclareKindV1Schema.parse(data),
  },
  'declareKindVersion.v1': {
    op: 'declareKindVersion.v1',
    order: 4,
    parse: data => opDeclareKindVersionV1Schema.parse(data),
  },
  'declareRelation.v1': {
    op: 'declareRelation.v1',
    order: 5,
    parse: data => opDeclareRelationV1Schema.parse(data),
  },
  'updateKind.v1': {
    op: 'updateKind.v1',
    order: 6,
    parse: data => opUpdateKindV1Schema.parse(data),
  },
  'updateKindVersion.v1': {
    op: 'updateKindVersion.v1',
    order: 7,
    parse: data => opUpdateKindVersionV1Schema.parse(data),
  },
  'updateRelation.v1': {
    op: 'updateRelation.v1',
    order: 8,
    parse: data => opUpdateRelationV1Schema.parse(data),
  },
};
