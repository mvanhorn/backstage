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

import { PropsWithChildren, useEffect } from 'react';
import Helmet from 'react-helmet';
import Grid from '@material-ui/core/Grid';
import Box from '@material-ui/core/Box';
import Skeleton from '@material-ui/lab/Skeleton';
import CodeIcon from '@material-ui/icons/Code';
import capitalize from 'lodash/capitalize';
import { useParams } from 'react-router-dom';
import { HeaderLabel } from '@backstage/core-components';
import { HeaderPage } from '@backstage/ui';
import {
  useTechDocsAddons,
  TechDocsAddonLocations as locations,
  useTechDocsReaderPage,
} from '@backstage/plugin-techdocs-react';
import {
  entityPresentationApiRef,
  EntityRefLink,
  EntityRefLinks,
  getEntityRelations,
} from '@backstage/plugin-catalog-react';
import {
  RELATION_OWNED_BY,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { configApiRef, useApi } from '@backstage/core-plugin-api';
import { TechDocsReaderPageContent } from '../reader/components/TechDocsReaderPageContent';
import { TechDocsReaderPageSubheader } from '../reader/components/TechDocsReaderPageSubheader';

const skeleton = <Skeleton animation="wave" variant="text" height={40} />;

const NfsTechDocsReaderPageHeader = (props: PropsWithChildren<{}>) => {
  const { children } = props;
  const addons = useTechDocsAddons();
  const configApi = useApi(configApiRef);
  const entityPresentationApi = useApi(entityPresentationApiRef);
  const { '*': path = '' } = useParams();

  const {
    title,
    setTitle,
    subtitle,
    setSubtitle,
    entityRef,
    metadata: { value: metadata, loading: metadataLoading },
    entityMetadata: { value: entityMetadata, loading: entityMetadataLoading },
  } = useTechDocsReaderPage();

  useEffect(() => {
    if (!metadata) {
      return;
    }

    setTitle(metadata.site_name);
    setSubtitle(() => {
      let { site_description } = metadata;
      if (!site_description || site_description === 'None') {
        site_description = '';
      }
      return site_description;
    });
  }, [metadata, setTitle, setSubtitle]);

  const appTitle = configApi.getOptional('app.title') || 'Backstage';
  const { locationMetadata, spec } = entityMetadata || {};
  const lifecycle = spec?.lifecycle;
  const ownedByRelations = entityMetadata
    ? getEntityRelations(entityMetadata, RELATION_OWNED_BY)
    : [];
  const labels = (
    <>
      <HeaderLabel
        label={capitalize(entityMetadata?.kind || 'entity')}
        value={
          <EntityRefLink
            color="inherit"
            entityRef={entityRef}
            title={entityMetadata?.metadata.title}
            defaultKind="Component"
          />
        }
      />
      {ownedByRelations.length > 0 && (
        <HeaderLabel
          label="Owner"
          value={
            <EntityRefLinks
              color="inherit"
              entityRefs={ownedByRelations}
              defaultKind="group"
            />
          }
        />
      )}
      {lifecycle ? (
        <HeaderLabel label="Lifecycle" value={String(lifecycle)} />
      ) : null}
      {locationMetadata &&
      locationMetadata.type !== 'dir' &&
      locationMetadata.type !== 'file' ? (
        <HeaderLabel
          label=""
          value={
            <Grid container direction="column" alignItems="center">
              <Grid style={{ padding: 0 }} item>
                <CodeIcon style={{ marginTop: '-25px' }} />
              </Grid>
              <Grid style={{ padding: 0 }} item>
                Source
              </Grid>
            </Grid>
          }
          url={locationMetadata.target}
        />
      ) : null}
    </>
  );

  const noEntMetadata = !entityMetadataLoading && entityMetadata === undefined;
  const noTdMetadata = !metadataLoading && metadata === undefined;
  if (noEntMetadata || noTdMetadata) {
    return null;
  }

  const stringEntityRef = stringifyEntityRef(entityRef);
  const entityDisplayName =
    entityPresentationApi.forEntity(stringEntityRef).snapshot.primaryTitle;
  const removeTrailingSlash = (str: string) => str.replace(/\/$/, '');
  const normalizeAndSpace = (str: string) =>
    str.replace(/[-_]/g, ' ').split(' ').map(capitalize).join(' ');

  let techdocsTabTitleItems: string[] = [];
  if (path !== '') {
    techdocsTabTitleItems = removeTrailingSlash(path)
      .split('/')
      .map(normalizeAndSpace);
  }

  const tabTitleItems = [entityDisplayName, ...techdocsTabTitleItems, appTitle];
  const tabTitle = tabTitleItems.join(' | ');

  return (
    <>
      <Helmet titleTemplate="%s">
        <title>{tabTitle}</title>
      </Helmet>
      <HeaderPage
        title={title || ''}
        customActions={
          <>
            {children}
            {addons.renderComponentsByLocation(locations.Header)}
          </>
        }
      />
      {(subtitle ||
        metadataLoading ||
        entityMetadataLoading ||
        entityMetadata) && (
        <Box mt={2}>
          {subtitle !== '' ? subtitle || skeleton : null}
          {entityMetadata && <Box mt={subtitle === '' ? 0 : 1}>{labels}</Box>}
        </Box>
      )}
    </>
  );
};

export type NfsTechDocsReaderLayoutProps = {
  withHeader?: boolean;
  withSearch?: boolean;
};

export const NfsTechDocsReaderLayout = (
  props: NfsTechDocsReaderLayoutProps,
) => {
  const { withSearch, withHeader = true } = props;

  return (
    <>
      {withHeader && <NfsTechDocsReaderPageHeader />}
      <TechDocsReaderPageSubheader />
      <TechDocsReaderPageContent withSearch={withSearch} />
    </>
  );
};
