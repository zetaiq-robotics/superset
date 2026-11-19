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
 * Added by ZetaIQ: the rules a dashboard's timed refresh follows.
 * - The deployment can say timed refresh cannot run now, and why
 *   (extension 'dashboard.refresh.policy').
 * - The minimum interval is the larger of the deployment's
 *   SUPERSET_DASHBOARD_PERIODICAL_REFRESH_LIMIT and the dashboard's own
 *   `refresh_minimum` (json_metadata, seconds).
 * - Each chart can refresh more slowly than its dashboard:
 *   `chart_refresh_intervals` (json_metadata, chart id to seconds); a chart
 *   in `timed_refresh_immune_slices` never refreshes on the timer.
 */
import { useSelector } from 'react-redux';
import { getExtensionsRegistry } from '@superset-ui/core';
import { RootState } from 'src/dashboard/types';

export type RefreshRules = {
  allowed: boolean;
  reason?: string;
  minimum: number;
};

const seconds = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** A configured limit in milliseconds (a multiple of 1000 past 1000) reads as seconds, as upstream does. */
const limitSeconds = (v: unknown): number => {
  const n = seconds(v);
  return n >= 1000 && n % 1000 === 0 ? n / 1000 : n;
};

const ALWAYS = (): { allowed: boolean; reason?: string } => ({ allowed: true });

export function useRefreshRules(): RefreshRules {
  const policy =
    getExtensionsRegistry().get('dashboard.refresh.policy') ?? ALWAYS;
  const { allowed, reason } = policy();
  const limit = useSelector((state: RootState) =>
    limitSeconds(
      state.dashboardInfo?.common?.conf
        ?.SUPERSET_DASHBOARD_PERIODICAL_REFRESH_LIMIT,
    ),
  );
  const own = useSelector((state: RootState) =>
    seconds(
      (state.dashboardInfo?.metadata as Record<string, unknown> | undefined)
        ?.refresh_minimum,
    ),
  );
  return { allowed, reason, minimum: Math.max(limit, own) };
}

/** The interval that runs: 0 stays off, anything else is at least the minimum. */
export const effectiveRefresh = (frequency: number, minimum: number) =>
  frequency > 0 ? Math.max(frequency, minimum) : 0;

/**
 * The charts a timed refresh re-runs: not the immune ones, and not one whose
 * own slower interval has not passed since it last finished. Half a tick of
 * slack keeps a 60 s chart on a 30 s dashboard on every second tick.
 */
export function chartsDue(
  chartIds: number[],
  immune: number[],
  intervals: Record<string, number> | undefined,
  lastEnd: (chartId: number) => number | null | undefined,
  tickMs: number,
  now: number,
): number[] {
  return chartIds.filter(id => {
    if (immune.includes(id)) return false;
    const own = seconds(intervals?.[String(id)]) * 1000;
    if (!own || own <= tickMs) return true;
    const end = lastEnd(id);
    return !end || now - end >= own - tickMs / 2;
  });
}
