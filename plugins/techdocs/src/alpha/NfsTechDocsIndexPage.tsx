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

import { FC, ReactNode } from 'react';
import { useOutlet } from 'react-router-dom';
import { HeaderPage } from '@backstage/ui';
import {
  TechDocsIndexPageProps,
  DefaultTechDocsHome,
} from '../home/components';
import { configApiRef, useApi } from '@backstage/core-plugin-api';

const NfsTechDocsPageWrapper: FC<{ children?: ReactNode }> = ({ children }) => {
  const configApi = useApi(configApiRef);
  const generatedSubtitle = `Documentation available in ${
    configApi.getOptionalString('organization.name') ?? 'Backstage'
  }`;

  return (
    <>
      <HeaderPage title="Documentation" subtitle={generatedSubtitle} />
      {children}
    </>
  );
};

export const NfsTechDocsIndexPage = (props: TechDocsIndexPageProps) => {
  const outlet = useOutlet();

  return (
    outlet || (
      <DefaultTechDocsHome {...props} PageWrapper={NfsTechDocsPageWrapper} />
    )
  );
};
