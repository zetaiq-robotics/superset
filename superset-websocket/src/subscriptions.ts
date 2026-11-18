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

// ZetaIQ: per-dashboard subscriptions. A socket names a dashboard by uuid;
// Superset decides, from the socket's own bearer token, whether its person may
// open it. The key is built from the introspected tenant, never from the
// message. This module holds no permission logic and never logs the token.
import type { RawData, WebSocket } from 'ws';
import type { GatewayIdentity } from './gatewayAuth.js';
import { isSocketActive, logger, opts, sendToSocket } from './index.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_CHECK_TIMEOUT_MS = 5000;
// Sliding window: the 11th inbound frame within any 1000 ms closes the socket.
const MAX_FRAMES_PER_WINDOW = 10;
const FRAME_WINDOW_MS = 1000;
const POLICY_VIOLATION_CLOSE_CODE = 1008;

type Answer =
  | { ok: true; etag: string; charts_digest: string }
  | { ok: false; why: 'invalid' | 'limit' | 'not_found' | 'unavailable' };

type CountHook = (tenant: string, uuid: string, localCount: number) => void;

// key -> ids of the sockets on this replica subscribed to it.
const byKey = new Map<string, Set<string>>();
let countHook: CountHook = () => undefined;

/** Register the hook fired whenever a key's local subscriber count changes. */
export const onCountChange = (hook: CountHook): void => {
  countHook = hook;
};

export const dashboardKey = (tenant: string, uuid: string): string =>
  `t:${tenant}:d:${uuid}`;

/** Live socket ids subscribed to `key` (a closing socket is skipped at once). */
export const subscribersOf = (key: string): string[] =>
  [...(byKey.get(key) ?? [])].filter(isSocketActive);

/**
 * Ask Superset whether the bearer's person may open the dashboard. "Does not
 * exist" and "no access" both answer `not_found`, so a client cannot probe.
 */
export async function checkAccess(
  token: string,
  uuid: string,
  abandon?: AbortSignal,
): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(`${opts.accessCheckUrl}/${uuid}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.any([
        ...(abandon ? [abandon] : []),
        AbortSignal.timeout(ACCESS_CHECK_TIMEOUT_MS),
      ]),
      redirect: 'error',
    });
  } catch {
    return { ok: false, why: 'unavailable' };
  }
  if (res.status !== 200) {
    // Release the pooled connection to Superset.
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      why: [401, 403, 404].includes(res.status) ? 'not_found' : 'unavailable',
    };
  }
  try {
    const { etag, charts_digest } = (await res.json()) ?? {};
    if (typeof etag === 'string' && typeof charts_digest === 'string') {
      return { ok: true, etag, charts_digest };
    }
  } catch {
    // Not JSON: unavailable below.
  }
  return { ok: false, why: 'unavailable' };
}

type SocketState = {
  id: string;
  tenant: string;
  token: string;
  subscribed: Set<string>;
  // uuid -> abort handle of the access check in flight. Whoever deletes it
  // aborts it; a check whose handle is no longer here is dropped silently
  // (no reply, not counted as unavailable).
  pending: Map<string, AbortController>;
  frames: number[];
};

// A throwing hook must never break add/remove or the reply.
const notify = (tenant: string, uuid: string, localCount: number): void => {
  try {
    countHook(tenant, uuid, localCount);
  } catch (err) {
    logger.error(
      `count hook failed for tenant ${tenant} dashboard ${uuid}: ${err}`,
    );
  }
};

const add = (s: SocketState, uuid: string): void => {
  if (s.subscribed.has(uuid)) return;
  s.subscribed.add(uuid);
  const key = dashboardKey(s.tenant, uuid);
  const ids = byKey.get(key) ?? new Set<string>();
  byKey.set(key, ids.add(s.id));
  notify(s.tenant, uuid, ids.size);
};

const remove = (s: SocketState, uuid: string): void => {
  if (!s.subscribed.delete(uuid)) return;
  const key = dashboardKey(s.tenant, uuid);
  const ids = byKey.get(key);
  if (!ids) return;
  ids.delete(s.id);
  if (ids.size === 0) byKey.delete(key);
  notify(s.tenant, uuid, ids.size);
};

const reply = (s: SocketState, dashboard: string | null, a: Answer): void => {
  sendToSocket(
    s.id,
    JSON.stringify({
      topic: 'subscribed',
      payload: {
        dashboard,
        ok: a.ok,
        etag: a.ok ? a.etag : null,
        charts_digest: a.ok ? a.charts_digest : null,
        why: a.ok ? null : a.why,
      },
    }),
  );
};

async function subscribe(s: SocketState, raw: unknown): Promise<void> {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
    reply(s, typeof raw === 'string' ? raw : null, {
      ok: false,
      why: 'invalid',
    });
    return;
  }
  const uuid = raw.toLowerCase();
  // A check for this dashboard is already in flight: its one reply answers
  // this subscribe too, so a burst costs Superset one call.
  if (s.pending.has(uuid)) return;
  // Subscriptions and checks in flight both count, so a burst cannot race
  // past the cap. A dashboard already held is a refresh, not a new slot.
  const held = new Set([...s.subscribed, ...s.pending.keys()]);
  const cap = opts.maxSubscriptionsPerSocket;
  if (!held.has(uuid) && cap > 0 && held.size >= cap) {
    reply(s, uuid, { ok: false, why: 'limit' });
    return;
  }
  const ticket = new AbortController();
  s.pending.set(uuid, ticket);
  const answer = await checkAccess(s.token, uuid, ticket.signal);
  if (s.pending.get(uuid) !== ticket) return;
  s.pending.delete(uuid);
  if (!isSocketActive(s.id)) return;
  if (answer.ok) {
    add(s, uuid);
  } else {
    // A refused re-check drops a subscription the socket already had.
    remove(s, uuid);
    logger.debug(
      `subscribe refused (${answer.why}) for tenant ${s.tenant} dashboard ${uuid}`,
    );
  }
  reply(s, uuid, answer);
}

const unsubscribe = (s: SocketState, raw: unknown): void => {
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) return;
  const uuid = raw.toLowerCase();
  s.pending.get(uuid)?.abort();
  s.pending.delete(uuid);
  remove(s, uuid);
};

/**
 * Handle a socket's inbound frames (`subscribe` / `unsubscribe`) and drop all
 * its subscriptions when it closes. Frames over 1 KB never get here: the
 * WebSocketServer's `maxPayload` closes the socket with 1009.
 */
export function watchSubscriptions(
  ws: WebSocket,
  id: string,
  identity: GatewayIdentity,
): void {
  const s: SocketState = {
    id,
    tenant: identity.tenant,
    token: identity.token,
    subscribed: new Set(),
    pending: new Map(),
    frames: [],
  };

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (!isSocketActive(id)) return;
    const now = Date.now();
    s.frames = s.frames.filter(t => now - t < FRAME_WINDOW_MS);
    s.frames.push(now);
    if (s.frames.length > MAX_FRAMES_PER_WINDOW) {
      logger.warn(`Closing socket for tenant ${s.tenant}: too many messages`);
      ws.close(POLICY_VIOLATION_CLOSE_CODE, 'too many messages');
      return;
    }
    if (isBinary) return;
    let msg: { type?: unknown; dashboard?: unknown } | null;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg?.type === 'subscribe') void subscribe(s, msg.dashboard);
    else if (msg?.type === 'unsubscribe') unsubscribe(s, msg.dashboard);
  });

  ws.on('close', () => {
    s.pending.forEach(ticket => ticket.abort());
    s.pending.clear();
    [...s.subscribed].forEach(uuid => remove(s, uuid));
  });
}

// test utility
export const resetSubscriptions = (): void => {
  byKey.clear();
  countHook = () => undefined;
};
