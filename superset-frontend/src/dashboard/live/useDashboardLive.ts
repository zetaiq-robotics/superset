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
import { createContext, useCallback, useEffect, useState } from 'react';
import { useStore } from 'react-redux';
import { useHistory } from 'react-router-dom';
import { t } from '@apache-superset/core/translation';
import { logging } from '@apache-superset/core/utils';
import { addInfoToast } from 'src/components/MessageToasts/actions';
import { setDashboardVersions } from 'src/dashboard/actions/dashboardInfo';
import { clearDashboardHistory } from 'src/dashboard/actions/dashboardLayout';
import {
  setEditMode,
  setUnsavedChanges,
} from 'src/dashboard/actions/dashboardState';
import { reloadWithoutEdits } from 'src/dashboard/components/StaleSaveModal';
import {
  selectIsDashboardVersionPreviewActive,
  VersionHistoryRootState,
} from 'src/features/versionHistory/reducer';
import type { RootState } from 'src/dashboard/types';
import { useAppDispatch } from 'src/views/store';
import {
  sendRealtime,
  subscribeRealtime,
  subscribeRealtimeOpen,
} from 'src/middleware/realtime';
import {
  dashboardLastSave,
  loadStaleSummary,
  StaleSummary,
} from './changeSummary';
import { classifyEvent, DashboardChanged } from './classifyEvent';
import { refreshInPlace } from './refreshInPlace';
import {
  NO_VERSIONS,
  noteNewer,
  ownWritesInFlight,
  subscribeOwnWritesSettled,
  versionOf,
} from './versionTracker';

/** What the page shows about live changes. */
export type DashboardLiveState = {
  /** the viewer toast currently standing for a pending refresh */
  notice: 'updated' | 'updated-deferred' | null;
  /** an editor with unsaved changes should see "Dashboard changed" */
  prompt: boolean;
  /** newer saves heard since the prompt ("Newer version available") */
  badgeCount: number;
  /** the dashboard was deleted */
  unavailable: boolean;
  /**
   * Who saved and when, from one history read after the event: undefined
   * while it loads, null when it could not be read.
   */
  summary: StaleSummary | undefined;
};

const IDLE: DashboardLiveState = {
  notice: null,
  prompt: false,
  badgeCount: 0,
  unavailable: false,
  summary: undefined,
};

/** The header's "Newer version available" badge, fed by the page. */
export type LiveBadge = { count: number; names: string[]; open: () => void };
export const LiveBadgeContext = createContext<LiveBadge>({
  count: 0,
  names: [],
  open: () => {},
});

type Subscribed = {
  dashboard?: string;
  ok?: boolean;
  etag?: string;
  charts_digest?: string;
  why?: string | null;
};

// ponytail: "mid-action" is read from the page, because none of it is in
// the store: the filter selection lives in the filter bar's local state and
// open menus in the UI library's. Unapplied filter changes = an enabled
// Apply button; a filter control open = an open select, date or popover
// panel; a drill or context menu = an open dropdown menu. Polled once a
// second only while a refresh waits; a store flag per control is the
// upgrade if a class name changes.
const MID_ACTION = [
  '[data-test="filter-bar__apply-button"]:not([disabled])',
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
  '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
  '.ant-popover:not(.ant-popover-hidden)',
  '.ant-dropdown:not(.ant-dropdown-hidden)',
].join(',');
const MID_ACTION_POLL_MS = 1000;
const isMidAction = () => document.querySelector(MID_ACTION) !== null;

/**
 * Keep the open dashboard current (spec §7.6–§7.8): subscribe to its
 * changes, skip what the tab has already seen, hold events while a write by
 * this tab is in flight or a version preview is open, and refresh once,
 * after a random share of `spread_ms`, when the tab is visible and the
 * viewer is not mid-action. An editor with unsaved changes is told instead
 * ("Dashboard changed", then a badge), and nothing of theirs is touched.
 * An empty `dashboardUuid` does nothing.
 */
export function useDashboardLive(dashboardUuid: string) {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const history = useHistory();
  const [live, setLive] = useState<DashboardLiveState>(IDLE);

  useEffect(() => {
    if (!dashboardUuid) return undefined;

    let disposed = false;
    // deleted, or a refresh found it gone: no further refreshes
    let gone = false;
    let reads = 0;
    let maxVersion: number | null = null;
    const chartEtags: Record<number, string> = {};
    let promptedBase: string | null | undefined;
    let digest: string | null = null;
    let rebaseline = false;
    let held: DashboardChanged[] = [];
    let pending: {
      charts: number[];
      /** newest dashboard version asked for, null if a non-version reason */
      etag: string | null;
      deferred: boolean;
      /** any of the events was a save, not an access-only change */
      saved: boolean;
    } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;

    const previewing = () =>
      selectIsDashboardVersionPreviewActive(
        store.getState() as unknown as VersionHistoryRootState,
      );
    const holding = () => ownWritesInFlight() > 0 || previewing();
    const isGone = () => gone || !!store.getState().dashboardState.unavailable;

    // who saved and when: one history read, through normal access checks
    const readSummary = (base: string | null) => {
      reads += 1;
      const read = reads;
      const { id } = store.getState().dashboardInfo;
      loadStaleSummary('dashboard', dashboardUuid, base, () =>
        dashboardLastSave(id),
      ).then(summary => {
        if (!disposed && read === reads) setLive(s => ({ ...s, summary }));
      });
    };

    // an editor with unsaved changes: the modal once per base, then the badge
    const tellEditor = (base: string | null) => {
      if (promptedBase === base) {
        setLive(s => ({ ...s, badgeCount: s.badgeCount + 1 }));
      } else {
        promptedBase = base;
        setLive(s => ({
          ...s,
          prompt: true,
          badgeCount: 1,
          summary: undefined,
        }));
      }
      readSummary(base);
    };

    const subscribe = (again = false) => {
      rebaseline = again;
      sendRealtime({ type: 'subscribe', dashboard: dashboardUuid });
    };

    const notify = (deferred: boolean) => {
      pending!.deferred = deferred;
      dispatch(
        addInfoToast(
          deferred
            ? t("Dashboard updated. It will refresh when you're done.")
            : t('Dashboard updated'),
        ),
      );
      setLive(s => ({
        ...s,
        notice: deferred ? 'updated-deferred' : 'updated',
      }));
    };

    const cancel = () => {
      clearTimeout(timer);
      // eslint-disable-next-line no-use-before-define -- mutual recursion
      document.removeEventListener('visibilitychange', onVisible);
      pending = null;
    };

    const fire = () => {
      const { dashboardInfo, dashboardState } = store.getState();
      const { id, versions = NO_VERSIONS } = dashboardInfo;
      const { charts, etag, saved } = pending!;
      pending = null;
      setLive(s => ({ ...s, notice: null }));
      if (isGone()) return;
      // a refresh in flight already brought this version in
      if (etag && versionOf(etag) === versions.base) return;
      // edits started while the refresh waited: tell the editor instead
      if (dashboardState.editMode && dashboardState.hasUnsavedChanges) {
        if (saved) tellEditor(versions.base);
        return;
      }
      refreshing = true;
      dispatch(refreshInPlace(id, { history, charts }))
        .catch(error => logging.warn('Live dashboard refresh failed', error))
        .finally(() => {
          refreshing = false;
          // re-baseline the chart digest against the copy now loaded
          if (!disposed) subscribe(true);
        });
    };

    const attempt = () => {
      timer = undefined;
      if (!pending) return;
      if (document.visibilityState !== 'visible') {
        // eslint-disable-next-line no-use-before-define -- mutual recursion
        document.addEventListener('visibilitychange', onVisible);
        return;
      }
      if (isMidAction() || refreshing || previewing()) {
        if (isMidAction() && !pending.deferred) notify(true);
        timer = setTimeout(attempt, MID_ACTION_POLL_MS);
        return;
      }
      fire();
    };

    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onVisible);
      attempt();
    }

    const schedule = (ev: DashboardChanged) => {
      const first = !pending;
      if (!pending)
        pending = { charts: [], etag: null, deferred: false, saved: false };
      if (ev.reason !== 'access') pending.saved = true;
      pending.charts.push(...(ev.charts ?? []).map(c => c.id));
      // the newest dashboard version, unless any other reason is waiting
      pending.etag =
        ev.reason === 'dashboard' && (first || pending.etag)
          ? (ev.etag ?? null)
          : null;
      if (!first) return;
      notify(isMidAction());
      timer = setTimeout(attempt, Math.random() * (ev.spread_ms ?? 0));
    };

    const process = (ev: DashboardChanged) => {
      if (isGone()) return;
      const { dashboardInfo, dashboardState } = store.getState();
      const versions = dashboardInfo.versions ?? NO_VERSIONS;
      const outcome = classifyEvent(ev, {
        holding: false,
        versions,
        maxVersion,
        chartEtags,
        editMode: Boolean(dashboardState.editMode),
        hasUnsavedChanges: Boolean(dashboardState.hasUnsavedChanges),
        promptedBase,
      });
      if (
        ev.reason === 'dashboard' &&
        ev.version != null &&
        (maxVersion === null || ev.version > maxVersion)
      )
        maxVersion = ev.version;
      if (outcome === 'ignore') return;

      const v = versionOf(ev.etag ?? null);
      if (
        (ev.reason === 'dashboard' || ev.reason === 'catch-up') &&
        v &&
        v !== versions.base &&
        v !== versions.latest
      )
        dispatch(
          setDashboardVersions(dashboardInfo.id, noteNewer(versions, v)),
        );
      (ev.charts ?? []).forEach(c => {
        if (c.etag) chartEtags[c.id] = c.etag;
        else delete chartEtags[c.id];
      });

      if (outcome === 'unavailable') {
        gone = true;
        cancel();
        setLive(s => ({ ...s, notice: null, unavailable: true }));
      } else if (outcome === 'prompt' || outcome === 'badge') {
        tellEditor(versions.base);
      } else {
        schedule(ev);
      }
    };

    // Own writes (a version restore among them): hold, then judge once the
    // write's new version is adopted. An open version preview: hold until
    // it closes, so the snapshot on screen is not replaced under it.
    const receive = (ev: DashboardChanged) => {
      if (ev.uuid !== dashboardUuid) return;
      if (holding()) held.push(ev);
      else process(ev);
    };
    const release = () => {
      if (disposed || holding() || !held.length) return;
      const events = held;
      held = [];
      events.forEach(process);
    };
    const offSettled = subscribeOwnWritesSettled(release);

    let wasEditing = Boolean(store.getState().dashboardState.editMode);
    let lastBase = (store.getState().dashboardInfo.versions ?? NO_VERSIONS)
      .base;
    const offStore = store.subscribe(() => {
      const { dashboardState, dashboardInfo } = store.getState();
      const editing = Boolean(dashboardState.editMode);
      const { base } = dashboardInfo.versions ?? NO_VERSIONS;
      // discarded, saved (the base moved) or left edit mode: start over
      if (
        promptedBase !== undefined &&
        ((wasEditing && !editing) || base !== lastBase)
      ) {
        promptedBase = undefined;
        reads += 1;
        setLive(s => ({
          ...s,
          prompt: false,
          badgeCount: 0,
          summary: undefined,
        }));
      }
      wasEditing = editing;
      lastBase = base;
      // a preview closed: judge after its own re-hydrate has landed
      if (held.length && !holding()) setTimeout(release, 0);
    });

    const offChanged = subscribeRealtime('dashboard.changed', payload =>
      receive(payload as DashboardChanged),
    );
    const offSubscribed = subscribeRealtime('subscribed', payload => {
      const reply = (payload ?? {}) as Subscribed;
      if (reply.dashboard !== dashboardUuid) return;
      const again = rebaseline;
      rebaseline = false;
      if (!reply.ok) {
        // gone or no longer allowed: the refresh's re-fetch says which
        if (reply.why === 'not_found' && !again)
          receive({
            uuid: dashboardUuid,
            reason: 'catch-up',
            digestChanged: true,
          });
        return;
      }
      const digestChanged =
        digest !== null && digest !== (reply.charts_digest ?? null);
      digest = reply.charts_digest ?? null;
      if (again) return;
      // catch-up after a (re)connect: anything missed while down
      receive({
        uuid: dashboardUuid,
        reason: 'catch-up',
        etag: reply.etag,
        digestChanged,
        spread_ms: 0,
      });
    });
    const offOpen = subscribeRealtimeOpen(() => subscribe());
    subscribe();

    return () => {
      disposed = true;
      cancel();
      offSettled();
      offStore();
      offChanged();
      offSubscribed();
      offOpen();
      sendRealtime({ type: 'unsubscribe', dashboard: dashboardUuid });
      // nothing carries over to the next dashboard
      setLive(IDLE);
    };
  }, [dashboardUuid, dispatch, store, history]);

  /** "Keep editing": the base stays; later saves only update the badge. */
  const dismissPrompt = useCallback(
    () => setLive(s => ({ ...s, prompt: false })),
    [],
  );
  /** The badge offers the same two choices again. */
  const openPrompt = useCallback(
    () => setLive(s => ({ ...s, prompt: true })),
    [],
  );
  /** "Discard my changes": load the latest version in place, leave edit mode. */
  const discard = useCallback(() => {
    const { id } = store.getState().dashboardInfo;
    dispatch(setUnsavedChanges(false));
    // leaving edit mode resets the prompt and the badge (the store listener)
    dispatch(setEditMode(false));
    return dispatch(refreshInPlace(id, { history, charts: [] }))
      .then(() => {
        // the edits must not come back through undo
        dispatch(clearDashboardHistory());
      })
      .catch(error => {
        // the edited copy must not stay on screen looking saved
        logging.warn('Live dashboard discard failed', error);
        reloadWithoutEdits();
      });
  }, [dispatch, store, history]);

  return { ...live, dismissPrompt, openPrompt, discard };
}
