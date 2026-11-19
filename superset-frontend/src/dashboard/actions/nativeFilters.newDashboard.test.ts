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
// Modified by ZetaIQ: a dashboard not stored yet keeps its native filters in the page until its
// first Save sends them (docs/specs/2026-11-19-dashboard-save-paths-design.md §7.3).
import { SupersetClient } from '@superset-ui/core';
import type { SaveFilterChangesType } from 'src/dashboard/components/nativeFilters/FiltersConfigModal/types';
import type { RootState } from 'src/dashboard/types';
import {
  SET_NATIVE_FILTERS_CONFIG_COMPLETE,
  setFilterConfiguration,
} from './nativeFilters';

test('a dashboard not stored yet keeps its filter changes in the page', async () => {
  const request = jest.spyOn(SupersetClient, 'request');
  const put = jest.spyOn(SupersetClient, 'put');
  const dispatch = jest.fn();
  const getState = () =>
    ({
      dashboardInfo: { id: 0, metadata: {} },
      nativeFilters: {
        filters: { a: { id: 'a', name: 'A' }, c: { id: 'c', name: 'C' } },
      },
      dataMask: {},
    }) as unknown as RootState;
  const changes = {
    modified: [{ id: 'b', name: 'B' }],
    deleted: ['a'],
    reordered: ['b', 'c'],
  } as unknown as SaveFilterChangesType;
  await setFilterConfiguration(changes)(dispatch, getState);
  expect(request).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  const complete = dispatch.mock.calls
    .map(call => call[0])
    .find(action => action?.type === SET_NATIVE_FILTERS_CONFIG_COMPLETE);
  expect(complete.filterChanges).toEqual([
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]);
  expect(complete.deletedIds).toEqual(['a']);
});
