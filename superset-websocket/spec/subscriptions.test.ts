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
import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import { EventEmitter } from 'events';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import * as server from '../src/index';
import type { GatewayIdentity } from '../src/gatewayAuth';
import {
  dashboardKey,
  onCountChange,
  resetSubscriptions,
  subscribersOf,
} from '../src/subscriptions';

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { subscribe: vi.fn(), on: vi.fn() };
  }),
}));

const TOKEN = 'dlg_socket-own-token-0001';
const NOW = new Date('2026-11-17T18:00:00Z').valueOf();
const D1 = '0b5f3c1e-8a7d-4c2b-9e6f-1a2b3c4d5e6f';
const D2 = '1b5f3c1e-8a7d-4c2b-9e6f-1a2b3c4d5e6f';
const D3 = '2b5f3c1e-8a7d-4c2b-9e6f-1a2b3c4d5e6f';
const D4 = '3b5f3c1e-8a7d-4c2b-9e6f-1a2b3c4d5e6f';
const D5 = '4b5f3c1e-8a7d-4c2b-9e6f-1a2b3c4d5e6f';

const identity = (tenant = 'acme'): GatewayIdentity => ({
  tenant,
  person: 'u-1',
  expiresAtMs: NOW + 20 * 60 * 1000,
  token: TOKEN,
  channel: `t:${tenant}:p:u-1`,
});

const answer = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });
const granted = () => answer(200, { etag: '"e1"', charts_digest: 'cd1' });

/** Stand-in for an accepted `ws` socket, driven by emitting its events. */
class FakeWs extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  send = vi.fn();
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSING;
  });
  frame(body: unknown) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    this.emit('message', Buffer.from(text), false);
  }
  hangUp() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1001, Buffer.alloc(0));
  }
  replies() {
    return this.send.mock.calls.map(([data]) => JSON.parse(String(data)));
  }
}

const connect = (tenant = 'acme') => {
  const ws = new FakeWs();
  server.wsConnection(ws as unknown as WebSocket, identity(tenant));
  const id = Object.keys(server.sockets).find(
    socketId => server.sockets[socketId].ws === (ws as unknown as WebSocket),
  ) as string;
  return { ws, id };
};

// Settle the mocked access checks (setImmediate is left real).
const flush = () => new Promise(resolve => setImmediate(resolve));

const subscribed = (
  dashboard: string | null,
  ok: boolean,
  why: string | null,
  etag: string | null = null,
  charts_digest: string | null = null,
) => ({
  topic: 'subscribed',
  payload: { dashboard, ok, etag, charts_digest, why },
});

/** A fetch answer the test releases by hand. */
const deferred = () => {
  let release!: (res: Response) => void;
  const promise = new Promise<Response>(resolve => (release = resolve));
  return { promise, release };
};

describe('dashboard subscriptions', () => {
  let fetchMock: Mock<typeof fetch>;
  let counts: Array<[string, string, number]>;

  beforeEach(() => {
    vi.useFakeTimers({
      now: NOW,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date'],
    });
    server.resetState();
    resetSubscriptions();
    vi.spyOn(server.statsd, 'increment').mockReturnValue();
    fetchMock = vi.fn(async () => granted());
    vi.stubGlobal('fetch', fetchMock);
    counts = [];
    onCountChange((tenant, uuid, n) => counts.push([tenant, uuid, n]));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('limits default to the agreed values', () => {
    expect(server.opts.maxSubscriptionsPerSocket).toEqual(4);
    expect(server.wss.options.maxPayload).toEqual(1024);
  });

  test('dashboardKey is t:<tenant>:d:<uuid>', () => {
    expect(dashboardKey('acme', D1)).toEqual(`t:acme:d:${D1}`);
  });

  test('subscribe with a non-uuid is refused', async () => {
    const { ws } = connect();
    for (const bad of [
      'not-a-uuid',
      ` ${D1}`,
      `{${D1}}`,
      D1.replace(/-/g, ''),
      `${D1}0`,
      `t:meridian:d:${D1}`,
    ]) {
      ws.frame({ type: 'subscribe', dashboard: bad });
    }
    ws.frame({ type: 'subscribe', dashboard: 42 });
    ws.frame({ type: 'subscribe' });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ws.replies()).toHaveLength(8);
    ws.replies().forEach(reply =>
      expect(reply.payload).toMatchObject({ ok: false, why: 'invalid' }),
    );
    expect(ws.replies()[6].payload.dashboard).toBeNull();
    expect(ws.close).not.toHaveBeenCalled();
  });

  test('a granted subscribe asks with the socket bearer and replies the etag and digest', async () => {
    const { ws, id } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1.toUpperCase() });
    await flush();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toEqual(`${server.opts.accessCheckUrl}/${D1}`);
    expect(init).toMatchObject({
      headers: { Authorization: `Bearer ${TOKEN}` },
      redirect: 'error',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(ws.replies()).toEqual([subscribed(D1, true, null, '"e1"', 'cd1')]);
    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([id]);
    expect(counts).toEqual([['acme', D1, 1]]);
  });

  test('access 404 → ok:false and no key', async () => {
    const body = { cancel: vi.fn(async () => undefined) };
    const res = answer(404);
    vi.spyOn(res, 'body', 'get').mockReturnValue(
      body as unknown as ReadableStream,
    );
    fetchMock.mockResolvedValueOnce(res);
    const { ws } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();

    expect(ws.replies()).toEqual([subscribed(D1, false, 'not_found')]);
    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([]);
    expect(body.cancel).toHaveBeenCalled();
    expect(counts).toEqual([]);
  });

  test.each([
    ['401', () => answer(401), 'not_found'],
    ['403', () => answer(403), 'not_found'],
    ['500', () => answer(500), 'unavailable'],
    ['302', () => answer(302), 'unavailable'],
    [
      'network error',
      () => Promise.reject(new TypeError('fetch failed')),
      'unavailable',
    ],
    [
      'timeout',
      () => Promise.reject(new DOMException('t', 'TimeoutError')),
      'unavailable',
    ],
    [
      'non-JSON body',
      () => new Response('<html>', { status: 200 }),
      'unavailable',
    ],
    [
      'body without etag',
      () => answer(200, { charts_digest: 'x' }),
      'unavailable',
    ],
    ['null body', () => answer(200, null), 'unavailable'],
  ])('access %s → ok:false', async (_name, reply, why) => {
    fetchMock.mockImplementationOnce(async () => reply());
    const { ws } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();

    expect(ws.replies()).toEqual([subscribed(D1, false, why)]);
    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([]);
  });

  test("key uses the socket's tenant, never the message", async () => {
    const { ws, id } = connect('acme');
    ws.frame({
      type: 'subscribe',
      dashboard: D1,
      tenant: 'meridian',
      key: `t:meridian:d:${D1}`,
      token: 'dlg_someone-else',
    });
    await flush();

    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([id]);
    expect(subscribersOf(dashboardKey('meridian', D1))).toEqual([]);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(counts).toEqual([['acme', D1, 1]]);
  });

  test('fifth subscription refused', async () => {
    const { ws } = connect();
    for (const d of [D1, D2, D3, D4, D5]) {
      ws.frame({ type: 'subscribe', dashboard: d });
    }
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    // The refusal is immediate, before any check answers.
    expect(ws.replies()[0]).toEqual(subscribed(D5, false, 'limit'));
    expect(
      ws
        .replies()
        .slice(1)
        .map(r => r.payload.ok),
    ).toEqual([true, true, true, true]);
    expect(subscribersOf(dashboardKey('acme', D5))).toEqual([]);
  });

  test('checks still in flight count toward the cap', async () => {
    const pending = [deferred(), deferred(), deferred(), deferred()];
    pending.forEach(p => fetchMock.mockImplementationOnce(() => p.promise));
    const { ws } = connect();
    for (const d of [D1, D2, D3, D4, D5]) {
      ws.frame({ type: 'subscribe', dashboard: d });
    }
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(ws.replies()).toEqual([subscribed(D5, false, 'limit')]);

    pending.forEach(p => p.release(granted()));
    await flush();
    expect(ws.replies()).toHaveLength(5);
  });

  test('subscribing again re-checks, replies ok and keeps one entry', async () => {
    const { ws, id } = connect();
    for (const d of [D1, D2, D3, D4]) {
      ws.frame({ type: 'subscribe', dashboard: d });
    }
    await flush();
    fetchMock.mockResolvedValueOnce(
      answer(200, { etag: '"e2"', charts_digest: 'cd2' }),
    );
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(ws.replies()[4]).toEqual(subscribed(D1, true, null, '"e2"', 'cd2'));
    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([id]);
    expect(counts.filter(([, uuid]) => uuid === D1)).toEqual([['acme', D1, 1]]);
  });

  test('a re-check that is refused drops the subscription', async () => {
    const { ws } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();
    fetchMock.mockResolvedValueOnce(answer(404));
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();

    expect(ws.replies()[1]).toEqual(subscribed(D1, false, 'not_found'));
    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([]);
    expect(counts).toEqual([
      ['acme', D1, 1],
      ['acme', D1, 0],
    ]);
  });

  test('unsubscribe removes at once and is idempotent', async () => {
    const { ws } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();
    ws.frame({ type: 'unsubscribe', dashboard: D1.toUpperCase() });

    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([]);
    ws.frame({ type: 'unsubscribe', dashboard: D1 });
    ws.frame({ type: 'unsubscribe', dashboard: D2 });
    ws.frame({ type: 'unsubscribe', dashboard: 'nope' });
    await flush();

    expect(ws.replies()).toHaveLength(1);
    expect(counts).toEqual([
      ['acme', D1, 1],
      ['acme', D1, 0],
    ]);
    expect(ws.close).not.toHaveBeenCalled();
  });

  test('unsubscribe while the check is in flight: not added, no reply', async () => {
    const pending = deferred();
    fetchMock.mockImplementationOnce(() => pending.promise);
    const { ws } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    ws.frame({ type: 'unsubscribe', dashboard: D1 });
    pending.release(granted());
    await flush();

    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([]);
    expect(ws.replies()).toEqual([]);
    expect(counts).toEqual([]);
  });

  test('socket closed while the check is in flight: not added, no reply', async () => {
    const pending = deferred();
    fetchMock.mockImplementationOnce(() => pending.promise);
    const { ws } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    ws.hangUp();
    pending.release(granted());
    await flush();

    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([]);
    expect(ws.send).not.toHaveBeenCalled();
    expect(counts).toEqual([]);
  });

  test('socket closing (no close event yet) while in flight: not added, no reply', async () => {
    const pending = deferred();
    fetchMock.mockImplementationOnce(() => pending.promise);
    const { ws } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    ws.readyState = WebSocket.CLOSING;
    pending.release(granted());
    await flush();

    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([]);
    expect(ws.send).not.toHaveBeenCalled();
    expect(counts).toEqual([]);
  });

  test('closing a socket removes all its subscriptions at once', async () => {
    const a = connect();
    const b = connect();
    for (const d of [D1, D2]) a.ws.frame({ type: 'subscribe', dashboard: d });
    b.ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();
    counts.length = 0;
    a.ws.hangUp();

    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([b.id]);
    expect(subscribersOf(dashboardKey('acme', D2))).toEqual([]);
    expect(counts).toEqual(
      expect.arrayContaining([
        ['acme', D1, 1],
        ['acme', D2, 0],
      ]),
    );
    expect(counts).toHaveLength(2);
  });

  test('closed socket is skipped by subscribersOf immediately', async () => {
    const a = connect();
    const b = connect();
    a.ws.frame({ type: 'subscribe', dashboard: D1 });
    b.ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();
    expect(subscribersOf(dashboardKey('acme', D1)).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    // Closed, but neither the close event nor the sweep has run yet.
    a.ws.readyState = WebSocket.CLOSED;

    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([b.id]);
  });

  test('tenants never share a key', async () => {
    const a = connect('acme');
    const m = connect('meridian');
    a.ws.frame({ type: 'subscribe', dashboard: D1 });
    m.ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();

    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([a.id]);
    expect(subscribersOf(dashboardKey('meridian', D1))).toEqual([m.id]);
  });

  test('subscribes to a dashboard whose check is in flight share that one check and reply', async () => {
    const pending = deferred();
    fetchMock.mockImplementationOnce(() => pending.promise);
    const { ws, id } = connect();
    for (let i = 0; i < 5; i += 1) {
      ws.frame({ type: 'subscribe', dashboard: i % 2 ? D1.toUpperCase() : D1 });
    }
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ws.send).not.toHaveBeenCalled();

    pending.release(granted());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ws.replies()).toEqual([subscribed(D1, true, null, '"e1"', 'cd1')]);
    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([id]);

    // Once resolved, a re-subscribe checks again (the etag refresh).
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ws.replies()).toHaveLength(2);
  });

  /** A held fetch that rejects like the real one when its signal aborts. */
  const abortableFetch = () => {
    const seen: { signal?: AbortSignal } = {};
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen.signal = init?.signal as AbortSignal;
          seen.signal.addEventListener('abort', () =>
            reject(seen.signal?.reason),
          );
        }),
    );
    return seen;
  };

  test('unsubscribe aborts the access check in flight, with no reply', async () => {
    const seen = abortableFetch();
    const { ws } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();
    expect(seen.signal?.aborted).toBe(false);
    ws.frame({ type: 'unsubscribe', dashboard: D1 });
    await flush();

    expect(seen.signal?.aborted).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([]);
    expect(counts).toEqual([]);
  });

  test('socket close aborts the access check in flight, with no reply', async () => {
    const seen = abortableFetch();
    const { ws } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();
    ws.hangUp();
    await flush();

    expect(seen.signal?.aborted).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
    expect(counts).toEqual([]);
  });

  test('unsubscribe during a re-check of a held dashboard: not re-added', async () => {
    const { ws } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();
    const pending = deferred();
    fetchMock.mockImplementationOnce(() => pending.promise);
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();
    ws.frame({ type: 'unsubscribe', dashboard: D1 });
    pending.release(granted());
    await flush();

    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([]);
    expect(ws.replies()).toHaveLength(1);
    expect(counts).toEqual([
      ['acme', D1, 1],
      ['acme', D1, 0],
    ]);
  });

  test('a throwing count hook breaks neither add, remove nor the reply', async () => {
    const hook = vi.fn(() => {
      throw new Error('hook failed');
    });
    onCountChange(hook);
    const { ws, id } = connect();
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();

    expect(ws.replies()).toEqual([subscribed(D1, true, null, '"e1"', 'cd1')]);
    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([id]);

    ws.frame({ type: 'subscribe', dashboard: D2 });
    await flush();
    ws.frame({ type: 'unsubscribe', dashboard: D1 });
    expect(subscribersOf(dashboardKey('acme', D1))).toEqual([]);
    ws.hangUp();
    expect(subscribersOf(dashboardKey('acme', D2))).toEqual([]);
    expect(hook).toHaveBeenCalledTimes(4);
    expect(ws.replies()).toHaveLength(2);
  });

  test('unknown types and malformed JSON are ignored without closing', async () => {
    const { ws } = connect();
    ws.frame('{not json');
    ws.frame('null');
    ws.frame('42');
    ws.frame({ type: 'publish', dashboard: D1 });
    ws.emit('message', Buffer.from([0xff, 0x00]), true);
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  test('11 frames in a second closes 1008', async () => {
    const { ws } = connect();
    for (let i = 0; i < 10; i += 1) ws.frame('{not json');
    expect(ws.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();

    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(1008, expect.any(String));
    // The frame that broke the limit is not acted on, nor any after it.
    ws.frame({ type: 'subscribe', dashboard: D1 });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  test('10 frames every second stay open', async () => {
    const { ws } = connect();
    for (let s = 0; s < 3; s += 1) {
      for (let i = 0; i < 10; i += 1) ws.frame('{"type":"noop"}');
      vi.advanceTimersByTime(1000);
    }
    expect(ws.close).not.toHaveBeenCalled();
  });

  test('frame over 1 KB closes 1009', async () => {
    // A real handshake through the server's own WebSocketServer.
    server.wss.on('connection', (ws: WebSocket) => ws.on('error', () => {}));
    const httpServer = http.createServer();
    httpServer.on('upgrade', (req, socket, head) =>
      server.wss.handleUpgrade(req, socket, head, ws => {
        server.wss.emit('connection', ws, req);
        server.wsConnection(ws, identity());
      }),
    );
    await new Promise<void>(resolve => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}/`);
      await new Promise(resolve => client.once('open', resolve));
      const closed = new Promise<number>(resolve =>
        client.once('close', code => resolve(code)),
      );
      // Exactly 1024 bytes is accepted: the subscribe after it is answered.
      const atLimit = JSON.stringify({ type: 'noop', pad: 'x'.repeat(1000) });
      expect(Buffer.byteLength(atLimit)).toEqual(1024);
      client.send(atLimit);
      const reply = new Promise(resolve =>
        client.once('message', data => resolve(JSON.parse(String(data)))),
      );
      client.send(JSON.stringify({ type: 'subscribe', dashboard: D1 }));
      expect(await reply).toEqual(subscribed(D1, true, null, '"e1"', 'cd1'));

      client.send('x'.repeat(1025));

      expect(await closed).toEqual(1009);
    } finally {
      server.wss.removeAllListeners('connection');
      httpServer.closeAllConnections();
      await new Promise(resolve => httpServer.close(resolve));
    }
  });
});
