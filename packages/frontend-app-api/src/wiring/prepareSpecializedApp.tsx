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
import {
  ApiBlueprint,
  AnyApiFactory,
  ApiHolder,
  AppTree,
  AppTreeApi,
  appTreeApiRef,
  ConfigApi,
  configApiRef,
  coreExtensionData,
  RouteRef,
  ExternalRouteRef,
  SubRouteRef,
  AnyRouteRefParams,
  RouteFunc,
  RouteResolutionApi,
  createApiFactory,
  createApiRef,
  routeResolutionApiRef,
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
import type {
  EvaluatePermissionRequest,
  EvaluatePermissionResponse,
} from '@backstage/plugin-permission-common';
import { FilterPredicate } from '@backstage/filter-predicates';
import {
  createExtensionDataContainer,
  OpaqueFrontendPlugin,
} from '@internal/frontend';
import { OpaqueType } from '@internal/opaque';
import { ComponentType, ReactNode, useLayoutEffect, useState } from 'react';

// eslint-disable-next-line @backstage/no-relative-monorepo-imports
import {
  resolveExtensionDefinition,
  toInternalExtension,
} from '../../../frontend-plugin-api/src/wiring/resolveExtensionDefinition';

import {
  extractRouteInfoFromAppNode,
  RouteInfo,
} from '../routing/extractRouteInfoFromAppNode';

import { CreateAppRouteBinder } from '../routing';
import { RouteResolver } from '../routing/RouteResolver';
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
import {
  instantiateAppNodeSubtree,
  instantiateAppNodeTree,
} from '../tree/instantiateAppNodeTree';
// eslint-disable-next-line @backstage/no-relative-monorepo-imports
import { AppIdentityProxy } from '../../../core-app-api/src/apis/implementations/IdentityApi/AppIdentityProxy';
import { BackstageRouteObject } from '../routing/types';
import { matchRoutes } from 'react-router-dom';
import {
  createPluginInfoAttacher,
  FrontendPluginInfoResolver,
} from './createPluginInfoAttacher';
import { createRouteAliasResolver } from '../routing/RouteAliasResolver';
import {
  AppError,
  createErrorCollector,
  ErrorCollector,
} from './createErrorCollector';
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

type ExtensionPredicateContext = {
  featureFlags: string[];
  permissions: string[];
};

type InternalSpecializedAppSessionState = {
  apis: ApiHolder;
  identityApi?: IdentityApi;
  predicateContext: ExtensionPredicateContext;
};

const EMPTY_PREDICATE_CONTEXT: ExtensionPredicateContext = {
  featureFlags: [],
  permissions: [],
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

// Helps delay callers from reaching out to the API before the app tree has been materialized
class AppTreeApiProxy implements AppTreeApi {
  #routeInfo?: RouteInfo;
  private readonly tree: AppTree;
  private readonly appBasePath: string;

  constructor(tree: AppTree, appBasePath: string) {
    this.tree = tree;
    this.appBasePath = appBasePath;
  }

  private checkIfInitialized() {
    if (!this.#routeInfo) {
      throw new Error(
        `You can't access the AppTreeApi during initialization of the app tree. Please move occurrences of this out of the initialization of the factory`,
      );
    }
  }

  getTree() {
    this.checkIfInitialized();

    return { tree: this.tree };
  }

  getNodesByRoutePath(routePath: string): { nodes: AppNode[] } {
    this.checkIfInitialized();
    const routeInfo = this.#routeInfo;
    if (!routeInfo) {
      throw new Error(
        `You can't access the AppTreeApi during initialization of the app tree. Please move occurrences of this out of the initialization of the factory`,
      );
    }

    let path = routePath;
    if (path.startsWith(this.appBasePath)) {
      path = path.slice(this.appBasePath.length);
    }

    const matchedRoutes = matchRoutes(routeInfo.routeObjects, path);

    const matchedAppNodes =
      matchedRoutes?.flatMap(routeObj => {
        const appNode = routeObj.route.appNode;
        return appNode ? [appNode] : [];
      }) || [];

    return { nodes: matchedAppNodes };
  }

  initialize(routeInfo: RouteInfo) {
    this.#routeInfo = routeInfo;
  }
}

// Helps delay callers from reaching out to the API before the app tree has been materialized
class RouteResolutionApiProxy implements RouteResolutionApi {
  #delegate: RouteResolutionApi | undefined;
  #routeObjects: BackstageRouteObject[] | undefined;

  private readonly routeBindings: Map<ExternalRouteRef, RouteRef | SubRouteRef>;
  private readonly appBasePath: string;

  constructor(
    routeBindings: Map<ExternalRouteRef, RouteRef | SubRouteRef>,
    appBasePath: string,
  ) {
    this.routeBindings = routeBindings;
    this.appBasePath = appBasePath;
  }

  resolve<TParams extends AnyRouteRefParams>(
    anyRouteRef:
      | RouteRef<TParams>
      | SubRouteRef<TParams>
      | ExternalRouteRef<TParams>,
    options?: { sourcePath?: string },
  ): RouteFunc<TParams> | undefined {
    if (!this.#delegate) {
      throw new Error(
        `You can't access the RouteResolver during initialization of the app tree. Please move occurrences of this out of the initialization of the factory`,
      );
    }

    return this.#delegate.resolve(anyRouteRef, options);
  }

  initialize(
    routeInfo: RouteInfo,
    routeRefsById: Map<string, RouteRef | SubRouteRef>,
  ) {
    this.#delegate = new RouteResolver(
      routeInfo.routePaths,
      routeInfo.routeParents,
      routeInfo.routeObjects,
      this.routeBindings,
      this.appBasePath,
      routeInfo.routeAliasResolver,
      routeRefsById,
    );
    this.#routeObjects = routeInfo.routeObjects;

    return routeInfo;
  }

  getRouteObjects() {
    return this.#routeObjects;
  }
}

class PreparedAppIdentityProxy extends AppIdentityProxy {
  #onTargetSet?:
    | ((
        identityApi: Parameters<AppIdentityProxy['setTarget']>[0],
      ) => Promise<void> | void)
    | undefined;
  #onTargetError?: ((error: unknown) => void) | undefined;

  setTargetHandlers(options: {
    onTargetSet?(
      identityApi: Parameters<AppIdentityProxy['setTarget']>[0],
    ): Promise<void> | void;
    onTargetError?(error: unknown): void;
  }) {
    this.#onTargetSet = options.onTargetSet;
    this.#onTargetError = options.onTargetError;
  }

  clearTargetHandlers() {
    this.#onTargetSet = undefined;
    this.#onTargetError = undefined;
  }

  override setTarget(
    identityApi: Parameters<AppIdentityProxy['setTarget']>[0],
    targetOptions: Parameters<AppIdentityProxy['setTarget']>[1],
  ) {
    super.setTarget(identityApi, targetOptions);

    const onTargetSet = this.#onTargetSet;
    if (!onTargetSet) {
      return;
    }

    const onTargetError = this.#onTargetError;
    this.clearTargetHandlers();

    try {
      void Promise.resolve(onTargetSet(identityApi)).catch(error => {
        onTargetError?.(error);
      });
    } catch (error) {
      onTargetError?.(error);
    }
  }
}

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
  onFinalized(
    callback: (app: FinalizedSpecializedApp) => void,
    onError?: (error: Error) => void,
  ): () => void;
  finalize(options?: {
    sessionState?: SpecializedAppSessionState;
  }): FinalizedSpecializedApp;
};

// Minimal local permission API interface to avoid a dependency on @backstage/plugin-permission-react
type MinimalPermissionApi = {
  authorize(
    request: EvaluatePermissionRequest,
  ): Promise<EvaluatePermissionResponse>;
};

const localPermissionApiRef = createApiRef<MinimalPermissionApi>({
  id: 'plugin.permission.api',
});

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
  const predicateReferences = collectPredicateReferences(tree);
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
  const state: {
    signInRuntime?: SignInRuntime;
    cachedSessionState?: SpecializedAppSessionState;
    sessionStatePromise?: Promise<SpecializedAppSessionState>;
    finalized?: FinalizedSpecializedApp;
    bootstrapApp?: BootstrapSpecializedApp;
    bootstrapError?: Error;
    finalizationState?: FinalizationState;
    bootstrapErrorReporter?: (error: Error) => void;
    pendingBootstrapError?: Error;
  } = {
    cachedSessionState: providedSessionState,
  };

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

  function getActiveFeatureFlags() {
    const featureFlagsApi = phase.apis.get(featureFlagsApiRef);
    if (!featureFlagsApi) {
      return [];
    }

    return predicateReferences.featureFlags.filter(name =>
      featureFlagsApi.isActive(name),
    );
  }

  function getImmediatePredicateContext():
    | ExtensionPredicateContext
    | undefined {
    if (predicateReferences.permissions.length > 0) {
      const permissionApi = phase.apis.get(localPermissionApiRef);
      if (permissionApi) {
        return undefined;
      }
    }

    return {
      featureFlags: getActiveFeatureFlags(),
      permissions: [],
    };
  }

  async function createPredicateContext() {
    const immediatePredicateContext = getImmediatePredicateContext();
    if (immediatePredicateContext) {
      return immediatePredicateContext;
    }

    let allowedPermissions: string[] = [];
    const permissionApi = phase.apis.get(localPermissionApiRef);
    if (permissionApi) {
      const permNames = predicateReferences.permissions;
      const responses = await Promise.all(
        permNames.map(name =>
          permissionApi.authorize({
            permission: { name, type: 'basic', attributes: {} },
          }),
        ),
      );
      allowedPermissions = permNames.filter(
        (_, i) => responses[i].result === 'ALLOW',
      );
    }

    return {
      featureFlags: getActiveFeatureFlags(),
      permissions: allowedPermissions,
    };
  }

  function createSessionState(predicateContext: ExtensionPredicateContext) {
    const identityApi =
      state.signInRuntime?.readyIdentityApi ?? providedSessionData?.identityApi;
    updateIdentityApiTarget(identityApi);
    const sessionState = OpaqueSpecializedAppSessionState.createInstance('v1', {
      apis: phase.apis,
      identityApi,
      predicateContext,
    });
    state.cachedSessionState = sessionState;
    return sessionState;
  }

  function getImmediateSessionState() {
    if (state.cachedSessionState) {
      return state.cachedSessionState;
    }
    if (state.signInRuntime?.requiresSignIn) {
      return undefined;
    }

    const predicateContext = getImmediatePredicateContext();
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
    if (state.sessionStatePromise) {
      return state.sessionStatePromise;
    }
    if (state.signInRuntime?.error) {
      return Promise.reject(state.signInRuntime.error);
    }
    if (
      state.signInRuntime?.requiresSignIn &&
      !state.signInRuntime.readyIdentityApi
    ) {
      return Promise.reject(
        new Error(
          'prepareSpecializedApp requires waiting for the bootstrap app to be ready before calling finalize()',
        ),
      );
    }

    state.sessionStatePromise = createPredicateContext()
      .then(predicateContext => {
        if (state.cachedSessionState) {
          return state.cachedSessionState;
        }
        return createSessionState(predicateContext);
      })
      .catch(error => {
        state.sessionStatePromise = undefined;
        throw error;
      });

    return state.sessionStatePromise;
  }

  function startSignInFinalize(
    runtime: SignInRuntime,
    identityApi: IdentityApi,
  ): Promise<SpecializedAppSessionState> {
    runtime.readyIdentityApi = identityApi;
    return getSessionState().catch(error => {
      runtime.error = error;
      throw error;
    });
  }

  function finalizeFromSessionState(
    finalizedSessionState: SpecializedAppSessionState,
  ): FinalizedSpecializedApp {
    if (state.finalized) {
      return state.finalized;
    }

    state.cachedSessionState = finalizedSessionState;
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
    state.finalized = finalizedApp;
    return finalizedApp;
  }

  function reportBootstrapFailure(error: unknown) {
    const bootstrapFailure = asError(error);
    state.bootstrapError = bootstrapFailure;
    if (state.bootstrapErrorReporter) {
      state.bootstrapErrorReporter(bootstrapFailure);
      return;
    }

    state.pendingBootstrapError = bootstrapFailure;
  }

  function getFinalizationState(): FinalizationState {
    if (state.finalizationState) {
      return state.finalizationState;
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

    state.finalizationState = {
      started: false,
      promise,
      resolve,
      reject,
    };
    return state.finalizationState;
  }

  function beginFinalization(
    loader: Promise<SpecializedAppSessionState>,
  ): Promise<FinalizedSpecializedApp> {
    if (state.finalized) {
      return Promise.resolve(state.finalized);
    }
    const finalization = getFinalizationState();
    if (finalization.started) {
      return finalization.promise;
    }
    finalization.started = true;

    void loader
      .then(sessionState => {
        const finalizedApp = finalizeFromSessionState(sessionState);
        finalization.resolve(finalizedApp);
      })
      .catch(error => {
        state.finalizationState = undefined;

        if (state.signInRuntime?.requiresSignIn) {
          finalization.reject(error);
          return;
        }

        reportBootstrapFailure(error);
        finalization.reject(state.bootstrapError);
      });

    return finalization.promise;
  }

  function getBootstrapApp() {
    if (state.bootstrapApp) {
      return state.bootstrapApp;
    }

    const runtime: SignInRuntime = {
      requiresSignIn: false,
    };
    if (!providedSessionState) {
      phase.identityApiProxy.setTargetHandlers({
        onTargetSet(identityApi) {
          return beginFinalization(
            startSignInFinalize(runtime, identityApi),
          ).then(() => {});
        },
        onTargetError(error) {
          reportBootstrapFailure(error);
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
      registerBootstrapErrorReporter(reporter) {
        state.bootstrapErrorReporter = reporter;
        if (state.pendingBootstrapError) {
          reporter(state.pendingBootstrapError);
          state.pendingBootstrapError = undefined;
        }

        return () => {
          if (state.bootstrapErrorReporter === reporter) {
            state.bootstrapErrorReporter = undefined;
          }
        };
      },
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
    state.signInRuntime = runtime;
    state.bootstrapApp = result.bootstrapApp;

    return state.bootstrapApp;
  }

  return {
    getBootstrapApp,
    onFinalized(callback, onError) {
      getBootstrapApp();

      let subscribed = true;

      if (state.bootstrapError) {
        const bootstrapError = state.bootstrapError;
        Promise.resolve().then(() => {
          if (subscribed) {
            onError?.(bootstrapError);
          }
        });
        return () => {
          subscribed = false;
        };
      }

      if (state.finalized) {
        const finalizedApp = state.finalized;
        Promise.resolve().then(() => {
          if (subscribed) {
            callback(finalizedApp);
          }
        });
        return () => {
          subscribed = false;
        };
      }

      const finalizedAppPromise = state.signInRuntime?.requiresSignIn
        ? getFinalizationState().promise
        : beginFinalization(getSessionState());
      void finalizedAppPromise
        .then(finalizedApp => {
          if (subscribed) {
            callback(finalizedApp);
          }
        })
        .catch(error => {
          if (subscribed) {
            onError?.(asError(error));
          }
        });

      return () => {
        subscribed = false;
      };
    },
    finalize(finalizeOptions?: { sessionState?: SpecializedAppSessionState }) {
      if (state.finalized) {
        return state.finalized;
      }

      if (state.bootstrapError) {
        throw state.bootstrapError;
      }
      if (state.signInRuntime?.error && !state.signInRuntime.requiresSignIn) {
        throw state.signInRuntime.error;
      }

      if (!finalizeOptions?.sessionState && !state.cachedSessionState) {
        getBootstrapApp();
      }

      const finalizedSessionState =
        finalizeOptions?.sessionState ??
        state.cachedSessionState ??
        (state.signInRuntime?.requiresSignIn
          ? undefined
          : getImmediateSessionState());
      if (!finalizedSessionState) {
        if (state.signInRuntime?.requiresSignIn) {
          throw new Error(
            'prepareSpecializedApp requires waiting for the bootstrap app to be ready before calling finalize()',
          );
        }
        throw new Error(
          'prepareSpecializedApp requires waiting for asynchronous finalization before calling finalize()',
        );
      }

      state.finalized = finalizeFromSessionState(finalizedSessionState);
      state.finalizationState?.resolve(state.finalized);
      return state.finalized;
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
  registerBootstrapErrorReporter(reporter: (error: Error) => void): () => void;
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
    stopAtSessionBoundary: true,
    skipChild: options.skipBootstrapChild,
    onMissingApi: options.onMissingApi,
  });
  prepareBootstrapErrorBoundary({
    tree: options.tree,
    registerBootstrapErrorReporter: options.registerBootstrapErrorReporter,
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

function createPhaseApis(options: {
  tree: AppTree;
  config: ConfigApi;
  appApiRegistry: FrontendApiRegistry;
  fallbackApis?: ApiHolder;
  includeConfigApi: boolean;
  appBasePath: string;
  routeBindings: Map<ExternalRouteRef, RouteRef | SubRouteRef>;
  staticFactories: AnyApiFactory[];
}) {
  const appTreeApi = new AppTreeApiProxy(options.tree, options.appBasePath);
  const routeResolutionApi = new RouteResolutionApiProxy(
    options.routeBindings,
    options.appBasePath,
  );
  const identityProxy = new PreparedAppIdentityProxy();
  const phaseApiRegistry = new FrontendApiRegistry();
  phaseApiRegistry.registerAll([
    createApiFactory(appTreeApiRef, appTreeApi),
    ...(options.includeConfigApi
      ? [createApiFactory(configApiRef, options.config)]
      : []),
    createApiFactory(routeResolutionApiRef, routeResolutionApi),
    createApiFactory(identityApiRef, identityProxy),
    ...options.staticFactories,
  ]);

  const apis = new FrontendApiResolver({
    primaryRegistry: phaseApiRegistry,
    secondaryRegistry: options.appApiRegistry,
    fallbackApis: options.fallbackApis,
  });

  return {
    apis,
    routeResolutionApi,
    appTreeApi,
    identityApiProxy: identityProxy,
  };
}

function instantiateAndInitializePhaseTree(options: {
  tree: AppTree;
  apis: ApiHolder;
  collector: ErrorCollector;
  extensionFactoryMiddleware?: ExtensionFactoryMiddleware;
  routeResolutionApi: RouteResolutionApiProxy;
  appTreeApi: AppTreeApiProxy;
  routeRefsById: ReturnType<typeof collectRouteIds>;
  stopAtSessionBoundary?: boolean;
  skipChild?(ctx: { node: AppNode; input: string; child: AppNode }): boolean;
  onMissingApi?(ctx: { node: AppNode; apiRefId: string }): void;
  predicateContext?: ExtensionPredicateContext;
}) {
  instantiateAppNodeTree(
    options.tree.root,
    options.apis,
    options.collector,
    options.extensionFactoryMiddleware,
    {
      ...(options.stopAtSessionBoundary
        ? {
            stopAtAttachment: ({
              node,
              input,
            }: {
              node: AppNode;
              input: string;
            }) => isSessionBoundaryAttachment(node, input),
          }
        : {}),
      skipChild: options.skipChild,
      onMissingApi: options.onMissingApi,
      predicateContext: options.predicateContext,
    },
  );

  const routeInfo = extractRouteInfoFromAppNode(
    options.tree.root,
    createRouteAliasResolver(options.routeRefsById),
  );

  options.routeResolutionApi.initialize(
    routeInfo,
    options.routeRefsById.routes,
  );
  options.appTreeApi.initialize(routeInfo);
}

function prepareFinalizedTree(options: { tree: AppTree }) {
  for (const appRootNode of getFinalizationBoundaryNodes(options.tree)) {
    const attachments = appRootNode.edges.attachments as Map<string, AppNode[]>;
    attachments.delete('signInPage');
  }
}

function prepareBootstrapErrorBoundary(options: {
  tree: AppTree;
  registerBootstrapErrorReporter(reporter: (error: Error) => void): () => void;
}) {
  const rootNode = options.tree.root;
  const rootInstance = rootNode.instance;
  if (!rootInstance) {
    return;
  }

  const rootElement = rootInstance.getData(coreExtensionData.reactElement);
  if (!rootElement) {
    return;
  }

  function PreparedBootstrapRoot() {
    const [bootstrapError, setBootstrapError] = useState<Error>();

    useLayoutEffect(() => {
      return options.registerBootstrapErrorReporter(setBootstrapError);
    }, []);

    if (bootstrapError) {
      throw bootstrapError;
    }

    return rootElement;
  }

  setNodeInstance(
    rootNode,
    createReactElementOverrideInstance(rootInstance, <PreparedBootstrapRoot />),
  );
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

function createReactElementOverrideInstance(
  instance: AppNodeInstance,
  value: ReactNode,
): AppNodeInstance {
  return {
    getDataRefs() {
      const refs = Array.from(instance.getDataRefs());
      if (!refs.some(ref => ref.id === coreExtensionData.reactElement.id)) {
        refs.push(coreExtensionData.reactElement);
      }
      return refs[Symbol.iterator]();
    },
    getData<TValue>(dataRef: ExtensionDataRef<TValue>) {
      if (dataRef.id === coreExtensionData.reactElement.id) {
        return value as TValue;
      }
      return instance.getData(dataRef);
    },
  };
}

function setNodeInstance(node: AppNode, instance?: AppNodeInstance) {
  (node as AppNode & { instance?: AppNodeInstance }).instance = instance;
}

function clearNodeInstance(node: AppNode) {
  setNodeInstance(node, undefined);
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function setIdentityApiTarget(options: {
  identityApiProxy: AppIdentityProxy;
  identityApi: IdentityApi;
  signOutTargetUrl: string;
}) {
  options.identityApiProxy.setTarget(options.identityApi, {
    signOutTargetUrl: options.signOutTargetUrl,
  });
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

function collectPredicateReferences(tree: AppTree): ExtensionPredicateContext {
  const featureFlags = new Set<string>();
  const permissions = new Set<string>();

  for (const node of tree.nodes.values()) {
    if (node.spec.if === undefined) {
      continue;
    }

    for (const name of extractFeatureFlagNames(node.spec.if)) {
      featureFlags.add(name);
    }
    for (const name of extractPermissionNames(node.spec.if)) {
      permissions.add(name);
    }
  }

  return {
    featureFlags: Array.from(featureFlags),
    permissions: Array.from(permissions),
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

/**
 * Recursively walks a FilterPredicate and returns all string values referenced
 * by `featureFlags: { $contains: '...' }` expressions. This lets us call
 * `isActive()` only for the flags that are actually used in predicates rather
 * than fetching the full registered-flag list.
 */
function extractFeatureFlagNames(predicate: FilterPredicate): string[] {
  return extractPredicateKeyNames(predicate, 'featureFlags');
}

/**
 * Recursively walks a FilterPredicate and returns all string values referenced
 * by `permissions: { $contains: '...' }` expressions. This lets us issue a
 * single batched authorize call for only the permissions actually referenced.
 */
function extractPermissionNames(predicate: FilterPredicate): string[] {
  return extractPredicateKeyNames(predicate, 'permissions');
}

function extractPredicateKeyNames(
  predicate: FilterPredicate,
  key: string,
): string[] {
  if (typeof predicate !== 'object' || predicate === null) {
    return [];
  }
  const obj = predicate as Record<string, unknown>;
  if (Array.isArray(obj.$all)) {
    return (obj.$all as FilterPredicate[]).flatMap(p =>
      extractPredicateKeyNames(p, key),
    );
  }
  if (Array.isArray(obj.$any)) {
    return (obj.$any as FilterPredicate[]).flatMap(p =>
      extractPredicateKeyNames(p, key),
    );
  }
  if (obj.$not !== undefined) {
    return extractPredicateKeyNames(obj.$not as FilterPredicate, key);
  }
  const value = obj[key];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const contains = (value as Record<string, unknown>).$contains;
    if (typeof contains === 'string') {
      return [contains];
    }
  }
  return [];
}
