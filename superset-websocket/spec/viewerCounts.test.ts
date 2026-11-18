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
import { hostname } from 'os';
import {
  createViewerCounts,
  replicaId,
  type CountsRedis,
} from '../src/viewerCounts';

const D1 = '0b5f3c1e-8a7d-4c2b-9e6f-1a2b3c4d5e6f';
const KEY = `t:acme:live:${D1}`;

/** Hashes with per-field expiry (Redis 7.4 HEXPIRE), on the fake clock. */
class FakeRedis {
  hashes = new Map<string, Map<string, { v: string; exp?: number }>>();
  ops: string[][] = [];
  txKinds: string[] = [];
  down = false;

  private live(key: string) {
    const h = this.hashes.get(key);
    h?.forEach((e, f) => {
      if (e.exp !== undefined && e.exp <= Date.now()) h.delete(f);
    });
    return h;
  }

  private run(cmd: string[]): unknown {
    this.ops.push(cmd);
    const [name, key, ...rest] = cmd;
    if (name === 'hset') {
      const h = this.live(key) ?? new Map();
      h.set(rest[0], { v: rest[1] }); // an overwrite clears the field TTL
      this.hashes.set(key, h);
      return 1;
    }
    if (name === 'hexpire') {
      const [seconds, , , ...fields] = rest;
      const h = this.live(key);
      fields.forEach(f => {
        const e = h?.get(f);
        if (e) e.exp = Date.now() + Number(seconds) * 1000;
      });
      return fields.map(() => 1);
    }
    throw new Error(`unexpected ${name}`);
  }

  private tx(kind: string) {
    const queued: string[][] = [];
    const tx = {
      hset: (k: string, f: string, v: string | number) => {
        queued.push(['hset', k, f, String(v)]);
        return tx;
      },
      hexpire: (k: string, ...rest: (string | number)[]) => {
        queued.push(['hexpire', k, ...rest.map(String)]);
        return tx;
      },
      exec: async () => {
        if (this.down) throw new Error('connection lost');
        this.txKinds.push(kind);
        return queued.map(c => [null, this.run(c)]);
      },
    };
    return tx;
  }

  multi = () => this.tx('multi');
  hdel = vi.fn(async (key: string, field: string) => {
    if (this.down) throw new Error('connection lost');
    this.ops.push(['hdel', key, field]);
    return this.live(key)?.delete(field) ? 1 : 0;
  });
  hvals = vi.fn(async (key: string) => {
    if (this.down) throw new Error('connection lost');
    return [...(this.live(key)?.values() ?? [])].map(e => e.v);
  });
}

let redis: FakeRedis;
let deps: {
  statsd: { increment: ReturnType<typeof vi.fn> };
  logger: { warn: ReturnType<typeof vi.fn> };
};

const counts = (id = 'r1') =>
  createViewerCounts(redis as unknown as CountsRedis, id, deps);

beforeEach(() => {
  vi.useFakeTimers();
  redis = new FakeRedis();
  deps = { statsd: { increment: vi.fn() }, logger: { warn: vi.fn() } };
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0); // no stray timers
  vi.useRealTimers();
});

describe('viewerCounts', () => {
  test('recordCount writes the field with a 60 s TTL in one transaction', async () => {
    await counts().recordCount('acme', D1, 3);
    expect(redis.txKinds).toEqual(['multi']);
    expect(redis.ops).toEqual([
      ['hset', KEY, 'r1', '3'],
      ['hexpire', KEY, '60', 'FIELDS', '1', 'r1'],
    ]);
  });

  test('count field expires (gone after 60 s without refresh)', async () => {
    const c = counts();
    await c.recordCount('acme', D1, 3);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await c.totalViewers('acme', D1)).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await c.totalViewers('acme', D1)).toBe(0);
  });

  test('totalViewers sums every replica, ignoring non-numeric values', async () => {
    await counts('r1').recordCount('acme', D1, 120);
    await counts('r2').recordCount('acme', D1, 80);
    redis.hashes.get(KEY)!.set('junk', { v: 'abc' });
    expect(await counts().totalViewers('acme', D1)).toBe(200);
    expect(redis.hvals).toHaveBeenCalledWith(KEY);
  });

  test('a count of 0 deletes the field', async () => {
    const c = counts();
    await c.recordCount('acme', D1, 2);
    await c.recordCount('acme', D1, 0);
    expect(redis.ops.at(-1)).toEqual(['hdel', KEY, 'r1']);
    expect(await c.totalViewers('acme', D1)).toBe(0);
  });

  test('periodic rewrite keeps held keys alive, in one transaction, and skips zeroed ones', async () => {
    const D2 = '1b5f3c1e-8a7d-4c2b-9e6f-1a2b3c4d5e6f';
    const c = counts();
    await c.recordCount('acme', D1, 3);
    await c.recordCount('acme', D2, 1);
    await c.recordCount('acme', D2, 0);
    c.start();
    redis.ops = [];
    redis.txKinds = [];

    await vi.advanceTimersByTimeAsync(30_000);
    expect(redis.txKinds).toEqual(['multi']);
    expect(redis.ops).toEqual([
      ['hset', KEY, 'r1', '3'],
      ['hexpire', KEY, '60', 'FIELDS', '1', 'r1'],
    ]);

    // Well past the first write's 60 s: the rewrites kept it alive.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await c.totalViewers('acme', D1)).toBe(3);
    c.stop();
  });

  test('a write failure is logged and counted, never thrown', async () => {
    redis.down = true;
    const c = counts();
    await expect(c.recordCount('acme', D1, 3)).resolves.toBeUndefined();
    await expect(c.recordCount('acme', D1, 0)).resolves.toBeUndefined();
    expect(deps.statsd.increment).toHaveBeenCalledWith(
      'ws_viewer_count_write_failed',
    );
    expect(deps.logger.warn).toHaveBeenCalledTimes(2);
  });

  test('a failed write flags writes failing until the next successful write', async () => {
    const c = counts();
    expect(c.writesFailing()).toBe(false);
    redis.down = true;
    await c.recordCount('acme', D1, 3);
    expect(c.writesFailing()).toBe(true);
    redis.down = false;
    await c.recordCount('acme', D1, 4);
    expect(c.writesFailing()).toBe(false);
  });

  test('the periodic rewrite also sets and clears the flag', async () => {
    const c = counts();
    await c.recordCount('acme', D1, 3);
    c.start();
    redis.down = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.writesFailing()).toBe(true);
    redis.down = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.writesFailing()).toBe(false);
    c.stop();
  });

  test('the rewrite repairs a count whose write failed', async () => {
    const c = counts();
    redis.down = true;
    await c.recordCount('acme', D1, 3);
    redis.down = false;
    c.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await c.totalViewers('acme', D1)).toBe(3);
    c.stop();
  });

  test('a read failure rejects (the router falls back to 30000)', async () => {
    redis.down = true;
    await expect(counts().totalViewers('acme', D1)).rejects.toThrow();
  });
});

describe('replicaId', () => {
  test('REPLICA_ID when set, else host-pid', () => {
    expect(replicaId({ REPLICA_ID: 'ws-0' })).toBe('ws-0');
    expect(replicaId({})).toBe(`${hostname()}-${process.pid}`);
  });
});
