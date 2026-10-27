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
 * Added by ZetaIQ (variables spec G1).
 */
import { chartsUsingFilter } from './chartsUsingFilter';

const slices: any = {
  1: { slice_id: 1, form_data: { datasource: '1__table' } }, // otel_logs: ServiceName
  2: { slice_id: 2, form_data: { datasource: '13__table' } }, // robot_minute: robot
  3: { slice_id: 3, form_data: { datasource: '20__table' } }, // SQL reads robot via Jinja
  4: { slice_id: 4, form_data: { datasource: '99__table' } }, // dataset not loaded
  5: {
    slice_id: 5,
    form_data: {
      datasource: '1__table',
      adhoc_filters: [{ sqlExpression: "AssetId IN {{ filter_values('robot') | where_in }}" }],
    },
  },
};
const datasources: any = {
  '1__table': { column_names: ['ServiceName', 'AssetId'], sql: null },
  '13__table': { column_names: ['robot', 'Timestamp'], sql: 'SELECT AssetId AS robot …' },
  '20__table': {
    column_names: ['SeverityText'],
    sql: "SELECT … {% if filter_values('robot') %} AND AssetId IN … {% endif %}",
  },
};
const ALL = [1, 2, 3, 4, 5];
const robot = (val: string[]) => ({ filters: [{ col: 'robot', op: 'IN', val }] });

test('a column filter re-runs only charts whose dataset, SQL or form data name the column', () => {
  expect(chartsUsingFilter(ALL, robot(['SB-012']), robot(['SB-001']), slices, datasources)).toEqual([
    2, 3, 4, 5,
  ]);
});

test('clearing a filter uses the columns it had', () => {
  expect(chartsUsingFilter(ALL, {}, robot(['SB-001']), slices, datasources)).toEqual([2, 3, 4, 5]);
});

test('time, grain or column overrides re-run everything in scope', () => {
  const grain = { time_grain_sqla: 'P1D' };
  expect(chartsUsingFilter(ALL, grain, {}, slices, datasources)).toEqual(ALL);
  expect(chartsUsingFilter(ALL, { ...robot(['x']), time_range: 'Last day' }, {}, slices, datasources)).toEqual(ALL);
});

test('a filter on an adhoc (non-string) column re-runs everything in scope', () => {
  const adhoc = { filters: [{ col: { sqlExpression: 'lower(x)' }, op: 'IN', val: ['a'] }] };
  expect(chartsUsingFilter(ALL, adhoc, {}, slices, datasources)).toEqual(ALL);
});

test('a filter nobody uses re-runs nothing it cannot affect', () => {
  const sev = { filters: [{ col: 'Nonexistent', op: 'IN', val: ['WARN'] }] };
  expect(chartsUsingFilter(ALL, sev, {}, slices, datasources)).toEqual([4]);
});
