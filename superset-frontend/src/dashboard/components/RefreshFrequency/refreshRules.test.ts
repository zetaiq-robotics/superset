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
import { renderHook } from '@testing-library/react';
import { getExtensionsRegistry } from '@superset-ui/core';
import { createWrapper } from 'spec/helpers/testing-library';
import { chartsDue, effectiveRefresh, useRefreshRules } from './refreshRules';

test('the interval that runs: off stays off, anything faster than the minimum runs at it', () => {
  expect(effectiveRefresh(0, 30)).toBe(0);
  expect(effectiveRefresh(5, 30)).toBe(30);
  expect(effectiveRefresh(60, 30)).toBe(60);
  expect(effectiveRefresh(10, 0)).toBe(10);
});

test('a timed refresh skips immune charts and charts whose own slower interval has not passed', () => {
  const ends: Record<number, number | null> = {
    1: 0,
    2: 100_000,
    3: 70_000,
    4: null,
  };
  const due = (now: number) =>
    chartsDue(
      [1, 2, 3, 4, 5],
      [5],
      { 2: 60, 3: 60, 4: 300 },
      id => ends[id],
      30_000,
      now,
    );
  // At 130 s: chart 2 finished 30 s ago (60 s rate: not yet), chart 3 finished 60 s ago (due), chart 4 never ran (due)
  expect(due(130_000)).toEqual([1, 3, 4]);
  // Half a tick of slack: 45 s after its last end, a 60 s chart on a 30 s dashboard is due (every second tick)
  expect(due(145_000)).toEqual([1, 2, 3, 4]);
});

test('a chart rate no slower than the dashboard just follows it', () => {
  expect(
    chartsDue([7], [], { 7: 30 }, () => Date.now(), 60_000, Date.now()),
  ).toEqual([7]);
});

test('the minimum is the larger of the deployment limit and the dashboard own; the policy can refuse', () => {
  const state = {
    dashboardInfo: {
      common: { conf: { SUPERSET_DASHBOARD_PERIODICAL_REFRESH_LIMIT: 5 } },
      metadata: { refresh_minimum: 30 },
    },
  };
  let result = renderHook(() => useRefreshRules(), {
    wrapper: createWrapper({ useRedux: true, initialState: state }),
  }).result.current;
  expect(result).toEqual({ allowed: true, reason: undefined, minimum: 30 });

  getExtensionsRegistry().set('dashboard.refresh.policy', () => ({
    allowed: false,
    reason: 'Needs a window that ends now',
  }));
  result = renderHook(() => useRefreshRules(), {
    wrapper: createWrapper({ useRedux: true, initialState: state }),
  }).result.current;
  expect(result.allowed).toBe(false);
  expect(result.reason).toBe('Needs a window that ends now');
});
