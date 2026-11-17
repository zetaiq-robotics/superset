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
import fetchMock from 'fetch-mock';
import {
  act,
  createStore,
  render,
  screen,
  userEvent,
  waitFor,
} from 'spec/helpers/testing-library';
import reducerIndex from 'spec/helpers/reducerIndex';
import mockDashboardData from 'spec/fixtures/mockDashboardData';
import { saveDashboardRequest } from 'src/dashboard/actions/dashboardState';
import { SAVE_TYPE_OVERWRITE } from 'src/dashboard/util/constants';
import { navigateTo } from 'src/utils/navigationUtils';
import { armUnsavedChangesPrompt } from 'src/dashboard/util/unsavedChangesPrompt';
import DashboardStaleSave, { StaleSaveModal } from '.';

jest.mock('src/utils/navigationUtils', () => ({
  ...jest.requireActual('src/utils/navigationUtils'),
  navigateTo: jest.fn(),
  navigateWithState: jest.fn(),
}));

const TITLE = 'This dashboard was changed after you opened it';

const entry = (uuid: string, name: string, path: string[]) => ({
  version_uuid: uuid,
  issued_at: '2026-11-17T10:00:00',
  changed_by: { first_name: name },
  changes: [{ path, operation: 'edit' }],
});

type Server = {
  putStatuses: number[];
  versions: (() => unknown[]) | 'fail';
  etag?: string;
  entityFails?: boolean;
};

// PUT /dashboard/1 answers putStatuses in order (200 after); the history and
// the dashboard GET answer as configured. Returns the request log.
function server({
  putStatuses,
  versions,
  etag = '"c:access"',
  entityFails = false,
}: Server) {
  const log: { method: string; url: string; ifMatch: string | null }[] = [];
  const note = (method: string) => (call: any) => {
    log.push({
      method,
      url: call.url,
      ifMatch: new Headers(call.options.headers).get('If-Match'),
    });
  };
  let puts = 0;
  fetchMock.put('glob:*/api/v1/dashboard/1', (call: any) => {
    note('PUT')(call);
    const status = putStatuses[puts] ?? 200;
    puts += 1;
    return status === 200
      ? {
          result: mockDashboardData,
          old_version_uuid: 'c',
          new_version_uuid: 'n',
        }
      : { status, body: { message: 'stale' }, headers: { ETag: '"z"' } };
  });
  fetchMock.get('glob:*/api/v1/dashboard/dash-uuid/versions/', (call: any) => {
    note('GET')(call);
    return versions === 'fail'
      ? { status: 500, body: { message: 'boom' } }
      : { result: versions() };
  });
  fetchMock.get('glob:*/api/v1/dashboard/1', (call: any) => {
    note('GET')(call);
    if (entityFails) return { status: 500, body: { message: 'boom' } };
    return {
      body: {
        result: {
          id: 1,
          changed_by_name: 'Priya Rao',
          changed_on: '2026-11-17T09:30:00',
        },
      },
      headers: { ETag: etag },
    };
  });
  fetchMock.get('glob:*/api/v1/dashboard/1/datasets', { result: [] });
  fetchMock.post('glob:*/api/v1/dashboard/1/copy/', (call: any) => {
    note('POST')(call);
    return { result: { id: 2, last_modified_time: 1 } };
  });
  return log;
}

function setup() {
  const store = createStore(
    {
      dashboardInfo: {
        id: 1,
        uuid: 'dash-uuid',
        dashboard_title: 'Sales',
        metadata: {},
        versions: { base: 'a', latest: 'a' },
      },
      dashboardState: { sliceIds: [], hasUnsavedChanges: true },
      dashboardFilters: {},
      dashboardLayout: {
        past: [],
        present: mockDashboardData.positions,
        future: [],
      },
      charts: {},
    },
    reducerIndex,
  );
  render(<DashboardStaleSave />, { store });
  const save = () =>
    act(async () => {
      await store.dispatch(
        saveDashboardRequest(
          { ...mockDashboardData, dashboard_title: 'Sales' },
          1,
          SAVE_TYPE_OVERWRITE,
        ) as any,
      );
    });
  return { store, save };
}

afterEach(() => {
  fetchMock.clearHistory().removeRoutes();
  jest.clearAllMocks();
});

test('renders the first line and the summary lines', () => {
  render(
    <StaleSaveModal
      title={TITLE}
      summary={{
        changedBy: 'Priya',
        changedAt: 'Nov 17, 2026 10:00 AM',
        lines: ['Priya changed: title, 1 filter', 'Ana changed: layout'],
      }}
      onDiscard={jest.fn()}
      onCopy={jest.fn()}
      onOverwrite={jest.fn()}
      onHide={jest.fn()}
    />,
  );

  expect(screen.getByText(TITLE)).toBeInTheDocument();
  expect(
    screen.getByText('Changed by Priya at Nov 17, 2026 10:00 AM.'),
  ).toBeInTheDocument();
  expect(
    screen.getByText('Priya changed: title, 1 filter'),
  ).toBeInTheDocument();
  expect(screen.getByText('Ana changed: layout')).toBeInTheDocument();
});

test('a refused save opens the modal with what changed since the base', async () => {
  const log = server({
    putStatuses: [412],
    versions: () => [
      entry('a', 'Lee', ['css']),
      entry('c', 'Priya', ['dashboard_title']),
    ],
  });
  const { save } = setup();

  await save();

  expect(await screen.findByText(TITLE)).toBeInTheDocument();
  expect(screen.getByText('Priya changed: title')).toBeInTheDocument();
  expect(screen.getByText(/^Changed by Priya at /)).toBeInTheDocument();
  // the history is read once, only after the 412
  expect(log.map(c => c.method)).toEqual(['PUT', 'GET']);
});

const failedHistory = () => server({ putStatuses: [412], versions: 'fail' });

test('when the history cannot be read the first line comes from the dashboard GET', async () => {
  const log = failedHistory();
  const { save } = setup();

  await save();

  expect(await screen.findByText(TITLE)).toBeInTheDocument();
  expect(screen.getByText(/^Changed by Priya Rao at /)).toBeInTheDocument();
  expect(screen.queryByText(/changed:/)).not.toBeInTheDocument();
  expect(log.map(c => c.url.replace(/^.*\/api\/v1/, ''))).toEqual([
    '/dashboard/1',
    '/dashboard/dash-uuid/versions/',
    '/dashboard/1',
  ]);
});

test('when neither can be read only the title and the buttons show', async () => {
  server({ putStatuses: [412], versions: 'fail', entityFails: true });
  const { save } = setup();

  await save();

  expect(await screen.findByText(TITLE)).toBeInTheDocument();
  expect(screen.queryByText(/^Changed by/)).not.toBeInTheDocument();
  [
    'Discard my changes and reload',
    'Save as a copy',
    'Overwrite their changes',
  ].forEach(name => expect(screen.getByRole('button', { name })).toBeEnabled());
});

test('an Overwrite that fails leaves the base, so the next Save is still refused', async () => {
  const log = server({ putStatuses: [412, 500, 412], versions: 'fail' });
  const { save, store } = setup();

  await save();
  userEvent.click(
    await screen.findByRole('button', { name: 'Overwrite their changes' }),
  );
  await waitFor(() =>
    expect(log.filter(c => c.method === 'PUT')).toHaveLength(2),
  );
  await waitFor(() =>
    expect(store.getState().dashboardState.dashboardIsSaving).toBe(false),
  );

  // the fresh token was only that retry's If-Match; it is remembered as latest
  expect(store.getState().dashboardInfo.versions).toEqual({
    base: 'a',
    latest: 'c',
  });
  await save();
  expect(log.filter(c => c.method === 'PUT').map(c => c.ifMatch)).toEqual([
    '"a"',
    '"c"',
    '"a"',
  ]);
});

// A pending "Leave site?" prompt: dispatch the event the browser would.
const leavePromptArmed = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

test('without the history, Discard reloads the dashboard out of edit mode', async () => {
  failedHistory();
  const { save, store } = setup();
  const original = window.location;
  // the dashboard armed it for the unsaved edits being discarded
  armUnsavedChangesPrompt(true);
  let armedAtReload: boolean | undefined;
  const assign = jest.fn(() => {
    armedAtReload = leavePromptArmed();
  });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/superset/dashboard/1/?edit=true', assign },
  });

  await save();
  userEvent.click(
    await screen.findByRole('button', {
      name: 'Discard my changes and reload',
    }),
  );

  expect(assign).toHaveBeenCalledTimes(1);
  expect(String(assign.mock.calls[0][0])).toBe(
    'http://localhost/superset/dashboard/1/',
  );
  // the person chose to discard: no "Leave site?" asking again
  expect(armedAtReload).toBe(false);
  expect(store.getState().dashboardState.hasUnsavedChanges).toBe(false);
  armUnsavedChangesPrompt(false);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: original,
  });
});

test('without the history, Save as a copy uses save-as; the copy is a Draft', async () => {
  const log = failedHistory();
  const { save } = setup();

  await save();
  userEvent.click(
    await screen.findByRole('button', { name: 'Save as a copy' }),
  );

  await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/dashboard/2/'));
  const copy = fetchMock.callHistory.lastCall(
    'glob:*/api/v1/dashboard/1/copy/',
  );
  const body = JSON.parse(copy!.options.body as string);
  expect(body.dashboard_title).toBe('Sales [copy]');
  // the copy endpoint takes no `published` (sending one is a 400): the
  // server creates every copy unpublished, Dashboard.published default False
  expect(body).not.toHaveProperty('published');
  expect(log.filter(c => c.method === 'POST')).toHaveLength(1);
  await waitFor(() =>
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument(),
  );
  // the original is left alone: only the refused save ever PUT it
  expect(log.filter(c => c.method === 'PUT')).toHaveLength(1);
});

test('without the history, Overwrite re-reads the version and resends', async () => {
  const log = failedHistory();
  const { save, store } = setup();

  await save();
  userEvent.click(
    await screen.findByRole('button', { name: 'Overwrite their changes' }),
  );

  await waitFor(() =>
    expect(store.getState().dashboardInfo.versions).toEqual({
      base: 'n',
      latest: 'n',
    }),
  );
  expect(log.map(c => `${c.method} ${c.ifMatch}`)).toEqual([
    'PUT "a"',
    'GET null', // the history (fails)
    'GET null', // the dashboard, for who saved last
    'GET null', // the current version
    'PUT "c"',
  ]);
  await waitFor(() =>
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument(),
  );
});

test('Overwrite: a third save in between re-opens the modal with the newer summary', async () => {
  let history = [entry('a', 'Lee', ['css']), entry('c', 'Priya', ['slug'])];
  const log = server({ putStatuses: [412, 412], versions: () => history });
  const { save } = setup();

  await save();
  expect(await screen.findByText('Priya changed: URL')).toBeInTheDocument();

  history = [...history, entry('d', 'Ana', ['CHART-x'])];
  userEvent.click(
    screen.getByRole('button', { name: 'Overwrite their changes' }),
  );

  // the base did not move, so the summary covers every save since it
  expect(await screen.findByText('Ana changed: layout')).toBeInTheDocument();
  expect(screen.getByText('Priya changed: URL')).toBeInTheDocument();
  expect(screen.getByText(/^Changed by Ana at /)).toBeInTheDocument();
  expect(log.map(c => `${c.method} ${c.ifMatch}`)).toEqual([
    'PUT "a"',
    'GET null',
    'GET null', // GET /api/v1/dashboard/1 for the current ETag
    'PUT "c"',
    'GET null',
  ]);
  expect(log[2].url).toMatch(/\/api\/v1\/dashboard\/1$/);
});
