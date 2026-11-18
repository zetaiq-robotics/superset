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
// Modified by ZetaIQ: identity from the gateway's delegated token (introspection) replaces the JWT cookie; per-person cap, SIGTERM close;
// per-dashboard subscribe/unsubscribe frames (1 KB frame cap); tenant channels by pattern (`t:*:realtime`) with
// cross-tenant routes dropped, per-dashboard delivery and audience-sized spread from viewer counts shared in Redis.
import * as http from 'http';
import * as net from 'net';
import { readFileSync } from 'fs';
import { inspect } from 'util';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { Redis, RedisOptions } from 'ioredis';
import StatsD from 'hot-shots';

import { createLogger } from './logger.js';
import { buildConfig, RedisConfig } from './config.js';
import {
  GatewayIdentity,
  IdentityRefused,
  IdentityUnavailable,
  REFUSED_CLOSE_CODE,
  identityFromRequest,
  watchIdentity,
} from './gatewayAuth.js';
import {
  onCountChange,
  subscribersOf,
  watchSubscriptions,
} from './subscriptions.js';
import { routeEnvelope } from './tenantRouting.js';
import { createViewerCounts, replicaId } from './viewerCounts.js';
import {
  checkServerIdentity,
  ConnectionOptions,
  PeerCertificate,
  rootCertificates,
} from 'tls';

/**
 * The generic envelope the server forwards to browsers. Every connected socket
 * has an introspected gateway token. A browser client dispatches on `topic` (the semantic
 * stream), never on the route it arrived by:
 *   - `entity.changed` - a lossy "an entity changed" nudge broadcast to every
 *     authenticated socket; `payload` carries opaque ids only (`{entity_type, id}`).
 *   - `task.status` - a targeted task/status message delivered only to the sockets
 *     the producer routed to; `payload` is feature-defined (e.g. `{task_id, status}`).
 * The server-side routing keys never reach the browser.
 */
export interface OutboundMessage {
  topic: string;
  payload: unknown;
}

/**
 * A Redis message from the Superset producer. Self-describing: `topic` is the
 * semantic stream forwarded to the browser, `scope` is the delivery breadth the
 * server routes by (`authenticated_global` => broadcast; otherwise targeted to
 * `routes`), `routes` are the server-side routing keys (present for a targeted
 * scope, absent/ignored for a broadcast), and `payload` is forwarded verbatim.
 */
export interface RealtimeEnvelope {
  topic: string;
  scope: string;
  routes?: string[];
  payload: unknown;
}

export interface SocketInstance {
  ws: WebSocket;
  channel: string;
  // Additional per-tab channel the socket is also registered under, when the
  // browser advertised a `tab_id` at connect (`<channel>:<tabId>`).
  tabChannel?: string;
  identity: GatewayIdentity;
  pongTs: number;
}

interface ChannelValue {
  sockets: Array<string>;
}

const environment = process.env.NODE_ENV;

const startServer = process.argv[2] === 'start';

export const opts = buildConfig();

export const logger = createLogger({
  silent: environment === 'test',
  logLevel: opts.logLevel,
  logToFile: opts.logToFile,
  logFilename: opts.logFilename,
});

export const statsd = new StatsD({
  ...opts.statsd,
  errorHandler: (e: Error) => {
    logger.error(e);
  },
});

if (startServer && !opts.introspectUrl) {
  logger.error('Please provide introspectUrl (INTROSPECT_URL)');
  process.exit(1);
}
if (startServer && !opts.accessCheckUrl) {
  logger.error('Please provide accessCheckUrl (ACCESS_CHECK_URL)');
  process.exit(1);
}

const readPem = (path: string): string => readFileSync(path, 'utf8');

const buildTlsOptions = (baseConfig: RedisConfig): ConnectionOptions => {
  const tlsOpts: ConnectionOptions = {
    checkServerIdentity: (
      hostname: string,
      cert: PeerCertificate,
    ): Error | undefined => {
      // Note, the cert chain will have been verified already. the role of this method is to
      // validate that at least one of the SAN's (or subject) of the server's cert matches the provided hostname
      if (baseConfig.validateHostname) {
        return checkServerIdentity(hostname, cert);
      }
    },
  };
  if (baseConfig.sslCertReqs === 'none') {
    tlsOpts.rejectUnauthorized = false;
  }
  if (baseConfig.sslCaCerts) {
    // Supplying `ca` replaces Node's default trust store, so the public roots
    // are re-added to keep public and private CAs usable together.
    tlsOpts.ca = [...rootCertificates, readPem(baseConfig.sslCaCerts)];
  }
  if (baseConfig.sslCertfile) {
    tlsOpts.cert = readPem(baseConfig.sslCertfile);
  }
  if (baseConfig.sslKeyfile) {
    tlsOpts.key = readPem(baseConfig.sslKeyfile);
  }
  return tlsOpts;
};

/**
 * Translate the `redis` config into ioredis options, covering the same modes as
 * the Python coordination backend: standalone or Sentinel (`sentinels` set),
 * each optionally over TLS. In Sentinel mode TLS applies to the resolved master
 * only; the sentinel nodes are reached in plaintext, as on the Python side.
 */
export const buildRedisOpts = (baseConfig: RedisConfig) => {
  const redisOpts: RedisOptions = { db: baseConfig.db };

  if (baseConfig.sentinels.length > 0) {
    if (!baseConfig.sentinelMaster) {
      throw new Error(
        'redis.sentinelMaster (REDIS_SENTINEL_MASTER) is required when ' +
          'redis.sentinels (REDIS_SENTINELS) is set',
      );
    }
    redisOpts.sentinels = baseConfig.sentinels.map(({ host, port }) => ({
      host,
      port,
    }));
    redisOpts.name = baseConfig.sentinelMaster;
    // Drop the connection to a master that has been demoted by a failover so
    // the subscriber re-resolves the new master and keeps receiving messages.
    redisOpts.failoverDetector = true;
    if (baseConfig.sentinelPassword !== '') {
      redisOpts.sentinelPassword = baseConfig.sentinelPassword;
    }
  } else {
    redisOpts.host = baseConfig.host;
    redisOpts.port = baseConfig.port;
  }

  const passwd = baseConfig.password;
  if (passwd !== '') {
    redisOpts.username = baseConfig.username;
    redisOpts.password = baseConfig.password;
  }

  if (baseConfig.ssl) {
    redisOpts.tls = buildTlsOptions(baseConfig);
    // ioredis ignores `tls` for the Sentinel-resolved master (connecting in
    // plaintext) unless this flag is set.
    if (redisOpts.sentinels) {
      redisOpts.enableTLSForSentinelMode = true;
    }
  }

  return redisOpts;
};

// A Redis connection dedicated to Pub/Sub: once a connection enters subscriber
// mode it can no longer issue ordinary commands, so subscriptions need a
// connection of their own.
const redisSubscriber = new Redis(buildRedisOpts(opts.redis));
redisSubscriber.on('error', (err: Error) => {
  logger.error(`Redis connection error: ${err.message}`);
});
// Viewer counts need ordinary commands, so a second connection. Its loss
// never closes sockets: counts only size the refresh spread.
const redisCounts = new Redis(buildRedisOpts(opts.redis));
redisCounts.on('error', (err: Error) => {
  logger.error(`Redis (viewer counts) connection error: ${err.message}`);
});
export const viewerCounts = createViewerCounts(redisCounts, replicaId(), {
  logger,
  statsd,
});
const httpServer = http.createServer();
export const wss = new WebSocketServer({
  noServer: true,
  clientTracking: false,
  // Inbound frames are only subscribe/unsubscribe; a larger one closes 1009.
  maxPayload: 1024,
});

const SOCKET_ACTIVE_STATES: number[] = [WebSocket.OPEN, WebSocket.CONNECTING];

// The server tails every tenant's channel, `t:<tenant>:realtime`, by pattern.
// Upstream's own channel (`<REALTIME_CHANNEL_PREFIX>realtime`) is not
// subscribed, so its topics stay off; tenantRouting validates each channel.
const REALTIME_PATTERN = 't:*:realtime';

// Bound on a client-supplied tab id before it is concatenated into a channel key
// (`<channel>:<tabId>`). The principal prefix is server-derived, but the tab
// suffix is client-controlled, so cap its length and restrict its charset. Kept
// in lockstep with the Flask ingress guard (superset/tasks/subscription.py).
const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const isValidTabId = (value: string): boolean => TAB_ID_PATTERN.test(value);

// Backoff before retrying an initial Pub/Sub subscription that failed (e.g.
// Redis unreachable at startup); see subscribeToChannels.
const SUBSCRIBE_RETRY_MS = 5000;

export let channels: Record<string, ChannelValue> = {};
export let sockets: Record<string, SocketInstance> = {};

// WebSocket close code used when a connection is refused because a configured
// connection limit has been reached (1013 = "Try Again Later").
const CONNECTION_LIMIT_CLOSE_CODE = 1013;

// The Redis Pub/Sub subscriber is the server's only source of realtime messages.
// If it drops, a browser socket can stay open while the server silently misses
// messages, so subscriber health gates the transport: while unhealthy, new
// upgrades are refused and existing sockets are closed with a retryable code
// (1012 = "Service Restart") so clients reconnect and run their status_changes
// catch-up once the subscriber is healthy again. (Left off /health, which is a
// liveness probe — coupling it to a transient Redis blip would churn pods.)
const SUBSCRIBER_UNHEALTHY_CLOSE_CODE = 1012;
export let subscriberHealthy = false;
// Set by SIGTERM: no upgrade is admitted after it.
let shuttingDown = false;

export const markSubscriberHealthy = (): void => {
  if (subscriberHealthy) return;
  subscriberHealthy = true;
  logger.info('Redis subscriber healthy; realtime transport available');
};

export const markSubscriberUnhealthy = (reason: string): void => {
  if (!subscriberHealthy) return; // act only on the healthy -> unhealthy edge
  subscriberHealthy = false;
  logger.warn(
    `Redis subscriber unhealthy (${reason}); refusing upgrades and closing ` +
      `sockets so clients reconnect and catch up`,
  );
  closeAllSockets(
    SUBSCRIBER_UNHEALTHY_CLOSE_CODE,
    'realtime backend unavailable',
  );
};

function closeAllSockets(code: number, reason: string): void {
  // Snapshot ids first: ws.close triggers the 'close' handler, which deletes from
  // `sockets` — mutating the object mid-iteration.
  Object.keys(sockets).forEach(socketId => {
    try {
      sockets[socketId]?.ws.close(code, reason);
    } catch (err) {
      logger.error(`Failed to close socket ${socketId} (${reason}): ${err}`);
    }
  });
}

// Grace between the 1012 close frames and exit, so they reach the clients.
const SHUTDOWN_GRACE_MS = 1000;

/** SIGTERM: close every socket `1012` so clients reconnect promptly, then exit. */
export const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('SIGTERM: closing every socket with 1012');
  httpServer.close();
  viewerCounts.stop();
  closeAllSockets(SUBSCRIBER_UNHEALTHY_CLOSE_CODE, 'server restart');
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
};

// A dropped/ended subscriber connection means missed messages; ioredis
// auto-reconnects (and re-subscribes), and the 'ready' handler below reconfirms
// the subscription and flips back to healthy.
redisSubscriber.on('close', () => markSubscriberUnhealthy('connection closed'));
redisSubscriber.on('end', () => markSubscriberUnhealthy('connection ended'));

/**
 * Returns whether the socket with the given id is currently active, i.e. it is
 * still registered and its underlying connection is in an active readyState.
 *
 * Closed sockets are only removed from the registries asynchronously (via the
 * `checkSockets`/`cleanChannel` GC routines), so connection-limit checks must
 * filter on live socket state rather than trusting the raw registry sizes.
 */
export const isSocketActive = (socketId: string): boolean => {
  const socketInstance = sockets[socketId];
  return (
    !!socketInstance &&
    SOCKET_ACTIVE_STATES.includes(socketInstance.ws.readyState)
  );
};

/**
 * Counts the sockets in the global registry that are still active.
 */
export const activeSocketCount = (): number =>
  Object.keys(sockets).filter(isSocketActive).length;

/**
 * Counts the active sockets currently registered on the given channel.
 */
export const activeChannelSocketCount = (channel: string): number =>
  channels[channel]?.sockets.filter(isSocketActive).length ?? 0;

/**
 * Determines whether accepting a new connection on the given channel would
 * exceed a configured connection limit. Returns a human-readable reason when a
 * limit is reached, or `null` when the connection is within limits.
 *
 * Both limits are opt-in: a value of `0` (the default) disables the check.
 *
 * Counts are derived from active socket state rather than raw registry sizes:
 * recently closed sockets linger in the registries until the next GC pass, so
 * counting them would spuriously reject new connections even when no active
 * connection is consuming capacity.
 */
export const connectionLimitReason = (channel: string): string | null => {
  const { maxTotalConnections, maxConnectionsPerChannel, maxSocketsPerPerson } =
    opts;

  if (maxTotalConnections > 0 && activeSocketCount() >= maxTotalConnections) {
    return `total connection limit (${maxTotalConnections}) reached`;
  }

  // The channel is the person's own (`t:<tenant>:p:<person>`).
  if (
    maxSocketsPerPerson > 0 &&
    activeChannelSocketCount(channel) >= maxSocketsPerPerson
  ) {
    return `per-person socket limit (${maxSocketsPerPerson}) reached`;
  }

  if (
    maxConnectionsPerChannel > 0 &&
    activeChannelSocketCount(channel) >= maxConnectionsPerChannel
  ) {
    return `per-channel connection limit (${maxConnectionsPerChannel}) reached`;
  }

  return null;
};

/**
 * Adds the passed channel and socket instance to the internal registries.
 */
export const trackClient = (
  channel: string,
  socketInstance: SocketInstance,
): string => {
  statsd.increment('ws_connected_client');

  const socketId = randomUUID();
  sockets[socketId] = socketInstance;

  if (channel in channels) {
    channels[channel].sockets.push(socketId);
  } else {
    channels[channel] = { sockets: [socketId] };
  }

  return socketId;
};

/**
 * Sends one already-serialized message to a single socket, applying backpressure
 * and cleanup. Returns whether the send succeeded. When `cleanupChannel` is
 * given, a missing/terminated/errored socket triggers a `cleanChannel` on it;
 * broadcast callers omit it (the next targeted send or GC prunes the socket).
 */
export const sendToSocket = (
  socketId: string,
  strData: string,
  cleanupChannel?: string,
): boolean => {
  const socketInstance: SocketInstance = sockets[socketId];
  if (!socketInstance) {
    if (cleanupChannel) cleanChannel(cleanupChannel);
    return false;
  }
  // Backpressure: if this send would grow a slow or stalled client's outbound
  // buffer past the configured cap, terminate it rather than buffering
  // unbounded data in server memory. A cap of 0 disables the check.
  const { maxSocketBufferBytes } = opts;
  if (
    maxSocketBufferBytes > 0 &&
    socketInstance.ws.bufferedAmount + Buffer.byteLength(strData) >
      maxSocketBufferBytes
  ) {
    statsd.increment('ws_client_backpressure_disconnect');
    logger.warn(
      `Terminating socket ${socketId}: send buffer ` +
        `(${socketInstance.ws.bufferedAmount} bytes) exceeded the ` +
        `configured limit (${maxSocketBufferBytes} bytes)`,
    );
    socketInstance.ws.terminate();
    // Drop the terminated socket from the global registry immediately
    // rather than waiting for the next checkSockets sweep, so a burst of
    // slow clients doesn't leave dead entries resident between pings.
    delete sockets[socketId];
    if (cleanupChannel) cleanChannel(cleanupChannel);
    return false;
  }
  try {
    socketInstance.ws.send(strData);
    return true;
  } catch (err) {
    statsd.increment('ws_client_send_error');
    logger.debug(`Error sending to socket: ${err}`);
    if (cleanupChannel) cleanChannel(cleanupChannel);
    return false;
  }
};

/**
 * Sends a single message to every socket registered on a channel.
 * A channel may have multiple connected sockets (e.g. one browser tab each);
 * this emits the message to all of them, leaving it to the client to decide
 * which are relevant to its current context.
 */
export const sendToChannel = (
  channel: string,
  message: OutboundMessage,
): void => {
  const strData = JSON.stringify(message);
  if (!channels[channel]) {
    logger.debug(`channel ${channel} is unknown, skipping`);
    return;
  }
  let sentCount = 0;
  // Iterate a copy: a failed send may cleanChannel and mutate the sockets list.
  channels[channel].sockets.slice().forEach(socketId => {
    if (sendToSocket(socketId, strData, channel)) sentCount += 1;
  });
  logger.debug(
    `Forwarded ${message.topic} to ${sentCount} socket(s) on channel ${channel}`,
  );
};

/**
 * Validate and narrow a parsed Redis message to a RealtimeEnvelope, or return
 * null (logging) when it is malformed. A targeted (non-broadcast) envelope must
 * carry a non-empty `routes` array of non-empty strings; a broadcast may omit it.
 */
function parseRealtimeEnvelope(payload: unknown): RealtimeEnvelope | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as {
    topic?: unknown;
    scope?: unknown;
    routes?: unknown;
    payload?: unknown;
  };
  if (typeof candidate.topic !== 'string' || candidate.topic.length === 0) {
    return null;
  }
  if (typeof candidate.scope !== 'string' || candidate.scope.length === 0) {
    return null;
  }
  let routes: string[] | undefined;
  if (candidate.routes !== undefined) {
    if (
      !Array.isArray(candidate.routes) ||
      !candidate.routes.every(
        route => typeof route === 'string' && route.length > 0,
      )
    ) {
      return null;
    }
    routes = candidate.routes as string[];
  }
  return {
    topic: candidate.topic,
    scope: candidate.scope,
    routes,
    payload: candidate.payload,
  };
}

/**
 * Routes a raw Redis Pub/Sub message from a tenant channel. tenantRouting
 * drops the whole envelope if its channel is not a tenant's, its scope is the
 * upstream broadcast, or any route lies outside the channel's tenant; it
 * forwards the browser-facing `{topic, payload}` (routes and scope stripped).
 */
export const routeRedisMessage = (
  channel: string,
  rawMessage: string,
): Promise<void> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch (err) {
    logger.error(`Failed to parse message on channel ${channel}: ${err}`);
    return Promise.resolve();
  }
  const envelope = parseRealtimeEnvelope(parsed);
  if (!envelope) {
    logger.error(`Invalid realtime envelope on channel ${channel}`);
    return Promise.resolve();
  }
  return routeEnvelope(channel, envelope, {
    statsd,
    logger,
    subscribersOf: key => subscribersOf(key),
    totalViewers: viewerCounts.totalViewers,
    countWritesFailing: viewerCounts.writesFailing,
    sendToSocket: (id, data) => sendToSocket(id, data),
    sendToChannel,
  });
};

/**
 * Subscribes the Redis connection by pattern to every tenant channel
 * (`t:*:realtime`), which carries every browser-bound message.
 *
 * Pub/Sub is best-effort and not replayable, so there is no server-side catch-up:
 * a message published while a socket was away is simply gone. The browser recovers
 * by reconciling through the authorized REST API — a ``status_changes`` catch-up on
 * (re)connect and a last-chance read before giving up — not an interval poll.
 *
 * Failure to subscribe at all is observable and self-healing rather than silent:
 * if the initial ``subscribe`` rejects (e.g. Redis unreachable at startup) it is
 * logged and retried, so the transport can't end up running with no
 * subscription. ioredis additionally re-establishes the subscription
 * automatically across reconnects once it exists.
 */
let messageBound = false;

export const subscribeToChannels = async (): Promise<void> => {
  // Bind the router exactly once; retries must not stack duplicate listeners
  // (which would route every message N times).
  if (!messageBound) {
    redisSubscriber.on(
      'pmessage',
      (_pattern: string, channel: string, message: string) => {
        routeRedisMessage(channel, message).catch(err =>
          logger.error(`Failed to route message on ${channel}: ${err}`),
        );
      },
    );
    messageBound = true;
  }
  try {
    await redisSubscriber.psubscribe(REALTIME_PATTERN);
    markSubscriberHealthy();
    logger.info(`Subscribed to Redis channels: ${REALTIME_PATTERN}`);
  } catch (err) {
    logger.error(
      `Failed to subscribe to Redis channels; retrying in ` +
        `${SUBSCRIBE_RETRY_MS}ms: ${err}`,
    );
    setTimeout(subscribeToChannels, SUBSCRIBE_RETRY_MS);
  }
};

// After a reconnect ioredis re-subscribes automatically; reconfirm the
// subscription (idempotent) so the healthy flag flips back on. Wired here, after
// subscribeToChannels is defined, to avoid a use-before-define reference.
redisSubscriber.on('ready', () => {
  subscribeToChannels();
});

/**
 * WebSocket `connection` event handler. `identity` is the one introspected
 * during the HTTP upgrade (see `httpUpgrade`); `watchIdentity` re-checks it.
 */
export const wsConnection = (
  ws: WebSocket,
  identity: GatewayIdentity,
  tabId?: string,
) => {
  const { channel } = identity;

  // Refuse the connection if a configured connection limit has been reached,
  // before tracking it against the internal registries. The cap is keyed on the
  // principal channel (which counts all of a principal's tabs); the per-tab
  // channel is a delivery refinement and is not separately limit-checked.
  const limitReason = connectionLimitReason(channel);
  if (limitReason) {
    statsd.increment('ws_connection_rejected');
    logger.warn(`Refusing connection on channel ${channel}: ${limitReason}`);
    ws.close(CONNECTION_LIMIT_CLOSE_CODE, limitReason);
    return;
  }

  // When the browser advertised a tab id at connect, also register the socket
  // under a per-tab channel derived from its authorized principal channel
  // (`<channel>:<tabId>`). The tab id is client-supplied but always prefixed by
  // the authorized principal channel, so it can never address another
  // principal's sockets. Task-status can then target one tab, while the
  // principal channel still reaches all of a principal's tabs.
  const tabChannel = tabId ? `${channel}:${tabId}` : undefined;

  const socketInstance: SocketInstance = {
    ws,
    channel,
    tabChannel,
    identity,
    pongTs: Date.now(),
  };

  // Register once (mints a single socket id), then also index that same id under
  // the per-tab channel - never call trackClient twice (it would mint a second
  // id and a duplicate registry entry).
  const socketId = trackClient(channel, socketInstance);
  if (tabChannel) {
    (channels[tabChannel] ??= { sockets: [] }).sockets.push(socketId);
  }
  watchIdentity(ws, identity);
  watchSubscriptions(ws, socketId, identity);
  logger.debug(
    `socket ${socketId} connected on channel ${channel}` +
      (tabChannel ? ` (tab channel ${tabChannel})` : ''),
  );

  ws.on('pong', function pong(data: Buffer) {
    const socketId = data.toString();
    // `sockets` is a plain object, so an unsolicited pong carrying an
    // inherited key ('__proto__', 'constructor', 'hasOwnProperty', ...) as
    // its payload would otherwise resolve through the prototype chain
    // instead of missing outright, letting a client write an enumerable
    // `pongTs` onto Object.prototype (tripped over by the for...in loops in
    // checkSockets/cleanChannel on every GC pass). Guarding with an
    // own-property check rejects every such key in one place.
    if (!Object.prototype.hasOwnProperty.call(sockets, socketId)) {
      logger.warn(`pong received for nonexistent socket ${socketId}`);
      return;
    }
    sockets[socketId].pongTs = Date.now();
  });
};

/**
 * HTTP `request` event handler, called via httpServer
 */
export const httpRequest = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => {
  const rawUrl = request.url as string;
  const method = request.method as string;
  const headers = request.headers || {};
  const url = new URL(rawUrl as string, `http://${headers.host}`);
  if (url.pathname === '/health' && ['GET', 'HEAD'].includes(method)) {
    // Liveness: the process is up. Deliberately independent of subscriber health
    // (see /ready) so a transient Redis blip doesn't get the pod restarted.
    response.writeHead(200);
    response.end('OK');
  } else if (url.pathname === '/ready' && ['GET', 'HEAD'].includes(method)) {
    // Readiness: healthy only while the Redis subscriber is connected+subscribed,
    // so a load balancer can drain a pod whose transport is degraded (upgrade
    // refusal + socket close still cover correctness on their own).
    if (subscriberHealthy) {
      response.writeHead(200);
      response.end('OK');
    } else {
      response.writeHead(503);
      response.end('SUBSCRIBER_UNAVAILABLE');
    }
  } else {
    logger.info(`Received unexpected request: ${method} ${rawUrl}`);
    response.writeHead(404);
    response.end('Not Found');
  }
};

/**
 * Validates the `Origin` header of a WebSocket upgrade request against the
 * configured `allowedOrigins` list, mitigating Cross-Site WebSocket Hijacking.
 *
 * When `allowedOrigins` is empty the check is skipped (preserving existing
 * behavior); a single `'*'` entry explicitly allows any origin. Otherwise the
 * request's `Origin` must exactly match one of the configured origins.
 */
export const isOriginAllowed = (request: http.IncomingMessage): boolean => {
  const { allowedOrigins } = opts;

  if (!allowedOrigins || allowedOrigins.length === 0) {
    return true;
  }
  if (allowedOrigins.includes('*')) {
    return true;
  }

  // `origin` is typed as `string | string[] | undefined`; only a single,
  // unambiguous string header is acceptable for an exact-match comparison.
  const origin = request.headers.origin;
  if (typeof origin !== 'string') {
    return false;
  }
  return allowedOrigins.includes(origin);
};

/**
 * HTTP `upgrade` event handler, called via httpServer
 */
export const httpUpgrade = async (
  request: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): Promise<void> => {
  if (!isOriginAllowed(request)) {
    logger.error(
      `Rejecting WebSocket upgrade from disallowed origin: ${
        request.headers.origin || '(none)'
      }`,
    );
    socket.destroy();
    return;
  }

  // Refuse upgrades while the Redis subscriber is unhealthy: a socket accepted now
  // would silently miss messages until the subscription recovers. Reply 503 so the
  // client backs off and retries (its reconnect then runs the status_changes
  // catch-up against a healthy server).
  const unavailable = (why: string) => {
    statsd.increment('ws_upgrade_rejected');
    logger.warn(`Rejecting WebSocket upgrade: ${why}`);
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
  };
  if (!subscriberHealthy) return unavailable('Redis subscriber unhealthy');
  if (shuttingDown) return unavailable('shutting down');

  // Introspection is async; a client reset meanwhile must not crash the process.
  socket.on('error', () => socket.destroy());
  let identity: GatewayIdentity;
  try {
    identity = await identityFromRequest(request);
  } catch (err) {
    // Messages never carry the token. A refusal completes the handshake and
    // closes 4401 because a browser cannot read a failed upgrade's status.
    if (err instanceof IdentityUnavailable) return unavailable(err.message);
    statsd.increment('ws_upgrade_rejected');
    logger.warn(
      `Rejected WebSocket upgrade from ${request.socket.remoteAddress ?? 'unknown'}: ` +
        `${(err as Error).message}`,
    );
    if (err instanceof IdentityRefused) {
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit('connection', ws, request);
        ws.close(REFUSED_CLOSE_CODE, 'unauthorized');
      });
    } else {
      socket.destroy();
    }
    return;
  }
  // The subscriber may have dropped, or SIGTERM arrived, while introspection
  // was in flight.
  if (!subscriberHealthy) return unavailable('Redis subscriber unhealthy');
  if (shuttingDown) return unavailable('shutting down');

  // Optional per-tab id advertised on the connect URL (`?tab_id=<id>`), used to
  // also bind the socket to a per-tab channel for targeted task-status delivery.
  // Parsed from the request URL (mirrors httpRequest); absent/blank/invalid ->
  // no per-tab channel (principal-grain delivery, as before).
  let tabId: string | undefined;
  try {
    const parsed = new URL(
      request.url ?? '',
      `http://${request.headers.host ?? 'localhost'}`,
    ).searchParams.get('tab_id');
    if (parsed && isValidTabId(parsed)) tabId = parsed;
  } catch {
    // Malformed URL: ignore the tab hint and fall back to principal-grain.
  }

  wss.handleUpgrade(request, socket, head, function cb(ws: WebSocket) {
    wss.emit('connection', ws, request);
    wsConnection(ws, identity, tabId);
  });
};

// Connection cleanup and garbage collection

/**
 * Iterate over all tracked sockets, terminating and removing references to
 * connections that have not responded with a _pong_ within the timeout window.
 * Sends a _ping_ to all active connections.
 */
export const checkSockets = () => {
  logger.debug(`channel count: ${Object.keys(channels).length}`);
  logger.debug(`socket count: ${Object.keys(sockets).length}`);
  for (const socketId in sockets) {
    const socketInstance = sockets[socketId];
    const now = Date.now();
    const timeout = now - socketInstance.pongTs;
    let isActive = true;

    if (now >= socketInstance.identity.expiresAtMs) {
      logger.debug(
        `terminating socket with expired token: ${socketId}, channel: ${socketInstance.channel}`,
      );
      statsd.increment('ws_token_expired_disconnect');
      socketInstance.ws.terminate();
      isActive = false;
    } else if (timeout >= opts.socketResponseTimeoutMs) {
      logger.debug(
        `terminating unresponsive socket: ${socketId}, channel: ${socketInstance.channel}`,
      );
      socketInstance.ws.terminate();
      isActive = false;
    } else if (!isSocketActive(socketId)) {
      isActive = false;
    }

    if (isActive) {
      socketInstance.ws.ping(socketId);
    } else {
      delete sockets[socketId];
      logger.debug(`forgetting socket ${socketId}`);
    }
  }
};

/**
 * Iterate over all sockets within a channel, removing references to
 * inactive connections, ultimately removing the channel from the
 * _channels_ registry if no active connections remain.
 */
export const cleanChannel = (channel: string) => {
  const activeSockets: string[] =
    channels[channel]?.sockets.filter(socketId => isSocketActive(socketId)) ||
    [];

  if (activeSockets.length === 0) {
    delete channels[channel];
  } else {
    channels[channel].sockets = activeSockets;
  }
};

// server startup

if (startServer) {
  // Last-resort handlers so an unhandled async error is recorded through the
  // configured logger instead of printing a default trace (or, for an
  // unhandled rejection, terminating the process on newer Node versions).
  process.on('unhandledRejection', (reason: unknown) => {
    // Normalize the reason defensively: a raw template interpolation throws on
    // a Symbol (or other exotic value), which would crash this last-resort
    // handler. `inspect` safely stringifies any value.
    logger.error(`Unhandled promise rejection: ${inspect(reason)}`);
  });
  process.on('uncaughtException', (err: unknown) => {
    // JavaScript can throw non-Error values (including null), so guard the
    // shape before dereferencing instead of assuming an Error is present.
    const detail =
      err instanceof Error ? (err.stack ?? err.message) : inspect(err);
    logger.error(`Uncaught exception: ${detail}`);
  });

  wss.on('connection', function (ws: WebSocket) {
    ws.on('error', (err: Error) =>
      logger.error(`socket error: ${err.message}`),
    );
  });
  httpServer.on('request', httpRequest);
  httpServer.on('upgrade', httpUpgrade);
  process.on('SIGTERM', shutdown);
  httpServer.listen(opts.port);
  logger.info(`Server started on port ${opts.port}`);

  subscribeToChannels();
  onCountChange((tenant, uuid, count) => {
    void viewerCounts.recordCount(tenant, uuid, count);
  });
  viewerCounts.start();

  setInterval(checkSockets, opts.pingSocketsIntervalMs);
  setInterval(function gc() {
    for (const channel in channels) {
      cleanChannel(channel);
    }
  }, opts.gcChannelsIntervalMs);
}

// test utilities

export const resetState = () => {
  channels = {};
  sockets = {};
  messageBound = false;
  shuttingDown = false;
  // A reset server is a clean, running (subscribed) server, so tests start from a
  // healthy transport; a test drives the unhealthy edge with markSubscriberUnhealthy.
  subscriberHealthy = true;
};
