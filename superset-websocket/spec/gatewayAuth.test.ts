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
import * as http from 'http';
import * as net from 'net';
import { WebSocket } from 'ws';
import * as server from '../src/index';
import {
  IdentityRefused,
  IdentityUnavailable,
  introspect,
} from '../src/gatewayAuth';

vi.mock('ws');
vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { subscribe: vi.fn(), on: vi.fn() };
  }),
}));

const wsMock = WebSocket as unknown as Mock<typeof WebSocket>;
const TOKEN = 'dlg_secret-token-value-1234';
const NOW = new Date('2026-11-17T18:00:00Z').valueOf();

const rfc3339 = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

const answer = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

const granted = (overrides: Record<string, unknown> = {}) =>
  answer(200, {
    org_user_id: 'u-1',
    email: 'a@example.test',
    display_name: 'A',
    tenant_id: 'acme',
    role_id: 'viewer',
    expires_at: rfc3339(Date.now() + 20 * 60 * 1000),
    ...overrides,
  });

const makeRequest = (authorization: string | null): http.IncomingMessage => {
  const request = new http.IncomingMessage(new net.Socket());
  request.method = 'GET';
  request.url = 'http://localhost/';
  if (authorization !== null) request.headers.authorization = authorization;
  return request;
};

/** Run one upgrade end to end against a mocked handshake. */
const upgrade = async (authorization: string | null = `Bearer ${TOKEN}`) => {
  const socket = new net.Socket();
  const destroy = vi.spyOn(socket, 'destroy');
  const write = vi.spyOn(socket, 'write').mockReturnValue(true);
  const ws = new wsMock('localhost');
  vi.spyOn(ws, 'readyState', 'get').mockReturnValue(WebSocket.OPEN);
  const handshake = vi
    .spyOn(server.wss, 'handleUpgrade')
    .mockImplementation((_r, _s, _h, cb: (ws: WebSocket) => void) => cb(ws));
  await server.httpUpgrade(makeRequest(authorization), socket, Buffer.alloc(0));
  return { destroy, write, ws, handshake };
};

describe('gateway identity', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    // Every test runs on fake timers, so no re-check scheduled by one test can
    // fire into the next test's fetch mock.
    vi.useFakeTimers({ now: NOW });
    server.resetState();
    vi.spyOn(server.statsd, 'increment').mockReturnValue();
    fetchMock = vi.fn(async () => granted());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('limits default to the agreed values', () => {
    expect(server.opts).toMatchObject({
      introspectIntervalMs: 60000,
      maxSocketsPerPerson: 20,
      maxTotalConnections: 10000,
      maxSocketBufferBytes: 1048576,
    });
  });

  test('introspects with the token, the dashboards service, no redirects and a timeout', async () => {
    const id = await introspect(TOKEN);

    expect(id).toEqual({
      tenant: 'acme',
      person: 'u-1',
      expiresAtMs: expect.any(Number),
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toEqual(server.opts.introspectUrl);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      token: TOKEN,
      service: 'dashboards',
    });
  });

  test('an accepted upgrade binds t:<tenant>:p:<person>', async () => {
    const { handshake, ws } = await upgrade('bearer ' + TOKEN);

    expect(handshake).toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
    expect(server.channels['t:acme:p:u-1'].sockets).toHaveLength(1);
    const [socketId] = server.channels['t:acme:p:u-1'].sockets;
    expect(server.sockets[socketId].identity).toMatchObject({
      tenant: 'acme',
      person: 'u-1',
      channel: 't:acme:p:u-1',
      token: TOKEN,
    });
  });

  test.each([
    ['no header', null],
    ['another scheme', `Basic ${TOKEN}`],
    ['an empty bearer', 'Bearer '],
    ['a bare scheme', 'Bearer'],
  ])('refuses upgrade without bearer (%s)', async (_what, header) => {
    const { destroy, handshake, write } = await upgrade(header);

    expect(destroy).toHaveBeenCalled();
    expect(handshake).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('introspection 404 closes 4401', async () => {
    fetchMock.mockImplementation(async () =>
      answer(404, { error: 'not_found' }),
    );

    const { handshake, ws, destroy } = await upgrade();

    expect(handshake).toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(4401, expect.any(String));
    expect(Object.keys(server.sockets)).toHaveLength(0);
  });

  test('bad tenant in answer is refused', async () => {
    fetchMock.mockImplementation(async () => granted({ tenant_id: 'Bad!' }));

    const { ws } = await upgrade();

    expect(ws.close).toHaveBeenCalledWith(4401, expect.any(String));
    expect(Object.keys(server.sockets)).toHaveLength(0);
  });

  test.each([
    ['500', async () => answer(500)],
    ['400', async () => answer(400, { error: 'bad_request' })],
    [
      'a network error',
      async () => Promise.reject(new TypeError('fetch failed')),
    ],
    [
      'an unparsable body',
      async () => new Response('not json', { status: 200 }),
    ],
    ['an empty tenant', async () => granted({ tenant_id: '' })],
    ['no person', async () => granted({ org_user_id: undefined })],
    ['an unparsable expires_at', async () => granted({ expires_at: 'soon' })],
  ])('introspection %s answers 503', async (_what, impl) => {
    fetchMock.mockImplementation(impl as () => Promise<Response>);

    const { write, destroy, handshake } = await upgrade();

    expect(write).toHaveBeenCalledWith(expect.stringContaining('503'));
    expect(destroy).toHaveBeenCalled();
    expect(handshake).not.toHaveBeenCalled();
  });

  test('a person id outside [A-Za-z0-9_-]{1,128} is refused', async () => {
    fetchMock.mockImplementation(async () => granted({ org_user_id: 'u:1' }));
    await expect(introspect(TOKEN)).rejects.toBeInstanceOf(IdentityRefused);

    fetchMock.mockImplementation(async () =>
      granted({ org_user_id: 'u'.repeat(129) }),
    );
    await expect(introspect(TOKEN)).rejects.toBeInstanceOf(IdentityRefused);

    fetchMock.mockImplementation(async () =>
      granted({ org_user_id: 'A_b-9'.repeat(25) }),
    );
    await expect(introspect(TOKEN)).resolves.toMatchObject({
      person: 'A_b-9'.repeat(25),
    });
  });

  test('an answer whose expires_at has passed is refused', async () => {
    fetchMock.mockImplementation(async () =>
      granted({ expires_at: rfc3339(NOW) }),
    );

    await expect(introspect(TOKEN)).rejects.toBeInstanceOf(IdentityRefused);
  });

  test('a non-200 answer has its body released', async () => {
    const res = answer(503, { error: 'unavailable' });
    const cancel = vi.spyOn(res.body!, 'cancel');
    fetchMock.mockImplementation(async () => res);

    await expect(introspect(TOKEN)).rejects.toBeInstanceOf(IdentityUnavailable);
    expect(cancel).toHaveBeenCalled();
  });

  test('a socket closed during re-introspection is not re-armed', async () => {
    const { ws } = await upgrade();
    let release!: (res: Response) => void;
    fetchMock.mockImplementation(
      () => new Promise<Response>(resolve => (release = resolve)),
    );
    await vi.advanceTimersByTimeAsync(server.opts.introspectIntervalMs);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const onClose = vi
      .mocked(ws.on)
      .mock.calls.find(([event]) => event === 'close')![1] as () => void;
    onClose();
    release(granted());
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ws.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('closes at expires_at', async () => {
    fetchMock.mockImplementation(async () =>
      granted({ expires_at: rfc3339(NOW + 6000) }),
    );

    const { ws } = await upgrade();
    await vi.advanceTimersByTimeAsync(5999);
    expect(ws.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(ws.close).toHaveBeenCalledWith(4401, expect.any(String));
  });

  test('re-introspection refusal closes 4401', async () => {
    const { ws } = await upgrade();
    fetchMock.mockImplementation(async () => answer(404));

    await vi.advanceTimersByTimeAsync(server.opts.introspectIntervalMs);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ws.close).toHaveBeenCalledWith(4401, expect.any(String));
  });

  test('re-introspection keeps the socket and moves expires_at', async () => {
    fetchMock.mockImplementation(async () =>
      granted({ expires_at: rfc3339(NOW + 61_000) }),
    );
    const { ws } = await upgrade();
    fetchMock.mockImplementation(async () =>
      granted({ expires_at: rfc3339(NOW + 120_000) }),
    );

    await vi.advanceTimersByTimeAsync(90_000);

    expect(ws.close).not.toHaveBeenCalled();
    const [socketId] = Object.keys(server.sockets);
    expect(server.sockets[socketId].identity.expiresAtMs).toEqual(
      NOW + 120_000,
    );
  });

  test('re-introspection while the control plane is down closes 1013', async () => {
    const { ws } = await upgrade();
    fetchMock.mockImplementation(async () => answer(503));

    await vi.advanceTimersByTimeAsync(server.opts.introspectIntervalMs);

    expect(ws.close).toHaveBeenCalledWith(1013, expect.any(String));
  });

  test('token is never logged', async () => {
    const logged: unknown[] = [];
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(server.logger, level).mockImplementation(((
        ...args: unknown[]
      ) => {
        logged.push(...args);
        return server.logger;
      }) as never);
    }

    await upgrade(); // accepted
    fetchMock.mockImplementation(async () => answer(404));
    await vi.advanceTimersByTimeAsync(server.opts.introspectIntervalMs); // re-check refused
    await upgrade(); // refused at upgrade
    fetchMock.mockImplementation(async () => answer(500));
    await upgrade(); // unavailable
    fetchMock.mockImplementation(async () => granted({ tenant_id: 'Bad!' }));
    await upgrade(); // bad tenant
    await upgrade(`Basic ${TOKEN}`); // wrong scheme

    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged.map(String))).not.toContain(TOKEN);
  });

  test('SIGTERM closes 1012', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const a = await upgrade();
    const b = await upgrade();

    server.shutdown();

    expect(a.ws.close).toHaveBeenCalledWith(1012, expect.any(String));
    expect(b.ws.close).toHaveBeenCalledWith(1012, expect.any(String));
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('a second SIGTERM does nothing', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const { ws } = await upgrade();

    server.shutdown();
    server.shutdown();
    await vi.advanceTimersByTimeAsync(5000);

    const closes = vi.mocked(ws.close).mock.calls.filter(([c]) => c === 1012);
    expect(closes).toHaveLength(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test('an upgrade still introspecting at SIGTERM answers 503', async () => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let release!: (res: Response) => void;
    fetchMock.mockImplementation(
      () => new Promise<Response>(resolve => (release = resolve)),
    );
    const pending = upgrade();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    server.shutdown();
    release(granted());
    const { write, handshake } = await pending;

    expect(write).toHaveBeenCalledWith(expect.stringContaining('503'));
    expect(handshake).not.toHaveBeenCalled();
    expect(Object.keys(server.sockets)).toHaveLength(0);
  });

  test('21st socket for one person closes 1013', async () => {
    for (let i = 0; i < 20; i += 1) {
      const { ws } = await upgrade();
      expect(ws.close).not.toHaveBeenCalled();
    }

    const { ws } = await upgrade();

    expect(ws.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(server.channels['t:acme:p:u-1'].sockets).toHaveLength(20);
  });

  test('a send that would overflow the buffer cap terminates the socket', async () => {
    const { ws } = await upgrade();
    vi.spyOn(ws, 'bufferedAmount', 'get').mockReturnValue(
      server.opts.maxSocketBufferBytes - 4,
    );

    server.sendToChannel('t:acme:p:u-1', {
      topic: 'x',
      payload: 'more than four bytes',
    });

    expect(ws.terminate).toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });
});
