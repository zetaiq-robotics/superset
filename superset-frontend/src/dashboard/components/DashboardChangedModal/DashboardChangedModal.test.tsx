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
import DashboardChangedModal from '.';

test('prompt shows name and time from the re-fetch', async () => {
  const onDiscard = jest.fn();
  const onKeepEditing = jest.fn();
  render(
    <DashboardChangedModal
      show
      summary={{
        changedBy: 'Priya',
        changedAt: 'Nov 17, 2026 10:00 AM',
        lines: [],
      }}
      onDiscard={onDiscard}
      onKeepEditing={onKeepEditing}
    />,
  );
  expect(await screen.findByText('Dashboard changed')).toBeInTheDocument();
  expect(
    screen.getByText(
      'Priya saved a newer version at Nov 17, 2026 10:00 AM. Your unsaved changes are based on the older one.',
    ),
  ).toBeInTheDocument();

  await userEvent.click(
    screen.getByRole('button', { name: 'Discard my changes' }),
  );
  expect(onDiscard).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(onKeepEditing).toHaveBeenCalledTimes(1);
});

test('without the history read: no name or time, both choices still work', async () => {
  const onDiscard = jest.fn();
  const onKeepEditing = jest.fn();
  render(
    <DashboardChangedModal
      show
      summary={null}
      onDiscard={onDiscard}
      onKeepEditing={onKeepEditing}
    />,
  );
  expect(
    await screen.findByText(
      'Someone saved a newer version. Your unsaved changes are based on the older one.',
    ),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole('button', { name: 'Discard my changes' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(onDiscard).toHaveBeenCalledTimes(1);
  expect(onKeepEditing).toHaveBeenCalledTimes(1);
});

test('hidden when show is false', () => {
  render(
    <DashboardChangedModal
      show={false}
      summary={null}
      onDiscard={jest.fn()}
      onKeepEditing={jest.fn()}
    />,
  );
  expect(screen.queryByText('Dashboard changed')).not.toBeInTheDocument();
});

test('chart changes only: no name, no claim the edits are stale', async () => {
  render(
    <DashboardChangedModal
      show
      chartOnly
      summary={null}
      onDiscard={jest.fn()}
      onKeepEditing={jest.fn()}
    />,
  );
  expect(
    await screen.findByText('A chart on this dashboard was changed.'),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/Your unsaved changes are based/),
  ).not.toBeInTheDocument();
});
