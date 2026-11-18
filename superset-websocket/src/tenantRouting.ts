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

// ZetaIQ: tenant channels. One instance serves every tenant, so an envelope
// on `t:<tenant>:realtime` may only name routes under `t:<tenant>:`; one bad
// route drops the whole envelope. Dashboard routes go to that dashboard's
// subscribers with `payload.spread_ms` sized by its audience on every replica.
// Never logs payloads.
import type { OutboundMessage, RealtimeEnvelope } from './index.js';

const CHANNEL_PATTERN = /^t:([a-z0-9]{2,63}):realtime$/;
const DASHBOARD_ROUTE =
  /^t:([a-z0-9]{2,63}):d:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SCOPE_AUTHENTICATED_GLOBAL = 'authenticated_global';
const MAX_SPREAD_MS = 30000;
const SPREAD_PER_VIEWER_MS = 50;
const COUNT_READ_TIMEOUT_MS = 250;

export interface RoutingDeps {
  statsd: { increment(stat: string): void };
  logger: { warn(msg: string): unknown; debug(msg: string): unknown };
  subscribersOf(key: string): string[];
  totalViewers(tenant: string, uuid: string): Promise<number>;
  // True while this replica's own count writes fail: the total may lack it.
  countWritesFailing(): boolean;
  sendToSocket(socketId: string, data: string): boolean;
  sendToChannel(channel: string, message: OutboundMessage): void;
}

export const spreadMs = (total: number): number =>
  Math.min(MAX_SPREAD_MS, SPREAD_PER_VIEWER_MS * total);

/** The envelope if every route stays inside the channel's tenant, else null. */
export function acceptEnvelope(
  channel: string,
  env: RealtimeEnvelope,
  deps: Pick<RoutingDeps, 'statsd' | 'logger'>,
): RealtimeEnvelope | null {
  const tenant = CHANNEL_PATTERN.exec(channel)?.[1];
  if (!tenant) {
    deps.logger.debug('dropped an envelope on a non-tenant channel');
    return null;
  }
  if (env.scope === SCOPE_AUTHENTICATED_GLOBAL || !env.routes?.length) {
    deps.logger.debug(`dropped an untargeted envelope for tenant ${tenant}`);
    return null;
  }
  const prefix = `t:${tenant}:`;
  const outside = env.routes.filter(r => !r.startsWith(prefix)).length;
  if (outside > 0) {
    deps.statsd.increment('ws_cross_tenant_route_dropped');
    deps.logger.warn(
      `dropped an envelope for tenant ${tenant}: ${outside} route(s) outside it`,
    );
    return null;
  }
  return env;
}

/**
 * Total viewers as a spread, never below this replica's own count. A failed
 * or slow (>250 ms) read, or failing count writes, spread fully.
 */
async function spreadFor(
  deps: RoutingDeps,
  tenant: string,
  uuid: string,
  local: number,
): Promise<number> {
  if (deps.countWritesFailing()) return MAX_SPREAD_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const total = await Promise.race([
      deps.totalViewers(tenant, uuid),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out')),
          COUNT_READ_TIMEOUT_MS,
        );
      }),
    ]);
    return spreadMs(Math.max(total, local));
  } catch (err) {
    deps.statsd.increment('ws_viewer_count_read_failed');
    deps.logger.debug(`viewer count read failed for tenant ${tenant}: ${err}`);
    return MAX_SPREAD_MS;
  } finally {
    clearTimeout(timer);
  }
}

/** Accept, then deliver `{topic, payload}` to each distinct route once. */
export async function routeEnvelope(
  channel: string,
  raw: RealtimeEnvelope,
  deps: RoutingDeps,
): Promise<void> {
  const env = acceptEnvelope(channel, raw, deps);
  if (!env) return;
  await Promise.all(
    [...new Set(env.routes)].map(async route => {
      const dashboard = DASHBOARD_ROUTE.exec(route);
      if (!dashboard) {
        // Person (and tab) channels keep upstream's channel delivery.
        deps.sendToChannel(route, { topic: env.topic, payload: env.payload });
        return;
      }
      const [, tenant, uuid] = dashboard;
      const { payload } = env;
      if (typeof payload !== 'object' || payload === null) {
        deps.statsd.increment('ws_bad_payload_dropped');
        deps.logger.debug(
          `dropped a non-object payload for tenant ${tenant} dashboard ${uuid}`,
        );
        return;
      }
      // One read per route per event, only on replicas with a local viewer.
      const local = deps.subscribersOf(route).length;
      if (local === 0) return;
      const spread_ms = await spreadFor(deps, tenant, uuid, local);
      const data = JSON.stringify({
        topic: env.topic,
        payload: { ...payload, spread_ms },
      });
      // Re-read after the await: a socket that closed meanwhile is skipped.
      deps.subscribersOf(route).forEach(id => deps.sendToSocket(id, data));
    }),
  );
}
