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
import { render, screen, userEvent } from 'spec/helpers/testing-library';
import RefreshSection, { NEVER } from './RefreshSection';

const state = {
  charts: { 11: {}, 12: {} },
  sliceEntities: {
    slices: { 11: { slice_name: 'CPU' }, 12: { slice_name: 'Memory' } },
  },
};

test('each chart on the dashboard gets its own rate, shown from the saved rates', () => {
  render(
    <RefreshSection
      refreshFrequency={30}
      onRefreshFrequencyChange={jest.fn()}
      chartRates={{ 12: NEVER }}
      onChartRateChange={jest.fn()}
    />,
    { useRedux: true, initialState: state },
  );
  expect(screen.getByText('CPU')).toBeInTheDocument();
  expect(screen.getByTestId('chart-refresh-11')).toHaveTextContent(
    'Follow the dashboard',
  );
  expect(screen.getByTestId('chart-refresh-12')).toHaveTextContent('Never');
});

test('picking a slower rate reports the chart and its seconds', async () => {
  const onChartRateChange = jest.fn();
  render(
    <RefreshSection
      refreshFrequency={30}
      onRefreshFrequencyChange={jest.fn()}
      onChartRateChange={onChartRateChange}
    />,
    { useRedux: true, initialState: state },
  );
  await userEvent.click(
    screen.getByRole('combobox', { name: 'Refresh rate of CPU' }),
  );
  await userEvent.click(await screen.findByText('Every 5 minutes'));
  expect(onChartRateChange).toHaveBeenCalledWith(11, 300);
});

test('the dashboard minimum hides faster intervals; no chart list outside a dashboard', () => {
  render(
    <RefreshSection
      refreshFrequency={0}
      onRefreshFrequencyChange={jest.fn()}
      minimum={30}
    />,
    {
      useRedux: true,
      initialState: { charts: {} },
    },
  );
  expect(
    screen.queryByRole('radio', { name: '10 seconds' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: '30 seconds' })).toBeInTheDocument();
  expect(screen.queryByText('Each chart')).not.toBeInTheDocument();
});
