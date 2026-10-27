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
 * Modified by ZetaIQ: an optional label column is fetched beside the value.
 */
import {
  buildQueryContext,
  getColumnLabel,
  isPhysicalColumn,
  QueryObject,
  QueryObjectFilterClause,
  BuildQuery,
} from '@superset-ui/core';
import { GenericDataType } from '@apache-superset/core/common';
import { DEFAULT_FORM_DATA, PluginFilterSelectQueryFormData } from './types';

const buildQuery: BuildQuery<PluginFilterSelectQueryFormData> = (
  formData: PluginFilterSelectQueryFormData,
  options,
) => {
  const { search, coltypeMap } = options?.ownState || {};
  const { sortAscending, sortMetric, labelColumn } = {
    ...DEFAULT_FORM_DATA,
    ...formData,
  };
  return buildQueryContext(formData, baseQueryObject => {
    const { columns: valueColumns = [], filters = [] } = baseQueryObject;
    // Search and sort stay on the value column; the label only rides along.
    const columns =
      labelColumn && !valueColumns.includes(labelColumn)
        ? [...valueColumns, labelColumn]
        : valueColumns;
    const extraFilters: QueryObjectFilterClause[] = [];
    if (search) {
      valueColumns.filter(isPhysicalColumn).forEach(column => {
        const label = getColumnLabel(column);
        if (
          coltypeMap[label] === GenericDataType.String ||
          (coltypeMap[label] === GenericDataType.Numeric &&
            !Number.isNaN(Number(search)))
        ) {
          extraFilters.push({
            col: column,
            op: 'ILIKE',
            val: `%${search}%`,
          });
        }
      });
    }

    const sortColumns = sortMetric ? [sortMetric] : valueColumns;
    // Sorting by the searched column makes the engine scan and sort every
    // match before applying the row limit, which is the dominant cost of
    // search-as-you-type on a high-cardinality column. The dropdown re-sorts
    // the returned page client-side, so the server sort buys nothing here. A
    // sort metric is different: it selects *which* rows come back, so it has
    // to stay.
    const skipOrderBy = !!search && !sortMetric;
    const query: QueryObject[] = [
      {
        ...baseQueryObject,
        columns,
        metrics: sortMetric ? [sortMetric] : [],
        filters: filters.concat(extraFilters),
        orderby:
          !skipOrderBy && (sortMetric || sortAscending !== undefined)
            ? sortColumns.map(column => [column, !!sortAscending])
            : [],
      },
    ];
    return query;
  });
};

export default buildQuery;
