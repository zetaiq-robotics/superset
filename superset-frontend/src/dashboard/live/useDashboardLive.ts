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
import {
  addDangerToast,
  addInfoToast,
} from 'src/components/MessageToasts/actions';
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
import {
  classifyEvent,
  DashboardChanged,
  UnavailableReason,
} from './classifyEvent';
import { refreshInPlace, RefreshResult } from './refreshInPlace';
import {
  NO_VERSIONS,
  noteNewer,
  ownWritesInFlight,
  subscribeOwnWritesSettled,
  versionOf,
} from './versionTracker';

/** What the page shows about live changes. */
export type DashboardLiveState = {
  /** a refresh waits for the viewer to finish ("Update waiting") */
  waiting: boolean;
  /** an editor with unsaved changes should see "Dashboard changed" */
  prompt: boolean;
  /** newer saves heard since the editor's base ("Newer version available") */
  badgeCount: number;
  /** every save counted was a chart's: nothing for a dashboard save to clash with */
  chartOnly: boolean;
  /** the dashboard was deleted */
  unavailable: boolean;
  /**
   * Who saved and when, from one history read after the event: undefined
   * while it loads, null when it could not be read.
   */
  summary: StaleSummary | undefined;
};

const IDLE: DashboardLiveState = {
  waiting: false,
  prompt: false,
  badgeCount: 0,
  chartOnly: false,
  unavailable: false,
  summary: undefined,
};

/**
 * Deleted under an editor with unsaved changes: their work stays on screen,
 * but every save path (Save, Save as a copy) would answer 404.
 */
export const deletedWhileEditingMessage = () =>
  t(
    "This dashboard was deleted while you were editing. Your changes stay on screen, but they can't be saved unless the dashboard is restored.",
  );

/** What the header shows about live changes, fed by the page. */
export type LiveBadge = {
  count: number;
  names: string[];
  chartOnly: boolean;
  /** the dashboard is gone: Save and Save as are not offered */
  gone: boolean;
  /** a refresh waits for the viewer to finish */
  waiting: boolean;
  open: () => void;
};
export const LiveBadgeContext = createContext<LiveBadge>({
  count: 0,
  names: [],
  chartOnly: false,
  gone: false,
  waiting: false,
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
// Apply button (its own class: data-test is stripped from builds); a filter
// control open = an open select, date or popover panel; a drill or context
// menu = an open dropdown menu; any open dialog; typing in a field. Polled
// once a second only while a refresh waits; a store flag per control is the
// upgrade if a class name changes.
const MID_ACTION = [
  '.filter-bar__apply-button:not([disabled])',
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
  '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
  '.ant-popover:not(.ant-popover-hidden)',
  '.ant-dropdown:not(.ant-dropdown-hidden)',
].join(',');
const EDITABLE = [
  'input:not([readonly]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])',
  'textarea:not([readonly])',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(',');
// closed dialogs can stay in the page, hidden by a display:none wrapper
const openDialog = () =>
  Array.from(document.querySelectorAll('[role="dialog"]')).some(
    el => !el.closest('[style*="display: none"]'),
  );
const MID_ACTION_POLL_MS = 1000;
const isMidAction = () =>
  document.querySelector(MID_ACTION) !== null ||
  openDialog() ||
  !!document.activeElement?.matches(EDITABLE);

/** The "who saved" read gives up after this; the modal then names no one. */
const SUMMARY_TIMEOUT_MS = 5000;
/** An own write that has not settled by then stops holding live events. */
const OWN_WRITE_HOLD_MS = 30_000;
/** A refresh that failed or was skipped asks again after a jittered backoff. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;

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
    // the base a "Dashboard changed" modal was shown for
    let promptedBase: string | null | undefined;
    // the editor has been told something (modal or badge) since the reset
    let told = false;
    // an access change arrived while the editor had unsaved changes
    let accessPending = false;
    let digest: string | null = null;
    // one entry per subscribe sent on this socket: is it a re-baseline?
    // Replies come back in the order sent; a reconnect starts afresh.
    const sent: boolean[] = [];
    let held: DashboardChanged[] = [];
    // when this tab was first seen with own writes in flight
    let writesSeen: number | null = null;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: {
      charts: number[];
      /** newest dashboard version asked for, null if a non-version reason */
      etag: string | null;
      deferred: boolean;
      /** any of the events was a save, not an access-only change */
      saved: boolean;
      /** every event was a chart's save */
      chartOnly: boolean;
      /** why the page goes away if the refresh answers 404 */
      reason?: UnavailableReason;
    } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const previewing = () =>
      selectIsDashboardVersionPreviewActive(
        store.getState() as unknown as VersionHistoryRootState,
      );
    // own writes hold events, but one that never settles only for so long
    const writing = () => {
      if (ownWritesInFlight() === 0) {
        writesSeen = null;
        return false;
      }
      writesSeen ??= Date.now();
      return Date.now() - writesSeen < OWN_WRITE_HOLD_MS;
    };
    const holding = () => writing() || previewing();
    const isGone = () => gone || !!store.getState().dashboardState.unavailable;
    const isDirty = () => {
      const { editMode, hasUnsavedChanges } = store.getState().dashboardState;
      return Boolean(editMode && hasUnsavedChanges);
    };

    // who saved and when: one history read, through normal access checks
    const readSummary = (base: string | null) => {
      reads += 1;
      const read = reads;
      const { id } = store.getState().dashboardInfo;
      Promise.race([
        loadStaleSummary('dashboard', dashboardUuid, base, () =>
          dashboardLastSave(id),
        ),
        new Promise<null>(resolve =>
          setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS),
        ),
      ]).then(summary => {
        if (!disposed && read === reads) setLive(s => ({ ...s, summary }));
      });
    };

    // An editor with unsaved changes: the modal once per base, then the
    // badge. A chart's save cannot make their dashboard save be refused, so
    // it only counts on the badge, with no one named.
    const tellEditor = (base: string | null, chart: boolean) => {
      told = true;
      if (chart) {
        setLive(s => ({
          ...s,
          badgeCount: s.badgeCount + 1,
          chartOnly: s.badgeCount === 0 || s.chartOnly,
        }));
        return;
      }
      if (promptedBase === base) {
        setLive(s => ({
          ...s,
          badgeCount: s.badgeCount + 1,
          chartOnly: false,
        }));
      } else {
        promptedBase = base;
        setLive(s => ({
          ...s,
          prompt: true,
          badgeCount: s.badgeCount + 1,
          chartOnly: false,
          summary: undefined,
        }));
      }
      readSummary(base);
    };

    const subscribe = (again = false) => {
      if (sendRealtime({ type: 'subscribe', dashboard: dashboardUuid }))
        sent.push(again);
    };

    // The newer version was not brought in: forget it, so the catch-up the
    // server answers with asks again, after a jittered backoff.
    const retry = () => {
      const { id, versions = NO_VERSIONS } = store.getState().dashboardInfo;
      if (versions.latest !== versions.base)
        dispatch(
          setDashboardVersions(id, {
            base: versions.base,
            latest: versions.base,
          }),
        );
      failures += 1;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(
        () => subscribe(),
        Math.random() * Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures),
      );
    };

    // The viewer is mid-action: told now, refreshed when they are done.
    // A refresh that is not deferred is told once it has applied.
    const defer = () => {
      pending!.deferred = true;
      dispatch(
        addInfoToast(t("Dashboard updated. It will refresh when you're done.")),
      );
      setLive(s => ({ ...s, waiting: true }));
    };

    const cancel = () => {
      clearTimeout(timer);
      // eslint-disable-next-line no-use-before-define -- mutual recursion
      document.removeEventListener('visibilitychange', onVisible);
      pending = null;
    };

    const fire = () => {
      const { id, versions = NO_VERSIONS } = store.getState().dashboardInfo;
      const { charts, etag, saved, chartOnly, deferred, reason } = pending!;
      pending = null;
      setLive(s => ({ ...s, waiting: false }));
      if (isGone()) return;
      // a refresh in flight already brought this version in
      if (etag && versionOf(etag) === versions.base) return;
      // edits started while the refresh waited: tell the editor instead
      if (isDirty()) {
        if (saved) tellEditor(versions.base, chartOnly);
        return;
      }
      refreshing = true;
      dispatch(refreshInPlace(id, { history, charts, reason }))
        .catch((error): RefreshResult | 'failed' => {
          logging.warn('Live dashboard refresh failed', error);
          return 'failed';
        })
        .then(result => {
          refreshing = false;
          if (disposed || result === 'gone') return;
          if (result === 'applied') {
            failures = 0;
            if (!deferred) dispatch(addInfoToast(t('Dashboard updated')));
            // re-baseline the chart digest against the copy now loaded
            subscribe(true);
          } else {
            retry();
          }
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
      // a write of this tab's or an open preview: a copy fetched now could
      // undo the write or replace the snapshot on screen
      if (isMidAction() || refreshing || holding()) {
        if (isMidAction() && !pending.deferred) defer();
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

    const schedule = (ev: DashboardChanged, chart: boolean) => {
      const first = !pending;
      if (!pending)
        pending = {
          charts: [],
          etag: null,
          deferred: false,
          saved: false,
          chartOnly: true,
        };
      if (ev.reason !== 'access') pending.saved = true;
      // a 404 after an access change: most likely why
      if (ev.reason === 'access') pending.reason = 'access';
      pending.chartOnly = pending.chartOnly && chart;
      pending.charts.push(...(ev.charts ?? []).map(c => c.id));
      // the newest dashboard version, unless any other reason is waiting
      pending.etag =
        ev.reason === 'dashboard' && (first || pending.etag)
          ? (ev.etag ?? null)
          : null;
      if (!first) return;
      if (isMidAction()) defer();
      timer = setTimeout(attempt, Math.random() * (ev.spread_ms ?? 0));
    };

    const process = (ev: DashboardChanged) => {
      if (isGone()) return;
      const { dashboardInfo, dashboardState } = store.getState();
      const versions = dashboardInfo.versions ?? NO_VERSIONS;
      const dirty = isDirty();
      // permissions are re-read by the refresh once the editor is clean
      if (ev.reason === 'access' && dirty) accessPending = true;
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
      // a chart's save: the dashboard's own version did not move
      const chart =
        ev.reason === 'chart' ||
        (ev.reason === 'catch-up' &&
          (v === null || v === versions.base || v === versions.latest));
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
        // Unsaved work stays on screen (the page is replaced only once it
        // is clean), with a notice that stays until closed.
        if (dirty)
          dispatch(
            addDangerToast(deletedWhileEditingMessage(), { duration: 0 }),
          );
        setLive(s => ({ ...s, waiting: false, unavailable: true }));
      } else if (outcome === 'prompt' || outcome === 'badge') {
        tellEditor(versions.base, chart);
      } else {
        schedule(ev, chart);
      }
    };

    // Own writes (a version restore among them): hold, then judge once the
    // write's new version is adopted. An open version preview: hold until
    // it closes, so the snapshot on screen is not replaced under it.
    const release = () => {
      if (disposed || holding() || !held.length) return;
      const events = held;
      held = [];
      events.forEach(process);
    };
    const receive = (ev: DashboardChanged) => {
      if (ev.uuid !== dashboardUuid) return;
      if (!holding()) {
        process(ev);
        return;
      }
      held.push(ev);
      // a write that never settles: let go, and ask for anything missed
      capTimer ??= setTimeout(() => {
        capTimer = undefined;
        if (!held.length || ownWritesInFlight() === 0) return;
        release();
        subscribe();
      }, OWN_WRITE_HOLD_MS);
    };
    const offSettled = subscribeOwnWritesSettled(() => {
      writesSeen = null;
      release();
    });

    let wasEditing = Boolean(store.getState().dashboardState.editMode);
    let lastBase = (store.getState().dashboardInfo.versions ?? NO_VERSIONS)
      .base;
    const offStore = store.subscribe(() => {
      const { dashboardState, dashboardInfo } = store.getState();
      const editing = Boolean(dashboardState.editMode);
      const { base } = dashboardInfo.versions ?? NO_VERSIONS;
      // discarded, saved (the base moved) or left edit mode: start over
      if (told && ((wasEditing && !editing) || base !== lastBase)) {
        told = false;
        promptedBase = undefined;
        reads += 1;
        setLive(s => ({
          ...s,
          prompt: false,
          badgeCount: 0,
          chartOnly: false,
          summary: undefined,
        }));
      }
      wasEditing = editing;
      lastBase = base;
      if (accessPending && !isDirty()) {
        accessPending = false;
        setTimeout(() => {
          if (!disposed)
            receive({ uuid: dashboardUuid, reason: 'access', spread_ms: 0 });
        }, 0);
      }
      // a preview closed: judge after its own re-hydrate has landed
      if (held.length && !holding()) setTimeout(release, 0);
    });

    const offChanged = subscribeRealtime('dashboard.changed', payload =>
      receive(payload as DashboardChanged),
    );
    const offSubscribed = subscribeRealtime('subscribed', payload => {
      const reply = (payload ?? {}) as Subscribed;
      if (reply.dashboard !== dashboardUuid) return;
      const again = sent.shift() ?? false;
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
    const offOpen = subscribeRealtimeOpen(() => {
      // replies to subscribes sent on the old socket never come
      sent.length = 0;
      subscribe();
    });
    subscribe();

    return () => {
      disposed = true;
      cancel();
      clearTimeout(retryTimer);
      clearTimeout(capTimer);
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
      .then(result => {
        // the edits must not come back through undo
        if (result === 'applied') dispatch(clearDashboardHistory());
        // not applied (a write of this tab's is out): load the page afresh
        else if (result === 'skipped') reloadWithoutEdits();
      })
      .catch(error => {
        // the edited copy must not stay on screen looking saved
        logging.warn('Live dashboard discard failed', error);
        reloadWithoutEdits();
      });
  }, [dispatch, store, history]);

  return { ...live, dismissPrompt, openPrompt, discard };
}
