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
import fetchMock from 'fetch-mock';
import { ensureTagIds } from './tags';

// ZetaIQ: dashboard properties may add a new tag by name; it is created, then saved by id.
afterEach(() => fetchMock.clearHistory().removeRoutes());

test('existing tags pass through; a typed name is created, then saved by its id', async () => {
  fetchMock.post('glob:*/api/v1/tag/', { status: 201, body: {} });
  fetchMock.get('glob:*/api/v1/tag/?q=*', { result: [{ id: 77, name: 'fleet ops' }] });
  const out = await ensureTagIds([
    { id: 3, name: 'drones' },
    { id: 'fleet ops' as unknown as number, name: 'fleet ops' },
  ]);
  expect(out).toEqual([
    { id: 3, name: 'drones' },
    { id: 77, name: 'fleet ops' },
  ]);
  const created = fetchMock.callHistory.calls('glob:*/api/v1/tag/').filter(c => c.options?.method?.toUpperCase() === 'POST');
  expect(JSON.parse(String(created[0].options.body))).toEqual({ name: 'fleet ops', description: '', objects_to_tag: [] });
});

test('a name that already exists (create refused) is still found by name', async () => {
  fetchMock.post('glob:*/api/v1/tag/', { status: 422, body: { message: 'exists' } });
  fetchMock.get('glob:*/api/v1/tag/?q=*', { result: [{ id: 5, name: 'hub' }] });
  expect(await ensureTagIds([{ id: 'hub' as unknown as number, name: 'hub' }])).toEqual([{ id: 5, name: 'hub' }]);
});

test('a tag that cannot be created or found is dropped, not saved with a name as id', async () => {
  fetchMock.post('glob:*/api/v1/tag/', { status: 403, body: {} });
  fetchMock.get('glob:*/api/v1/tag/?q=*', { result: [] });
  expect(await ensureTagIds([{ id: 'nope' as unknown as number, name: 'nope' }])).toEqual([]);
});
