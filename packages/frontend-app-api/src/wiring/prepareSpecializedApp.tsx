/*
 * Copyright 2023 The Backstage Authors
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

import { ConfigReader } from '@backstage/config';
import { isError } from '@backstage/errors';
import {
  ApiBlueprint,
  AnyApiFactory,
  ApiHolder,
  AppTree,
  ConfigApi,
  coreExtensionData,
  AppNode,
  AppNodeInstance,
  ExtensionDataRef,
  ExtensionFactoryMiddleware,
  FrontendFeature,
  featureFlagsApiRef,
  IdentityApi,
  identityApiRef,
  createExtensionDataRef,
} from '@backstage/frontend-plugin-api';
import { FilterPredicate } from '@backstage/filter-predicates';
import {
  createExtensionDataContainer,
  OpaqueFrontendPlugin,
} from '@internal/frontend';
import { OpaqueType } from '@internal/opaque';
import { ComponentType, ReactNode } from 'react';

// eslint-disable-next-line @backstage/no-relative-monorepo-imports
import {
  resolveExtensionDefinition,
  toInternalExtension,
} from '../../../frontend-plugin-api/src/wiring/resolveExtensionDefinition';

import { CreateAppRouteBinder } from '../routing';
import { resolveRouteBindings } from '../routing/resolveRouteBindings';
import { collectRouteIds } from '../routing/collectRouteIds';
// eslint-disable-next-line @backstage/no-relative-monorepo-imports
import {
  toInternalFrontendModule,
  isInternalFrontendModule,
} from '../../../frontend-plugin-api/src/wiring/createFrontendModule';
import { getBasePath } from '../routing/getBasePath';
import { Root } from '../extensions/Root';
import { resolveAppTree } from '../tree/resolveAppTree';
import { resolveAppNodeSpecs } from '../tree/resolveAppNodeSpecs';
import { readAppExtensionsConfig } from '../tree/readAppExtensionsConfig';
import { instantiateAppNodeSubtree } from '../tree/instantiateAppNodeTree';
import {
  createPluginInfoAttacher,
  FrontendPluginInfoResolver,
} from './createPluginInfoAttacher';
import {
  AppError,
  createErrorCollector,
  ErrorCollector,
} from './createErrorCollector';
import {
  AppTreeApiProxy,
  createPhaseApis,
  instantiateAndInitializePhaseTree,
  RouteResolutionApiProxy,
  setIdentityApiTarget,
} from './phaseApis';
import {
  collectPredicateReferences,
  createPredicateContextLoader,
  EMPTY_PREDICATE_CONTEXT,
  type ExtensionPredicateContext,
} from './predicates';
import {
  FrontendApiRegistry,
  FrontendApiResolver,
} from './FrontendApiRegistry';

function deduplicateFeatures(
  allFeatures: FrontendFeature[],
): FrontendFeature[] {
  // Start by removing duplicates by reference
  const features = Array.from(new Set(allFeatures));

  // Plugins are deduplicated by ID, last one wins
  const seenIds = new Set<string>();
  return features
    .reverse()
    .filter(feature => {
      if (!OpaqueFrontendPlugin.isType(feature)) {
        return true;
      }
      if (seenIds.has(feature.id)) {
        return false;
      }
      seenIds.add(feature.id);
      return true;
    })
    .reverse();
}

type SignInPageProps = {
  onSignInSuccess(identityApi: IdentityApi): void;
  children?: ReactNode;
};

/**
 * Result of bootstrapping a prepared specialized app.
 *
 * @public
 */
export type BootstrapSpecializedApp = {
  element: JSX.Element;
  tree: AppTree;
};

/**
 * Result of finalizing a prepared specialized app.
 *
 * @public
 */
export type FinalizedSpecializedApp = {
  element: JSX.Element;
  sessionState: SpecializedAppSessionState;
  tree: AppTree;
  errors?: AppError[];
};

type SignInRuntime = {
  error?: unknown;
  readyIdentityApi?: IdentityApi;
  requiresSignIn: boolean;
};

type FinalizationState = {
  started: boolean;
  promise: Promise<FinalizedSpecializedApp>;
  resolve(app: FinalizedSpecializedApp): void;
  reject(error: unknown): void;
};

type InternalSpecializedAppSessionState = {
  apis: ApiHolder;
  identityApi?: IdentityApi;
  predicateContext: ExtensionPredicateContext;
};

/**
 * Opaque reusable session state for specialized apps.
 *
 * @public
 */
export type SpecializedAppSessionState = {
  $$type: '@backstage/SpecializedAppSessionState';
};

const OpaqueSpecializedAppSessionState = OpaqueType.create<{
  public: SpecializedAppSessionState;
  versions: InternalSpecializedAppSessionState & {
    version: 'v1';
  };
}>({
  type: '@backstage/SpecializedAppSessionState',
  versions: ['v1'],
});

const signInPageComponentDataRef = createExtensionDataRef<
  ComponentType<SignInPageProps>
>().with({ id: 'core.sign-in-page.component' });

/**
 * Options for {@link prepareSpecializedApp}.
 *
 * @public
 */
export type PrepareSpecializedAppOptions = {
  /**
   * The list of features to load.
   */
  features?: FrontendFeature[];

  /**
   * The config API implementation to use. For most normal apps, this should be
   * specified.
   *
   * If none is given, a new _empty_ config will be used during startup. In
   * later stages of the app lifecycle, the config API in the API holder will be
   * used.
   */
  config?: ConfigApi;

  /**
   * Allows for the binding of plugins' external route refs within the app.
   */
  bindRoutes?(context: { bind: CreateAppRouteBinder }): void;

  /**
   * Advanced, more rarely used options.
   */
  advanced?: {
    /**
     * A reusable specialized app session state to use.
     *
     * This can be obtained from either the app passed to
     * {@link PreparedSpecializedApp.onFinalized} or from
     * {@link PreparedSpecializedApp.finalize}, and reused in a future app
     * instance to skip sign-in and session preparation.
     */
    sessionState?: SpecializedAppSessionState;

    /**
     * Applies one or more middleware on every extension, as they are added to
     * the application.
     *
     * This is an advanced use case for modifying extension data on the fly as
     * it gets emitted by extensions being instantiated.
     */
    extensionFactoryMiddleware?:
      | ExtensionFactoryMiddleware
      | ExtensionFactoryMiddleware[];

    /**
     * Allows for customizing how plugin info is retrieved.
     */
    pluginInfoResolver?: FrontendPluginInfoResolver;
  };
};

/**
 * Result of {@link prepareSpecializedApp}.
 *
 * @public
 */
export type PreparedSpecializedApp = {
  getBootstrapApp(): BootstrapSpecializedApp;
  onFinalized(callback: (app: FinalizedSpecializedApp) => void): () => void;
  finalize(options?: {
    sessionState?: SpecializedAppSessionState;
  }): FinalizedSpecializedApp;
};

// Internal options type, not exported in the public API
export interface CreateSpecializedAppInternalOptions
  extends PrepareSpecializedAppOptions {
  __internal?: {
    apiFactoryOverrides?: AnyApiFactory[];
  };
}

export function createSessionStateFromApis(
  apis: ApiHolder,
): SpecializedAppSessionState {
  return OpaqueSpecializedAppSessionState.createInstance('v1', {
    apis,
    identityApi: apis.get(identityApiRef),
    predicateContext: EMPTY_PREDICATE_CONTEXT,
  });
}

/**
 * Prepares an app without instantiating the full extension tree.
 *
 * @remarks
 *
 * This is useful for split sign-in flows where the sign-in page should be
 * rendered first, and the full app finalized once an identity has been
 * captured.
 *
 * @public
 */
export function prepareSpecializedApp(
  options?: PrepareSpecializedAppOptions,
): PreparedSpecializedApp {
  const internalOptions = options as CreateSpecializedAppInternalOptions;
  const config = options?.config ?? new ConfigReader({}, 'empty-config');
  const features = deduplicateFeatures(options?.features ?? []).map(
    createPluginInfoAttacher(config, options?.advanced?.pluginInfoResolver),
  );

  const collector = createErrorCollector();

  const tree = resolveAppTree(
    'root',
    resolveAppNodeSpecs({
      features,
      builtinExtensions: [
        resolveExtensionDefinition(Root, { namespace: 'root' }),
      ],
      parameters: readAppExtensionsConfig(config),
      forbidden: new Set(['root']),
      collector,
    }),
    collector,
  );

  const appBasePath = getBasePath(config);
  const routeRefsById = collectRouteIds(features, collector);
  const routeBindings = resolveRouteBindings(
    options?.bindRoutes,
    config,
    routeRefsById,
    collector,
  );

  const mergedExtensionFactoryMiddleware = mergeExtensionFactoryMiddleware(
    options?.advanced?.extensionFactoryMiddleware,
  );
  const providedSessionState = options?.advanced?.sessionState;
  const providedSessionData = providedSessionState
    ? OpaqueSpecializedAppSessionState.toInternal(providedSessionState)
    : undefined;
  const providedApis = providedSessionData?.apis;
  const bootstrapClassification = classifyBootstrapTree({
    tree,
    collector,
  });
  const predicateReferences = collectPredicateReferences(tree.nodes.values());
  const appApiRegistry = new FrontendApiRegistry();
  const internalStaticFactories =
    internalOptions?.__internal?.apiFactoryOverrides ?? [];
  const phaseStaticFactories = [...internalStaticFactories];
  const bootstrapApiFactoryEntries = new Map<string, ApiFactoryEntry>();
  const bootstrapMissingApiAccesses = new Map<
    string,
    { node: AppNode; apiRefId: string }
  >();

  if (providedApis) {
    registerFeatureFlagDeclarationsInHolder(providedApis, features);
  } else {
    collectApiFactoryEntries({
      apiNodes: (tree.root.edges.attachments.get('apis') ?? []).filter(
        apiNode => !bootstrapClassification.deferredApiRoots.has(apiNode),
      ),
      collector,
      entries: bootstrapApiFactoryEntries,
    });
    const apiFactories = Array.from(
      bootstrapApiFactoryEntries.values(),
      entry => wrapFeatureFlagApiFactory(entry.factory, features),
    );
    appApiRegistry.registerAll(apiFactories);
  }
  const phase = createPhaseApis({
    tree,
    config,
    appApiRegistry,
    fallbackApis: providedApis,
    includeConfigApi: !providedApis,
    appBasePath,
    routeBindings,
    staticFactories: phaseStaticFactories,
  });
  const predicateContextLoader = createPredicateContextLoader({
    apis: phase.apis,
    predicateReferences,
  });
  let signInRuntime: SignInRuntime | undefined;
  let cachedSessionState = providedSessionState;
  let sessionStatePromise: Promise<SpecializedAppSessionState> | undefined;
  let finalized: FinalizedSpecializedApp | undefined;
  let bootstrapApp: BootstrapSpecializedApp | undefined;
  let bootstrapError: Error | undefined;
  let finalizationState: FinalizationState | undefined;

  function updateIdentityApiTarget(identityApi?: IdentityApi) {
    if (!identityApi) {
      return;
    }

    setIdentityApiTarget({
      identityApiProxy: phase.identityApiProxy,
      identityApi,
      signOutTargetUrl: appBasePath || '/',
    });
  }

  function createSessionState(predicateContext: ExtensionPredicateContext) {
    const identityApi =
      signInRuntime?.readyIdentityApi ?? providedSessionData?.identityApi;
    updateIdentityApiTarget(identityApi);
    const sessionState = OpaqueSpecializedAppSessionState.createInstance('v1', {
      apis: phase.apis,
      identityApi,
      predicateContext,
    });
    cachedSessionState = sessionState;
    return sessionState;
  }

  function getImmediateSessionState() {
    if (cachedSessionState) {
      return cachedSessionState;
    }
    if (signInRuntime?.requiresSignIn) {
      return undefined;
    }

    const predicateContext = predicateContextLoader.getImmediate();
    if (!predicateContext) {
      return undefined;
    }

    return createSessionState(predicateContext);
  }

  function getSessionState() {
    const immediateSessionState = getImmediateSessionState();
    if (immediateSessionState) {
      return Promise.resolve(immediateSessionState);
    }
    if (sessionStatePromise) {
      return sessionStatePromise;
    }
    if (signInRuntime?.error) {
      return Promise.reject(signInRuntime.error);
    }
    if (signInRuntime?.requiresSignIn && !signInRuntime.readyIdentityApi) {
      return Promise.reject(
        new Error(
          'prepareSpecializedApp requires waiting for the bootstrap app to be ready before calling finalize()',
        ),
      );
    }

    sessionStatePromise = predicateContextLoader
      .load()
      .then(predicateContext => {
        if (cachedSessionState) {
          return cachedSessionState;
        }
        return createSessionState(predicateContext);
      })
      .catch(error => {
        sessionStatePromise = undefined;
        throw error;
      });

    return sessionStatePromise;
  }

  function finalizeFromSessionState(
    finalizedSessionState: SpecializedAppSessionState,
  ): FinalizedSpecializedApp {
    if (finalized) {
      return finalized;
    }

    cachedSessionState = finalizedSessionState;
    const sessionStateData = OpaqueSpecializedAppSessionState.toInternal(
      finalizedSessionState,
    );
    updateIdentityApiTarget(sessionStateData.identityApi);
    if (!providedApis) {
      syncFinalApiFactories({
        deferredApiNodes: bootstrapClassification.deferredApiRoots,
        appApiRegistry,
        apiResolver: phase.apis,
        collector,
        features,
        bootstrapApiFactoryEntries,
        bootstrapMissingApiAccesses,
        predicateContext: sessionStateData.predicateContext,
      });
    }

    prepareFinalizedTree({
      tree,
    });
    clearFinalizationBoundaryInstances(tree);
    instantiateAndInitializePhaseTree({
      tree,
      apis: phase.apis,
      collector,
      extensionFactoryMiddleware: mergedExtensionFactoryMiddleware,
      routeResolutionApi: phase.routeResolutionApi,
      appTreeApi: phase.appTreeApi,
      routeRefsById,
      predicateContext: sessionStateData.predicateContext,
    });

    const element = tree.root.instance?.getData(coreExtensionData.reactElement);
    if (!element) {
      throw new Error('Expected finalized app tree to expose a root element');
    }

    const finalizedApp: FinalizedSpecializedApp = {
      element,
      sessionState: finalizedSessionState,
      tree,
      errors: collector.collectErrors(),
    };
    finalized = finalizedApp;
    return finalizedApp;
  }

  function finalizeFromBootstrapError(error: Error): FinalizedSpecializedApp {
    if (finalized) {
      return finalized;
    }

    bootstrapError = error;
    const finalizedSessionState =
      cachedSessionState ??
      OpaqueSpecializedAppSessionState.createInstance('v1', {
        apis: phase.apis,
        identityApi:
          signInRuntime?.readyIdentityApi ?? providedSessionData?.identityApi,
        predicateContext: EMPTY_PREDICATE_CONTEXT,
      });
    cachedSessionState = finalizedSessionState;

    prepareFinalizedTree({
      tree,
    });
    clearFinalizationBoundaryInstances(tree);
    attachThrowingFinalizationChild(tree, error);
    instantiateAndInitializePhaseTree({
      tree,
      apis: phase.apis,
      collector,
      extensionFactoryMiddleware: mergedExtensionFactoryMiddleware,
      routeResolutionApi: phase.routeResolutionApi,
      appTreeApi: phase.appTreeApi,
      routeRefsById,
    });

    const element = tree.root.instance?.getData(coreExtensionData.reactElement);
    if (!element) {
      throw new Error('Expected finalized app tree to expose a root element');
    }

    const finalizedApp: FinalizedSpecializedApp = {
      element,
      sessionState: finalizedSessionState,
      tree,
    };
    finalized = finalizedApp;
    return finalizedApp;
  }

  function getFinalizationState(): FinalizationState {
    if (finalizationState) {
      return finalizationState;
    }

    let resolve: ((app: FinalizedSpecializedApp) => void) | undefined;
    let reject: ((error: unknown) => void) | undefined;
    const promise = new Promise<FinalizedSpecializedApp>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    if (!resolve || !reject) {
      throw new Error('Failed to create finalization state');
    }

    finalizationState = {
      started: false,
      promise,
      resolve,
      reject,
    };
    return finalizationState;
  }

  function beginFinalization(
    loader: Promise<SpecializedAppSessionState>,
  ): Promise<FinalizedSpecializedApp> {
    if (finalized) {
      return Promise.resolve(finalized);
    }
    const finalization = getFinalizationState();
    if (finalization.started) {
      return finalization.promise;
    }
    finalization.started = true;

    loader
      .then(sessionState => {
        const finalizedApp = finalizeFromSessionState(sessionState);
        finalization.resolve(finalizedApp);
      })
      .catch(error => {
        try {
          const finalizedApp = finalizeFromBootstrapError(
            isError(error) ? error : new Error(String(error)),
          );
          finalization.resolve(finalizedApp);
        } catch (finalizationError) {
          finalizationState = undefined;
          finalization.reject(finalizationError);
        }
      });

    return finalization.promise;
  }

  function getBootstrapApp() {
    if (bootstrapApp) {
      return bootstrapApp;
    }

    const runtime: SignInRuntime = {
      requiresSignIn: false,
    };
    if (!providedSessionState) {
      phase.identityApiProxy.setTargetHandlers({
        onTargetSet(identityApi) {
          runtime.readyIdentityApi = identityApi;
          beginFinalization(
            getSessionState().catch(error => {
              runtime.error = error;
              throw error;
            }),
          );
        },
      });
    }

    const result = createBootstrapApp({
      tree,
      apis: phase.apis,
      collector,
      routeRefsById,
      routeResolutionApi: phase.routeResolutionApi,
      appTreeApi: phase.appTreeApi,
      extensionFactoryMiddleware: mergedExtensionFactoryMiddleware,
      disableSignIn: Boolean(providedSessionState),
      skipBootstrapChild({ child }) {
        return bootstrapClassification.deferredRoots.has(child);
      },
      onMissingApi({ node, apiRefId }) {
        bootstrapMissingApiAccesses.set(`${node.spec.id}:${apiRefId}`, {
          node,
          apiRefId,
        });
      },
    });
    if (!result.requiresSignIn) {
      phase.identityApiProxy.clearTargetHandlers();
    }

    runtime.requiresSignIn = result.requiresSignIn;
    signInRuntime = runtime;
    bootstrapApp = result.bootstrapApp;

    return bootstrapApp;
  }

  return {
    getBootstrapApp,
    onFinalized(callback) {
      getBootstrapApp();

      let subscribed = true;

      if (finalized) {
        const finalizedApp = finalized;
        Promise.resolve().then(() => {
          if (subscribed) {
            callback(finalizedApp);
          }
        });
        return () => {
          subscribed = false;
        };
      }

      const finalizedAppPromise = signInRuntime?.requiresSignIn
        ? getFinalizationState().promise
        : beginFinalization(getSessionState());
      finalizedAppPromise
        .then(finalizedApp => {
          if (subscribed) {
            callback(finalizedApp);
          }
        })
        .catch(() => {});

      return () => {
        subscribed = false;
      };
    },
    finalize(finalizeOptions?: { sessionState?: SpecializedAppSessionState }) {
      if (finalized) {
        return finalized;
      }

      if (bootstrapError) {
        throw bootstrapError;
      }
      if (signInRuntime?.error && !signInRuntime.requiresSignIn) {
        throw signInRuntime.error;
      }

      if (!finalizeOptions?.sessionState && !cachedSessionState) {
        getBootstrapApp();
      }

      const finalizedSessionState =
        finalizeOptions?.sessionState ??
        cachedSessionState ??
        (signInRuntime?.requiresSignIn
          ? undefined
          : getImmediateSessionState());
      if (!finalizedSessionState) {
        if (signInRuntime?.requiresSignIn) {
          throw new Error(
            'prepareSpecializedApp requires waiting for the bootstrap app to be ready before calling finalize()',
          );
        }
        throw new Error(
          'prepareSpecializedApp requires waiting for asynchronous finalization before calling finalize()',
        );
      }

      finalized = finalizeFromSessionState(finalizedSessionState);
      finalizationState?.resolve(finalized);
      return finalized;
    },
  };
}

function registerFeatureFlagDeclarations(
  featureFlagApi: typeof featureFlagsApiRef.T,
  features: FrontendFeature[],
) {
  for (const feature of features) {
    if (OpaqueFrontendPlugin.isType(feature)) {
      OpaqueFrontendPlugin.toInternal(feature).featureFlags.forEach(flag =>
        featureFlagApi.registerFlag({
          name: flag.name,
          description: flag.description,
          pluginId: feature.id,
        }),
      );
    }
    if (isInternalFrontendModule(feature)) {
      toInternalFrontendModule(feature).featureFlags.forEach(flag =>
        featureFlagApi.registerFlag({
          name: flag.name,
          description: flag.description,
          pluginId: feature.pluginId,
        }),
      );
    }
  }
}

function registerFeatureFlagDeclarationsInHolder(
  apis: ApiHolder,
  features: FrontendFeature[],
) {
  const featureFlagApi = apis.get(featureFlagsApiRef);
  if (featureFlagApi) {
    registerFeatureFlagDeclarations(featureFlagApi, features);
  }
}

function wrapFeatureFlagApiFactory(
  factory: AnyApiFactory,
  features: FrontendFeature[],
) {
  if (factory.api.id !== featureFlagsApiRef.id) {
    return factory;
  }

  return {
    ...factory,
    factory(deps) {
      const featureFlagApi = factory.factory(
        deps,
      ) as typeof featureFlagsApiRef.T;
      registerFeatureFlagDeclarations(featureFlagApi, features);
      return featureFlagApi;
    },
  } as AnyApiFactory;
}

type ApiFactoryEntry = {
  node: AppNode;
  pluginId: string;
  factory: AnyApiFactory;
};

type BootstrapClassification = {
  deferredApiRoots: Set<AppNode>;
  deferredElementRoots: Set<AppNode>;
  deferredRoots: Set<AppNode>;
};

function createBootstrapApp(options: {
  tree: AppTree;
  apis: ApiHolder;
  collector: ErrorCollector;
  routeRefsById: ReturnType<typeof collectRouteIds>;
  routeResolutionApi: RouteResolutionApiProxy;
  appTreeApi: AppTreeApiProxy;
  extensionFactoryMiddleware?: ExtensionFactoryMiddleware;
  disableSignIn?: boolean;
  skipBootstrapChild?(ctx: {
    node: AppNode;
    input: string;
    child: AppNode;
  }): boolean;
  onMissingApi?(ctx: { node: AppNode; apiRefId: string }): void;
}): {
  bootstrapApp: BootstrapSpecializedApp;
  requiresSignIn: boolean;
} {
  const signInPageNode = getAppRootNode(options.tree)?.edges.attachments.get(
    'signInPage',
  )?.[0];

  instantiateAndInitializePhaseTree({
    tree: options.tree,
    apis: options.apis,
    collector: options.collector,
    extensionFactoryMiddleware: options.extensionFactoryMiddleware,
    routeResolutionApi: options.routeResolutionApi,
    appTreeApi: options.appTreeApi,
    routeRefsById: options.routeRefsById,
    stopAtAttachment: ({ node, input }) =>
      isSessionBoundaryAttachment(node, input),
    skipChild: options.skipBootstrapChild,
    onMissingApi: options.onMissingApi,
  });

  const element = options.tree.root.instance?.getData(
    coreExtensionData.reactElement,
  );
  if (!element) {
    throw new Error('Expected bootstrap tree to expose a root element');
  }

  return {
    bootstrapApp: {
      element,
      tree: options.tree,
    },
    requiresSignIn:
      !options.disableSignIn &&
      Boolean(signInPageNode?.instance?.getData(signInPageComponentDataRef)),
  };
}

function prepareFinalizedTree(options: { tree: AppTree }) {
  for (const appRootNode of getFinalizationBoundaryNodes(options.tree)) {
    const attachments = appRootNode.edges.attachments as Map<string, AppNode[]>;
    attachments.delete('signInPage');
  }
}

function clearFinalizationBoundaryInstances(tree: AppTree) {
  clearNodeInstance(tree.root);

  const visited = new Set<AppNode>();
  function visit(node: AppNode) {
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    clearNodeInstance(node);

    for (const [input, children] of node.edges.attachments) {
      if (node.spec.id === 'app/root' && input === 'elements') {
        continue;
      }

      for (const child of children) {
        visit(child);
      }
    }
  }

  for (const appRootNode of getFinalizationBoundaryNodes(tree)) {
    visit(appRootNode);
  }
}

function getAppRootNode(tree: AppTree) {
  return tree.nodes.get('app/root');
}

function getFinalizationBoundaryNodes(tree: AppTree): AppNode[] {
  const nodes = new Set<AppNode>();
  const appRootNode = getAppRootNode(tree);
  if (appRootNode) {
    nodes.add(appRootNode);
  }
  const attachedAppRootNode = tree.root.edges.attachments.get('app')?.[0];
  if (attachedAppRootNode) {
    nodes.add(attachedAppRootNode);
  }
  return Array.from(nodes);
}

function isSessionBoundaryAttachment(node: AppNode, input: string) {
  return node.spec.id === 'app/root' && input === 'children';
}

function attachThrowingFinalizationChild(tree: AppTree, error: Error) {
  const bootstrapChildNode =
    getAppRootNode(tree)?.edges.attachments.get('children')?.[0];
  if (!bootstrapChildNode) {
    throw error;
  }

  function ThrowBootstrapError(): never {
    throw error;
  }

  (bootstrapChildNode as AppNode & { instance?: AppNodeInstance }).instance = {
    getDataRefs() {
      return [coreExtensionData.reactElement].values();
    },
    getData<TValue>(dataRef: ExtensionDataRef<TValue>) {
      if (dataRef.id === coreExtensionData.reactElement.id) {
        return (<ThrowBootstrapError />) as TValue;
      }
      return undefined;
    },
  };
}

function clearNodeInstance(node: AppNode) {
  (node as AppNode & { instance?: AppNodeInstance }).instance = undefined;
}

const EMPTY_API_HOLDER: ApiHolder = {
  get() {
    return undefined;
  },
};

function collectApiFactoryEntries(options: {
  apiNodes: Iterable<AppNode>;
  collector: ErrorCollector;
  predicateContext?: ExtensionPredicateContext;
  entries?: Map<string, ApiFactoryEntry>;
}): Map<string, ApiFactoryEntry> {
  const factoriesById = options.entries ?? new Map<string, ApiFactoryEntry>();
  for (const apiNode of options.apiNodes) {
    const detachedApiNode = instantiateAppNodeSubtree({
      rootNode: apiNode,
      apis: EMPTY_API_HOLDER,
      collector: options.collector,
      predicateContext: options.predicateContext,
      writeNodeInstances: false,
      reuseExistingInstances: false,
    });
    if (!detachedApiNode) {
      continue;
    }
    const apiFactory = detachedApiNode.instance?.getData(
      ApiBlueprint.dataRefs.factory,
    );
    if (apiFactory) {
      const apiRefId = apiFactory.api.id;
      const ownerId = getApiOwnerId(apiRefId);
      const pluginId = apiNode.spec.plugin.pluginId ?? 'app';
      const existingFactory = factoriesById.get(apiRefId);

      // This allows modules to override factories provided by the plugin, but
      // it rejects API overrides from other plugins. In the event of a
      // conflict, the owning plugin is attempted to be inferred from the API
      // reference ID.
      if (existingFactory && existingFactory.pluginId !== pluginId) {
        const shouldReplace =
          ownerId === pluginId && existingFactory.pluginId !== ownerId;
        const acceptedPluginId = shouldReplace
          ? pluginId
          : existingFactory.pluginId;
        const rejectedPluginId = shouldReplace
          ? existingFactory.pluginId
          : pluginId;

        options.collector.report({
          code: 'API_FACTORY_CONFLICT',
          message: `API '${apiRefId}' is already provided by plugin '${acceptedPluginId}', cannot also be provided by '${rejectedPluginId}'.`,
          context: {
            node: apiNode,
            apiRefId,
            pluginId: rejectedPluginId,
            existingPluginId: acceptedPluginId,
          },
        });
        if (shouldReplace) {
          factoriesById.set(apiRefId, {
            pluginId,
            node: apiNode,
            factory: apiFactory,
          });
        }
        continue;
      }

      factoriesById.set(apiRefId, {
        pluginId,
        node: apiNode,
        factory: apiFactory,
      });
    } else {
      options.collector.report({
        code: 'API_EXTENSION_INVALID',
        message: `API extension '${apiNode.spec.id}' did not output an API factory`,
        context: {
          node: apiNode,
        },
      });
    }
  }

  return factoriesById;
}

function syncFinalApiFactories(options: {
  deferredApiNodes: Iterable<AppNode>;
  appApiRegistry: FrontendApiRegistry;
  apiResolver: FrontendApiResolver;
  collector: ErrorCollector;
  features: FrontendFeature[];
  bootstrapApiFactoryEntries: ReadonlyMap<string, ApiFactoryEntry>;
  bootstrapMissingApiAccesses: Map<string, { node: AppNode; apiRefId: string }>;
  predicateContext: ExtensionPredicateContext;
}) {
  const finalApiEntries = collectApiFactoryEntries({
    apiNodes: options.deferredApiNodes,
    collector: options.collector,
    predicateContext: options.predicateContext,
    entries: new Map(options.bootstrapApiFactoryEntries),
  });
  const changedEntries = Array.from(finalApiEntries.values()).filter(entry => {
    const bootstrapEntry = options.bootstrapApiFactoryEntries.get(
      entry.factory.api.id,
    );
    if (!bootstrapEntry) {
      return true;
    }
    if (bootstrapEntry.factory === entry.factory) {
      return false;
    }
    if (options.apiResolver.isMaterialized(entry.factory.api.id)) {
      options.collector.report({
        code: 'EXTENSION_BOOTSTRAP_API_OVERRIDE_IGNORED',
        message:
          `Extension '${entry.node.spec.id}' tried to override API ` +
          `'${entry.factory.api.id}' after it had already been materialized during bootstrap. ` +
          'The bootstrap implementation was kept and the deferred override was ignored.',
        context: {
          node: entry.node,
          apiRefId: entry.factory.api.id,
          bootstrapNode: bootstrapEntry.node,
          pluginId: entry.pluginId,
          bootstrapPluginId: bootstrapEntry.pluginId,
        },
      });
      return false;
    }
    return true;
  });
  const changedFactories = changedEntries.map(entry =>
    wrapFeatureFlagApiFactory(entry.factory, options.features),
  );
  options.appApiRegistry.setAll(changedFactories);
  options.apiResolver.invalidate(
    changedFactories.map(factory => factory.api.id),
  );
  for (const bootstrapAccess of options.bootstrapMissingApiAccesses.values()) {
    if (
      options.bootstrapApiFactoryEntries.has(bootstrapAccess.apiRefId) ||
      !finalApiEntries.has(bootstrapAccess.apiRefId)
    ) {
      continue;
    }

    options.collector.report({
      code: 'EXTENSION_BOOTSTRAP_API_UNAVAILABLE',
      message:
        `Extension '${bootstrapAccess.node.spec.id}' tried to access API ` +
        `'${bootstrapAccess.apiRefId}' during bootstrap before it was available. ` +
        'That API became available during finalization, so bootstrap-visible extensions must not depend on deferred APIs.',
      context: {
        node: bootstrapAccess.node,
        apiRefId: bootstrapAccess.apiRefId,
      },
    });
  }
}

function collectBootstrapVisibleNodes(
  tree: AppTree,
  options?: { deferredRoots?: Set<AppNode> },
) {
  const visibleNodes = new Set<AppNode>();

  function visit(node: AppNode) {
    if (visibleNodes.has(node)) {
      return;
    }
    visibleNodes.add(node);

    for (const [input, children] of node.edges.attachments) {
      if (isSessionBoundaryAttachment(node, input)) {
        continue;
      }

      for (const child of children) {
        if (options?.deferredRoots?.has(child)) {
          continue;
        }
        visit(child);
      }
    }
  }

  visit(tree.root);

  return visibleNodes;
}

function classifyBootstrapTree(options: {
  tree: AppTree;
  collector: ErrorCollector;
}): BootstrapClassification {
  const apiNodes = options.tree.root.edges.attachments.get('apis') ?? [];
  const deferredApiRoots = new Set(
    apiNodes.filter(apiNode => subtreeContainsPredicate(apiNode)),
  );
  const appRootElementNodes =
    getAppRootNode(options.tree)?.edges.attachments.get('elements') ?? [];
  const deferredElementRoots = new Set(
    appRootElementNodes.filter(elementNode =>
      subtreeContainsPredicate(elementNode),
    ),
  );
  const deferredRoots = new Set<AppNode>([
    ...deferredApiRoots,
    ...deferredElementRoots,
  ]);
  const bootstrapNodes = collectBootstrapVisibleNodes(options.tree, {
    deferredRoots,
  });

  for (const node of bootstrapNodes) {
    if (node.spec.if === undefined) {
      continue;
    }

    options.collector.report({
      code: 'EXTENSION_BOOTSTRAP_PREDICATE_IGNORED',
      message:
        `Extension '${node.spec.id}' uses 'if' during bootstrap, so the predicate was ignored. ` +
        "Move it behind 'app/root.children', onto a deferred 'app/root.elements' subtree, or into an API subtree.",
      context: {
        node,
      },
    });
    (node.spec as typeof node.spec & { if?: FilterPredicate }).if = undefined;
  }

  return {
    deferredApiRoots,
    deferredElementRoots,
    deferredRoots,
  };
}

function subtreeContainsPredicate(root: AppNode) {
  const visited = new Set<AppNode>();

  function visit(node: AppNode): boolean {
    if (visited.has(node)) {
      return false;
    }
    visited.add(node);

    if (node.spec.if !== undefined) {
      return true;
    }

    for (const children of node.edges.attachments.values()) {
      for (const child of children) {
        if (visit(child)) {
          return true;
        }
      }
    }

    return false;
  }

  return visit(root);
}

// TODO(Rugvip): It would be good if this was more explicit, but I think that
//               might need to wait for some future update for API factories.
function getApiOwnerId(apiRefId: string): string {
  const [prefix, ...rest] = apiRefId.split('.');
  if (!prefix) {
    return apiRefId;
  }
  if (prefix === 'core') {
    return 'app';
  }
  if (prefix === 'plugin' && rest[0]) {
    return rest[0];
  }
  return prefix;
}

function mergeExtensionFactoryMiddleware(
  middlewares?: ExtensionFactoryMiddleware | ExtensionFactoryMiddleware[],
): ExtensionFactoryMiddleware | undefined {
  if (!middlewares) {
    return undefined;
  }
  if (!Array.isArray(middlewares)) {
    return middlewares;
  }
  if (middlewares.length <= 1) {
    return middlewares[0];
  }
  return middlewares.reduce((prev, next) => {
    if (!prev || !next) {
      return prev ?? next;
    }
    return (orig, ctx) => {
      const internalExt = toInternalExtension(ctx.node.spec.extension);
      if (internalExt.version !== 'v2') {
        return orig();
      }
      return next(ctxOverrides => {
        return createExtensionDataContainer(
          prev(orig, {
            node: ctx.node,
            apis: ctx.apis,
            config: ctxOverrides?.config ?? ctx.config,
          }),
          'extension factory middleware',
        );
      }, ctx);
    };
  });
}
