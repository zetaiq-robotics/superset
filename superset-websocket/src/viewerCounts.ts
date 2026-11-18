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

// ZetaIQ: viewer counts shared across replicas. Each replica keeps its count
// of a dashboard's sockets in the hash `t:<tenant>:live:<uuid>` (field =
// replica id) with a 60 s field TTL (HEXPIRE, Redis 7.4+), rewritten every 30 s, so a dead replica's
// count lapses on its own. A failed write is logged and counted, never thrown:
// counts only size the refresh spread.
import { hostname } from 'os';
import type { Redis } from 'ioredis';

const FIELD_TTL_S = 60;
const REWRITE_MS = 30000;

export type CountsRedis = Pick<Redis, 'multi' | 'hdel' | 'hvals'>;

interface CountsDeps {
  statsd: { increment(stat: string): void };
  logger: { warn(msg: string): unknown };
}

export const replicaId = (env: NodeJS.ProcessEnv = process.env): string =>
  env.REPLICA_ID || `${hostname()}-${process.pid}`;

const liveKey = (tenant: string, uuid: string): string =>
  `t:${tenant}:live:${uuid}`;

/** Counts for one replica, written on a connection not in subscribe mode. */
export function createViewerCounts(
  redis: CountsRedis,
  replica: string,
  deps: CountsDeps,
) {
  // Every key this replica holds with a count > 0.
  const held = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  // Set by any failed write, cleared by the next successful one.
  let failing = false;

  const failed = (err: unknown): void => {
    failing = true;
    deps.statsd.increment('ws_viewer_count_write_failed');
    deps.logger.warn(`viewer count write failed: ${err}`);
  };

  // One transaction, so HSET never lands without its HEXPIRE.
  const write = async (entries: [string, number][]): Promise<void> => {
    const tx = redis.multi();
    entries.forEach(([key, count]) =>
      tx
        .hset(key, replica, count)
        .hexpire(key, FIELD_TTL_S, 'FIELDS', 1, replica),
    );
    const results = await tx.exec();
    const err = results
      ? results.find(([e]) => e)?.[0]
      : new Error('transaction aborted');
    if (err) throw err;
    failing = false;
  };

  return {
    async recordCount(
      tenant: string,
      uuid: string,
      count: number,
    ): Promise<void> {
      const key = liveKey(tenant, uuid);
      try {
        if (count > 0) {
          held.set(key, count);
          await write([[key, count]]);
        } else {
          held.delete(key);
          await redis.hdel(key, replica);
          failing = false;
        }
      } catch (err) {
        failed(err);
      }
    },

    writesFailing: (): boolean => failing,

    async totalViewers(tenant: string, uuid: string): Promise<number> {
      const values = await redis.hvals(liveKey(tenant, uuid));
      return values.reduce((sum, v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? sum + n : sum;
      }, 0);
    },

    start(): void {
      timer ??= setInterval(() => {
        if (held.size === 0) return;
        write([...held]).catch(failed);
      }, REWRITE_MS).unref();
    },

    stop(): void {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
