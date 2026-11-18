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
import { Versions, versionOf } from './versionTracker';

/**
 * The `dashboard.changed` payload from the push service, plus `catch-up`:
 * the tab's own event when a `subscribed` reply shows its copy is behind.
 */
export type DashboardChanged = {
  uuid: string;
  /** the dashboard's version uuid (`<uuid>:<access>` on a catch-up) */
  etag?: string;
  /** the dashboard's own version number; absent on delete */
  version?: number;
  reason: 'dashboard' | 'chart' | 'access' | 'rollout' | 'deleted' | 'catch-up';
  /** only for `chart`; a chart with no etag was deleted */
  charts?: { id: number; etag?: string }[];
  spread_ms?: number;
  /** only for `catch-up`: the chart digest moved since the last reply */
  digestChanged?: boolean;
};

/** What the tab knows when an event arrives. */
export type LiveView = {
  /** a write by this tab is in flight */
  holding: boolean;
  versions: Versions;
  /** highest `version` of a `dashboard` event seen, null before the first */
  maxVersion: number | null;
  /** chart id -> the newest chart etag this tab has heard of */
  chartEtags: Record<number, string>;
  editMode: boolean;
  hasUnsavedChanges: boolean;
  /** the base a "Dashboard changed" prompt was shown for (undefined: none) */
  promptedBase: string | null | undefined;
};

export type LiveOutcome =
  | 'ignore'
  | 'refresh'
  | 'prompt'
  | 'badge'
  | 'unavailable';

/** Spec §7.7 step 1 (already seen) and §7.8 (editors). */
export function classifyEvent(ev: DashboardChanged, s: LiveView): LiveOutcome {
  if (s.holding) return 'ignore';
  if (ev.reason === 'deleted') return 'unavailable';

  const v = versionOf(ev.etag ?? null);
  const known =
    v !== null && (v === s.versions.base || v === s.versions.latest);
  if (ev.reason === 'dashboard') {
    // Only a dashboard save moves the version number; chart, access and
    // rollout events carry it unchanged, so it orders dashboard events only.
    const older =
      ev.version != null && s.maxVersion != null && ev.version <= s.maxVersion;
    if (older || known) return 'ignore';
  }
  if (ev.reason === 'catch-up' && known && !ev.digestChanged) return 'ignore';
  if (
    ev.reason === 'chart' &&
    (ev.charts ?? []).every(c => c.etag && s.chartEtags[c.id] === c.etag)
  )
    return 'ignore';

  if (s.editMode && s.hasUnsavedChanges)
    return s.promptedBase === s.versions.base ? 'badge' : 'prompt';
  return 'refresh';
}
