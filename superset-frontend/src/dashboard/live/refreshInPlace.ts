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
import type { History } from 'history';
import { SupersetClient } from '@superset-ui/core';
import { DASHBOARD_GET_COLUMNS } from 'src/hooks/apiResources/dashboards';
import {
  hydrateDashboard,
  HydrateChartData,
  HydrateDashboardData,
} from 'src/dashboard/actions/hydrate';
import type { GetState } from 'src/dashboard/types';
import type { AppDispatch } from 'src/views/store';

export type RefreshOptions = {
  history: History;
  /** chart ids named by the events this refresh answers */
  charts: number[];
};

/**
 * Load the dashboard's current version into the open page.
 *
 * ponytail: placeholder until the in-place refresh lands; it re-hydrates
 * like a page load (every chart re-queries, filter selections are carried
 * over as they are), so it ignores `charts`.
 */
export const refreshInPlace =
  (id: number, { history }: RefreshOptions) =>
  async (dispatch: AppDispatch, getState: GetState): Promise<void> => {
    const q = rison.encode({ columns: DASHBOARD_GET_COLUMNS });
    const [{ json, response }, charts] = await Promise.all([
      SupersetClient.get({ endpoint: `/api/v1/dashboard/${id}?q=${q}` }),
      SupersetClient.get({ endpoint: `/api/v1/dashboard/${id}/charts` }),
    ]);
    const { result } = json as { result: Record<string, unknown> };
    const { dashboardInfo, dashboardState, dataMask } = getState();
    // the tab moved to another dashboard while this was loading
    if (dashboardInfo.id !== id) return;
    dispatch(
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
        charts: (charts.json as { result: HydrateChartData[] }).result,
        dataMask,
        activeTabs: dashboardState.activeTabs,
        chartStates: null,
        editMode: dashboardState.editMode,
      }),
    );
  };
