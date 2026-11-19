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
import { act, renderHook } from '@testing-library/react';
import { createStore, createWrapper } from 'spec/helpers/testing-library';
import reducerIndex from 'spec/helpers/reducerIndex';
import {
  adoptOwnWrite,
  setDashboardVersions,
} from 'src/dashboard/actions/dashboardInfo';
import * as realtime from 'src/middleware/realtime';
import {
  dashboardUnavailable,
  setUnsavedChanges,
} from 'src/dashboard/actions/dashboardState';
import {
  clearVersionPreview,
  openVersionHistoryPanel,
  setVersionPreview,
} from 'src/features/versionHistory/reducer';
import { loadStaleSummary } from './changeSummary';
import { refreshInPlace } from './refreshInPlace';
import { trackOwnWrite } from './versionTracker';
import { useDashboardLive } from './useDashboardLive';

jest.mock('src/middleware/realtime', () => {
  // created here: other modules subscribe while being imported
  const handlers: Record<string, (payload: unknown) => void> = {};
  const openListeners = new Set<(mockReason: string) => void>();
  return {
    ...jest.requireActual('src/middleware/realtime'),
    mockHandlers: handlers,
    mockOpenListeners: openListeners,
    sendRealtime: jest.fn(() => true),
    subscribeRealtime: jest.fn(
      (topic: string, handler: (payload: unknown) => void) => {
        handlers[topic] = handler;
        return () => {
          delete handlers[topic];
        };
      },
    ),
    subscribeRealtimeOpen: jest.fn((listener: (mockReason: string) => void) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    }),
  };
});

jest.mock('./refreshInPlace', () => ({ refreshInPlace: jest.fn() }));
jest.mock('./changeSummary', () => ({
  ...jest.requireActual('./changeSummary'),
  loadStaleSummary: jest.fn(),
}));

const { mockHandlers, mockOpenListeners } = realtime as unknown as {
  mockHandlers: Record<string, (payload: unknown) => void>;
  mockOpenListeners: Set<(reason: string) => void>;
};
const send = realtime.sendRealtime as jest.Mock;
const refresh = refreshInPlace as jest.Mock;
const history = loadStaleSummary as jest.Mock;

// the version the server holds; the stub refresh moves the tab to it
let mockLive = 'v1';
let visibility: DocumentVisibilityState = 'visible';

const ID = 7;
const UUID = 'd1';

const setup = (
  dashboardState = { editMode: false, hasUnsavedChanges: false },
) => {
  const store = createStore(
    {
      dashboardInfo: {
        id: ID,
        uuid: UUID,
        versions: { base: 'v1', latest: 'v1' },
      },
      dashboardState,
      messageToasts: [],
    },
    reducerIndex,
  );
  const hook = renderHook(() => useDashboardLive(UUID), {
    wrapper: createWrapper({ store, useRouter: true }),
  });
  return { store, hook };
};

const toasts = (store: ReturnType<typeof createStore>) =>
  (
    store.getState() as unknown as { messageToasts: { text: string }[] }
  ).messageToasts.map(toast => toast.text);

const changed = (etag: string, version: number, spread_ms = 1000) =>
  act(() => {
    mockHandlers['dashboard.changed']({
      uuid: UUID,
      etag,
      version,
      reason: 'dashboard',
      spread_ms,
    });
  });

// only the hook's own listener: modules imported by the test add theirs
const reconnect = () =>
  act(() => Array.from(mockOpenListeners).pop()!('reconnect'));

const advance = (ms: number) =>
  act(async () => {
    jest.advanceTimersByTime(ms);
  });

const setVisibility = (state: DocumentVisibilityState) =>
  act(() => {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  });

beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
  send.mockClear();
  refresh.mockReset();
  refresh.mockImplementation(
    (id: number) => (dispatch: (action: unknown) => void) => {
      dispatch(setDashboardVersions(id, { base: mockLive, latest: mockLive }));
      return Promise.resolve('applied');
    },
  );
  history.mockReset();
  history.mockResolvedValue({
    changedBy: 'Priya',
    changedAt: 'Nov 17, 2026 10:00 AM',
    lines: [],
    authors: ['Priya'],
  });
  mockLive = 'v1';
  visibility = 'visible';
  document.body.innerHTML = '';
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('subscribes on mount and unsubscribes on unmount', () => {
  const before = mockOpenListeners.size;
  const { hook } = setup();
  expect(mockOpenListeners.size).toBe(before + 1);
  expect(send).toHaveBeenCalledWith({ type: 'subscribe', dashboard: UUID });
  expect(mockHandlers['dashboard.changed']).toBeDefined();
  expect(mockHandlers.subscribed).toBeDefined();

  hook.unmount();
  expect(send).toHaveBeenLastCalledWith({
    type: 'unsubscribe',
    dashboard: UUID,
  });
  expect(mockHandlers['dashboard.changed']).toBeUndefined();
  expect(mockOpenListeners.size).toBe(before);
});

test('re-subscribes on every reconnect', () => {
  setup();
  send.mockClear();
  reconnect();
  expect(send).toHaveBeenCalledWith({ type: 'subscribe', dashboard: UUID });
});

test('a viewer is told, then refreshed after the spread', async () => {
  const { store } = setup();
  mockLive = 'v2';
  changed('v2', 2);
  // told once the new copy is on screen, not before
  expect(toasts(store)).toEqual([]);
  await advance(499);
  expect(refresh).not.toHaveBeenCalled();
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh.mock.calls[0][0]).toBe(ID);
  expect(toasts(store)).toEqual(['Dashboard updated']);
});

test('hidden tab defers until visibilitychange', async () => {
  setup();
  setVisibility('hidden');
  mockLive = 'v2';
  changed('v2', 2);
  await advance(60_000);
  expect(refresh).not.toHaveBeenCalled();

  await setVisibility('visible');
  await advance(0);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('unapplied filter changes defer and are not lost', async () => {
  const { store } = setup();
  document.body.innerHTML =
    '<button class="filter-bar__apply-button">Apply filters</button>';
  mockLive = 'v2';
  changed('v2', 2);
  expect(toasts(store)).toEqual([
    "Dashboard updated. It will refresh when you're done.",
  ]);
  await advance(30_000);
  expect(refresh).not.toHaveBeenCalled();

  // the viewer applies (or clears) their selection: the button disables
  document.querySelector('button')!.setAttribute('disabled', 'disabled');
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('an open filter dropdown or drill menu defers the refresh', async () => {
  setup();
  document.body.innerHTML =
    '<div class="ant-select-dropdown"></div><div class="ant-dropdown ant-dropdown-hidden"></div>';
  mockLive = 'v2';
  changed('v2', 2);
  await advance(5000);
  expect(refresh).not.toHaveBeenCalled();

  document.body.innerHTML = '<div class="ant-dropdown"></div>';
  await advance(5000);
  expect(refresh).not.toHaveBeenCalled();

  document.body.innerHTML =
    '<div class="ant-select-dropdown ant-select-dropdown-hidden"></div>';
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('three events while hidden → one refresh to the newest', async () => {
  const { store } = setup();
  setVisibility('hidden');
  mockLive = 'v4';
  changed('v2', 2);
  changed('v3', 3);
  changed('v4', 4);
  expect(toasts(store)).toHaveLength(0);
  await advance(60_000);
  send.mockClear();

  await setVisibility('visible');
  await advance(0);
  expect(refresh).toHaveBeenCalledTimes(1);
  // one toast, once the refresh applied
  expect(toasts(store)).toEqual(['Dashboard updated']);
  expect((store.getState() as any).dashboardInfo.versions).toEqual({
    base: 'v4',
    latest: 'v4',
  });
  // re-baselined once after the refresh
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({ type: 'subscribe', dashboard: UUID });
});

test('out-of-order and duplicate events never move the tab backwards', async () => {
  const { store } = setup();
  setVisibility('hidden');
  changed('v3', 3);
  changed('v2', 2);
  changed('v3', 3);
  expect((store.getState() as any).dashboardInfo.versions).toEqual({
    base: 'v1',
    latest: 'v3',
  });

  mockLive = 'v3';
  await setVisibility('visible');
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(1);

  // the same events again, after the refresh: nothing
  changed('v3', 3);
  changed('v2', 2);
  await advance(60_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(toasts(store)).toHaveLength(1);
});

test('catch-up on reconnect when etag differs', async () => {
  setup();
  const subscribed = (etag: string, digest: string) =>
    act(() =>
      mockHandlers.subscribed({
        dashboard: UUID,
        ok: true,
        etag,
        charts_digest: digest,
        why: null,
      }),
    );

  // the first reply sets the digest baseline; same version: nothing to do
  subscribed('"v1:acc"', 'x');
  await advance(1000);
  expect(refresh).not.toHaveBeenCalled();

  // a save landed while the socket was down
  reconnect();
  mockLive = 'v2';
  subscribed('"v2:acc"', 'x');
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(1);

  // the re-baseline reply after the refresh sets the new digest
  subscribed('"v2:acc"', 'y');
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(1);

  // a chart saved while down: same version, different digest
  reconnect();
  subscribed('"v2:acc"', 'z');
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test('an own save is held and then ignored: no notice, no refresh', async () => {
  const { store } = setup();
  let finish: (body: unknown) => void = () => {};
  act(() => {
    trackOwnWrite(
      new Promise(resolve => {
        finish = resolve;
      }),
    ).then(body => store.dispatch(adoptOwnWrite(ID, body)));
  });
  // the event can beat the save's response
  changed('v2', 2);
  await act(async () => {
    finish({ old_version_uuid: 'v1', new_version_uuid: 'v2' });
  });
  await advance(60_000);
  expect(refresh).not.toHaveBeenCalled();
  expect(toasts(store)).toEqual([]);
  expect((store.getState() as any).dashboardInfo.versions).toEqual({
    base: 'v2',
    latest: 'v2',
  });
});

test('an event for another dashboard is ignored', async () => {
  const { store } = setup();
  act(() =>
    mockHandlers['dashboard.changed']({
      uuid: 'other',
      etag: 'v9',
      version: 9,
      reason: 'dashboard',
      spread_ms: 0,
    }),
  );
  await advance(1000);
  expect(refresh).not.toHaveBeenCalled();
  expect(toasts(store)).toEqual([]);
});

test('deleted marks the dashboard unavailable and cancels a pending refresh', async () => {
  const { hook } = setup();
  changed('v2', 2);
  act(() =>
    mockHandlers['dashboard.changed']({
      uuid: UUID,
      reason: 'deleted',
      spread_ms: 0,
    }),
  );
  await advance(60_000);
  expect(refresh).not.toHaveBeenCalled();
  expect(hook.result.current.unavailable).toBe(true);
});

test('unmount cancels a pending refresh', async () => {
  const { hook } = setup();
  changed('v2', 2);
  hook.unmount();
  await advance(60_000);
  expect(refresh).not.toHaveBeenCalled();
});

// editors (spec §7.8)
const EDITING = { editMode: true, hasUnsavedChanges: true };
const state = (store: ReturnType<typeof createStore>) =>
  store.getState() as any;

test('prompt shows name and time from the re-fetch', async () => {
  const { hook, store } = setup(EDITING);
  changed('v2', 2);
  // one history read, against the base the unsaved edits started from
  await act(async () => {});
  expect(history).toHaveBeenCalledTimes(1);
  expect(history.mock.calls[0].slice(0, 3)).toEqual(['dashboard', UUID, 'v1']);
  expect(hook.result.current.prompt).toBe(true);
  expect(hook.result.current.summary).toMatchObject({ changedBy: 'Priya' });
  // nothing of the editor's is touched
  await advance(60_000);
  expect(refresh).not.toHaveBeenCalled();
  expect(toasts(store)).toEqual([]);
  expect(state(store).dashboardInfo.versions).toEqual({
    base: 'v1',
    latest: 'v2',
  });
});

test('discard loads latest and leaves edit mode', async () => {
  const { hook, store } = setup(EDITING);
  mockLive = 'v2';
  changed('v2', 2);
  await act(async () => {});
  await act(async () => hook.result.current.discard());
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh.mock.calls[0][0]).toBe(ID);
  expect(state(store).dashboardState).toMatchObject({
    editMode: false,
    hasUnsavedChanges: false,
  });
  expect(state(store).dashboardInfo.versions).toEqual({
    base: 'v2',
    latest: 'v2',
  });
  expect(hook.result.current.prompt).toBe(false);
  expect(hook.result.current.badgeCount).toBe(0);
});

test('keep editing keeps base and shows badge', async () => {
  const { hook, store } = setup(EDITING);
  changed('v2', 2);
  await act(async () => {});
  act(() => hook.result.current.dismissPrompt());
  expect(hook.result.current.prompt).toBe(false);
  expect(hook.result.current.badgeCount).toBe(1);
  expect(state(store).dashboardInfo.versions.base).toBe('v1');
  expect(state(store).dashboardState.editMode).toBe(true);

  // the badge offers the same two choices again
  act(() => hook.result.current.openPrompt());
  expect(hook.result.current.prompt).toBe(true);
});

test('second save updates badge, no second modal', async () => {
  const { hook } = setup(EDITING);
  changed('v2', 2);
  await act(async () => {});
  act(() => hook.result.current.dismissPrompt());

  history.mockResolvedValue({
    changedBy: 'Ana',
    changedAt: 'Nov 17, 2026 10:05 AM',
    lines: [],
    authors: ['Priya', 'Ana'],
  });
  changed('v3', 3);
  // an access-only change is not a save
  act(() =>
    mockHandlers['dashboard.changed']({
      uuid: UUID,
      etag: 'v3',
      version: 3,
      reason: 'access',
    }),
  );
  await act(async () => {});
  expect(hook.result.current.prompt).toBe(false);
  expect(hook.result.current.badgeCount).toBe(2);
  expect(hook.result.current.summary?.authors).toEqual(['Priya', 'Ana']);
  expect(refresh).not.toHaveBeenCalled();
});

test('a successful save or leaving edit mode resets the badge', async () => {
  const { hook, store } = setup(EDITING);
  changed('v2', 2);
  await act(async () => {});
  act(() => hook.result.current.dismissPrompt());
  expect(hook.result.current.badgeCount).toBe(1);

  // Overwrite: the save moved the base
  act(() => {
    store.dispatch(setDashboardVersions(ID, { base: 'v4', latest: 'v4' }));
  });
  expect(hook.result.current.badgeCount).toBe(0);

  // a newer save prompts again for the new base
  changed('v5', 5);
  await act(async () => {});
  expect(hook.result.current.prompt).toBe(true);
});

test('clean edit mode refreshes and stays in edit mode', async () => {
  const { hook, store } = setup({ editMode: true, hasUnsavedChanges: false });
  mockLive = 'v2';
  changed('v2', 2, 0);
  await advance(0);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(hook.result.current.prompt).toBe(false);
  expect(state(store).dashboardState.editMode).toBe(true);
});

test('edits started while a refresh waits get the prompt instead', async () => {
  const { hook, store } = setup({ editMode: true, hasUnsavedChanges: false });
  changed('v2', 2);
  act(() => {
    store.dispatch(setUnsavedChanges(true));
  });
  await advance(1000);
  expect(refresh).not.toHaveBeenCalled();
  expect(hook.result.current.prompt).toBe(true);
});

test('version preview holds events', async () => {
  const { store } = setup();
  act(() => {
    store.dispatch(openVersionHistoryPanel('dashboard'));
    store.dispatch(
      setVersionPreview({
        entityUuid: UUID,
        versionUuid: 'old',
        transactionId: 1,
        headline: 'old',
        issuedAt: '2026-11-17T10:00:00',
      }),
    );
  });
  mockLive = 'v2';
  changed('v2', 2, 0);
  await advance(60_000);
  expect(refresh).not.toHaveBeenCalled();
  expect(toasts(store)).toEqual([]);

  act(() => {
    store.dispatch(clearVersionPreview(UUID));
  });
  // released after the preview's own re-hydrate, then refreshed
  await advance(1);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('no further refreshes once the dashboard is unavailable', async () => {
  const { store } = setup();
  act(() => {
    store.dispatch(dashboardUnavailable());
  });
  changed('v2', 2, 0);
  await advance(60_000);
  expect(refresh).not.toHaveBeenCalled();
});

// combined review fixes

const reply = (etag: string, digest = 'x') =>
  act(() =>
    mockHandlers.subscribed({
      dashboard: UUID,
      ok: true,
      etag,
      charts_digest: digest,
      why: null,
    }),
  );
const subscribes = () =>
  send.mock.calls.filter(([m]) => m.type === 'subscribe').length;

test('deleted while editing keeps the page and says it is gone', async () => {
  const { hook, store } = setup(EDITING);
  act(() =>
    mockHandlers['dashboard.changed']({ uuid: UUID, reason: 'deleted' }),
  );
  expect(hook.result.current.unavailable).toBe(true);
  // a notice that stays until closed; the unsaved work stays on screen
  const notice = (store.getState() as any).messageToasts.find(
    (toast: { text: string }) =>
      toast.text ===
      "This dashboard was deleted while you were editing. Your changes stay on screen, but they can't be saved unless the dashboard is restored.",
  );
  expect(notice).toMatchObject({ toastType: 'DANGER_TOAST', duration: 0 });
  expect(state(store).dashboardState.editMode).toBe(true);
});

test('a refresh waits while an own write is in flight', async () => {
  setup();
  mockLive = 'v2';
  changed('v2', 2, 1000);
  let finish: () => void = () => {};
  act(() => {
    trackOwnWrite(
      new Promise<void>(resolve => {
        finish = resolve;
      }),
    );
  });
  await advance(5000);
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => finish());
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('a refresh refreshInPlace skipped is retried with a plain catch-up', async () => {
  const { store } = setup();
  refresh.mockImplementationOnce(() => () => Promise.resolve('skipped'));
  changed('v2', 2, 0);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  // the newer version was not brought in: forgotten, so it is asked again
  expect(state(store).dashboardInfo.versions).toEqual({
    base: 'v1',
    latest: 'v1',
  });
  send.mockClear();
  await advance(60_000);
  expect(subscribes()).toBe(1);
  mockLive = 'v2';
  reply('"v2:acc"');
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test('a failed refresh is retried', async () => {
  const { store } = setup();
  refresh.mockImplementationOnce(() => () => Promise.reject(new Error('502')));
  changed('v2', 2, 0);
  await advance(1);
  expect(state(store).dashboardInfo.versions.latest).toBe('v1');
  send.mockClear();
  await advance(60_000);
  expect(subscribes()).toBe(1);
  mockLive = 'v2';
  reply('"v2:acc"');
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(state(store).dashboardInfo.versions.base).toBe('v2');
});

test('a chart change while editing only updates the badge', async () => {
  const { hook } = setup(EDITING);
  act(() =>
    mockHandlers['dashboard.changed']({
      uuid: UUID,
      etag: 'v1',
      version: 1,
      reason: 'chart',
      charts: [{ id: 3, etag: 'c2' }],
    }),
  );
  await act(async () => {});
  expect(hook.result.current.prompt).toBe(false);
  expect(hook.result.current.badgeCount).toBe(1);
  expect(hook.result.current.chartOnly).toBe(true);
  expect(history).not.toHaveBeenCalled();

  // a dashboard save still prompts, with who saved it
  changed('v2', 2);
  await act(async () => {});
  expect(hook.result.current.prompt).toBe(true);
  expect(hook.result.current.chartOnly).toBe(false);
  expect(hook.result.current.badgeCount).toBe(2);
  expect(history).toHaveBeenCalledTimes(1);
});

test('the history read gives up after 5 s', async () => {
  const { hook } = setup(EDITING);
  history.mockReturnValue(new Promise(() => {}));
  changed('v2', 2);
  expect(hook.result.current.summary).toBeUndefined();
  await advance(5000);
  expect(hook.result.current.summary).toBeNull();
});

test('an access change while editing refreshes once the editor is clean', async () => {
  const { store } = setup(EDITING);
  act(() =>
    mockHandlers['dashboard.changed']({
      uuid: UUID,
      etag: 'v1',
      version: 1,
      reason: 'access',
      spread_ms: 0,
    }),
  );
  await advance(60_000);
  expect(refresh).not.toHaveBeenCalled();

  act(() => {
    store.dispatch(setUnsavedChanges(false));
  });
  await advance(1);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => {
    store.dispatch(setUnsavedChanges(true));
    store.dispatch(setUnsavedChanges(false));
  });
  await advance(60_000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('a reconnect during a refresh does not lose the catch-up', async () => {
  setup();
  reply('"v1:acc"');
  let finish: () => void = () => {};
  refresh.mockImplementationOnce(
    (id: number) => (dispatch: (action: unknown) => void) =>
      new Promise(resolve => {
        finish = () => {
          dispatch(setDashboardVersions(id, { base: 'v2', latest: 'v2' }));
          resolve('applied');
        };
      }),
  );
  changed('v2', 2, 0);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  // the socket drops and comes back while the refresh is in flight
  reconnect();
  await act(async () => finish());
  // replies arrive in the order sent: the reconnect's first
  mockLive = 'v3';
  reply('"v3:acc"');
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test('an open dialog or a focused field defers the refresh', async () => {
  setup();
  document.body.innerHTML =
    '<div style="display: none"><div role="dialog"></div></div>';
  changed('v2', 2, 0);
  await advance(1);
  // a closed dialog left in the page does not count
  expect(refresh).toHaveBeenCalledTimes(1);

  document.body.innerHTML = '<div role="dialog"></div>';
  changed('v3', 3, 0);
  await advance(5000);
  expect(refresh).toHaveBeenCalledTimes(1);

  document.body.innerHTML = '<input id="f" />';
  (document.getElementById('f') as HTMLInputElement).focus();
  await advance(5000);
  expect(refresh).toHaveBeenCalledTimes(1);

  (document.getElementById('f') as HTMLInputElement).blur();
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

test("the editor's own write while keeping editing is not counted", async () => {
  const { hook, store } = setup(EDITING);
  changed('v2', 2);
  await act(async () => {});
  act(() => hook.result.current.dismissPrompt());
  expect(hook.result.current.badgeCount).toBe(1);

  // a native filter save while behind: replaces v2, creates v3
  let finish: (body: unknown) => void = () => {};
  act(() => {
    trackOwnWrite(
      new Promise(resolve => {
        finish = resolve;
      }),
    ).then(body => store.dispatch(adoptOwnWrite(ID, body)));
  });
  changed('v3', 3);
  await act(async () => {
    finish({ old_version_uuid: 'v2', new_version_uuid: 'v3' });
  });
  await advance(1);
  expect(hook.result.current.badgeCount).toBe(1);
  expect(state(store).dashboardInfo.versions).toEqual({
    base: 'v1',
    latest: 'v3',
  });
});

test('a write that never settles stops holding after 30 s', async () => {
  setup();
  let unstick: () => void = () => {};
  act(() => {
    trackOwnWrite(
      new Promise<void>(resolve => {
        unstick = resolve;
      }),
    );
  });
  mockLive = 'v2';
  changed('v2', 2, 0);
  send.mockClear();
  await advance(29_000);
  expect(refresh).not.toHaveBeenCalled();
  await advance(1000);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  // and the server is asked for anything else missed
  expect(subscribes()).toBeGreaterThanOrEqual(1);
  await act(async () => unstick());
  await advance(1);
});

// notices: toast after the refresh, the reason of a 404, "Update waiting"

const event = (reason: string, extra: object = {}) =>
  act(() =>
    mockHandlers['dashboard.changed']({
      uuid: UUID,
      reason,
      spread_ms: 0,
      ...extra,
    }),
  );
// the stub refresh answers 404, as the real one does
const refreshGone = () =>
  refresh.mockImplementation(
    (_id: number, { reason }: { reason?: string }) =>
      (dispatch: (action: unknown) => void) => {
        dispatch(dashboardUnavailable(reason as any));
        return Promise.resolve('gone');
      },
  );

test('an access change that 404s carries reason access; others none', async () => {
  const { store } = setup();
  refreshGone();
  event('access', { etag: 'v1', version: 1 });
  await advance(1);
  await advance(1);
  expect(refresh.mock.calls[0][1].reason).toBe('access');
  expect(state(store).dashboardState.unavailableReason).toBe('access');
  expect(toasts(store)).toEqual([]);
});

test('a dashboard save that 404s has no known reason', async () => {
  const { store } = setup();
  refreshGone();
  changed('v2', 2, 0);
  await advance(1);
  await advance(1);
  expect(refresh.mock.calls[0][1].reason).toBeUndefined();
  expect(state(store).dashboardState.unavailableReason).toBeUndefined();
  expect(toasts(store)).toEqual([]);
});

test('a deferred refresh that 404s adds no second toast', async () => {
  const { store } = setup();
  refreshGone();
  document.body.innerHTML =
    '<button class="filter-bar__apply-button">Apply filters</button>';
  changed('v2', 2, 0);
  expect(toasts(store)).toEqual([
    "Dashboard updated. It will refresh when you're done.",
  ]);
  document.querySelector('button')!.setAttribute('disabled', 'disabled');
  await advance(1000);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(toasts(store)).toEqual([
    "Dashboard updated. It will refresh when you're done.",
  ]);
});

test('a deferred refresh that applies adds no second toast', async () => {
  const { store } = setup();
  document.body.innerHTML =
    '<button class="filter-bar__apply-button">Apply filters</button>';
  mockLive = 'v2';
  changed('v2', 2, 0);
  document.querySelector('button')!.setAttribute('disabled', 'disabled');
  await advance(1000);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(toasts(store)).toEqual([
    "Dashboard updated. It will refresh when you're done.",
  ]);
});

test('a failed refresh shows no toast', async () => {
  const { store } = setup();
  refresh.mockImplementation(() => () => Promise.resolve('skipped'));
  changed('v2', 2, 0);
  await advance(1);
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(toasts(store)).toEqual([]);
});

test('"Update waiting" stands while a deferred refresh waits, gone once it runs', async () => {
  const { hook } = setup();
  expect(hook.result.current.waiting).toBe(false);
  document.body.innerHTML =
    '<button class="filter-bar__apply-button">Apply filters</button>';
  mockLive = 'v2';
  changed('v2', 2, 0);
  expect(hook.result.current.waiting).toBe(true);
  await advance(30_000);
  expect(hook.result.current.waiting).toBe(true);
  document.querySelector('button')!.setAttribute('disabled', 'disabled');
  await advance(1000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(hook.result.current.waiting).toBe(false);
});

test('"Update waiting" goes when the dashboard is deleted', async () => {
  const { hook } = setup();
  document.body.innerHTML =
    '<button class="filter-bar__apply-button">Apply filters</button>';
  changed('v2', 2, 0);
  expect(hook.result.current.waiting).toBe(true);
  event('deleted');
  expect(hook.result.current.waiting).toBe(false);
});
