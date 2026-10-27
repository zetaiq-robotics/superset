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
 *
 * Added by ZetaIQ (variables spec G8).
 */
import { useSelector } from 'react-redux';
import { t } from '@apache-superset/core/translation';

type Filters = Record<string, { name?: string }>;
type Masks = Record<
  string,
  { filterState?: { value?: unknown; label?: string } } | undefined
>;

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_SHOWN = 5;
const key = (name: string) => name.trim().toLowerCase();

/** Text, never markup: HTML entities first, then Markdown's special characters. */
export const escapeMarkdown = (text: string) =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/[`*_{}[\]()#+!|~]/g, c => `\\${c}`);

function shown(state?: { value?: unknown; label?: string }): string {
  const values = Array.isArray(state?.value) ? state!.value : [];
  if (!values.length) return t('All');
  if (values.length > MAX_SHOWN) {
    return `${values.slice(0, MAX_SHOWN).join(', ')}, … (+${values.length - MAX_SHOWN})`;
  }
  return state?.label || values.join(', ');
}

/**
 * `{{Name}}` becomes the applied value of the native filter named Name (any case), like a Grafana
 * variable in a panel title. Unknown names stay as typed so authors see the mistake.
 */
export function fillFilterPlaceholders(
  text: string,
  filters: Filters,
  dataMask: Masks,
  escape: (s: string) => string = s => s,
): string {
  if (!text || !text.includes('{{')) return text;
  const byName = new Map(
    Object.entries(filters).map(([id, f]) => [key(f?.name ?? ''), id]),
  );
  return text.replace(PLACEHOLDER, (match, name: string) => {
    const id = byName.get(key(name));
    return id ? escape(shown(dataMask[id]?.filterState)) : match;
  });
}

export function useFilterPlaceholders(text: string, markdown = false): string {
  const filters = useSelector<any, Filters>(
    state => state.nativeFilters?.filters ?? {},
  );
  const dataMask = useSelector<any, Masks>(state => state.dataMask ?? {});
  return fillFilterPlaceholders(
    text,
    filters,
    dataMask,
    markdown ? escapeMarkdown : undefined,
  );
}
