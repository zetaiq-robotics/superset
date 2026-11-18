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

// ZetaIQ: identity from the read gateway's delegated token. The gateway strips
// cookies and stamps `Authorization: Bearer <token>`; the only way to learn who
// the caller is, is to introspect that token with the control plane. The token
// lives in memory only and is never logged.
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { logger, opts } from './index.js';

/** The control plane refused the token (revoked, expired, wrong service...). */
export class IdentityRefused extends Error {}
/** The control plane could not answer; the caller should retry later. */
export class IdentityUnavailable extends Error {}

export type GatewayIdentity = {
  tenant: string;
  person: string;
  expiresAtMs: number;
  token: string;
  channel: string;
};

const SERVICE = 'dashboards';
const INTROSPECT_TIMEOUT_MS = 5000;
const TENANT_PATTERN = /^[a-z0-9]{2,63}$/;
// No `:` so a person can never alias another channel key (`<channel>:<tab>`).
const PERSON_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const BEARER_PATTERN = /^Bearer +(\S+)$/i;
export const REFUSED_CLOSE_CODE = 4401;
const RETRY_LATER_CLOSE_CODE = 1013;

export async function introspect(
  token: string,
): Promise<{ tenant: string; person: string; expiresAtMs: number }> {
  let res: Response;
  try {
    res = await fetch(opts.introspectUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, service: SERVICE }),
      signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    // The error names the failure only; it never carries the request body.
    throw new IdentityUnavailable(
      `introspection request failed (${(err as Error)?.name ?? 'unknown'})`,
    );
  }
  if (res.status !== 200) {
    // Release the pooled connection to the control plane.
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) throw new IdentityRefused('token refused');
    throw new IdentityUnavailable(`introspection answered ${res.status}`);
  }
  let body: Record<string, unknown>;
  try {
    body = ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    throw new IdentityUnavailable('introspection answer is not JSON');
  }
  const { tenant_id: tenant, org_user_id: person, expires_at } = body;
  if (typeof tenant !== 'string' || tenant === '') {
    throw new IdentityUnavailable('introspection answer has no tenant');
  }
  if (!TENANT_PATTERN.test(tenant)) {
    throw new IdentityRefused('introspection answer has a malformed tenant');
  }
  if (typeof person !== 'string' || person === '') {
    throw new IdentityUnavailable('introspection answer has no person');
  }
  if (!PERSON_PATTERN.test(person)) {
    throw new IdentityRefused('introspection answer has a malformed person');
  }
  const expiresAtMs =
    typeof expires_at === 'string' ? Date.parse(expires_at) : NaN;
  if (!Number.isFinite(expiresAtMs)) {
    throw new IdentityUnavailable('introspection answer has no expiry');
  }
  if (expiresAtMs <= Date.now()) throw new IdentityRefused('token expired');
  return { tenant, person, expiresAtMs };
}

/**
 * Identity of an upgrade request. The bearer comes from the `authorization`
 * header only (no query-string or cookie fallback). A missing or malformed
 * bearer throws a plain Error: no gateway would forward such a request.
 */
export async function identityFromRequest(
  req: IncomingMessage,
): Promise<GatewayIdentity> {
  const token = BEARER_PATTERN.exec(req.headers.authorization ?? '')?.[1];
  if (!token) throw new Error('no bearer token');
  const { tenant, person, expiresAtMs } = await introspect(token);
  return {
    tenant,
    person,
    expiresAtMs,
    token,
    channel: `t:${tenant}:p:${person}`,
  };
}

/**
 * Keep an accepted socket's identity honest: close `4401` exactly at
 * `expiresAtMs`, and introspect again every `introspectIntervalMs` (first check
 * at a random offset so a replica's sockets do not all call at once). Refusal
 * closes `4401`; an unavailable control plane closes `1013` (fail closed, the
 * client backs off and reconnects).
 */
export function watchIdentity(ws: WebSocket, identity: GatewayIdentity): void {
  const who = `tenant ${identity.tenant} person ${identity.person}`;
  // Set once the socket is closing, so an introspection still in flight does
  // not re-arm timers (and keep sending the token) for a dead socket.
  let closed = false;
  const stop = () => {
    closed = true;
    clearTimeout(expiry);
    clearTimeout(recheck);
  };
  const close = (code: number, reason: string) => {
    stop();
    ws.close(code, reason);
  };
  const expire = () => {
    logger.info(`Closing socket for ${who}: token expired`);
    close(REFUSED_CLOSE_CODE, 'token expired');
  };
  let expiry = setTimeout(expire, identity.expiresAtMs - Date.now());

  const check = async () => {
    try {
      const fresh = await introspect(identity.token);
      if (closed) return;
      if (
        fresh.tenant !== identity.tenant ||
        fresh.person !== identity.person
      ) {
        throw new IdentityRefused('identity changed');
      }
      identity.expiresAtMs = fresh.expiresAtMs;
      clearTimeout(expiry);
      expiry = setTimeout(expire, identity.expiresAtMs - Date.now());
      recheck = setTimeout(check, opts.introspectIntervalMs);
    } catch (err) {
      if (closed) return;
      const refused = err instanceof IdentityRefused;
      logger.warn(
        `Closing socket for ${who}: re-introspection ${
          refused ? 'refused' : 'unavailable'
        } (${(err as Error).message})`,
      );
      close(
        refused ? REFUSED_CLOSE_CODE : RETRY_LATER_CLOSE_CODE,
        refused ? 'unauthorized' : 'identity check unavailable',
      );
    }
  };
  let recheck = setTimeout(check, Math.random() * opts.introspectIntervalMs);

  ws.on('close', stop);
}
