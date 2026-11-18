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

/**
 * The versions a tab knows of. `base` is the version its copy (and any
 * unsaved edits) started from, and is what `If-Match` carries; `latest` is
 * the newest version it has heard of. Versions are opaque tokens.
 */
export type Versions = { base: string | null; latest: string | null };

export const NO_VERSIONS: Versions = { base: null, latest: null };

/** The version token in an ETag: `W/"<token>:<access>:zstd"` -> `<token>`. */
export function versionOf(etag: string | null): string | null {
  if (!etag) return null;
  return etag.replace(/^W\//, '').replace(/"/g, '').split(':')[0] || null;
}

/**
 * After a write by this tab: adopt the new version only when the write
 * replaced the tab's base. A tab that is behind someone else's save keeps
 * its base, so its next full save is still refused.
 */
export function adoptAfterOwnWrite(
  v: Versions,
  replaced: string | null,
  created: string | null,
): Versions {
  if (replaced === v.base) return { base: created, latest: created };
  return { base: v.base, latest: created ?? v.latest };
}

/** Someone else saved: remember it without moving the base. */
export function noteNewer(v: Versions, etag: string): Versions {
  return { base: v.base, latest: versionOf(etag) };
}

/** The `If-Match` header for a full save; none when there is no base. */
export function ifMatch(
  base: string | null | undefined,
): Record<string, string> {
  return base ? { 'If-Match': `"${base}"` } : {};
}

let ownWrites = 0;
const settledListeners = new Set<() => void>();

/** Writes by this tab in flight; live events are held while above 0. */
export const ownWritesInFlight = (): number => ownWrites;

/**
 * Count `write` (a dashboard write by this tab) as in flight until it
 * settles. The count drops a macrotask later, so the caller's
 * `adoptOwnWrite`, chained on the same promise, has landed by then.
 */
export function trackOwnWrite<T>(write: Promise<T>): Promise<T> {
  ownWrites += 1;
  const settle = () =>
    setTimeout(() => {
      ownWrites -= 1;
      if (ownWrites === 0) settledListeners.forEach(listener => listener());
    }, 0);
  write.then(settle, settle);
  return write;
}

/** Called each time the last in-flight own write settles. */
export function subscribeOwnWritesSettled(listener: () => void): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}
