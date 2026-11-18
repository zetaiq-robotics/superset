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
import NewerVersionBadge from '.';

test('one save: the plain badge, a button that offers the choices', async () => {
  const onClick = jest.fn();
  render(<NewerVersionBadge count={1} names={['Priya']} onClick={onClick} />);
  await userEvent.click(
    screen.getByRole('button', { name: 'Newer version available' }),
  );
  expect(onClick).toHaveBeenCalledTimes(1);
});

test('more saves: counted, with each author named once', () => {
  render(
    <NewerVersionBadge
      count={3}
      names={['Priya', 'Ana']}
      onClick={jest.fn()}
    />,
  );
  expect(
    screen.getByRole('button', {
      name: 'Newer version available (3 saves by Priya and Ana)',
    }),
  ).toBeInTheDocument();
});

test('nothing newer: no badge', () => {
  render(<NewerVersionBadge count={0} names={[]} onClick={jest.fn()} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('chart changes only: says so, without naming anyone', async () => {
  render(
    <NewerVersionBadge count={2} names={[]} chartOnly onClick={jest.fn()} />,
  );
  const badge = screen.getByRole('button', {
    name: 'Newer version available',
  });
  await userEvent.hover(badge);
  expect(
    await screen.findByText('A chart on this dashboard was changed.'),
  ).toBeInTheDocument();
});
