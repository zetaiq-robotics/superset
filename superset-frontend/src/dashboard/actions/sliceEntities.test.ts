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
import { SupersetClient } from '@superset-ui/core';
import { fetchSlices } from './sliceEntities';

// ZetaIQ: fetchSlices appends the `dashboard.slices.folder` extension's filters.
afterEach(() => jest.restoreAllMocks());

const sentFilters = async (...args: Parameters<typeof fetchSlices>) => {
  const get = jest
    .spyOn(SupersetClient, 'get')
    .mockResolvedValue({ json: { result: [] } } as any);
  await fetchSlices(...args)(jest.fn());
  const { endpoint } = get.mock.calls[0][0] as { endpoint: string };
  return (rison.decode(endpoint.split('?q=')[1]) as { filters: unknown[] })
    .filters;
};

test('fetchSlices sends only its own filters by default', async () => {
  expect(await sentFilters(1, 'abc')).toEqual([
    { col: 'slice_name', opr: 'chart_all_text', value: 'abc' },
    { col: 'id', opr: 'is_editable', value: 1 },
  ]);
});

test('fetchSlices appends extra filters to the rison filters', async () => {
  expect(
    await sentFilters(1, 'abc', 'changed_on', [
      { col: 'id', opr: 'zeta_path', value: 'Plant A' },
    ]),
  ).toEqual([
    { col: 'slice_name', opr: 'chart_all_text', value: 'abc' },
    { col: 'id', opr: 'is_editable', value: 1 },
    { col: 'id', opr: 'zeta_path', value: 'Plant A' },
  ]);
});
