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
 * Added by ZetaIQ (variables spec G1).
 */
type Values = { filters?: { col?: unknown }[]; [key: string]: unknown };
type Dataset = { column_names?: string[]; sql?: string | null };
type SliceLike = { form_data?: { datasource?: string } & Record<string, unknown> };

/**
 * The charts in `scope` a native filter's change can affect, like Grafana re-running only the panels
 * that use a variable. A filter that only adds column conditions affects a chart whose dataset has the
 * column, or whose dataset SQL or own form data names it (Jinja filter_values). Anything else re-runs:
 * time, grain or column overrides, adhoc columns, a dataset not loaded yet.
 */
export function chartsUsingFilter(
  scope: number[],
  values: Values = {},
  previous: Values = {},
  slices: Record<string, SliceLike>,
  datasources: Record<string, Dataset>,
): number[] {
  const columnsOnly = (v: Values) =>
    Object.keys(v).every(k => k === 'filters');
  if (!columnsOnly(values) || !columnsOnly(previous)) return scope;
  const cols = [...(values.filters ?? []), ...(previous.filters ?? [])].map(
    f => f.col,
  );
  if (!cols.every(c => typeof c === 'string')) return scope;
  return scope.filter(id => {
    const formData = slices[id]?.form_data;
    const ds = formData?.datasource ? datasources[formData.datasource] : undefined;
    if (!ds?.column_names) return true;
    const text = `${ds.sql ?? ''}\n${JSON.stringify(formData)}`;
    return (cols as string[]).some(
      c => ds.column_names!.includes(c) || text.includes(c),
    );
  });
}
