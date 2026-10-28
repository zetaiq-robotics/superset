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
 * Modified by ZetaIQ: tests for the collapsing builder pane.
 */

import { render, screen } from 'spec/helpers/testing-library';
import BuilderComponentPane from '.';

jest.mock('src/dashboard/containers/SliceAdder', () => () => (
  <div data-test="mock-slice-adder" />
));

test('BuilderComponentPane has correct tabs in correct order', () => {
  render(<BuilderComponentPane topOffset={115} />, {
    useRedux: true,
    initialState: {
      dashboardState: {
        nativeFiltersBarOpen: false,
      },
    },
  });
  const tabs = screen.getAllByRole('tab');
  expect(tabs).toHaveLength(2);
  expect(tabs[0]).toHaveTextContent('Charts');
  expect(tabs[1]).toHaveTextContent('Layout elements');
  expect(screen.getByRole('tab', { selected: true })).toHaveTextContent(
    'Charts',
  );
});

// ZetaIQ: the pane collapses so the whole dashboard is visible while editing.
test('an open pane offers to collapse', () => {
  const onToggle = jest.fn();
  render(<BuilderComponentPane topOffset={0} isOpen onToggle={onToggle} />, {
    useRedux: true,
  });
  screen.getByRole('button', { name: 'Collapse panel' }).click();
  expect(onToggle).toHaveBeenCalledTimes(1);
});

test('a collapsed pane shows only an expand button', () => {
  const onToggle = jest.fn();
  render(
    <BuilderComponentPane topOffset={0} isOpen={false} onToggle={onToggle} />,
    { useRedux: true },
  );
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  screen.getByRole('button', { name: 'Expand panel' }).click();
  expect(onToggle).toHaveBeenCalledTimes(1);
});
