<!--
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements.  See the NOTICE file
distributed with this work for additional information
regarding copyright ownership.  The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License.  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.  See the License for the
specific language governing permissions and limitations
under the License.
-->
<!-- Modified by ZetaIQ: identity from the gateway's bearer token checked by introspection replaces the JWT cookie. -->

# Superset WebSocket Server

A Node.js WebSocket server that pushes realtime events from the Superset backend
to the web frontend. It is a shared transport for authenticated realtime
sockets: it broadcasts opaque entity-change nudges and fans targeted task-status
events out to socket routing keys bound to an introspected identity.

## Requirements

- Node.js 20.11+ to run the built bundle (the build targets `node20`, and
  `import.meta.dirname` requires 20.11). Building and developing this package
  follow the stricter `engines` range in `package.json`.
- Redis or Valkey, reachable for Pub/Sub

To use realtime push, enable it in the Superset backend (`WEBSOCKET_ENABLE`,
`WEBSOCKET_URL`; see below) and run this server behind the read gateway, which
stamps each upgrade with the caller's bearer token.

## Architecture

### The `realtime` Pub/Sub channel and the message envelope

Realtime events are published to a single Redis **Pub/Sub** channel,
`<REALTIME_CHANNEL_PREFIX>realtime` (just `realtime` with the default empty
prefix), by the Superset Flask app (`superset/tasks/manager.py`). Pub/Sub is
intentionally best-effort (fire-and-forget, at-most-once — no replay): it
accelerates each feature's authoritative REST/poll path rather than guaranteeing
delivery, so a message missed during a disconnect is reconciled by a frontend
catch-up / REST refetch. See [Superset Configuration](#superset-configuration)
for the prefix and its Redis ACL implications.

Each Redis message is a self-describing envelope that separates **what** a message
is from **who** receives it:

```
{ topic, scope, routes?, payload }
```

- **`topic`** — the semantic stream the browser dispatches on: `task.status`,
  `entity.changed`, and future topics (`notification.*`, `report.progress`, …). A
  new surface adds a topic without inventing channel names or overloading payload
  shapes.
- **`scope`** — the delivery breadth the server routes by:
  - `authenticated_global` — broadcast to **every authenticated** realtime socket.
    This is authenticated-global, **not** public: anonymous users get no realtime
    principal, no bearer token, and therefore no socket, so they never receive these
    messages. (True anonymous/Public-role realtime would need a separate,
    restricted model and is out of scope.)
  - `principal` / `tab` — targeted to the routing keys in `routes`. The server
    treats the two the same way (deliver to `routes`); the distinction is only
    descriptive.
- **`routes`** — server-computed routing keys for a targeted scope: principal-grain
  `user:<id>` / `guest:<hmac>` (all of a principal's tabs), or per-tab
  `user:<id>:<tabId>` (one tab). Omitted for a broadcast. **Never forwarded to the
  browser.**
- **`payload`** — the feature-defined body forwarded verbatim to the browser.

The two topics in use:

1. **`entity.changed`** (`scope: authenticated_global`). An "an entity
   changed" broadcast whose payload carries only opaque ids
   (`{entity_type, id}`) — no status or sensitive data — so a list view can learn
   that an entity of a type it renders changed and re-fetch just the affected rows
   through the authorized API. Each client filters by `entity_type` and id.
2. **`task.status`** (`scope: principal` or `tab`). A targeted `{task_id, status}`
   message. It is published on a task's **terminal** completion (SUCCESS, FAILURE,
   ABORTED, TIMED_OUT), not on every intermediate transition — the chart-data
   client only needs to learn a task finished; intermediate progress for list
   views rides the `entity.changed` broadcast instead. Keys are principal-grain by
   default (reaching all of a principal's tabs) but a task type may narrow them to
   a per-tab channel (async chart-data does this), so only the tab watching a task
   is notified. A socket is bound to its per-tab channel only when the browser
   advertises a `tab_id` on the connect URL (see Connection); it is always also
   reachable on its principal channel.

The server forwards each browser message as `{topic, payload}` — the browser
dispatches on `topic` and never sees the route it arrived by. The server treats
each routing key as opaque; the producer is responsible for their correctness and
validates every policy-supplied key against the task's own subscriber principals
before publishing, so a key can never target another principal.

### Connection

The browser connects through the read gateway. The gateway strips cookies and
any client-sent `Authorization` header, and stamps
`Authorization: Bearer <token>`: a delegated token for the `dashboards` service
that names one person in one tenant and lasts at most 20 minutes. The bearer is
read from the `authorization` header only (scheme `Bearer`, any case); there is
no cookie or query-string fallback, and a request without one is dropped.

The server learns who the caller is only by introspecting that token with the
control plane: `POST <INTROSPECT_URL>` with
`{"token": "<token>", "service": "dashboards"}`, a 5 second timeout and no
redirects. The answer gives `tenant_id`, `org_user_id` and `expires_at`.

- A `404` answer, a tenant that does not match `^[a-z0-9]{2,63}$`, a person
  that does not match `^[A-Za-z0-9_-]{1,128}$`, or an `expires_at` already in
  the past refuses the token. Because a browser cannot read the status of a
  failed upgrade, the server completes the handshake and closes at once with
  code `4401`.
- Any other failure (another status, a network error or timeout, a malformed
  answer) answers the upgrade with `503`, and the client backs off.

The token is held in memory only and is never logged; logs name the tenant and
person at most.

An accepted socket is bound to its person channel, `t:<tenant>:p:<person>`. A
person may have several sockets (one per tab). When a browser also advertises
a `tab_id` on the connect URL (`wss://…/?tab_id=<id>`), its socket is
additionally bound to `<channel>:<tab_id>`.

Each socket's identity stays checked while it is open:

- a per-socket timer closes it with `4401` exactly at `expires_at`;
- it is introspected again every `introspectIntervalMs` (default 60 s, first
  check at a random offset so a replica's sockets do not all call at once). A
  refusal closes it with `4401`; an unavailable control plane closes it with
  `1013` so the client backs off and reconnects.

On `SIGTERM` the server stops admitting upgrades (one still waiting on
introspection answers `503`), closes every socket with `1012` so clients
reconnect promptly, and exits a second later.

The service is stateless apart from process-local live socket handles. Each
replica subscribes to the same Pub/Sub channel, receives the same events, and
forwards only to matching sockets connected to that replica. Sticky sessions
are not required; a client that reconnects to another replica presents a fresh
token and is bound to the same person channel. A one-shot catch-up fetch on
reconnect reconciles any events missed while disconnected. There is no
recurring poll while the socket is connected.

### Connection Management

The server uses standard WebSocket
[ping/pong](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers#pings_and_pongs_the_heartbeat_of_websockets)
to detect dead connections. Active sockets are pinged regularly (config:
`pingSocketsIntervalMs`) and the internal registry records the last _pong_
timestamp; a socket that has not responded within `socketResponseTimeoutMs` is
terminated. The sweep also terminates a socket whose token has expired (the
per-socket timer above normally closes it first). The
channel registry is periodically cleaned
(`gcChannelsIntervalMs`) to release stale references.

## Install

Install dependencies:

```bash
npm ci
```

## WebSocket Server Configuration

Copy `config.example.json` to `config.json` and adjust the values for your environment.

Configuration via environment variables is also supported which can be helpful in certain contexts, e.g., deployment. `src/config.ts` can be consulted to see the full list of supported values.

### Restricting WebSocket origins

To mitigate Cross-Site WebSocket Hijacking, set `allowedOrigins` (or the
`ALLOWED_ORIGINS` environment variable, comma-separated) to the list of origins
permitted to open WebSocket connections, e.g. the origin Superset is served
from:

```json
{
  "allowedOrigins": ["https://superset.example.com"]
}
```

The `Origin` header of each upgrade request must exactly match one of the
configured values. When `allowedOrigins` is empty (the default) the check is
skipped and any origin is accepted; a single `"*"` entry explicitly allows any
origin. Set it to the gateway's origin in production.

### Production hardening checklist

Because the websocket is now a shared realtime transport and ships in the main
image, review these before exposing it publicly:

- **`ALLOWED_ORIGINS`** — set it to your Superset origin(s) (see above). The
  default (empty) accepts any origin.
- **Reachable only from the gateway** — identity comes from the bearer token
  the gateway stamps; nothing else may reach this service's port.
- **Connection caps** — on by default (see the table below). Over the total or
  per-person cap the handshake completes and the socket closes with `1013`. A
  socket whose next send would push its outbound buffer past
  `maxSocketBufferBytes` is terminated: a tab that stops reading is cut rather
  than growing the server's memory.
- **Keepalive/timeouts** — `pingSocketsIntervalMs` / `socketResponseTimeoutMs`
  govern dead-connection reaping; the defaults are sane, tune per environment.

### Identity and limits

| Setting                    | Environment variable          | Default  | Notes |
| -------------------------- | ----------------------------- | -------- | ----- |
| `introspectUrl`            | `INTROSPECT_URL`              | (none)   | Full URL of the control plane's token introspection endpoint. Required: the server exits at start-up without it. |
| `introspectIntervalMs`     | `INTROSPECT_INTERVAL_MS`      | `60000`  | Re-introspection interval per socket; values below `5000` are raised to `5000`. |
| `maxSocketsPerPerson`      | `MAX_SOCKETS_PER_PERSON`      | `20`     | Open sockets per person on one replica; `0` disables. |
| `maxTotalConnections`      | `MAX_TOTAL_CONNECTIONS`       | `10000`  | Open sockets per replica; `0` disables. |
| `maxSocketBufferBytes`     | `MAX_SOCKET_BUFFER_BYTES`     | `1048576`| Outbound buffer cap per socket; `0` disables. |
| `maxConnectionsPerChannel` | `MAX_CONNECTIONS_PER_CHANNEL` | `0`      | Upstream per-channel cap; off by default. |

## Superset Configuration

Enable realtime push in the Superset Flask app (in `superset_config.py`):

```python
WEBSOCKET_ENABLE = True
WEBSOCKET_URL = "<the gateway path that routes to this server>"
```

`WEBSOCKET_URL` points at the gateway route, not at this server directly: the
gateway stamps the bearer token this server introspects.

The following value must be coordinated between the Flask app config and
this server's `config.json` (or its environment-variable overrides):

| Purpose                     | Flask app config            | WebSocket server config                     |
| --------------------------- | --------------------------- | ------------------------------------------- |
| Realtime channel prefix     | `REALTIME_CHANNEL_PREFIX`   | `realtimeChannelPrefix` / `REALTIME_CHANNEL_PREFIX` |

The Redis connection (`redis` / `REDIS_*`) must point at the same Redis instance
Superset publishes to (`DISTRIBUTED_COORDINATION_CONFIG`). The channel the server
**subscribes** to is `<REALTIME_CHANNEL_PREFIX>realtime` — the prefix is empty by
default (channel `realtime`), and the resulting name is a wire-protocol contract
with the backend producer, so the prefix **must be set identically** on both
sides (`REALTIME_CHANNEL_PREFIX` in Superset and `REALTIME_CHANNEL_PREFIX` /
`realtimeChannelPrefix` here). The server forwards each envelope to browsers as
`{topic, payload}`. A Redis ACL for this server must therefore allow subscribing
to the **resulting** channel — `realtime` by default, or e.g. `tenant-a:realtime`
when `REALTIME_CHANNEL_PREFIX=tenant-a:`. Set a per-deployment prefix to keep
deployments that share one Redis/Valkey from cross-delivering realtime nudges
(Redis pub/sub is not scoped by DB number).

### Redis / Valkey connection modes

The `redis` object (or the `REDIS_*` environment variables) supports the same
modes as the Python coordination backend: a standalone server, or Redis/Sentinel,
each optionally over TLS. Redis Cluster is not supported by either side.

| Setting                          | Environment variable       | Notes                                                                 |
| -------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| `host`, `port`, `db`             | `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB` | Standalone server (ignored in Sentinel mode)               |
| `username`, `password`           | `REDIS_USERNAME`, `REDIS_PASSWORD`     | Authenticate against the (resolved) master                 |
| `ssl`                            | `REDIS_SSL`                | Enable TLS to the server                                              |
| `sslCaCerts`                     | `REDIS_SSL_CA_CERTS`       | Path to a PEM CA bundle, trusted **in addition to** the public CAs    |
| `sslCertfile`, `sslKeyfile`      | `REDIS_SSL_CERTFILE`, `REDIS_SSL_KEYFILE` | Client certificate and key (mutual TLS)             |
| `sslCertReqs`                    | `REDIS_SSL_CERT_REQS`      | `required` (default), `optional` or `none`; only `none` skips verification |
| `validateHostname`               | `REDIS_VALIDATE_HOSTNAME`  | Check the server certificate's hostname (default `true`)              |
| `sentinels`                      | `REDIS_SENTINELS`          | Enables Sentinel mode. JSON: `[{"host": "s1", "port": 26379}]`; env: `s1:26379,s2:26379` |
| `sentinelMaster`                 | `REDIS_SENTINEL_MASTER`    | Master name; required when `sentinels` is set                         |
| `sentinelPassword`               | `REDIS_SENTINEL_PASSWORD`  | Password for the sentinel nodes themselves                            |

With no `sslCaCerts`, the server certificate is validated against the public CA
roots bundled with Node, so a certificate from a public CA works with just
`ssl: true`. In Sentinel mode TLS applies to the resolved master; the sentinel
nodes are contacted in plaintext, matching the Python backend. The server follows
failovers by re-resolving the master through the sentinels.

## StatsD monitoring

The application is tracking a couple of metrics with `statsd` using the [hot-shots](https://www.npmjs.com/package/hot-shots) library, such as the number of connected clients and the number of failed attempts to send a message to a client.

`statsd` can be configured with the `statsd` object in the configuration file. See the [hot-shots](https://www.npmjs.com/package/hot-shots) readme for more info. The default configuration is:

```json
{
  "statsd": {
    "host": "127.0.0.1",
    "port": 8125,
    "globalTags": []
  }
}
```

## Running

Running locally via dev server:

```bash
npm run dev-server
```

Running in production:

```bash
npm run build && npm start
```

### From the official Superset image (recommended)

The WebSocket server is bundled in the official Superset image and launched via
an alternate entrypoint, so no separate image is required:

```bash
docker run --rm -p 8080:8080 \
  -e INTROSPECT_URL="<control plane introspection URL>" \
  -e REDIS_HOST=<redis-host> \
  apache/superset:<tag> /app/docker/entrypoints/run-websocket.sh
```

Configure it with the same environment variables as the standalone server (see
`src/config.ts`); `INTROSPECT_URL` is required, and the Redis connection must
point at the same instance as `DISTRIBUTED_COORDINATION_CONFIG`.

With `docker compose`, start it via the opt-in `websocket` profile:

```bash
docker compose --profile websocket up superset-websocket
```

## Health check

The WebSocket server supports liveness checks via one of:

```text
GET /health
```

OR

```text
HEAD /health
```

`/health` is a pure liveness probe: it returns `200` whenever the process is up,
so a transient Redis blip does not churn pods.

For load-balancer draining, use the **readiness** endpoint instead:

```text
GET /ready
```

`/ready` returns `200` only while the server's Redis Pub/Sub subscriber is
connected and subscribed, and `503` when that subscriber has dropped (the server
can't deliver messages until it reconnects). Wire connection draining to `/ready`,
not `/health`, so a degraded pod stops receiving new connections while it recovers.

## Containerization

The server ships in the official Superset image (launched via
`/app/docker/entrypoints/run-websocket.sh`, see "Running" above). A standalone
`Dockerfile` is also provided in this directory for building the server on its
own during development.
