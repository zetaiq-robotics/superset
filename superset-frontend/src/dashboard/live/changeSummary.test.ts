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
import {
  fetchEtag,
  loadStaleSummary,
  summariseChanges,
  VersionEntry,
} from './changeSummary';

const version = (
  uuid: string,
  name: string,
  paths: (string | number)[][],
): VersionEntry => ({
  version_uuid: uuid,
  issued_at: '2026-11-17T10:00:00',
  changed_by: { first_name: name },
  changes: paths.map(path => ({ path, operation: 'edit' })),
});

test('groups the versions after `since` per author', () => {
  const versions = [
    version('v0', 'Lee', [['dashboard_title']]),
    version('v1', 'Priya', [['dashboard_title']]),
    version('v2', 'Priya', [['json_metadata', 'native_filter_configuration']]),
    version('v3', 'Ana', [['CHART-abc']]),
  ];

  expect(summariseChanges(versions, 'v0')).toEqual([
    'Priya changed: title, 1 filter',
    'Ana changed: layout',
  ]);
});

test('unknown paths are other settings', () => {
  expect(
    summariseChanges(
      [version('v0', 'Lee', []), version('v1', 'Priya', [['refresh_x']])],
      'v0',
    ),
  ).toEqual(['Priya changed: other settings']);
});

test('versions at or before `since` are ignored', () => {
  const versions = [
    version('v0', 'Priya', [['css']]),
    version('v1', 'Ana', [['slug']]),
    version('v2', 'Ana', [['published']]),
  ];

  expect(summariseChanges(versions, 'v1')).toEqual([
    'Ana changed: published state',
  ]);
  expect(summariseChanges(versions, 'v2')).toEqual([]);
});

test('a base the history does not list (never versioned) counts every version', () => {
  expect(
    summariseChanges([version('v0', 'Priya', [['css']])], 'unversioned'),
  ).toEqual(['Priya changed: CSS']);
});

test('counts the filters added, removed and edited in one list change', () => {
  const v: VersionEntry = {
    version_uuid: 'v1',
    changed_by: { first_name: 'Priya' },
    changes: [
      {
        path: ['json_metadata', 'native_filter_configuration'],
        operation: 'edit',
        from_value: [{ id: 'F-1' }, { id: 'F-2', name: 'a' }, { id: 'F-3' }],
        to_value: [{ id: 'F-2', name: 'b' }, { id: 'F-3' }, { id: 'F-4' }],
      },
      { path: ['json_metadata', 'label_colors', 'boy'], operation: 'edit' },
    ],
  };

  expect(summariseChanges([v], 'v0')).toEqual([
    'Priya changed: 3 filters, colours',
  ]);
});

test('chart paths', () => {
  expect(
    summariseChanges(
      [
        version('v1', 'Priya', [
          ['slice_name'],
          ['params', 'adhoc_filters', 'country'],
          ['query_context'],
          ['datasource_id'],
        ]),
      ],
      'v0',
    ),
  ).toEqual(['Priya changed: title, chart settings, dataset']);
});

test('a baseline or an empty version names no author (base predating the history)', () => {
  const versions: VersionEntry[] = [
    { ...version('v0', 'Lee', []), operation_type: 'baseline' },
    { ...version('v1', 'Ana', [['css']]), operation_type: 'baseline' },
    version('v2', 'Sam', []),
    version('v3', 'Priya', [['dashboard_title']]),
  ];

  expect(summariseChanges(versions, 'unversioned')).toEqual([
    'Priya changed: title',
  ]);
});

test('the first line never names a version that changed nothing', async () => {
  const get = jest.spyOn(SupersetClient, 'get').mockResolvedValue({
    json: {
      result: [
        version('v1', 'Priya', [['css']]),
        { ...version('v2', 'Lee', []), operation_type: 'baseline' },
      ],
    },
  } as any);

  const summary = await loadStaleSummary('dashboard', 'u', 'v0', async () =>
    null,
  );

  expect(summary?.changedBy).toBe('Priya');
  expect(summary?.lines).toEqual(['Priya changed: CSS']);
  get.mockRestore();
});

test('fetchEtag rejects when the fresh read carries no ETag', async () => {
  const get = jest.spyOn(SupersetClient, 'get').mockResolvedValue({
    json: {},
    response: new Response('{}'),
  } as any);

  await expect(fetchEtag('/api/v1/chart/1')).rejects.toThrow();
  get.mockRestore();
});
