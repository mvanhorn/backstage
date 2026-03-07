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

import { Content, Header, Page } from '@backstage/core-components';
import { HeaderPage } from '@backstage/ui';
import type { ReactNode } from 'react';

type HeaderVariant = 'legacy' | 'bui';

type ScaffolderPageLayoutProps = {
  headerVariant?: HeaderVariant;
  themeId?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  pageTitleOverride?: string;
  type?: string;
  typeLink?: string;
  headerActions?: ReactNode;
  contentClassName?: string;
  withContent?: boolean;
  children?: ReactNode;
};

export const ScaffolderPageLayout = (props: ScaffolderPageLayoutProps) => {
  const {
    headerVariant = 'legacy',
    themeId = 'home',
    title,
    subtitle,
    pageTitleOverride,
    type,
    typeLink,
    headerActions,
    contentClassName,
    withContent = true,
    children,
  } = props;

  const pageContent = withContent ? (
    <Content className={contentClassName}>{children}</Content>
  ) : (
    children
  );

  if (headerVariant === 'bui') {
    return (
      <>
        <HeaderPage
          title={title}
          subtitle={subtitle}
          customActions={headerActions}
        />
        {pageContent}
      </>
    );
  }

  return (
    <Page themeId={themeId}>
      <Header
        pageTitleOverride={pageTitleOverride}
        title={title}
        subtitle={subtitle}
        type={type}
        typeLink={typeLink}
      >
        {headerActions}
      </Header>
      {pageContent}
    </Page>
  );
};
