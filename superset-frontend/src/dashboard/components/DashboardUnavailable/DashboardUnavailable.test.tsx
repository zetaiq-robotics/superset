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
import DashboardUnavailable from '.';

test.each([
  [
    'deleted',
    'This dashboard was deleted.',
    'Someone who manages it can restore it from the archive.',
  ],
  [
    'access',
    'You no longer have access to this dashboard.',
    'Ask its owner to share it with you again.',
  ],
  [
    undefined,
    'This dashboard is no longer available to you.',
    'It may have been deleted or no longer shared with you.',
  ],
] as const)('reason %s says why', (reason, heading, line) => {
  render(<DashboardUnavailable reason={reason} />, { useRouter: true });
  expect(screen.getByText(heading)).toBeInTheDocument();
  expect(screen.getByText(line)).toBeInTheDocument();
});

test('"Back to dashboards" goes to the dashboard list inside the app', async () => {
  render(<DashboardUnavailable reason="deleted" />, { useRouter: true });
  await userEvent.click(
    screen.getByRole('button', { name: 'Back to dashboards' }),
  );
  expect(window.location.pathname).toBe('/dashboard/list/');
});
