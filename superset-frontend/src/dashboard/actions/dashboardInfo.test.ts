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
import { SupersetClient } from '@superset-ui/core';
import { FilterBarOrientation, RootState } from 'src/dashboard/types';
import { ADD_TOAST } from 'src/components/MessageToasts/actions';
import { ToastType } from 'src/components/MessageToasts/types';
import {
  adoptOwnWrite,
  dashboardSaveSucceeded,
  DASHBOARD_OWN_WRITE,
  saveChartConfiguration,
  saveCrossFiltersSetting,
  saveFilterBarOrientation,
  setDashboardVersions,
  SAVE_CHART_CONFIG_COMPLETE,
  SAVE_CHART_CONFIG_FAIL,
} from './dashboardInfo';

afterEach(() => jest.restoreAllMocks());

const getState = () =>
  ({ dashboardInfo: { id: 1, metadata: {} } }) as RootState;

test('successful cross-filter scoping save refreshes dashboard version history', async () => {
  const request = jest.spyOn(SupersetClient, 'request').mockResolvedValue(
    new Response(
      JSON.stringify({
        result: { json_metadata: '{}' },
        last_modified_time: 123,
      }),
      { status: 200 },
    ),
  );
  const dispatch = jest.fn();

  await saveChartConfiguration({})(dispatch, getState);

  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'PUT',
      endpoint: '/api/v1/dashboard/1',
    }),
  );
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: SAVE_CHART_CONFIG_COMPLETE }),
  );
  expect(dispatch).toHaveBeenCalledWith(dashboardSaveSucceeded(1));
});

test('failed cross-filter scoping save does not refresh dashboard version history', async () => {
  jest
    .spyOn(SupersetClient, 'request')
    .mockRejectedValue(new Error('save failed'));
  const dispatch = jest.fn();

  await saveChartConfiguration({})(dispatch, getState);

  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: SAVE_CHART_CONFIG_FAIL }),
  );
  expect(dispatch).not.toHaveBeenCalledWith(dashboardSaveSucceeded(1));
});

// ---------------------------------------------------------------------------
// json_metadata settings: If-Match, and one re-read + retry on 412
// ---------------------------------------------------------------------------

// What the server holds after someone else saved: a filter this tab never saw.
const freshMetadata = {
  native_filter_configuration: [{ id: 'NATIVE_FILTER-added-by-someone-else' }],
  filter_bar_orientation: FilterBarOrientation.Vertical,
  cross_filters_enabled: true,
};

const behindState = () =>
  ({
    dashboardInfo: {
      id: 1,
      metadata: { only_in_this_tab: true },
      versions: { base: 'a', latest: 'a' },
      crossFiltersEnabled: true,
    },
  }) as unknown as RootState;

// PUTs answer with `putStatuses` in order (200 once they run out); the GET
// answers with the fresh copy at version "fresh".
function fakeServer(putStatuses: number[]) {
  const puts: any[] = [];
  let gets = 0;
  jest.spyOn(SupersetClient, 'request').mockImplementation((async (
    config: any,
  ) => {
    if (config.method === 'GET') {
      gets += 1;
      return new Response(
        JSON.stringify({
          result: { json_metadata: JSON.stringify(freshMetadata) },
        }),
        { status: 200, headers: { ETag: '"fresh:accesshash"' } },
      );
    }
    puts.push(config);
    const status = putStatuses[puts.length - 1] ?? 200;
    if (status !== 200) {
      throw new Response(JSON.stringify({ message: 'stale' }), { status });
    }
    return new Response(
      JSON.stringify({
        result: { json_metadata: '{}' },
        last_modified_time: 1,
        old_version_uuid: puts.length === 1 ? 'a' : 'fresh',
        new_version_uuid: 'new',
      }),
      { status: 200 },
    );
  }) as any);
  return {
    puts,
    gets: () => gets,
    sentMetadata: (i: number) => JSON.parse(puts[i].jsonPayload.json_metadata),
  };
}

const chartConfiguration = { 7: { id: 7 } } as any;
const settingWrites: [string, () => any, Record<string, unknown>][] = [
  [
    'cross-filter scoping',
    () => saveChartConfiguration({ chartConfiguration }),
    { chart_configuration: chartConfiguration },
  ],
  [
    'filter bar orientation',
    () => saveFilterBarOrientation(FilterBarOrientation.Horizontal),
    { filter_bar_orientation: FilterBarOrientation.Horizontal },
  ],
  [
    'cross-filters setting',
    () => saveCrossFiltersSetting(false),
    { cross_filters_enabled: false },
  ],
];

const run = (thunk: any, dispatch: jest.Mock) =>
  // two of the three rethrow after their toast; the assertions are on calls
  Promise.resolve(thunk(dispatch, behindState)).catch(() => undefined);

test.each(settingWrites)(
  '%s sends If-Match with the base',
  async (_name, write) => {
    const server = fakeServer([]);

    await run(write(), jest.fn());

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0].headers).toEqual({ 'If-Match': '"a"' });
  },
);

test.each(settingWrites)(
  '%s on 412 re-reads once and retries its one change on the fresh copy',
  async (_name, write, change) => {
    const server = fakeServer([412]);
    const dispatch = jest.fn();

    await run(write(), dispatch);

    expect(server.gets()).toBe(1);
    expect(server.puts).toHaveLength(2);
    expect(server.puts[1].headers).toEqual({ 'If-Match': '"fresh"' });
    // the other editor's filter survives; the tab's stale copy is not sent
    expect(server.sentMetadata(1)).toEqual({ ...freshMetadata, ...change });
    // the tab has now seen "fresh"; its base moves only per adoptAfterOwnWrite
    expect(dispatch).toHaveBeenCalledWith(
      setDashboardVersions({ base: 'a', latest: 'fresh' }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      adoptOwnWrite(1, { old_version_uuid: 'fresh', new_version_uuid: 'new' }),
    );
  },
);

test.each(settingWrites)(
  '%s stops after one retry when that is refused too',
  async (_name, write) => {
    const server = fakeServer([412, 412]);
    const dispatch = jest.fn();

    await run(write(), dispatch);

    expect(server.gets()).toBe(1);
    expect(server.puts).toHaveLength(2);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ADD_TOAST,
        payload: expect.objectContaining({ toastType: ToastType.Danger }),
      }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: DASHBOARD_OWN_WRITE }),
    );
  },
);
