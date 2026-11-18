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
import { classifyEvent, DashboardChanged, LiveView } from './classifyEvent';

const view = (over: Partial<LiveView> = {}): LiveView => ({
  holding: false,
  versions: { base: 'v1', latest: 'v1' },
  maxVersion: 1,
  chartEtags: {},
  editMode: false,
  hasUnsavedChanges: false,
  promptedBase: undefined,
  ...over,
});

const changed = (over: Partial<DashboardChanged> = {}): DashboardChanged => ({
  uuid: 'd1',
  reason: 'dashboard',
  etag: 'v2',
  version: 2,
  spread_ms: 0,
  ...over,
});

test('an event held for an own write is ignored', () => {
  expect(classifyEvent(changed(), view({ holding: true }))).toBe('ignore');
});

test('an event for the version the tab adopted is ignored', () => {
  const adopted = view({ versions: { base: 'v2', latest: 'v2' } });
  expect(classifyEvent(changed({ version: undefined }), adopted)).toBe(
    'ignore',
  );
});

test('an older version is ignored', () => {
  expect(
    classifyEvent(changed({ etag: 'v0', version: 0 }), view({ maxVersion: 1 })),
  ).toBe('ignore');
});

test('the same event twice: the second is ignored', () => {
  expect(classifyEvent(changed(), view())).toBe('refresh');
  // after the first, the tab has heard of v2 (version 2)
  const heard = view({ versions: { base: 'v1', latest: 'v2' }, maxVersion: 2 });
  expect(classifyEvent(changed(), heard)).toBe('ignore');
  expect(classifyEvent(changed({ version: undefined }), heard)).toBe('ignore');
});

test('a chart event whose chart etags are all known is ignored', () => {
  const ev = changed({
    reason: 'chart',
    charts: [
      { id: 1, etag: 'c1' },
      { id: 2, etag: 'c2' },
    ],
  });
  expect(classifyEvent(ev, view({ chartEtags: { 1: 'c1', 2: 'c2' } }))).toBe(
    'ignore',
  );
  expect(classifyEvent(ev, view({ chartEtags: { 1: 'c1' } }))).toBe('refresh');
});

test('a deleted chart (no etag) is never already seen', () => {
  const ev = changed({ reason: 'chart', charts: [{ id: 1 }] });
  expect(classifyEvent(ev, view({ chartEtags: { 1: 'c1' } }))).toBe('refresh');
});

test('access refreshes; access and rollout ignore the dashboard version', () => {
  // they carry the dashboard's unchanged version number
  const same = { etag: 'v1', version: 1 };
  expect(classifyEvent(changed({ reason: 'access', ...same }), view())).toBe(
    'refresh',
  );
  expect(classifyEvent(changed({ reason: 'rollout', ...same }), view())).toBe(
    'refresh',
  );
});

test('deleted is unavailable', () => {
  expect(
    classifyEvent(
      { uuid: 'd1', reason: 'deleted', spread_ms: 0 },
      view({ maxVersion: 9 }),
    ),
  ).toBe('unavailable');
});

test('edit mode with unsaved changes prompts once per base, then badges', () => {
  const editing = { editMode: true, hasUnsavedChanges: true };
  expect(classifyEvent(changed(), view(editing))).toBe('prompt');
  expect(
    classifyEvent(changed(), view({ ...editing, promptedBase: 'v1' })),
  ).toBe('badge');
});

test('edit mode with nothing changed refreshes', () => {
  expect(classifyEvent(changed(), view({ editMode: true }))).toBe('refresh');
});

test('catch-up refreshes only when the version or the chart digest moved', () => {
  const catchUp = (etag: string, digestChanged: boolean) =>
    classifyEvent(
      { uuid: 'd1', reason: 'catch-up', etag, digestChanged, spread_ms: 0 },
      view(),
    );
  expect(catchUp('"v1:acc"', false)).toBe('ignore');
  expect(catchUp('"v2:acc"', false)).toBe('refresh');
  expect(catchUp('"v1:acc"', true)).toBe('refresh');
});
