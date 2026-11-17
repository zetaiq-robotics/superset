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
import { Dispatch } from 'redux';
import { t } from '@apache-superset/core/translation';
import { makeApi, getClientErrorObject, JsonObject } from '@superset-ui/core';
import { addDangerToast } from 'src/components/MessageToasts/actions';
import {
  ChartConfiguration,
  DashboardInfo,
  FilterBarOrientation,
  GlobalChartCrossFilterConfig,
  RootState,
} from 'src/dashboard/types';
import {
  ifMatch,
  noteNewer,
  NO_VERSIONS,
  Versions,
  versionOf,
} from 'src/dashboard/live/versionTracker';
import { onSave } from './dashboardState';

/** The version pair every dashboard write returns. */
export type VersionPair = {
  old_version_uuid?: string | null;
  new_version_uuid?: string | null;
};

type UpdateDashboardResponse = {
  result: Partial<DashboardInfo>;
  last_modified_time: number;
} & VersionPair;

const putJsonMetadata = (
  id: number,
  metadata: JsonObject,
  base: string | null | undefined,
) =>
  makeApi<Partial<DashboardInfo>, UpdateDashboardResponse>({
    method: 'PUT',
    endpoint: `/api/v1/dashboard/${id}`,
    headers: ifMatch(base),
  })({ json_metadata: JSON.stringify(metadata) });

export const SET_DASHBOARD_VERSIONS = 'SET_DASHBOARD_VERSIONS';

/** Ignored when the tab has since moved to another dashboard. */
export function setDashboardVersions(id: number, versions: Versions) {
  return { type: SET_DASHBOARD_VERSIONS, dashboardId: id, versions };
}

export const DASHBOARD_OWN_WRITE = 'DASHBOARD_OWN_WRITE';

/**
 * Dispatch with the response body of every write this tab makes to
 * dashboard `id`; the reducer applies `adoptAfterOwnWrite`. Ignored when the
 * tab has since moved to another dashboard.
 *
 * `sent` is the `If-Match` the write carried when it was not the base (an
 * explicit Overwrite): a write that replaced exactly that version moves the
 * base, as one that replaced the base would.
 */
export function adoptOwnWrite(id: number, body: unknown, sent?: string | null) {
  const pair = (body ?? {}) as VersionPair;
  return {
    type: DASHBOARD_OWN_WRITE,
    dashboardId: id,
    replaced: pair.old_version_uuid ?? null,
    created: pair.new_version_uuid ?? null,
    sent,
  };
}

/**
 * PUT the tab's `json_metadata` with one setting changed by `change`.
 *
 * The whole document is sent, so it carries `If-Match` like a full save. On
 * a 412 (someone else saved since this tab loaded) it re-reads the dashboard,
 * applies only `change` to the fresh metadata, and retries once against the
 * fresh version; a second 412 is thrown to the caller's error handling.
 */
async function saveMetadataChange(
  dispatch: Dispatch,
  getState: () => RootState,
  change: (metadata: JsonObject) => JsonObject,
): Promise<UpdateDashboardResponse> {
  const { id, metadata, versions } = getState().dashboardInfo;
  let response: UpdateDashboardResponse;
  try {
    response = await putJsonMetadata(
      id,
      change(metadata as JsonObject),
      versions?.base,
    );
  } catch (error) {
    if ((error as { status?: number })?.status !== 412) throw error;
    const fresh = await makeApi<{}, Response, 'raw'>({
      method: 'GET',
      endpoint: `/api/v1/dashboard/${id}`,
      responseType: 'raw',
      cache: 'no-store',
    })({});
    const etag = fresh.headers.get('ETag');
    // without a version to send, the retry would overwrite unconditionally
    if (!etag) throw error;
    const { result } = await fresh.json();
    const current = getState().dashboardInfo.versions ?? NO_VERSIONS;
    dispatch(setDashboardVersions(id, noteNewer(current, etag)));
    response = await putJsonMetadata(
      id,
      change(JSON.parse(result.json_metadata || '{}')),
      versionOf(etag),
    );
  }
  dispatch(adoptOwnWrite(id, response));
  return response;
}

export const DASHBOARD_SAVE_SUCCEEDED = 'DASHBOARD_SAVE_SUCCEEDED';

export function dashboardSaveSucceeded(dashboardId: number) {
  return { type: DASHBOARD_SAVE_SUCCEEDED, dashboardId };
}

export const DASHBOARD_INFO_UPDATED = 'DASHBOARD_INFO_UPDATED';
export const DASHBOARD_INFO_FILTERS_CHANGED = 'DASHBOARD_INFO_FILTERS_CHANGED';

// updates partially changed dashboard info
export function dashboardInfoChanged(newInfo: Partial<DashboardInfo>) {
  return { type: DASHBOARD_INFO_UPDATED, newInfo };
}

export function nativeFiltersConfigChanged(newInfo: Record<string, any>) {
  return { type: DASHBOARD_INFO_FILTERS_CHANGED, newInfo };
}

export const SAVE_CHART_CONFIG_BEGIN = 'SAVE_CHART_CONFIG_BEGIN';
export const SAVE_CHART_CONFIG_COMPLETE = 'SAVE_CHART_CONFIG_COMPLETE';
export const SAVE_CHART_CONFIG_FAIL = 'SAVE_CHART_CONFIG_FAIL';

export const saveChartConfiguration =
  ({
    chartConfiguration,
    globalChartConfiguration,
  }: {
    chartConfiguration?: ChartConfiguration;
    globalChartConfiguration?: GlobalChartCrossFilterConfig;
  }) =>
  async (dispatch: Dispatch, getState: () => RootState) => {
    dispatch({
      type: SAVE_CHART_CONFIG_BEGIN,
      chartConfiguration,
      globalChartConfiguration,
    });
    const { id } = getState().dashboardInfo;

    try {
      const response = await saveMetadataChange(
        dispatch,
        getState,
        metadata => ({
          ...metadata,
          chart_configuration:
            chartConfiguration ?? metadata.chart_configuration,
          global_chart_configuration:
            globalChartConfiguration ?? metadata.global_chart_configuration,
        }),
      );
      dispatch(
        dashboardInfoChanged({
          metadata: JSON.parse(response.result.json_metadata || '{}'),
        }),
      );
      dispatch({
        type: SAVE_CHART_CONFIG_COMPLETE,
        chartConfiguration,
        globalChartConfiguration,
      });
      dispatch(dashboardSaveSucceeded(id));
    } catch (err) {
      dispatch({
        type: SAVE_CHART_CONFIG_FAIL,
        chartConfiguration,
        globalChartConfiguration,
      });
      dispatch(addDangerToast(t('Failed to save cross-filter scoping')));
    }
  };

export const SET_FILTER_BAR_ORIENTATION = 'SET_FILTER_BAR_ORIENTATION';

export function setFilterBarOrientation(
  filterBarOrientation: FilterBarOrientation,
) {
  return { type: SET_FILTER_BAR_ORIENTATION, filterBarOrientation };
}

export const SET_CROSS_FILTERS_ENABLED = 'SET_CROSS_FILTERS_ENABLED';

export function setCrossFiltersEnabled(crossFiltersEnabled: boolean) {
  return { type: SET_CROSS_FILTERS_ENABLED, crossFiltersEnabled };
}

export function saveFilterBarOrientation(orientation: FilterBarOrientation) {
  return async (dispatch: Dispatch, getState: () => RootState) => {
    try {
      const response = await saveMetadataChange(
        dispatch,
        getState,
        metadata => ({ ...metadata, filter_bar_orientation: orientation }),
      );
      const updatedDashboard = response.result;
      const lastModifiedTime = response.last_modified_time;
      if (updatedDashboard.json_metadata) {
        const metadata = JSON.parse(updatedDashboard.json_metadata);
        if (metadata.filter_bar_orientation) {
          dispatch(setFilterBarOrientation(metadata.filter_bar_orientation));
        }
      }
      if (lastModifiedTime) {
        dispatch(onSave(lastModifiedTime));
      }
    } catch (errorObject) {
      const { error } = await getClientErrorObject(errorObject);
      dispatch(
        addDangerToast(
          t(
            'Sorry, there was an error saving this dashboard: %s',
            error || 'Bad Request',
          ),
        ),
      );
      throw errorObject;
    }
  };
}

export function saveCrossFiltersSetting(crossFiltersEnabled: boolean) {
  return async function saveCrossFiltersSettingThunk(
    dispatch: Dispatch,
    getState: () => RootState,
  ) {
    const previousCrossFiltersEnabled =
      getState().dashboardInfo.crossFiltersEnabled;

    dispatch(setCrossFiltersEnabled(crossFiltersEnabled));

    try {
      const response = await saveMetadataChange(
        dispatch,
        getState,
        metadata => ({
          ...metadata,
          cross_filters_enabled: crossFiltersEnabled,
        }),
      );

      const updatedDashboard = response.result;
      const lastModifiedTime = response.last_modified_time;

      if (updatedDashboard.json_metadata) {
        const metadata = JSON.parse(updatedDashboard.json_metadata);
        dispatch(setCrossFiltersEnabled(metadata.cross_filters_enabled));
      }

      if (lastModifiedTime) {
        dispatch(onSave(lastModifiedTime));
      }

      dispatch(
        dashboardInfoChanged({
          metadata: JSON.parse(response.result.json_metadata || '{}'),
        }),
      );
      return response;
    } catch (err) {
      dispatch(setCrossFiltersEnabled(previousCrossFiltersEnabled));
      dispatch(addDangerToast(t('Failed to save cross-filters setting')));
      throw err;
    }
  };
}
