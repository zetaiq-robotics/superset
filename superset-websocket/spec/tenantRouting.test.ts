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
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import {
  acceptEnvelope,
  routeEnvelope,
  spreadMs,
  type RoutingDeps,
} from '../src/tenantRouting';

const D1 = '0b5f3c1e-8a7d-4c2b-9e6f-1a2b3c4d5e6f';
const D2 = '1b5f3c1e-8a7d-4c2b-9e6f-1a2b3c4d5e6f';
const CHANNEL = 't:acme:realtime';

const changed = (routes?: string[], scope = 'targeted') => ({
  topic: 'dashboard.changed',
  scope,
  routes,
  payload: { uuid: D1, etag: 'e2', version: 3, reason: 'dashboard' },
});

let deps: RoutingDeps & {
  sent: Record<string, string[]>;
  subscribers: Record<string, string[]>;
};

beforeEach(() => {
  const sent: Record<string, string[]> = {};
  const subscribers: Record<string, string[]> = {};
  deps = {
    sent,
    subscribers,
    statsd: { increment: vi.fn() },
    logger: { warn: vi.fn(), debug: vi.fn() },
    subscribersOf: vi.fn((key: string) => subscribers[key] ?? []),
    totalViewers: vi.fn(async () => 0),
    countWritesFailing: vi.fn(() => false),
    sendToSocket: vi.fn((id: string, data: string) => {
      (sent[id] ??= []).push(data);
      return true;
    }),
    sendToChannel: vi.fn(),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('acceptEnvelope', () => {
  test('keeps a well-formed envelope for its own tenant', () => {
    const env = changed([`t:acme:d:${D1}`]);
    expect(acceptEnvelope(CHANNEL, env, deps)).toEqual(env);
    expect(deps.statsd.increment).not.toHaveBeenCalled();
  });

  test('drops route outside channel tenant (whole envelope, counted)', () => {
    const env = changed([`t:acme:d:${D1}`, `t:globex:d:${D2}`]);
    expect(acceptEnvelope(CHANNEL, env, deps)).toBeNull();
    expect(deps.statsd.increment).toHaveBeenCalledWith(
      'ws_cross_tenant_route_dropped',
    );
    // The log names the channel tenant and the count, never the payload.
    const logged = (deps.logger.warn as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(logged).toContain('acme');
    expect(logged).toContain('1');
    expect(logged).not.toContain('e2');
    expect(logged).not.toContain(D2);
  });

  test('a route that only starts with the tenant name is outside it', () => {
    // `t:acme2:` is another tenant even though it begins with `t:acme`.
    expect(
      acceptEnvelope(CHANNEL, changed([`t:acme2:d:${D1}`]), deps),
    ).toBeNull();
  });

  test('drops authenticated_global', () => {
    expect(
      acceptEnvelope(CHANNEL, changed(undefined, 'authenticated_global'), deps),
    ).toBeNull();
  });

  test('drops non-tenant channel', () => {
    const env = changed([`t:acme:d:${D1}`]);
    expect(acceptEnvelope('realtime', env, deps)).toBeNull();
    expect(acceptEnvelope('t:Acme:realtime', env, deps)).toBeNull();
    expect(acceptEnvelope('t:a:realtime', env, deps)).toBeNull();
    expect(acceptEnvelope('t:acme:x:realtime', env, deps)).toBeNull();
    expect(
      acceptEnvelope(`t:${'a'.repeat(64)}:realtime`, env, deps),
    ).toBeNull();
  });

  test('drops missing or empty routes', () => {
    expect(acceptEnvelope(CHANNEL, changed(undefined), deps)).toBeNull();
    expect(acceptEnvelope(CHANNEL, changed([]), deps)).toBeNull();
  });
});

describe('spreadMs', () => {
  test('is 50 ms per viewer, capped at 30 s', () => {
    expect(spreadMs(0)).toBe(0);
    expect(spreadMs(200)).toBe(10000);
    expect(spreadMs(1000)).toBe(30000);
  });
});

describe('routeEnvelope', () => {
  const sentPayload = (id: string) =>
    deps.sent[id].map(s => JSON.parse(s) as Record<string, unknown>);

  test('adds spread_ms from the total across replicas', async () => {
    deps.subscribers[`t:acme:d:${D1}`] = ['s1', 's2'];
    // Two replica fields, 120 and 80.
    deps.totalViewers = vi.fn(async () => 120 + 80);

    await routeEnvelope(CHANNEL, changed([`t:acme:d:${D1}`]), deps);

    expect(deps.totalViewers).toHaveBeenCalledTimes(1); // per route, not per socket
    expect(deps.totalViewers).toHaveBeenCalledWith('acme', D1);
    for (const id of ['s1', 's2']) {
      expect(sentPayload(id)).toEqual([
        {
          topic: 'dashboard.changed',
          payload: {
            uuid: D1,
            etag: 'e2',
            version: 3,
            reason: 'dashboard',
            spread_ms: 10000,
          },
        },
      ]);
    }
  });

  test('a large audience caps spread_ms at 30000', async () => {
    deps.subscribers[`t:acme:d:${D1}`] = ['s1'];
    deps.totalViewers = vi.fn(async () => 1000);
    await routeEnvelope(CHANNEL, changed([`t:acme:d:${D1}`]), deps);
    expect(sentPayload('s1')[0].payload).toMatchObject({ spread_ms: 30000 });
  });

  test('read failure spreads over 30000', async () => {
    deps.subscribers[`t:acme:d:${D1}`] = ['s1'];
    deps.totalViewers = vi.fn(async () => {
      throw new Error('redis down');
    });
    await routeEnvelope(CHANNEL, changed([`t:acme:d:${D1}`]), deps);
    expect(sentPayload('s1')[0].payload).toMatchObject({ spread_ms: 30000 });
  });

  test('a read slower than 250 ms spreads over 30000', async () => {
    vi.useFakeTimers();
    deps.subscribers[`t:acme:d:${D1}`] = ['s1'];
    deps.totalViewers = vi.fn(() => new Promise<number>(() => undefined));
    const done = routeEnvelope(CHANNEL, changed([`t:acme:d:${D1}`]), deps);
    await vi.advanceTimersByTimeAsync(249);
    expect(deps.sent.s1).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(sentPayload('s1')[0].payload).toMatchObject({ spread_ms: 30000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('never below the local count: Redis total 0, 3 local subscribers', async () => {
    deps.subscribers[`t:acme:d:${D1}`] = ['s1', 's2', 's3'];
    deps.totalViewers = vi.fn(async () => 0);
    await routeEnvelope(CHANNEL, changed([`t:acme:d:${D1}`]), deps);
    expect(sentPayload('s1')[0].payload).toMatchObject({ spread_ms: 150 });
  });

  test('while count writes are failing, spread is 30000', async () => {
    deps.subscribers[`t:acme:d:${D1}`] = ['s1'];
    deps.totalViewers = vi.fn(async () => 2);
    deps.countWritesFailing = vi.fn(() => true);
    await routeEnvelope(CHANNEL, changed([`t:acme:d:${D1}`]), deps);
    expect(sentPayload('s1')[0].payload).toMatchObject({ spread_ms: 30000 });

    deps.countWritesFailing = vi.fn(() => false);
    await routeEnvelope(CHANNEL, changed([`t:acme:d:${D1}`]), deps);
    expect(sentPayload('s1')[1].payload).toMatchObject({ spread_ms: 100 });
  });

  test('a dashboard route with a non-object payload is dropped and counted', async () => {
    deps.subscribers[`t:acme:d:${D1}`] = ['s1'];
    await routeEnvelope(
      CHANNEL,
      { ...changed([`t:acme:d:${D1}`]), payload: 'secret-text' },
      deps,
    );
    expect(deps.sendToSocket).not.toHaveBeenCalled();
    expect(deps.statsd.increment).toHaveBeenCalledWith(
      'ws_bad_payload_dropped',
    );
    const logged = JSON.stringify(
      (deps.logger.debug as ReturnType<typeof vi.fn>).mock.calls,
    );
    expect(logged).not.toContain('secret-text');
  });

  test('no local subscriber: no read, nothing sent', async () => {
    await routeEnvelope(CHANNEL, changed([`t:acme:d:${D1}`]), deps);
    expect(deps.totalViewers).not.toHaveBeenCalled();
    expect(deps.sendToSocket).not.toHaveBeenCalled();
  });

  test('each route gets its own payload copy; the envelope is not mutated', async () => {
    deps.subscribers[`t:acme:d:${D1}`] = ['s1'];
    deps.subscribers[`t:acme:d:${D2}`] = ['s2'];
    deps.totalViewers = vi.fn(async (_t: string, uuid: string) =>
      uuid === D1 ? 2 : 400,
    );
    const env = changed([`t:acme:d:${D1}`, `t:acme:d:${D2}`]);
    await routeEnvelope(CHANNEL, env, deps);
    expect(sentPayload('s1')[0].payload).toMatchObject({ spread_ms: 100 });
    expect(sentPayload('s2')[0].payload).toMatchObject({ spread_ms: 20000 });
    expect(env.payload).not.toHaveProperty('spread_ms');
  });

  test('a route for another tenant drops the whole envelope', async () => {
    deps.subscribers[`t:acme:d:${D1}`] = ['s1'];
    await routeEnvelope(
      CHANNEL,
      changed([`t:acme:d:${D1}`, 't:globex:p:7']),
      deps,
    );
    expect(deps.sendToSocket).not.toHaveBeenCalled();
    expect(deps.sendToChannel).not.toHaveBeenCalled();
    expect(deps.totalViewers).not.toHaveBeenCalled();
  });

  test('person route still delivered by channel, routes and scope stripped', async () => {
    await routeEnvelope(
      CHANNEL,
      {
        topic: 'task.status',
        scope: 'principal',
        routes: ['t:acme:p:5', 't:acme:p:5'],
        payload: { task_id: 'abc' },
      },
      deps,
    );
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    expect(deps.sendToChannel).toHaveBeenCalledWith('t:acme:p:5', {
      topic: 'task.status',
      payload: { task_id: 'abc' },
    });
    expect(deps.totalViewers).not.toHaveBeenCalled();
  });
});
