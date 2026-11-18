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
import type { DataMaskStateWithId } from '@superset-ui/core';
import { carryDataMask, LiveFilter } from './carryDataMask';

const region: LiveFilter = {
  id: 'NATIVE_FILTER-region',
  name: 'Region',
  filterType: 'filter_select',
  targets: [{ datasetId: 1, column: { name: 'region' } }],
  defaultDataMask: { filterState: { value: ['EU'] }, extraFormData: {} },
};
const site: LiveFilter = {
  id: 'NATIVE_FILTER-site',
  name: 'Site',
  filterType: 'filter_select',
  targets: [{ datasetId: 1, column: { name: 'site' } }],
  defaultDataMask: { filterState: {}, extraFormData: {} },
};

const viewerMask = (): DataMaskStateWithId => ({
  [region.id]: {
    id: region.id,
    filterState: { value: ['APAC'] },
    extraFormData: { filters: [{ col: 'region', op: 'IN', val: ['APAC'] }] },
    ownState: {},
  },
  [site.id]: {
    id: site.id,
    filterState: { value: ['plant-3'] },
    extraFormData: { filters: [{ col: 'site', op: 'IN', val: ['plant-3'] }] },
    ownState: {},
  },
  // a cross-filter emitted by chart 11 and a table page on chart 12
  11: {
    id: 11 as unknown as string,
    filterState: { value: ['robot-7'] },
    extraFormData: {},
    ownState: {},
  },
  12: {
    id: 12 as unknown as string,
    filterState: {},
    extraFormData: {},
    ownState: { currentPage: 3 },
  },
});

test('keeps native filter values for unchanged filters', () => {
  const current = viewerMask();
  const { mask, removedFilterNames } = carryDataMask(
    current,
    [region, site],
    [{ ...region }, { ...site }],
    [11, 12],
  );
  expect(mask[region.id]).toBe(current[region.id]);
  expect(mask[site.id]).toBe(current[site.id]);
  expect(removedFilterNames).toEqual([]);
});

test('drops a removed filter and reports its name', () => {
  const { mask, removedFilterNames } = carryDataMask(
    viewerMask(),
    [region, site],
    [region],
    [11, 12],
  );
  expect(mask[site.id]).toBeUndefined();
  expect(removedFilterNames).toEqual(['Site']);
});

test('resets a filter whose targets changed', () => {
  const moved = {
    ...region,
    targets: [{ datasetId: 2, column: { name: 'region' } }],
  };
  const { mask } = carryDataMask(viewerMask(), [region], [moved], []);
  expect(mask[region.id].filterState).toEqual({ value: ['EU'] });
  expect(mask[region.id].extraFormData).toEqual({});
});

test('resets a filter whose type changed', () => {
  const retyped = { ...region, filterType: 'filter_range' };
  const { mask } = carryDataMask(viewerMask(), [region], [retyped], []);
  expect(mask[region.id].filterState).toEqual({ value: ['EU'] });
});

test('new filter gets its default', () => {
  const shift: LiveFilter = {
    id: 'NATIVE_FILTER-shift',
    name: 'Shift',
    filterType: 'filter_select',
    targets: [],
    defaultDataMask: { filterState: { value: ['night'] } },
  };
  const { mask } = carryDataMask(viewerMask(), [region], [region, shift], []);
  expect(mask[shift.id]).toMatchObject({
    id: shift.id,
    filterState: { value: ['night'] },
  });
});

test('keeps cross-filters and table state of live charts, drops a removed chart', () => {
  const current = viewerMask();
  const { mask } = carryDataMask(current, [region], [region], [12]);
  expect(mask[11]).toBeUndefined();
  expect(mask[12]).toBe(current[12]);
});
