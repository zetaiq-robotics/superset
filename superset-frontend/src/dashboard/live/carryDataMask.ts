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
import type { DataMask, DataMaskStateWithId } from '@superset-ui/core';
import { isEqual } from 'lodash-es';
import { getInitialDataMask } from 'src/dataMask/reducer';

/** What the carry reads from a native filter, customization or divider. */
export type LiveFilter = {
  id: string;
  name?: string;
  filterType?: string;
  targets?: unknown;
  defaultDataMask?: DataMask;
  controlValues?: { column?: unknown };
};

/**
 * The viewer's data mask carried onto a newer definition of the dashboard
 * (spec §7.7). A filter keeps its value while its id, type and targets are
 * unchanged; a changed or new one starts from its default; a removed one is
 * dropped and named. Chart-keyed entries (cross-filters, a table's server
 * side sort/page/search) stay while their chart is on the dashboard.
 */
export function carryDataMask(
  current: DataMaskStateWithId,
  oldFilters: LiveFilter[],
  newFilters: LiveFilter[],
  liveChartIds: number[],
): { mask: DataMaskStateWithId; removedFilterNames: string[] } {
  const old = new Map(oldFilters.map(f => [f.id, f]));
  const mask: DataMaskStateWithId = {};

  newFilters.forEach(f => {
    const prev = old.get(f.id);
    if (
      prev &&
      current[f.id] &&
      prev.filterType === f.filterType &&
      isEqual(prev.targets, f.targets)
    ) {
      mask[f.id] = current[f.id];
      return;
    }
    // the default, by the rule a filter-config save applies to a changed filter
    const fresh = {
      ...getInitialDataMask(f.id),
      ...f.defaultDataMask,
    } as DataMaskStateWithId[string];
    // a customization picks its column from its config, as hydration does
    if (f.controlValues?.column) {
      fresh.ownState = { ...fresh.ownState, column: f.controlValues.column };
    }
    mask[f.id] = fresh;
  });

  const kept = new Set(newFilters.map(f => f.id));
  const live = new Set(liveChartIds.map(String));
  Object.entries(current).forEach(([key, value]) => {
    if (!old.has(key) && live.has(key)) mask[key] = value;
  });

  return {
    mask,
    removedFilterNames: oldFilters
      .filter(f => !kept.has(f.id) && f.name)
      .map(f => f.name as string),
  };
}
