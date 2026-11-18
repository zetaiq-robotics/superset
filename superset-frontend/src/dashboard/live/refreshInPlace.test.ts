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
import fetchMock from 'fetch-mock';
import { createMemoryHistory } from 'history';
import { createStore } from 'spec/helpers/testing-library';
import reducerIndex from 'spec/helpers/reducerIndex';
import {
  hydrateDashboard,
  HydrateChartData,
  HydrateDashboardData,
} from 'src/dashboard/actions/hydrate';
import {
  SET_ACTIVE_TABS,
  setDirectPathToChild,
  setFullSizeChartId,
  setRefreshFrequency,
} from 'src/dashboard/actions/dashboardState';
import { updateDataMask } from 'src/dataMask/actions';
import {
  CHART_UPDATE_SUCCEEDED,
  TRIGGER_QUERY,
} from 'src/components/Chart/chartAction';
import { refreshInPlace } from './refreshInPlace';

beforeAll(() => fetchMock.mockGlobal());
afterAll(() => fetchMock.hardReset());
afterEach(() => {
  fetchMock.clearHistory().removeRoutes();
  document.body.innerHTML = '';
  jest.restoreAllMocks();
});

const ID = 7;
const history = createMemoryHistory();

const filter = (id: string, name: string, column: string) => ({
  id,
  name,
  type: 'NATIVE_FILTER',
  filterType: 'filter_select',
  targets: [{ datasetId: 1, column: { name: column } }],
  defaultDataMask: { filterState: {}, extraFormData: {} },
  controlValues: {},
  cascadeParentIds: [],
  scope: { rootPath: ['ROOT_ID'], excluded: [] },
});
const REGION = filter('NATIVE_FILTER-region', 'Region', 'region');
const SITE = filter('NATIVE_FILTER-site', 'Site', 'site');

const formData = (id: number, metric = 'count') => ({
  slice_id: id,
  viz_type: 'table',
  datasource: '1__table',
  metric,
});

type Def = {
  tabs?: Record<string, number[]>;
  charts?: Record<number, string>;
  filters?: object[];
  refresh?: number;
};

const layout = (tabs: Record<string, number[]>) => {
  const l: Record<string, unknown> = {
    DASHBOARD_VERSION_KEY: 'v2',
    ROOT_ID: { id: 'ROOT_ID', type: 'ROOT', children: ['TABS-1'] },
    'TABS-1': {
      id: 'TABS-1',
      type: 'TABS',
      children: Object.keys(tabs),
      meta: {},
    },
  };
  Object.entries(tabs).forEach(([tab, ids]) => {
    l[tab] = { id: tab, type: 'TAB', children: [`ROW-${tab}`], meta: {} };
    l[`ROW-${tab}`] = {
      id: `ROW-${tab}`,
      type: 'ROW',
      children: ids.map(c => `CHART-${c}`),
      meta: {},
    };
    ids.forEach(c => {
      l[`CHART-${c}`] = {
        id: `CHART-${c}`,
        type: 'CHART',
        children: [],
        meta: { chartId: c, width: 4, height: 50 },
      };
    });
  });
  return l;
};

const V1: Required<Def> = {
  tabs: { 'TAB-a': [11, 12], 'TAB-b': [13] },
  charts: { 11: 'count', 12: 'count', 13: 'count' },
  filters: [REGION, SITE],
  refresh: 0,
};

const payload = (def: Def) => {
  const d = { ...V1, ...def };
  return {
    dashboard: {
      id: ID,
      dashboard_title: 'Fleet',
      slug: null,
      owners: [],
      published: true,
      css: '',
      changed_on: '2026-11-18T00:00:00',
      json_metadata: JSON.stringify({
        native_filter_configuration: d.filters,
        refresh_frequency: d.refresh,
      }),
      position_json: JSON.stringify(layout(d.tabs)),
    },
    charts: Object.entries(d.charts).map(([id, metric]) => ({
      id: Number(id),
      slice_id: Number(id),
      slice_name: `chart ${id}`,
      slice_url: '',
      form_data: formData(Number(id), metric),
      description: '',
      description_markeddown: '',
      editors: [],
      modified: '',
      changed_on: '2026-11-18T00:00:00',
    })),
  };
};

/** The page as a viewer has it: loaded at v1, charts rendered, state set. */
const setup = () => {
  const store = createStore({}, reducerIndex) as unknown as {
    dispatch: (action: unknown) => any;
    getState: () => any;
  };
  const { dashboard, charts } = payload({});
  store.dispatch(
    hydrateDashboard({
      history,
      dashboard: {
        ...dashboard,
        etag: 'W/"v1:a:zstd"',
        metadata: JSON.parse(dashboard.json_metadata),
        position_data: JSON.parse(dashboard.position_json),
      } as unknown as HydrateDashboardData,
      charts: charts as HydrateChartData[],
      dataMask: {},
      activeTabs: null,
      chartStates: null,
    }) as any,
  );
  [11, 12, 13].forEach(key => {
    store.dispatch({ type: TRIGGER_QUERY, value: false, key });
    store.dispatch({
      type: CHART_UPDATE_SUCCEEDED,
      key,
      queriesResponse: [{ data: [{ n: key }] }],
    });
  });
  store.dispatch(
    updateDataMask(REGION.id, {
      filterState: { value: ['APAC'] },
      extraFormData: { filters: [{ col: 'region', op: 'IN', val: ['APAC'] }] },
    }),
  );
  store.dispatch(
    updateDataMask(SITE.id, { filterState: { value: ['plant-3'] } }),
  );
  // chart 12 cross-filters the dashboard; chart 11 is on table page 3
  store.dispatch(updateDataMask(12, { filterState: { value: ['robot-7'] } }));
  store.dispatch(updateDataMask(11, { ownState: { currentPage: 3 } }));
  store.dispatch(setRefreshFrequency(30));
  return store;
};

const serve = (def: Def, etag = 'W/"v2:a:zstd"') => {
  const { dashboard, charts } = payload(def);
  fetchMock.get(`glob:*/api/v1/dashboard/${ID}?q=*`, {
    body: { result: dashboard },
    headers: { ETag: etag },
  });
  fetchMock.get(`glob:*/api/v1/dashboard/${ID}/charts`, {
    body: { result: charts },
  });
};

const refresh = (store: ReturnType<typeof setup>, charts: number[] = []) =>
  store.dispatch(refreshInPlace(ID, { history, charts }) as any);

test('keeps native filter values for unchanged filters', async () => {
  const store = setup();
  const before = store.getState().dataMask[REGION.id];
  serve({});
  await refresh(store);
  expect(store.getState().dataMask[REGION.id]).toEqual(before);
});

test('drops a removed filter and toasts its name', async () => {
  const store = setup();
  serve({ filters: [REGION] });
  await refresh(store);
  const state = store.getState();
  expect(state.dataMask[SITE.id]).toBeUndefined();
  expect(state.dataMask[REGION.id].filterState).toEqual({ value: ['APAC'] });
  expect(state.messageToasts.map((m: { text: string }) => m.text)).toContain(
    "Filter 'Site' was removed",
  );
});

test('resets a filter whose targets changed', async () => {
  const store = setup();
  serve({
    filters: [
      { ...REGION, targets: [{ datasetId: 2, column: { name: 'region' } }] },
      SITE,
    ],
  });
  await refresh(store);
  expect(store.getState().dataMask[REGION.id].filterState).toEqual({});
});

test('new filter gets its default', async () => {
  const store = setup();
  const shift = {
    ...filter('NATIVE_FILTER-shift', 'Shift', 'shift'),
    defaultDataMask: { filterState: { value: ['night'] }, extraFormData: {} },
  };
  serve({ filters: [REGION, SITE, shift] });
  await refresh(store);
  expect(store.getState().dataMask[shift.id].filterState).toEqual({
    value: ['night'],
  });
});

test('unchanged charts keep queriesResponse and are not re-queried', async () => {
  const store = setup();
  const { 11: before } = store.getState().charts;
  serve({});
  await refresh(store);
  const { 11: after } = store.getState().charts;
  expect(after).toBe(before);
  expect(after.triggerQuery).toBe(false);
});

test('changed chart re-queries without spinner', async () => {
  const store = setup();
  serve({ charts: { 11: 'count', 12: 'sum', 13: 'count' } });
  await refresh(store);
  const { 12: c12 } = store.getState().charts;
  expect(c12.triggerQuery).toBe(true);
  expect(c12.liveRefresh).toBe(true);
  expect(c12.form_data.metric).toBe('sum');
  // still mounted on its old result while the new one loads
  expect(c12.queriesResponse).toEqual([{ data: [{ n: 12 }] }]);
  expect(store.getState().charts[13].triggerQuery).toBe(false);
});

test('a chart named by the event re-queries even with the same definition', async () => {
  const store = setup();
  serve({});
  await refresh(store, [13]);
  expect(store.getState().charts[13].triggerQuery).toBe(true);
  expect(store.getState().charts[11].triggerQuery).toBe(false);
});

test('the result of a live re-query ends the spinner suppression', async () => {
  const store = setup();
  serve({}, 'W/"v2:a:zstd"');
  await refresh(store, [13]);
  store.dispatch({
    type: CHART_UPDATE_SUCCEEDED,
    key: 13,
    queriesResponse: [{ data: [] }],
  });
  expect(store.getState().charts[13].liveRefresh).toBe(false);
});

test('removed fullscreen chart exits fullscreen and its cross-filter is cleared', async () => {
  const store = setup();
  store.dispatch(setFullSizeChartId(12));
  serve({
    tabs: { 'TAB-a': [11], 'TAB-b': [13] },
    charts: { 11: 'count', 13: 'count' },
  });
  await expect(refresh(store)).resolves.toBeUndefined();
  const state = store.getState();
  expect(state.dashboardState.fullSizeChartId).toBeNull();
  expect(state.dataMask[12]).toBeUndefined();
  expect(state.charts[12]).toBeUndefined();
  // everything else the viewer had stays
  expect(state.dataMask[11].ownState).toEqual({ currentPage: 3 });
  expect(state.dataMask[REGION.id].filterState).toEqual({ value: ['APAC'] });
});

test('fullscreen chart that still exists stays fullscreen', async () => {
  const store = setup();
  store.dispatch(setFullSizeChartId(11));
  serve({});
  await refresh(store);
  expect(store.getState().dashboardState.fullSizeChartId).toBe(11);
});

test('active tab kept', async () => {
  const store = setup();
  store.dispatch({ type: SET_ACTIVE_TABS, activeTabs: ['TAB-b'] });
  store.dispatch(setDirectPathToChild(['ROOT_ID', 'TABS-1', 'TAB-b']));
  serve({ tabs: { 'TAB-a': [11, 12], 'TAB-b': [13], 'TAB-c': [] } });
  await refresh(store);
  const { dashboardState } = store.getState();
  expect(dashboardState.activeTabs).toEqual(['TAB-b']);
  expect(dashboardState.directPathToChild).toEqual([
    'ROOT_ID',
    'TABS-1',
    'TAB-b',
  ]);
});

test('active tab removed → first tab', async () => {
  const store = setup();
  store.dispatch({ type: SET_ACTIVE_TABS, activeTabs: ['TAB-b'] });
  serve({ tabs: { 'TAB-a': [11, 12] }, charts: { 11: 'count', 12: 'count' } });
  await refresh(store);
  const { dashboardState } = store.getState();
  expect(dashboardState.activeTabs).toEqual([]);
  expect(dashboardState.directPathToChild).toEqual([
    'ROOT_ID',
    'TABS-1',
    'TAB-a',
  ]);
});

test('viewer refreshFrequency and expanded charts kept', async () => {
  const store = setup();
  store.dispatch({
    type: 'TOGGLE_EXPAND_SLICE',
    sliceId: 11,
  });
  const expanded = store.getState().dashboardState.expandedSlices;
  serve({ refresh: 300 });
  await refresh(store);
  const { dashboardState } = store.getState();
  expect(dashboardState.refreshFrequency).toBe(30);
  expect(dashboardState.expandedSlices).toEqual(expanded);
});

test('adopts the fetched version as the base', async () => {
  const store = setup();
  serve({});
  await refresh(store);
  expect(store.getState().dashboardInfo.versions).toEqual({
    base: 'v2',
    latest: 'v2',
  });
});

test('scrolls back to the top visible chart', async () => {
  const store = setup();
  const holder = (id: number, rects: Partial<DOMRect>[]) => {
    const el = document.createElement('div');
    el.className = `dashboard-component dashboard-component-chart-holder dashboard-chart-id-${id}`;
    const rect = jest.fn();
    rects.forEach(r => rect.mockReturnValueOnce(r));
    rect.mockReturnValue(rects[rects.length - 1]);
    el.getBoundingClientRect = rect;
    document.body.appendChild(el);
  };
  // chart 11 scrolled past; chart 12 is the top visible one, 40px under
  // the top before the refresh and 140px under it after
  holder(11, [{ top: -300, bottom: -10, height: 290 }]);
  holder(12, [
    { top: 40, bottom: 330, height: 290 },
    { top: 140, bottom: 430, height: 290 },
  ]);
  const scrollBy = jest.fn();
  window.scrollBy = scrollBy;
  jest
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  serve({});
  await refresh(store);
  expect(scrollBy).toHaveBeenCalledWith(0, 100);
});

test('404 → DASHBOARD_UNAVAILABLE', async () => {
  const store = setup();
  fetchMock.get(`glob:*/api/v1/dashboard/${ID}?q=*`, 404);
  fetchMock.get(`glob:*/api/v1/dashboard/${ID}/charts`, 404);
  await refresh(store);
  expect(store.getState().dashboardState.unavailable).toBe(true);
  // the page's copy is left as it was
  expect(store.getState().charts[11].queriesResponse).toEqual([
    { data: [{ n: 11 }] },
  ]);
});
