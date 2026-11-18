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
 * Modified by ZetaIQ: gateway sign-in mode (WEBSOCKET_AUTH) and sendRealtime.
 */
import { SupersetClient } from '@superset-ui/core';
import {
  connectRealtime,
  dispatchRealtimeMessage,
  resetRealtimeForTests,
  sendRealtime,
  subscribeRealtime,
  subscribeRealtimeOpen,
  subscribeRealtimeState,
} from 'src/middleware/realtime';

// Controllable useTabId mock (overrides the global shim for this file) so we can
// drive both the current tab id baked into the connect URL and tab-id-change
// notifications. `var` + lazy init sidesteps jest.mock hoisting/TDZ.
/* eslint-disable no-var, vars-on-top */
var mockTabIdValue: string;
var mockTabIdListeners: Set<() => void>;
/* eslint-enable no-var, vars-on-top */
jest.mock('src/hooks/useTabId', () => {
  mockTabIdValue = 'test-tab-id';
  mockTabIdListeners = new Set();
  return {
    useTabId: () => 1,
    getTabId: () => mockTabIdValue,
    subscribeTabIdChange: (listener: () => void) => {
      mockTabIdListeners.add(listener);
      return () => mockTabIdListeners.delete(listener);
    },
  };
});

/** Simulate useTabId reassigning this tab a new id (TAB_ID_DENIED collision). */
const fireTabIdChange = (newId: string) => {
  mockTabIdValue = newId;
  mockTabIdListeners.forEach(listener => listener());
};

// A minimal fake WebSocket so connectRealtime can "open" a socket without a
// real network connection. Instances register themselves so a test can drive
// onmessage/onclose.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 0;

  onopen: (() => void) | null = null;

  onmessage: ((event: { data: string }) => void) | null = null;

  onclose: ((event?: { code: number }) => void) | null = null;

  onerror: (() => void) | null = null;

  send = jest.fn();

  close = jest.fn(() => {
    this.readyState = 3;
  });

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
}

const originalWebSocket = global.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  resetRealtimeForTests();
  global.WebSocket = originalWebSocket;
  mockTabIdValue = 'test-tab-id';
});

const ENABLED = {
  WEBSOCKET_ENABLE: true,
  WEBSOCKET_URL: 'ws://localhost:8080/',
};

test('dispatches a parsed envelope to every handler of its topic', () => {
  const a = jest.fn();
  const b = jest.fn();
  subscribeRealtime('entity.changed', a);
  subscribeRealtime('entity.changed', b);

  dispatchRealtimeMessage(
    JSON.stringify({ topic: 'entity.changed', payload: { id: '7' } }),
  );

  expect(a).toHaveBeenCalledWith({ id: '7' });
  expect(b).toHaveBeenCalledWith({ id: '7' });
});

test('dispatches only to handlers subscribed to the message topic', () => {
  const taskStatus = jest.fn();
  const entityChanged = jest.fn();
  subscribeRealtime('task.status', taskStatus);
  subscribeRealtime('entity.changed', entityChanged);

  dispatchRealtimeMessage(
    JSON.stringify({ topic: 'task.status', payload: { task_id: 'a' } }),
  );

  expect(taskStatus).toHaveBeenCalledWith({ task_id: 'a' });
  expect(entityChanged).not.toHaveBeenCalled();
});

test('unsubscribe stops a handler from receiving further messages', () => {
  const handler = jest.fn();
  const unsubscribe = subscribeRealtime('entity.changed', handler);

  unsubscribe();
  dispatchRealtimeMessage(
    JSON.stringify({ topic: 'entity.changed', payload: {} }),
  );

  expect(handler).not.toHaveBeenCalled();
});

test('ignores malformed data and messages without a topic', () => {
  const handler = jest.fn();
  subscribeRealtime('entity.changed', handler);

  expect(() => dispatchRealtimeMessage('not json')).not.toThrow();
  dispatchRealtimeMessage(JSON.stringify({ payload: { id: '7' } })); // no topic

  expect(handler).not.toHaveBeenCalled();
});

test('a throwing handler does not break other handlers', () => {
  const bad = jest.fn(() => {
    throw new Error('boom');
  });
  const good = jest.fn();
  subscribeRealtime('entity.changed', bad);
  subscribeRealtime('entity.changed', good);

  expect(() =>
    dispatchRealtimeMessage(
      JSON.stringify({ topic: 'entity.changed', payload: {} }),
    ),
  ).not.toThrow();
  expect(good).toHaveBeenCalledTimes(1);
});

test('notifies open-listeners when the socket connects', () => {
  const onOpen = jest.fn();
  const unsubscribe = subscribeRealtimeOpen(onOpen);
  connectRealtime(ENABLED);

  expect(FakeWebSocket.instances).toHaveLength(1);
  FakeWebSocket.instances[0].onopen?.();
  expect(onOpen).toHaveBeenCalledTimes(1);

  // A reopen (openSocket wires onopen on every socket) notifies again.
  FakeWebSocket.instances[0].onopen?.();
  expect(onOpen).toHaveBeenCalledTimes(2);

  unsubscribe();
  FakeWebSocket.instances[0].onopen?.();
  expect(onOpen).toHaveBeenCalledTimes(2); // no longer notified
});

test('does not open a socket when disabled', () => {
  connectRealtime({ WEBSOCKET_ENABLE: false, WEBSOCKET_URL: 'ws://x/' });
  expect(FakeWebSocket.instances).toHaveLength(0);
});

test('opens a socket when enabled and routes its messages to handlers', () => {
  const handler = jest.fn();
  subscribeRealtime('task.status', handler);
  connectRealtime(ENABLED);

  expect(FakeWebSocket.instances).toHaveLength(1);
  const ws = FakeWebSocket.instances[0];
  // The connect URL is the configured base plus this tab's id, so the server
  // can bind a per-tab channel. getTabId is mocked to 'test-tab-id' (shim).
  const wsUrl = new URL(ws.url);
  expect(`${wsUrl.protocol}//${wsUrl.host}${wsUrl.pathname}`).toBe(
    ENABLED.WEBSOCKET_URL,
  );
  expect(wsUrl.searchParams.get('tab_id')).toBe('test-tab-id');

  ws.onmessage?.({
    data: JSON.stringify({ topic: 'task.status', payload: { ok: true } }),
  });

  expect(handler).toHaveBeenCalledWith({ ok: true });
});

test('resolves a root-relative ws url against the page and adds tab_id', () => {
  // A root-relative endpoint (e.g. behind a same-origin proxy) is valid for
  // WebSocket; it must resolve against the page URL and normalize to ws(s),
  // still carrying tab_id — not silently drop the tab id.
  connectRealtime({ WEBSOCKET_ENABLE: true, WEBSOCKET_URL: '/superset-ws' });

  expect(FakeWebSocket.instances).toHaveLength(1);
  const u = new URL(FakeWebSocket.instances[0].url);
  expect(u.protocol).toBe('ws:'); // jsdom page is http:// → ws://
  expect(u.pathname).toBe('/superset-ws');
  expect(u.searchParams.get('tab_id')).toBe('test-tab-id');
});

test('reconnects with the new tab id when the tab id changes', () => {
  connectRealtime(ENABLED);
  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(
    new URL(FakeWebSocket.instances[0].url).searchParams.get('tab_id'),
  ).toBe('test-tab-id');

  // A duplicated tab is reassigned a new id: the socket must reconnect so it
  // re-registers under the new per-tab channel (else tab-targeted events miss
  // it and only polling notices completion).
  fireTabIdChange('tab-2');

  expect(FakeWebSocket.instances).toHaveLength(2);
  expect(FakeWebSocket.instances[0].close).toHaveBeenCalled();
  expect(
    new URL(FakeWebSocket.instances[1].url).searchParams.get('tab_id'),
  ).toBe('tab-2');
});

test('keeps the active socket when reconnecting with the same config', () => {
  connectRealtime(ENABLED);
  connectRealtime(ENABLED);

  expect(FakeWebSocket.instances).toHaveLength(1);
  expect(FakeWebSocket.instances[0].close).not.toHaveBeenCalled();
});

test('reconnects after the socket closes', () => {
  jest.useFakeTimers();
  connectRealtime(ENABLED);
  expect(FakeWebSocket.instances).toHaveLength(1);

  FakeWebSocket.instances[0].onclose?.();
  jest.advanceTimersByTime(5000);

  expect(FakeWebSocket.instances).toHaveLength(2);
  jest.useRealTimers();
});

test('reports reconnecting then unhealthy after repeated failures, and open resets it', () => {
  jest.useFakeTimers();
  const states: string[] = [];
  subscribeRealtimeState(s => states.push(s));
  connectRealtime(ENABLED);

  // Three consecutive closes with no successful OPEN in between.
  for (let i = 0; i < 3; i += 1) {
    FakeWebSocket.instances[FakeWebSocket.instances.length - 1].onclose?.();
    // Advance past the max backoff so the scheduled reconnect fires.
    jest.advanceTimersByTime(30000);
  }
  expect(states).toContain('reconnecting');
  expect(states).toContain('unhealthy');

  // A successful OPEN clears the failure state back to healthy.
  FakeWebSocket.instances[FakeWebSocket.instances.length - 1].onopen?.();
  expect(states[states.length - 1]).toBe('open');
  jest.useRealTimers();
});

test('a synchronous WebSocket constructor failure still schedules a reconnect', () => {
  jest.useFakeTimers();
  const Broken = jest.fn(() => {
    throw new Error('construct failed');
  });
  global.WebSocket = Broken as unknown as typeof WebSocket;

  connectRealtime(ENABLED);
  // The throw is caught; a reconnect is scheduled rather than dead-ending, so the
  // constructor is retried (repeatedly, with backoff) instead of only once.
  jest.advanceTimersByTime(30000);
  expect(Broken.mock.calls.length).toBeGreaterThan(1);
  jest.useRealTimers();
});

test('disconnect closes the socket and stops reconnecting', () => {
  jest.useFakeTimers();
  connectRealtime(ENABLED);
  const ws = FakeWebSocket.instances[0];

  // disconnect via a superseding reset; the prior socket must not reconnect.
  resetRealtimeForTests();
  expect(ws.close).toHaveBeenCalled();

  ws.onclose?.(); // a late close from the torn-down socket
  jest.advanceTimersByTime(5000);
  expect(FakeWebSocket.instances).toHaveLength(1); // no new socket
  jest.useRealTimers();
});

test('refreshes the cookie and reconnects before the token expires', async () => {
  jest.useFakeTimers();
  const getSpy = jest
    .spyOn(SupersetClient, 'get')
    .mockResolvedValue({} as never);
  try {
    // A 900s token → the keepalive fires at 0.6 of its life (540s), issuing the
    // authed cookie-refresh GET, then reconnecting so the new handshake rides a
    // freshly minted token before the server terminates the socket at expiry.
    connectRealtime({ ...ENABLED, WEBSOCKET_JWT_EXPIRATION_SECONDS: 900 });
    expect(FakeWebSocket.instances).toHaveLength(1);
    // Simulate the socket having connected — the keepalive only hands off a
    // socket that is still OPEN (readyState 1).
    FakeWebSocket.instances[0].readyState = 1;

    jest.advanceTimersByTime(540_000);
    expect(getSpy).toHaveBeenCalledWith({ endpoint: '/api/v1/me/' });

    // Flush the refresh promise chain so the .finally reconnect runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(2);
  } finally {
    getSpy.mockRestore();
    jest.useRealTimers();
  }
});

test('a socket that drops just before keepalive reconnects (not a keepalive handoff)', async () => {
  jest.useFakeTimers();
  const getSpy = jest
    .spyOn(SupersetClient, 'get')
    .mockResolvedValue({} as never);
  const reasons: string[] = [];
  subscribeRealtimeOpen(reason => reasons.push(reason));
  try {
    connectRealtime({ ...ENABLED, WEBSOCKET_JWT_EXPIRATION_SECONDS: 900 });
    const ws = FakeWebSocket.instances[0];
    ws.readyState = 1; // OPEN
    ws.onopen?.();
    expect(reasons).toEqual(['initial']);

    // The socket really drops just before the keepalive (540s) fires; onclose
    // schedules a real reconnect at +5s.
    jest.advanceTimersByTime(539_000);
    ws.readyState = 3; // CLOSED
    ws.onclose?.();

    // The keepalive timer fires while the socket is closed → it must bail (no
    // refresh GET, no keepalive handoff), leaving the real reconnect to run.
    jest.advanceTimersByTime(2_000);
    await Promise.resolve();
    expect(getSpy).not.toHaveBeenCalled();

    // The scheduled reconnect opens with reason 'reconnect' — so list views still
    // reconcile the outage rather than treating it as a seamless keepalive.
    jest.advanceTimersByTime(5_000);
    FakeWebSocket.instances[1].readyState = 1;
    FakeWebSocket.instances[1].onopen?.();
    expect(reasons).toEqual(['initial', 'reconnect']);
  } finally {
    getSpy.mockRestore();
    jest.useRealTimers();
  }
});

test('does not schedule a keepalive without a configured token lifetime', () => {
  jest.useFakeTimers();
  const getSpy = jest.spyOn(SupersetClient, 'get');
  try {
    connectRealtime(ENABLED); // no WEBSOCKET_JWT_EXPIRATION_SECONDS
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(getSpy).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  } finally {
    getSpy.mockRestore();
    jest.useRealTimers();
  }
});

// --- Gateway sign-in mode (WEBSOCKET_AUTH = "gateway") ---------------------

const GATEWAY = { ...ENABLED, WEBSOCKET_AUTH: 'gateway' };

const lastSocket = () =>
  FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

// Let a fetch(...).then(...) chain settle while fake timers are on.
const flushPromises = async () => {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

describe('gateway mode', () => {
  const originalFetch = window.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn().mockResolvedValue({ status: 200 });
    // Assigned after the module loaded: the client must look fetch up at call
    // time so the platform's window.fetch wrapper is the one that runs.
    window.fetch = fetchMock as unknown as typeof window.fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    window.fetch = originalFetch;
  });

  test('realtime: no keepalive request in gateway mode', () => {
    const getSpy = jest.spyOn(SupersetClient, 'get');
    connectRealtime({ ...GATEWAY, WEBSOCKET_JWT_EXPIRATION_SECONDS: 900 });
    FakeWebSocket.instances[0].readyState = 1;
    FakeWebSocket.instances[0].onopen?.();

    jest.advanceTimersByTime(60 * 60 * 1000);

    expect(getSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('4401 then 401 stops reconnecting (one /api/v1/me/ call, no postMessage)', async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    const postSpy = jest.spyOn(window, 'postMessage');
    const states: string[] = [];
    subscribeRealtimeState(s => states.push(s));
    connectRealtime(GATEWAY);

    FakeWebSocket.instances[0].onclose?.({ code: 4401 });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/me/');
    expect(states[states.length - 1]).toBe('unhealthy');
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(postSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['200', () => Promise.resolve({ status: 200 })],
    ['503', () => Promise.resolve({ status: 503 })],
    ['a network error', () => Promise.reject(new Error('offline'))],
  ])('4401 then %s reconnects', async (_label, answer) => {
    fetchMock.mockImplementation(answer);
    connectRealtime(GATEWAY);

    FakeWebSocket.instances[0].onclose?.({ code: 4401 });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(30_000);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test.each([1012, 1006])('%i reconnect delay within 0–30 s', code => {
    // Mid-range draw: 15 s, far from the normal backoff's first step (1–2 s).
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    connectRealtime(GATEWAY);
    FakeWebSocket.instances[0].onclose?.({ code });
    jest.advanceTimersByTime(14_999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Top of the range still lands inside 30 s.
    (Math.random as jest.Mock).mockReturnValue(0.9999);
    lastSocket().onclose?.({ code });
    jest.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('1013 uses normal backoff', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    connectRealtime(GATEWAY);
    FakeWebSocket.instances[0].onclose?.({ code: 1013 });
    // First backoff step: 1000 ms + 0.5 * 1000 ms of jitter.
    jest.advanceTimersByTime(1499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test('three failed connects trigger one /me check', async () => {
    connectRealtime(GATEWAY);
    for (let i = 0; i < 2; i += 1) {
      lastSocket().onclose?.({ code: 1013 });
      jest.advanceTimersByTime(30_000);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    lastSocket().onclose?.({ code: 1013 });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(4);

    // A fourth failure in the same streak does not ask again.
    lastSocket().onclose?.({ code: 1013 });
    await flushPromises();
    jest.advanceTimersByTime(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(5);
  });

  test('reports a reconnect open after every re-open', () => {
    const reasons: string[] = [];
    const states: string[] = [];
    subscribeRealtimeOpen(reason => reasons.push(reason));
    subscribeRealtimeState(s => states.push(s));
    connectRealtime(GATEWAY);
    FakeWebSocket.instances[0].onopen?.();

    for (let i = 0; i < 2; i += 1) {
      lastSocket().onclose?.({ code: 1006 });
      jest.advanceTimersByTime(30_000);
      lastSocket().onopen?.();
      expect(states[states.length - 1]).toBe('open');
    }

    expect(reasons).toEqual(['initial', 'reconnect', 'reconnect']);
  });

  test('cookie mode unchanged (keepalive still runs, 4401 not special)', async () => {
    const getSpy = jest
      .spyOn(SupersetClient, 'get')
      .mockResolvedValue({} as never);
    connectRealtime({ ...ENABLED, WEBSOCKET_JWT_EXPIRATION_SECONDS: 900 });

    FakeWebSocket.instances[0].onclose?.({ code: 4401 });
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    jest.advanceTimersByTime(5_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].readyState = 1;
    jest.advanceTimersByTime(540_000);
    expect(getSpy).toHaveBeenCalledWith({ endpoint: '/api/v1/me/' });
  });

  test.each([1006, 1012])(
    'cookie mode unchanged: %i uses normal backoff, not the 0–30 s spread',
    code => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      connectRealtime(ENABLED);
      FakeWebSocket.instances[0].onclose?.({ code });
      // First backoff step: 1000 ms + 0.5 * 1000 ms (the spread would be 15 s).
      jest.advanceTimersByTime(1499);
      expect(FakeWebSocket.instances).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(2);
    },
  );

  test('every 3rd failed connect checks /me: network error keeps going, 401 stops', async () => {
    // A laptop asleep past expiry sees 1006, never 4401: a failed check must
    // not be the last one, or the tab retries forever.
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ status: 401 });
    const states: string[] = [];
    subscribeRealtimeState(s => states.push(s));
    connectRealtime(GATEWAY);

    const failThreeTimes = async () => {
      for (let i = 0; i < 3; i += 1) {
        lastSocket().onclose?.({ code: 1006 });
        // eslint-disable-next-line no-await-in-loop
        await flushPromises();
        jest.advanceTimersByTime(30_000);
      }
    };

    await failThreeTimes();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(4); // kept reconnecting

    await failThreeTimes();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(6); // no reconnect after 401
    expect(states[states.length - 1]).toBe('unhealthy');
    expect(jest.getTimerCount()).toBe(0);
  });
});

test('sendRealtime sends JSON only on an open socket', () => {
  expect(sendRealtime({ type: 'x' })).toBe(false); // no socket

  connectRealtime(ENABLED);
  const [ws] = FakeWebSocket.instances;
  expect(sendRealtime({ type: 'x' })).toBe(false); // still connecting
  expect(ws.send).not.toHaveBeenCalled();

  ws.readyState = 1;
  expect(sendRealtime({ type: 'subscribe', id: 7 })).toBe(true);
  expect(ws.send).toHaveBeenCalledWith('{"type":"subscribe","id":7}');

  ws.readyState = 3;
  expect(sendRealtime({ type: 'x' })).toBe(false);
  expect(ws.send).toHaveBeenCalledTimes(1);
});
