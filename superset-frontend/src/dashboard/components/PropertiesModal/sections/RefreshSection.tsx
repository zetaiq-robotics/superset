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
 * Modified by ZetaIQ: the dashboard's minimum interval, and each chart's own
 * rate (follow the dashboard, slower, or never) under the frequency.
 */
import { useSelector } from 'react-redux';
import { t } from '@apache-superset/core/translation';
import { css } from '@apache-superset/core/theme';
import { Select } from '@superset-ui/core/components';
import { ModalFormField } from 'src/components/Modal';
import { RootState } from 'src/dashboard/types';
import { RefreshFrequencySelect } from '../../RefreshFrequency/RefreshFrequencySelect';

/** A chart's own rate: 0 follows the dashboard, NEVER stays out of timed refresh. */
export const NEVER = -1;
const RATES = [
  { value: 0, label: t('Follow the dashboard') },
  { value: 60, label: t('Every 1 minute') },
  { value: 300, label: t('Every 5 minutes') },
  { value: 900, label: t('Every 15 minutes') },
  { value: NEVER, label: t('Never') },
];

interface RefreshSectionProps {
  refreshFrequency: number;
  onRefreshFrequencyChange: (value: number) => void;
  // Modified by ZetaIQ
  minimum?: number;
  chartRates?: Record<string, number>;
  onChartRateChange?: (chartId: number, rate: number) => void;
}

const RefreshSection = ({
  refreshFrequency,
  onRefreshFrequencyChange,
  minimum = 0,
  chartRates = {},
  onChartRateChange,
}: RefreshSectionProps) => {
  // The charts on this dashboard, by name (none when the modal opens from a list page).
  const charts = useSelector((state: RootState) =>
    Object.keys(state.charts ?? {})
      .map(Number)
      .filter(id => Number.isFinite(id) && id > 0)
      .map(id => ({
        id,
        name:
          state.sliceEntities?.slices?.[id]?.slice_name ?? t('Chart %s', id),
      })),
  );
  return (
    <>
      <ModalFormField
        label={t('Refresh frequency')}
        helperText={
          minimum
            ? t(
                'Set the automatic refresh frequency for this dashboard. The dashboard will reload its data at the specified interval, at most every %s seconds.',
                minimum,
              )
            : t(
                'Set the automatic refresh frequency for this dashboard. The dashboard will reload its data at the specified interval.',
              )
        }
        bottomSpacing={false}
      >
        <RefreshFrequencySelect
          value={refreshFrequency}
          onChange={onRefreshFrequencyChange}
          minimum={minimum}
        />
      </ModalFormField>
      {onChartRateChange && charts.length > 0 && (
        <ModalFormField
          label={t('Each chart')}
          helperText={t(
            'A chart can refresh more slowly than the dashboard, or not at all; between its refreshes it keeps its last data.',
          )}
          bottomSpacing={false}
        >
          <div
            css={css`
              display: grid;
              grid-template-columns: minmax(0, 1fr) 200px;
              gap: 8px 12px;
              align-items: center;
            `}
          >
            {charts.map(chart => (
              <div
                key={chart.id}
                css={css`
                  display: contents;
                `}
              >
                <span
                  css={css`
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                  `}
                  title={chart.name}
                >
                  {chart.name}
                </span>
                <Select
                  ariaLabel={t('Refresh rate of %s', chart.name)}
                  data-test={`chart-refresh-${chart.id}`}
                  value={chartRates[String(chart.id)] ?? 0}
                  options={RATES}
                  onChange={value => onChartRateChange(chart.id, Number(value))}
                />
              </div>
            ))}
          </div>
        </ModalFormField>
      )}
    </>
  );
};

export default RefreshSection;
