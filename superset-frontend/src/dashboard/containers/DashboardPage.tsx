/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 *
 * Modified by ZetaIQ: keeps the open dashboard live when websockets run in
 * gateway mode.
 * Modified by ZetaIQ: the editor's "Dashboard changed" modal, the header
 * badge's state, and "no longer available" in place of a gone dashboard
 * (once any unsaved edits are discarded).
 * Modified by ZetaIQ: says why the dashboard went away; "Update waiting".
 */
// Modified by ZetaIQ: /superset/dashboard/new/ builds a dashboard in the page; nothing is stored until its
// first Save (docs/specs/2026-11-19-dashboard-save-paths-design.md §7.3).
import { createContext, lazy, FC, useEffect, useMemo, useRef } from 'react';
import { Global } from '@emotion/react';
import { useHistory } from 'react-router-dom';
import { t } from '@apache-superset/core/translation';
import { useTheme } from '@apache-superset/core/theme';
import { useDispatch, useSelector } from 'react-redux';
import { createSelector } from '@reduxjs/toolkit';
import { useToasts } from 'src/components/MessageToasts/withToasts';
import { EmptyState, Loading } from '@superset-ui/core/components';
import {
  useDashboard,
  useDashboardCharts,
  useDashboardDatasets,
} from 'src/hooks/apiResources';
import { hydrateDashboard } from 'src/dashboard/actions/hydrate';
import { clearDashboardHistory } from 'src/dashboard/actions/dashboardLayout';
import { setDatasources } from 'src/dashboard/actions/datasources';
import injectCustomCss from 'src/dashboard/util/injectCustomCss';
import {
  getAllActiveFilters,
  getRelevantDataMask,
} from 'src/dashboard/util/activeAllDashboardFilters';
import { getActiveFilters } from 'src/dashboard/util/activeDashboardFilters';
import { LocalStorageKeys, setItem } from 'src/utils/localStorageHelpers';
import { URL_PARAMS } from 'src/constants';
import { getUrlParam } from 'src/utils/urlUtils';
import { sanitizeDocumentTitle } from 'src/utils/sanitizeDocumentTitle';
import { setDatasetsStatus } from 'src/dashboard/actions/dashboardState';
import {
  DASHBOARD_HEADER_ID,
  NEW_DASHBOARD,
  NEW_DASHBOARD_ID,
} from 'src/dashboard/util/constants';
import { getUserSubjects } from 'src/dashboard/util/permissionUtils';
import {
  getFilterValue,
  getPermalinkValue,
} from 'src/dashboard/components/nativeFilters/FilterBar/keyValue';
import DashboardContainer from 'src/dashboard/containers/Dashboard';
import CrudThemeProvider from 'src/components/CrudThemeProvider';
import getBootstrapData from 'src/utils/getBootstrapData';
import {
  LiveBadgeContext,
  useDashboardLive,
} from 'src/dashboard/live/useDashboardLive';
import DashboardChangedModal from 'src/dashboard/components/DashboardChangedModal';
import DashboardUnavailable from 'src/dashboard/components/DashboardUnavailable';
import type { UnavailableReason } from 'src/dashboard/live/classifyEvent';
import type { DashboardChartStates } from 'src/dashboard/types/chartState';

import { nanoid } from 'nanoid';
import type { ActiveFilters } from '../types';
import { RootState } from '../types';
import {
  chartContextMenuStyles,
  filterCardPopoverStyle,
  focusStyle,
  headerStyles,
  chartHeaderStyles,
} from '../styles';
import SyncDashboardState, {
  getDashboardContextLocalStorage,
} from '../components/SyncDashboardState';
import { AutoRefreshProvider } from '../contexts/AutoRefreshContext';
import { Filter, PartialFilters, SupersetApiError } from '@superset-ui/core';
import { RoutePaths } from 'src/views/routePaths';
import {
  parseRisonFilters,
  risonFiltersToExtraFormDataFilters,
  getRisonFilterParam,
  prettifyRisonFilterUrl,
  injectRisonFiltersIntelligently,
  updateUrlWithUnmatchedFilters,
  RISON_UNMATCHED_DATAMASK_ID,
} from '../util/risonFilters';

type NativeFilterConfigEntry = Partial<Filter> & { id: string };

export const DashboardPageIdContext = createContext('');

const DashboardBuilder = lazy(
  () =>
    import(
      /* webpackChunkName: "DashboardContainer" */
      /* webpackPreload: true */
      'src/dashboard/components/DashboardBuilder/DashboardBuilder'
    ),
);

type PageProps = {
  idOrSlug: string;
};

// TODO: move to Dashboard.jsx when it's refactored to functional component
const selectRelevantDatamask = createSelector(
  (state: RootState) => state.dataMask, // the first argument accesses relevant data from global state
  dataMask => getRelevantDataMask(dataMask, 'ownState'), // the second parameter conducts the transformation
);

const selectChartConfiguration = (state: RootState) =>
  state.dashboardInfo.metadata?.chart_configuration;
const selectNativeFilters = (state: RootState) => state.nativeFilters.filters;
const selectDataMask = (state: RootState) => state.dataMask;
const selectAllSliceIds = (state: RootState) => state.dashboardState.sliceIds;
// TODO: move to Dashboard.jsx when it's refactored to functional component
const selectActiveFilters = createSelector(
  [
    selectChartConfiguration,
    selectNativeFilters,
    selectDataMask,
    selectAllSliceIds,
  ],
  (chartConfiguration, nativeFilters, dataMask, allSliceIds) => ({
    ...getActiveFilters(),
    ...getAllActiveFilters({
      // eslint-disable-next-line camelcase
      chartConfiguration,
      nativeFilters,
      dataMask,
      allSliceIds,
    }),
  }),
);

const StoredDashboardPage: FC<PageProps> = ({ idOrSlug }: PageProps) => {
  const theme = useTheme();
  const dispatch = useDispatch();
  const history = useHistory();
  const dashboardPageId = useMemo(() => nanoid(), []);
  const hasDashboardInfoInitiated = useSelector<RootState, boolean>(
    ({ dashboardInfo }) =>
      dashboardInfo && Object.keys(dashboardInfo).length > 0,
  );
  const reduxTheme = useSelector(
    (state: RootState) => state.dashboardInfo.theme,
  );
  const { addDangerToast } = useToasts();
  const { result: dashboard, error: dashboardApiError } =
    useDashboard(idOrSlug);
  const { result: charts, error: chartsApiError } =
    useDashboardCharts(idOrSlug);
  const {
    result: datasets,
    error: datasetsApiError,
    status,
  } = useDashboardDatasets(idOrSlug);
  const isDashboardHydrated = useRef(false);

  const error = dashboardApiError || chartsApiError;
  // Only 404 gets a graceful not-found state; a 403 (access denied) still
  // surfaces through the error boundary.
  const isNotFoundError = (error as SupersetApiError | null)?.status === 404;
  const readyToRender = Boolean(dashboard && charts);
  const { dashboard_title, id = 0 } = dashboard || {};

  // The live title is edited in Redux and persisted via an in-SPA save with no
  // full reload, so the useDashboard() API result can be stale. Track the live
  // title so the browser tab stays in sync after a rename.
  const liveDashboardTitle = useSelector<RootState, string | undefined>(
    state => state.dashboardLayout?.present?.[DASHBOARD_HEADER_ID]?.meta?.text,
  );
  // Only trust the live layout title once the layout belongs to the dashboard
  // being shown. During SPA dashboard-to-dashboard navigation the previous
  // dashboard's layout lingers until the new one hydrates, so fall back to the
  // freshly fetched API title until the hydrated dashboard matches.
  const hydratedDashboardId = useSelector<RootState, number | undefined>(
    state => state.dashboardInfo?.id,
  );
  const pageTitle =
    (hydratedDashboardId === id ? liveDashboardTitle : undefined) ||
    dashboard_title;

  // Live updates need the gateway's identity on the push socket; cookie
  // mode stays as upstream ships it.
  const hydratedUuid = useSelector<RootState, string | undefined>(
    state => state.dashboardInfo?.uuid,
  );
  const conf = getBootstrapData().common?.conf;
  const liveEnabled =
    Boolean(conf?.WEBSOCKET_ENABLE) && conf?.WEBSOCKET_AUTH === 'gateway';
  const live = useDashboardLive(
    liveEnabled && hydratedDashboardId === id ? (hydratedUuid ?? '') : '',
  );
  // a refresh answered 404, or a `deleted` event; why, when known
  const storeUnavailable = useSelector<RootState, boolean>(
    state => !!state.dashboardState?.unavailable,
  );
  const storeReason = useSelector<RootState, UnavailableReason | undefined>(
    state => state.dashboardState?.unavailableReason,
  );
  const unavailable = storeUnavailable || live.unavailable;
  const unavailableReason = live.unavailable ? 'deleted' : storeReason;
  // an editor's unsaved work is not taken off screen (a notice says the
  // dashboard is gone); the page is replaced once they discard or leave
  const unsavedEdits = useSelector<RootState, boolean>(
    state =>
      !!state.dashboardState?.editMode &&
      !!state.dashboardState?.hasUnsavedChanges,
  );
  const liveBadge = useMemo(
    () => ({
      // the modal itself stands in for the badge while it is open
      count: live.prompt ? 0 : live.badgeCount,
      names: live.summary?.authors ?? [],
      chartOnly: live.chartOnly,
      gone: unavailable,
      waiting: live.waiting,
      open: live.openPrompt,
    }),
    [
      live.prompt,
      live.badgeCount,
      live.summary,
      live.chartOnly,
      unavailable,
      live.waiting,
      live.openPrompt,
    ],
  );

  // Get CSS from dashboardInfo (unified properties location)
  const css =
    useSelector((state: RootState) => state.dashboardInfo.css) ||
    dashboard?.css;

  useEffect(() => {
    // mark tab id as redundant when user closes browser tab - a new id will be
    // generated next time user opens a dashboard and the old one won't be reused
    const handleTabClose = () => {
      const dashboardsContexts = getDashboardContextLocalStorage();
      setItem(LocalStorageKeys.DashboardExploreContext, {
        ...dashboardsContexts,
        [dashboardPageId]: {
          ...dashboardsContexts[dashboardPageId],
          isRedundant: true,
        },
      });
    };
    window.addEventListener('beforeunload', handleTabClose);
    return () => {
      window.removeEventListener('beforeunload', handleTabClose);
    };
  }, [dashboardPageId]);

  useEffect(() => {
    dispatch(setDatasetsStatus(status));
  }, [dispatch, status]);

  useEffect(() => {
    // eslint-disable-next-line consistent-return
    async function getDataMaskApplied() {
      const permalinkKey = getUrlParam(URL_PARAMS.permalinkKey);
      const nativeFilterKeyValue = getUrlParam(URL_PARAMS.nativeFiltersKey);
      const isOldRison = getUrlParam(URL_PARAMS.nativeFilters);

      let dataMask = nativeFilterKeyValue || {};
      // activeTabs is initialized with undefined so that it doesn't override
      // the currently stored value when hydrating
      let activeTabs: string[] | null | undefined;
      let chartStates: DashboardChartStates | null | undefined;
      let anchor: string | undefined;
      if (permalinkKey) {
        const permalinkValue = await getPermalinkValue(permalinkKey);
        if (permalinkValue?.state) {
          ({ dataMask, activeTabs, anchor } = permalinkValue.state);
          chartStates = permalinkValue.state.chartStates as
            | DashboardChartStates
            | undefined;
        }
      } else if (nativeFilterKeyValue) {
        dataMask = await getFilterValue(id, nativeFilterKeyValue);
      }
      if (isOldRison) {
        // Normalize legacy `currentState` → `filterState`. Pre-2021 URLs stored
        // per-filter selections under `currentState`; modern dataMask uses
        // `filterState`. Without this copy the filter panel shows no active
        // selections even though extraFormData still applies the query filter.
        if (typeof isOldRison === 'object' && isOldRison !== null) {
          dataMask = Object.fromEntries(
            Object.entries(
              isOldRison as Record<string, Record<string, unknown>>,
            ).map(([filterId, entry]) => [
              filterId,
              entry?.currentState && !entry?.filterState
                ? { ...entry, filterState: entry.currentState }
                : entry,
            ]),
          );
        }
      }

      // Parse Rison URL filters with intelligent native filter injection
      const risonFilterParam = getRisonFilterParam();
      if (risonFilterParam) {
        const risonFilters = parseRisonFilters(risonFilterParam);
        if (risonFilters.length > 0) {
          // Convert native filter config array to keyed object for lookup
          const filterConfigArray = (dashboard?.metadata
            ?.native_filter_configuration ?? []) as NativeFilterConfigEntry[];
          const nativeFilters: PartialFilters = {};
          filterConfigArray.forEach(filter => {
            nativeFilters[filter.id] = filter;
          });
          const injectionResult = injectRisonFiltersIntelligently(
            risonFilters,
            nativeFilters,
            dataMask,
          );

          dataMask = injectionResult.updatedDataMask;

          // Unmatched filters apply via a synthetic dataMask entry: because no
          // entry in `nativeFilters` claims this id, `getAllActiveFilters`
          // falls through to `allSliceIds` and the filters scope to every chart.
          if (injectionResult.unmatchedFilters.length > 0) {
            const extraFormDataFilters = risonFiltersToExtraFormDataFilters(
              injectionResult.unmatchedFilters,
            );

            dataMask = {
              ...dataMask,
              [RISON_UNMATCHED_DATAMASK_ID]: {
                id: RISON_UNMATCHED_DATAMASK_ID,
                extraFormData: { filters: extraFormDataFilters },
                filterState: {},
                ownState: {},
              },
            };
          }

          // Rewrite the URL to drop matched filters in a single step, keeping
          // only unmatched ones (and prettifying their encoding). Going
          // through react-router's history keeps `history.location.search` in
          // sync so `publishDataMask` doesn't re-emit the original `f=`.
          const matchedCount =
            risonFilters.length - injectionResult.unmatchedFilters.length;
          if (matchedCount > 0) {
            updateUrlWithUnmatchedFilters(
              injectionResult.unmatchedFilters,
              history,
            );
          }
          if (injectionResult.unmatchedFilters.length > 0) {
            prettifyRisonFilterUrl();
          }
        }
      }

      if (readyToRender) {
        if (!isDashboardHydrated.current) {
          isDashboardHydrated.current = true;
        }
        dispatch(
          hydrateDashboard({
            history,
            dashboard: dashboard!,
            charts: charts!,
            activeTabs: activeTabs ?? null,
            dataMask,
            chartStates: chartStates ?? null,
          } as unknown as Parameters<typeof hydrateDashboard>[0]),
        );
        dispatch(clearDashboardHistory());

        // Scroll to anchor element if specified in permalink state
        if (anchor) {
          // Use setTimeout to ensure the DOM has been updated after hydration
          setTimeout(() => {
            const element = document.getElementById(anchor);
            if (element) {
              element.scrollIntoView({ behavior: 'smooth' });
            }
          }, 0);
        }
      }
      return null;
    }
    if (id) getDataMaskApplied();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyToRender]);

  // Capture original title before any effects run
  const originalTitle = useMemo(() => document.title, []);

  // Update document title when dashboard title changes
  useEffect(() => {
    if (pageTitle) {
      document.title = sanitizeDocumentTitle(pageTitle);
    }
  }, [pageTitle]);

  // Restore original title on unmount
  useEffect(
    () => () => {
      document.title =
        originalTitle ||
        theme?.brandAppName ||
        theme?.brandLogoAlt ||
        'Superset';
    },
    [originalTitle, theme?.brandAppName, theme?.brandLogoAlt],
  );

  useEffect(() => {
    if (typeof css === 'string') {
      // returning will clean up custom css
      // when dashboard unmounts or changes
      return injectCustomCss(css);
    }
    return () => {};
  }, [css]);

  useEffect(() => {
    if (datasetsApiError) {
      // A missing dashboard also 404s its datasets; the not-found state covers it.
      if (!isNotFoundError) {
        addDangerToast(
          t('Error loading chart datasources. Filters may not work correctly.'),
        );
      }
    } else {
      dispatch(setDatasources(datasets));
    }
  }, [addDangerToast, datasets, datasetsApiError, dispatch, isNotFoundError]);

  const relevantDataMask = useSelector(selectRelevantDatamask);
  const activeFilters = useSelector(selectActiveFilters);

  if (error && !isNotFoundError) throw error; // caught in error boundary

  const globalStyles = useMemo(
    () => [
      filterCardPopoverStyle(),
      headerStyles(theme),
      chartContextMenuStyles(theme),
      focusStyle(theme),
      chartHeaderStyles(theme),
    ],
    [theme],
  );

  if (error && !isNotFoundError) throw error; // caught in error boundary

  const DashboardBuilderComponent = useMemo(() => <DashboardBuilder />, []);

  if (isNotFoundError) {
    return (
      <EmptyState
        size="large"
        image="empty-dashboard.svg"
        title={t('This dashboard does not exist')}
        description={t(
          'The dashboard you are looking for may have been deleted or moved.',
        )}
        buttonText={t('See all dashboards')}
        buttonAction={() => history.push(RoutePaths.DASHBOARD_LIST)}
      />
    );
  }

  if (unavailable && !unsavedEdits)
    return <DashboardUnavailable reason={unavailableReason} />;

  return (
    <>
      <Global styles={globalStyles} />
      {readyToRender && hasDashboardInfoInitiated ? (
        <>
          <SyncDashboardState dashboardPageId={dashboardPageId} />
          <DashboardPageIdContext.Provider value={dashboardPageId}>
            <CrudThemeProvider
              theme={reduxTheme !== undefined ? reduxTheme : dashboard?.theme}
            >
              <AutoRefreshProvider>
                <LiveBadgeContext.Provider value={liveBadge}>
                  <DashboardContainer
                    activeFilters={activeFilters as ActiveFilters}
                    ownDataCharts={relevantDataMask}
                  >
                    {DashboardBuilderComponent}
                  </DashboardContainer>
                </LiveBadgeContext.Provider>
                <DashboardChangedModal
                  // shown once the history read has said who saved
                  show={
                    live.prompt &&
                    (live.chartOnly || live.summary !== undefined)
                  }
                  summary={live.summary ?? null}
                  chartOnly={live.chartOnly}
                  onDiscard={live.discard}
                  onKeepEditing={live.dismissPrompt}
                />
              </AutoRefreshProvider>
            </CrudThemeProvider>
          </DashboardPageIdContext.Provider>
        </>
      ) : (
        <Loading />
      )}
    </>
  );
};

// ZetaIQ: a v4 uuid; crypto.randomUUID exists only in secure contexts, getRandomValues everywhere.
const newUuid = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] % 16) + 64; // version 4
  b[8] = (b[8] % 64) + 128; // RFC 4122 variant
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// ZetaIQ: an empty dashboard held in the page, edited by the person opening it.
const newDashboard = () =>
  ({
    id: NEW_DASHBOARD_ID,
    isNew: true,
    uuid: newUuid(),
    dashboard_title: t('[ untitled dashboard ]'),
    slug: null,
    css: '',
    metadata: {},
    position_data: null,
    published: true,
    changed_on: null,
    editors: getUserSubjects().map(id => ({ id })),
    extra_editors: [],
    viewers: [],
    tags: [],
    theme: null,
  }) as unknown as Parameters<typeof hydrateDashboard>[0]['dashboard'];

const NewDashboardPage: FC = () => {
  const theme = useTheme();
  const dispatch = useDispatch();
  const history = useHistory();
  const dashboardPageId = useMemo(() => nanoid(), []);
  const isHydrated = useSelector<RootState, boolean>(
    ({ dashboardInfo }) =>
      !!(dashboardInfo as { isNew?: boolean } | undefined)?.isNew,
  );
  useEffect(() => {
    dispatch(
      hydrateDashboard({
        history,
        dashboard: newDashboard(),
        charts: [],
        activeTabs: null,
        dataMask: {},
        chartStates: null,
        editMode: true,
      } as unknown as Parameters<typeof hydrateDashboard>[0]),
    );
    dispatch(clearDashboardHistory());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const relevantDataMask = useSelector(selectRelevantDatamask);
  const activeFilters = useSelector(selectActiveFilters);
  const globalStyles = useMemo(
    () => [
      filterCardPopoverStyle(),
      headerStyles(theme),
      chartContextMenuStyles(theme),
      focusStyle(theme),
      chartHeaderStyles(theme),
    ],
    [theme],
  );
  const DashboardBuilderComponent = useMemo(() => <DashboardBuilder />, []);
  return (
    <>
      <Global styles={globalStyles} />
      {isHydrated ? (
        <>
          <SyncDashboardState dashboardPageId={dashboardPageId} />
          <DashboardPageIdContext.Provider value={dashboardPageId}>
            <AutoRefreshProvider>
              <DashboardContainer
                activeFilters={activeFilters as ActiveFilters}
                ownDataCharts={relevantDataMask}
              >
                {DashboardBuilderComponent}
              </DashboardContainer>
            </AutoRefreshProvider>
          </DashboardPageIdContext.Provider>
        </>
      ) : (
        <Loading />
      )}
    </>
  );
};

export const DashboardPage: FC<PageProps> = ({ idOrSlug }: PageProps) =>
  idOrSlug === NEW_DASHBOARD ? (
    <NewDashboardPage />
  ) : (
    <StoredDashboardPage idOrSlug={idOrSlug} />
  );

export default DashboardPage;
