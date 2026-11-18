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
 */
import rison from 'rison';
import { isEqual } from 'lodash-es';
import type { AnyAction } from 'redux';
import type { History } from 'history';
import { t } from '@apache-superset/core/translation';
import { DataMaskWithId, SupersetClient } from '@superset-ui/core';
import { addInfoToast } from 'src/components/MessageToasts/actions';
import { DASHBOARD_GET_COLUMNS } from 'src/hooks/apiResources/dashboards';
import { dashboardUnavailable } from 'src/dashboard/actions/dashboardState';
import {
  hydrateDashboard,
  HydrateChartData,
  HydrateDashboardData,
} from 'src/dashboard/actions/hydrate';
import { getInitialDataMask } from 'src/dataMask/reducer';
import { TABS_TYPE } from 'src/dashboard/util/componentTypes';
import type { Chart, DashboardLayout, GetState } from 'src/dashboard/types';
import type { AppDispatch } from 'src/views/store';
import { carryDataMask, LiveFilter } from './carryDataMask';

export type RefreshOptions = {
  history: History;
  /** chart ids named by the events this refresh answers */
  charts: number[];
};

type HydrateDispatch = Parameters<ReturnType<typeof hydrateDashboard>>[0];

const HOLDER = '.dashboard-component-chart-holder';
// the per-chart class the CSS editor targets; data-test is stripped in builds
const CHART_CLASS = 'dashboard-chart-id-';

/** The first chart on screen and how far it sits from the viewport's top. */
function topVisibleChart(): { selector: string; top: number } | null {
  let found: { selector: string; top: number } | null = null;
  Array.from(document.querySelectorAll<HTMLElement>(HOLDER)).some(el => {
    const { top, bottom, height } = el.getBoundingClientRect();
    const cls = Array.from(el.classList).find(c => c.startsWith(CHART_CLASS));
    if (height > 0 && bottom > 0 && cls) found = { selector: `.${cls}`, top };
    return found !== null;
  });
  return found;
}

/**
 * Keep the viewer's tab. When the editor removed it, its tab group falls
 * back to its first tab: the path the Tabs components follow points there.
 */
function keepTabs(
  activeTabs: string[],
  path: string[],
  oldLayout: DashboardLayout,
  layout: DashboardLayout,
): { activeTabs: string[]; directPathToChild: string[] } | null {
  const depth = (id: string) => oldLayout[id]?.parents?.length ?? 0;
  const gone = [...path, ...activeTabs]
    .filter(id => !layout[id])
    .sort((a, b) => depth(a) - depth(b));
  if (!gone.length) return null;
  const group = gone
    .map(id => oldLayout[id]?.parents ?? [])
    .map(parents => layout[parents[parents.length - 1]])
    .find(c => c?.type === TABS_TYPE && c.children.length);
  return {
    activeTabs: activeTabs.filter(id => layout[id]),
    directPathToChild: group
      ? [...(group.parents ?? []), group.id, group.children[0]]
      : path.filter(id => layout[id]),
  };
}

/**
 * The slug changed (spec §11): an address naming the old slug would no
 * longer open this dashboard, so put the new one (or the id) in its place.
 * Replaced outside the router, which would re-load the page for a new path;
 * the query string, `native_filters_key` included, and the hash are kept.
 */
function correctSlug(
  old: string | null | undefined,
  slug: string | null | undefined,
  id: number,
) {
  if (!old || old === slug) return;
  const { pathname, search, hash } = window.location;
  const parts = pathname.split('/');
  // the last match: a slug like "dashboard" also matches the route's prefix
  const at = parts.reduce(
    (found, part, i) =>
      part === old || part === encodeURIComponent(old) ? i : found,
    -1,
  );
  if (at < 0) return;
  parts[at] = slug ? encodeURIComponent(slug) : String(id);
  window.history.replaceState(
    window.history.state,
    '',
    `${parts.join('/')}${search}${hash}`,
  );
}

/**
 * Load the dashboard's current version into the open page without losing
 * what the viewer is doing (spec §7.7): filter values, cross-filters, tab,
 * fullscreen chart, expanded charts, refresh interval and scroll position
 * are kept; only charts whose definition changed, or that the event names,
 * re-query, and they keep their old result on screen while they load.
 *
 * It goes out as a HYDRATE_DASHBOARD flagged `live`: built by the page's
 * own hydration, then given back the viewer's state, so every reducer
 * takes the new definition in one step.
 */
export const refreshInPlace =
  (id: number, { history, charts: named }: RefreshOptions) =>
  async (dispatch: AppDispatch, getState: GetState): Promise<void> => {
    const q = rison.encode({ columns: DASHBOARD_GET_COLUMNS });
    let responses;
    try {
      responses = await Promise.all([
        SupersetClient.get({ endpoint: `/api/v1/dashboard/${id}?q=${q}` }),
        SupersetClient.get({ endpoint: `/api/v1/dashboard/${id}/charts` }),
      ]);
    } catch (error) {
      // deleted, unpublished or no longer shared with this person
      if ((error as { status?: number })?.status !== 404) throw error;
      if (getState().dashboardInfo.id === id) dispatch(dashboardUnavailable());
      return;
    }
    const [{ json, response }, chartList] = responses;
    const before = getState();
    // the tab moved to another dashboard, or its editor started changing it
    if (
      before.dashboardInfo.id !== id ||
      before.dashboardState.hasUnsavedChanges
    ) {
      return;
    }

    const { result } = json as { result: Record<string, unknown> };
    let hydrated: AnyAction | undefined;
    hydrateDashboard({
      history,
      dashboard: {
        ...result,
        etag: response.headers.get('ETag'),
        metadata: JSON.parse((result.json_metadata as string) || '{}'),
        position_data: result.position_json
          ? JSON.parse(result.position_json as string)
          : null,
      } as unknown as HydrateDashboardData,
      charts: (chartList.json as { result: HydrateChartData[] }).result,
      dataMask: before.dataMask,
      activeTabs: before.dashboardState.activeTabs,
      chartStates: null,
      editMode: before.dashboardState.editMode,
    })(
      ((action: AnyAction) => {
        hydrated = action;
        return action;
      }) as HydrateDispatch,
      getState,
    );
    const { data } = hydrated!;
    const layout = data.dashboardLayout.present as DashboardLayout;
    const liveChartIds: number[] = data.dashboardState.sliceIds;

    // unchanged charts keep their state object: not re-queried, not remounted
    const charts = data.charts as Record<string, Chart>;
    Object.entries(charts).forEach(([key, fresh]) => {
      const old = before.charts[Number(key)];
      if (!old) return;
      const changed =
        named.includes(Number(key)) ||
        !isEqual(
          before.sliceEntities.slices[Number(key)]?.form_data,
          data.sliceEntities.slices[key].form_data,
        );
      charts[key] = changed
        ? {
            ...old,
            form_data: fresh.form_data,
            triggerQuery: true,
            liveRefresh: true,
          }
        : old;
    });

    const { mask, removedFilterNames } = carryDataMask(
      before.dataMask,
      Object.values(before.nativeFilters.filters) as LiveFilter[],
      Object.values(data.nativeFilters.filters) as LiveFilter[],
      liveChartIds,
    );
    // as hydration does: every chart that can cross-filter has an entry
    Object.keys(data.dashboardInfo.metadata.chart_configuration ?? {}).forEach(
      key => {
        if (!mask[key]) mask[key] = getInitialDataMask(key) as DataMaskWithId;
      },
    );
    data.dataMask = mask;

    // only what the definition decides; the reducer keeps the rest
    const view = before.dashboardState;
    const next = data.dashboardState;
    data.dashboardState = {
      sliceIds: next.sliceIds,
      css: next.css,
      colorNamespace: next.colorNamespace,
      colorScheme: next.colorScheme,
      isPublished: next.isPublished,
      lastModifiedTime: next.lastModifiedTime,
      expandAllSlices: next.expandAllSlices,
      fullSizeChartId:
        view.fullSizeChartId && liveChartIds.includes(view.fullSizeChartId)
          ? view.fullSizeChartId
          : null,
      ...keepTabs(
        view.activeTabs ?? [],
        view.directPathToChild ?? [],
        before.dashboardLayout.present,
        layout,
      ),
    };

    const anchor = topVisibleChart();
    dispatch({ ...hydrated!, live: true });
    correctSlug(before.dashboardInfo.slug, result.slug as string | null, id);
    removedFilterNames.forEach(name =>
      dispatch(addInfoToast(t("Filter '%s' was removed", name))),
    );
    if (anchor) {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(anchor.selector);
        const shift = el ? el.getBoundingClientRect().top - anchor.top : 0;
        if (shift) window.scrollBy(0, shift);
      });
    }
  };
