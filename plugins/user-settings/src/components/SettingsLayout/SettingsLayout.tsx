/*
 * Copyright 2022 The Backstage Authors
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

import { ElementType, ReactNode, useMemo } from 'react';
import { TabProps } from '@material-ui/core/Tab';
import {
  Content,
  Header,
  Page,
  RoutedTabs,
  useSidebarPinState,
} from '@backstage/core-components';
import { HeaderPage } from '@backstage/ui';
import {
  attachComponentData,
  useElementFilter,
} from '@backstage/core-plugin-api';
import { useTranslationRef } from '@backstage/frontend-plugin-api';
import { Helmet } from 'react-helmet';
import {
  matchRoutes,
  useLocation,
  useParams,
  useRoutes,
} from 'react-router-dom';
import { userSettingsTranslationRef } from '../../translation';

/** @public */
export type SettingsLayoutRouteProps = {
  path: string;
  title: string;
  children: JSX.Element;
  tabProps?: TabProps<ElementType, { component?: ElementType }>;
};

export const LAYOUT_DATA_KEY = 'plugin.user-settings.settingsLayout';
export const LAYOUT_ROUTE_DATA_KEY = 'plugin.user-settings.settingsLayoutRoute';

const Route: (props: SettingsLayoutRouteProps) => null = () => null;
attachComponentData(Route, LAYOUT_ROUTE_DATA_KEY, true);

// This causes all mount points that are discovered within this route to use the path of the route itself
attachComponentData(Route, 'core.gatherMountPoints', true);

/** @public */
export type SettingsLayoutProps = {
  title?: string;
  subtitle?: string;
  children?: ReactNode;
};

const normalizePath = (path: string) =>
  path !== '/' && path.endsWith('/') ? path.slice(0, -1) : path;

const getTabsBasePath = (
  pathname: string,
  routes: SettingsLayoutRouteProps[],
) => {
  const normalizedPathname = normalizePath(pathname);
  const relativeRoutePaths = routes
    .map(route => route.path.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const routePath of relativeRoutePaths) {
    const marker = `/${routePath}`;
    const matchIndex = normalizedPathname.lastIndexOf(marker);

    if (matchIndex === -1) {
      continue;
    }

    const matchEndIndex = matchIndex + marker.length;
    if (
      matchEndIndex !== normalizedPathname.length &&
      normalizedPathname[matchEndIndex] !== '/'
    ) {
      continue;
    }

    return normalizedPathname.slice(0, matchIndex) || '/';
  }

  return normalizedPathname || '/';
};

const useSelectedSubRoute = (
  subRoutes: SettingsLayoutRouteProps[],
): {
  route?: SettingsLayoutRouteProps;
  element?: JSX.Element;
} => {
  const params = useParams();

  const routes = subRoutes.map(({ path, children }) => ({
    caseSensitive: false,
    path: `${path}/*`,
    element: children,
  }));

  const sortedRoutes = routes.sort((a, b) =>
    b.path.replace(/\/\*$/, '').localeCompare(a.path.replace(/\/\*$/, '')),
  );

  const element = useRoutes(sortedRoutes) ?? subRoutes[0]?.children;

  let currentRoute = params['*'] ?? '';
  if (!currentRoute.startsWith('/')) {
    currentRoute = `/${currentRoute}`;
  }

  const [matchedRoute] = matchRoutes(sortedRoutes, currentRoute) ?? [];
  const foundIndex = matchedRoute
    ? subRoutes.findIndex(t => `${t.path}/*` === matchedRoute.route.path)
    : 0;
  const route = subRoutes[foundIndex === -1 ? 0 : foundIndex] ?? subRoutes[0];

  return {
    route,
    element,
  };
};

/**
 * @public
 */
export const SettingsLayout = (props: SettingsLayoutProps) => {
  const { title, children } = props;
  const { isMobile } = useSidebarPinState();
  const { t } = useTranslationRef(userSettingsTranslationRef);

  const routes = useElementFilter(children, elements =>
    elements
      .selectByComponentData({
        key: LAYOUT_ROUTE_DATA_KEY,
        withStrictError:
          'Child of SettingsLayout must be an SettingsLayout.Route',
      })
      .getElements<SettingsLayoutRouteProps>()
      .map(child => child.props),
  );

  return (
    <Page themeId="home">
      {!isMobile && <Header title={title ?? t('settingsLayout.title')} />}
      <RoutedTabs routes={routes} />
    </Page>
  );
};

export const NfsSettingsLayout = (props: SettingsLayoutProps) => {
  const { title, children } = props;
  const { isMobile } = useSidebarPinState();
  const { t } = useTranslationRef(userSettingsTranslationRef);
  const location = useLocation();

  const routes = useElementFilter(children, elements =>
    elements
      .selectByComponentData({
        key: LAYOUT_ROUTE_DATA_KEY,
        withStrictError:
          'Child of SettingsLayout must be an SettingsLayout.Route',
      })
      .getElements<SettingsLayoutRouteProps>()
      .map(child => child.props),
  );
  const { route, element } = useSelectedSubRoute(routes);
  const tabs = useMemo(() => {
    const basePath = getTabsBasePath(location.pathname, routes);

    return routes.map(subRoute => ({
      id: subRoute.path,
      label: subRoute.title,
      href: subRoute.path.startsWith('/')
        ? subRoute.path
        : `${basePath}/${subRoute.path}`.replace(/\/{2,}/g, '/'),
      matchStrategy: 'prefix' as const,
    }));
  }, [location.pathname, routes]);

  return (
    <>
      {!isMobile && <HeaderPage tabs={tabs} />}
      {isMobile && <RoutedTabs routes={routes} />}
      {!isMobile && (
        <Content>
          <Helmet title={route?.title} />
          {element}
        </Content>
      )}
    </>
  );
};

attachComponentData(SettingsLayout, LAYOUT_DATA_KEY, true);

SettingsLayout.Route = Route;
