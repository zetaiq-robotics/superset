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
import { t, tn } from '@apache-superset/core/translation';
import { SupersetClient } from '@superset-ui/core';
import { extendedDayjs } from '@superset-ui/core/utils/dates';

/** One item of `GET /api/v1/{dashboard,chart}/<uuid>/versions/`. */
export type VersionEntry = {
  version_uuid: string;
  issued_at?: string;
  operation_type?: string;
  changed_by?: { first_name?: string } | null;
  changes?: {
    path: (string | number)[];
    operation?: string;
    from_value?: unknown;
    to_value?: unknown;
  }[];
};

/** What the stale-save modal shows; null when the history could not be read. */
export type StaleSummary = {
  changedBy: string;
  changedAt: string;
  lines: string[];
} | null;

/** A full save refused with 412; `summary` is what changed since the base. */
export class StaleSaveError extends Error {
  constructor(public summary: StaleSummary) {
    super('stale save');
  }
}

// a function, so translations are looked up when used, not at import
const labelsByKey = (): Record<string, string> => ({
  dashboard_title: t('title'),
  slice_name: t('title'),
  description: t('description'),
  css: t('CSS'),
  slug: t('URL'),
  position_json: t('layout'),
  label_colors: t('colours'),
  color_scheme: t('colours'),
  published: t('published state'),
  params: t('chart settings'),
  query_context: t('chart settings'),
  datasource_id: t('dataset'),
});
const FILTERS = 'native_filter_configuration';
const LAYOUT_ID = /^(CHART|ROW|COLUMN|TABS?|HEADER|MARKDOWN|DIVIDER)-/;

const authorOf = (v: VersionEntry) => v.changed_by?.first_name || t('Someone');

// Oldest first, as the endpoint lists them. A base the history does not list
// (an entity that had no version rows when the tab loaded) predates them all,
// so the baseline row (the state before the first save, no changes) is in
// range too: versions that changed nothing are no one's save to report.
const newerThan = (versions: VersionEntry[], since?: string | null) =>
  versions
    .slice(versions.findIndex(v => v.version_uuid === since) + 1)
    .filter(v => v.operation_type !== 'baseline' && v.changes?.length);

const filterIds = (value: unknown): Map<unknown, string> =>
  new Map(
    (Array.isArray(value) ? value : []).map(f => [f?.id, JSON.stringify(f)]),
  );

/**
 * "Priya changed: title, 1 filter", one line per author, over the versions
 * newer than `since`. Only kinds of change are named, never values.
 */
export function summariseChanges(
  versions: VersionEntry[],
  since?: string | null,
): string[] {
  const known = labelsByKey();
  const byAuthor = new Map<
    string,
    { labels: Set<string>; filters: Set<unknown> }
  >();
  newerThan(versions, since).forEach(v => {
    const name = authorOf(v);
    const entry = byAuthor.get(name) ?? {
      labels: new Set(),
      filters: new Set(),
    };
    byAuthor.set(name, entry);
    (v.changes ?? []).forEach((change, i) => {
      const [first, second] = change.path.map(String);
      const key = first === 'json_metadata' ? second : first;
      if (key === FILTERS) {
        entry.labels.add(FILTERS);
        const from = filterIds(change.from_value);
        const to = filterIds(change.to_value);
        if (!from.size && !to.size) {
          entry.filters.add(change.path[2] ?? `${v.version_uuid}:${i}`);
        }
        new Set([...from.keys(), ...to.keys()]).forEach(id => {
          if (from.get(id) !== to.get(id)) entry.filters.add(id);
        });
      } else if (LAYOUT_ID.test(first)) {
        entry.labels.add(known.position_json);
      } else {
        entry.labels.add(known[key] ?? t('other settings'));
      }
    });
  });
  return [...byAuthor].map(([name, { labels, filters }]) =>
    t(
      '%s changed: %s',
      name,
      [...labels]
        .map(label =>
          label === FILTERS
            ? tn('%s filter', '%s filters', filters.size, filters.size)
            : label,
        )
        .join(', '),
    ),
  );
}

const localTime = (utc?: string | null) =>
  extendedDayjs.utc(utc).local().format('lll');

/**
 * After a 412: read the entity's history once and summarise what changed
 * since `since`. When the history cannot be read (or lists nothing newer),
 * `lastSave` supplies the first line alone; null when that fails too.
 */
export async function loadStaleSummary(
  resource: 'dashboard' | 'chart',
  uuid: string | null | undefined,
  since: string | null | undefined,
  lastSave: () => Promise<StaleSummary>,
): Promise<StaleSummary> {
  try {
    if (uuid) {
      const { json } = await SupersetClient.get({
        endpoint: `/api/v1/${resource}/${uuid}/versions/`,
      });
      const versions: VersionEntry[] = json?.result ?? [];
      const last = newerThan(versions, since).pop();
      if (last) {
        return {
          changedBy: authorOf(last),
          changedAt: localTime(last.issued_at),
          lines: summariseChanges(versions, since),
        };
      }
    }
  } catch {
    // fall back to the entity's own "changed by / on" fields
  }
  return lastSave().catch(() => null);
}

/** The first line alone, from an entity's own "changed by / on" fields. */
export const firstLineOnly = (
  name: string | null | undefined,
  utc: string | null | undefined,
): StaleSummary =>
  name ? { changedBy: name, changedAt: localTime(utc), lines: [] } : null;

/** Who saved the dashboard last, from its own GET. */
export async function dashboardLastSave(id: number): Promise<StaleSummary> {
  const { json } = await SupersetClient.get({
    endpoint: `/api/v1/dashboard/${id}`,
  });
  return firstLineOnly(json?.result?.changed_by_name, json?.result?.changed_on);
}

/**
 * The ETag the entity is served with now; read just before an overwrite.
 * Rejects when there is none: an overwrite must never fall back to an
 * unconditional PUT.
 */
export async function fetchEtag(endpoint: string): Promise<string> {
  const { response } = await SupersetClient.get({ endpoint });
  const etag = response?.headers?.get('ETag');
  if (!etag) throw new Error(t('Could not read the current version.'));
  return etag;
}
