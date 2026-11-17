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
 * Modified by ZetaIQ: tests for the removed certification fields.
 */

import {
  createStore,
  render,
  screen,
  userEvent,
  waitFor,
} from 'spec/helpers/testing-library';
import reducerIndex from 'spec/helpers/reducerIndex';
import { ToastType } from 'src/components/MessageToasts/types';
import fetchMock from 'fetch-mock';
import {
  isFeatureEnabled,
  FeatureFlag,
  SupersetClient,
} from '@superset-ui/core';
import PropertiesModal, { PropertiesModalProps } from '.';

jest.mock('@superset-ui/core', () => ({
  ...jest.requireActual('@superset-ui/core'),
  isFeatureEnabled: jest.fn(),
}));

const createProps = () =>
  ({
    slice: {
      cache_timeout: null,
      certified_by: 'John Doe',
      certification_details: 'Sample certification',
      description: null,
      slice_id: 318,
      slice_name: 'Age distribution of respondents',
      is_managed_externally: false,
    },
    show: true,
    onHide: jest.fn(),
    onSave: jest.fn(),
    addSuccessToast: jest.fn(),
    addDangerToast: jest.fn(),
  }) as PropertiesModalProps;

fetchMock.get('glob:*/api/v1/chart/318*', {
  body: {
    description_columns: {},
    id: 318,
    label_columns: {
      'tags.id': 'Tags Id',
      'tags.name': 'Tags Name',
      'tags.type': 'Tags Type',
      'editors.id': 'Editors Id',
      'editors.label': 'Editors Label',
      'editors.type': 'Editors Type',
    },
    result: {
      editors: [
        {
          id: 1,
          label: 'Superset Admin',
          type: 1,
        },
      ],
      viewers: [],
      tags: [
        {
          id: 1,
          name: 'type:chart',
          type: 2,
        },
        {
          id: 2,
          name: 'editor:1',
          type: 3,
        },
        {
          id: 3,
          name: 'my test tag',
          type: 1,
        },
      ],
      show_title: 'Show Slice',
      certification_details: 'Test certification details',
      certified_by: 'Test certified by',
      description: 'Test description',
      cache_timeout: 1000,
      slice_name: 'Test chart new name',
    },
    show_columns: [
      'tags.id',
      'tags.name',
      'tags.type',
      'editors.id',
      'editors.label',
      'editors.type',
    ],
    show_title: 'Show Slice',
  },
  headers: { ETag: '"v2"' },
});

fetchMock.put('glob:*/api/v1/chart/318', {
  body: {
    id: 318,
    old_version_uuid: 'v1',
    new_version_uuid: 'v2',
    result: {
      cache_timeout: null,
      certified_by: 'John Doe',
      certification_details: 'Sample certification',
      description: null,
      slice_name: 'Age distribution of respondents',
    },
  },
});

// who saved last, for the stale-save modal's first line (Explore's list read)
fetchMock.get('glob:*/api/v1/chart/?q=*', {
  result: [
    { changed_by_name: 'Priya Rao', changed_on_utc: '2026-11-17T09:30:00' },
  ],
});

afterAll(() => {
  fetchMock.clearHistory().removeRoutes();
});

const renderModal = (props: PropertiesModalProps) =>
  render(<PropertiesModal {...props} />, { useRedux: true });

// the modal's read on open has landed: fields filled, version loaded
const waitForLoad = () =>
  waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled(),
  );

const lastPut = () =>
  fetchMock.callHistory
    .calls('glob:*/api/v1/chart/318')
    .filter(c => c.options?.method?.toUpperCase() === 'PUT')
    .pop();

test('Should render null when show:false', async () => {
  const props = createProps();
  props.show = false;
  renderModal(props);

  await waitFor(() => {
    expect(
      screen.queryByRole('dialog', { name: 'Chart properties' }),
    ).not.toBeInTheDocument();
  });
});

test('Should render when show:true', async () => {
  const props = createProps();
  renderModal(props);

  await waitFor(
    () => {
      const modal = screen.getByRole('dialog');
      expect(modal).toBeInTheDocument();
      expect(modal).toHaveTextContent('Chart properties');
      expect(modal).not.toHaveClass('ant-zoom-appear');
    },
    { timeout: 3000 },
  );
});

test('Should have modal header', async () => {
  const props = createProps();
  renderModal(props);

  await waitFor(() => {
    expect(screen.getByText('Chart properties')).toBeVisible();
    expect(screen.getByTestId('close-modal-btn')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close' })).toBeVisible();
  });
});

test('"Close" button should call "onHide"', async () => {
  const props = createProps();
  renderModal(props);

  await waitFor(() => {
    expect(props.onHide).toHaveBeenCalledTimes(0);
  });

  await userEvent.click(screen.getByRole('button', { name: 'Close' }));

  await waitFor(() => {
    expect(props.onHide).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledTimes(0);
  });
});

test('Should render all elements inside modal', async () => {
  const props = createProps();
  renderModal(props);

  await waitFor(
    () => {
      // Check we have the modal
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Check for collapse sections instead of expecting all textboxes to be visible
      expect(screen.getByText('General settings')).toBeInTheDocument();
      expect(screen.getByText('Configuration')).toBeInTheDocument();
      // ZetaIQ: no certification, so no Advanced section (polish round, 2026-10-30).
      expect(screen.queryByText('Advanced')).not.toBeInTheDocument();

      // Only General settings is expanded by default
      // Check for visible labels and fields in the expanded section
      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Description')).toBeInTheDocument();
      expect(screen.getByText('Editors')).toBeInTheDocument();

      // Check that we have the expected number of textboxes visible
      const textboxes = screen.getAllByRole('textbox');
      expect(textboxes.length).toBeGreaterThanOrEqual(2); // At least Name and Description

      // Editors combobox should be visible
      expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(1);
    },
    { timeout: 10000 },
  );
});

test('Should have modal footer', async () => {
  const props = createProps();
  renderModal(props);

  await waitFor(() => {
    expect(screen.getByText('Cancel')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();

    expect(screen.getByText('Save')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

test('"Cancel" button should call "onHide"', async () => {
  const props = createProps();
  renderModal(props);

  await waitFor(() => {
    expect(props.onHide).toHaveBeenCalledTimes(0);
  });

  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  await waitFor(() => {
    expect(props.onHide).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledTimes(0);
  });
});

test('"Save" button should call "onSave" and "onHide"', async () => {
  const props = createProps();
  renderModal(props);
  await waitFor(() => {
    expect(props.onSave).toHaveBeenCalledTimes(0);
    expect(props.onHide).toHaveBeenCalledTimes(0);

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onHide).toHaveBeenCalledTimes(1);
  });
});

test('saving properties adopts the chart version the save created', async () => {
  const props = createProps();
  props.slice.version_uuid = 'v1';
  renderModal(props);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled(),
  );

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  // otherwise Explore's next overwrite would send If-Match "v1" and be refused
  await waitFor(() =>
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ version_uuid: 'v2' }),
    ),
  );
});

test('"Name" should not be empty', async () => {
  const props = createProps();
  renderModal(props);
  await waitForLoad();

  const name = screen.getByRole('textbox', { name: 'Name' });

  await userEvent.clear(name);

  expect(name).toHaveValue('');

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    expect(props.onSave).toHaveBeenCalledTimes(0);
  });
});

test('"Name" should not be empty when saved', async () => {
  const props = createProps();
  renderModal(props);
  await waitForLoad();

  const name = screen.getByRole('textbox', { name: 'Name' });

  await userEvent.clear(name);
  await userEvent.type(name, 'Test chart new name');

  expect(name).toHaveValue('Test chart new name');

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ slice_name: 'Test chart new name' }),
    );
  });
});

test('"Cache timeout" should not be empty when saved', async () => {
  const props = createProps();
  renderModal(props);
  await waitForLoad();

  // Expand the Configuration section first to access cache timeout
  const configPanel = screen.getByText('Configuration').closest('[role="tab"]');
  if (configPanel) {
    await userEvent.click(configPanel);
  }

  const cacheTimeout = await screen.findByRole('textbox', {
    name: 'Cache timeout',
  });
  await userEvent.clear(cacheTimeout);
  await userEvent.type(cacheTimeout, '1000');
  expect(cacheTimeout).toHaveValue('1000');

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ cache_timeout: 1000 }),
    );
  });
});

test('"Description" should not be empty when saved', async () => {
  const props = createProps();
  renderModal(props);

  // Wait for modal to be ready
  await waitForLoad();

  // Find the description textarea (it's the second textbox, as Name is the first)
  const textboxes = screen.getAllByRole('textbox');
  const description = textboxes[1]; // Description is the textarea

  await userEvent.clear(description);
  await userEvent.type(description, 'Test description');

  expect(description).toHaveValue('Test description');

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => {
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Test description' }),
    );
  });
});

test('Should display only custom tags when tagging system is enabled', async () => {
  const mockIsFeatureEnabled = isFeatureEnabled as jest.MockedFunction<
    typeof isFeatureEnabled
  >;
  mockIsFeatureEnabled.mockImplementation(
    flag => flag === FeatureFlag.TaggingSystem,
  );

  const props = createProps();
  renderModal(props);

  expect(await screen.findByText('Tags')).toBeInTheDocument();
  expect(
    await screen.findByRole('combobox', { name: 'Tags' }),
  ).toBeInTheDocument();

  expect(await screen.findByText('my test tag')).toBeInTheDocument();
  expect(screen.queryByText('type:chart')).not.toBeInTheDocument();
  expect(screen.queryByText('editor:1')).not.toBeInTheDocument();

  mockIsFeatureEnabled.mockRestore();
});

test('Should show Viewers picker when ENABLE_VIEWERS is on', async () => {
  const mockIsFeatureEnabled = isFeatureEnabled as jest.MockedFunction<
    typeof isFeatureEnabled
  >;
  mockIsFeatureEnabled.mockImplementation(
    flag => flag === FeatureFlag.EnableViewers,
  );

  const props = createProps();
  renderModal(props);

  await waitFor(() => {
    expect(screen.getByText('Viewers')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Viewers' }),
    ).toBeInTheDocument();
  });

  mockIsFeatureEnabled.mockRestore();
});

// ZetaIQ (polish round, 2026-10-30): certification is not offered; saving keeps the chart's own values as they are.
test('certification is not offered, and saving leaves it as it was', async () => {
  const props = createProps();
  renderModal(props);
  expect(
    screen.queryByRole('textbox', { name: 'Certified by' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('textbox', { name: 'Certification details' }),
  ).not.toBeInTheDocument();
  await waitForLoad();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(props.onSave).toHaveBeenCalled());
  // as stored now (the read on open), not the caller's older copy
  expect(JSON.parse(String(lastPut()?.options?.body))).toMatchObject({
    certified_by: 'Test certified by',
    certification_details: 'Test certification details',
  });
});

test('the fields come from the same read as the version the save is checked against', async () => {
  const props = createProps();
  props.slice.slice_name = 'Old';
  renderModal(props);

  // the read on open answers "Test chart new name" with ETag v2
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(
      'Test chart new name',
    ),
  );
  await waitForLoad();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(props.onSave).toHaveBeenCalled());
  const put = lastPut();
  expect(
    new Headers(put?.options?.headers as HeadersInit).get('If-Match'),
  ).toBe('"v2"');
  expect(JSON.parse(String(put?.options?.body))).toMatchObject({
    slice_name: 'Test chart new name',
    description: 'Test description',
    cache_timeout: 1000,
    certified_by: 'Test certified by',
    certification_details: 'Test certification details',
  });
});

test('Save stays disabled until the read on open has loaded the version', async () => {
  const { get } = SupersetClient;
  let release = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const getSpy = jest
    .spyOn(SupersetClient, 'get')
    .mockImplementation((request: any) =>
      request.endpoint?.includes('?q=')
        ? gate.then(() => get(request))
        : get(request),
    );
  renderModal(createProps());
  await waitFor(() => expect(getSpy).toHaveBeenCalled());

  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Name' })).toBeDisabled();

  release();
  await waitForLoad();
  expect(screen.getByRole('textbox', { name: 'Name' })).toBeEnabled();
  getSpy.mockRestore();
});

test.each(['fails', 'carries no ETag'])(
  'a read on open that %s keeps Save disabled and sends no PUT',
  async scenario => {
    const { get } = SupersetClient;
    const getSpy = jest
      .spyOn(SupersetClient, 'get')
      .mockImplementation((request: any) => {
        if (!request.endpoint?.includes('?q=')) return get(request);
        return scenario === 'fails'
          ? Promise.reject(new Response('{}', { status: 500 }))
          : get(request).then((r: any) => ({
              json: r.json,
              response: new Response('{}'),
            }));
      });
    const put = jest.spyOn(SupersetClient, 'put');
    const store = createStore({}, reducerIndex);
    render(<PropertiesModal {...createProps()} />, { useRedux: true, store });

    await waitFor(() =>
      expect(
        store
          .getState()
          .messageToasts.filter(
            (toast: any) => toast.toastType === ToastType.Danger,
          ),
      ).toHaveLength(1),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(put).not.toHaveBeenCalled();
    [getSpy, put].forEach(spy => spy.mockRestore());
  },
);

// The modal's GET on open answers v5; any later read of the chart (the
// Overwrite's fresh read) answers `fresh` (null: no ETag). The PUTs are
// refused with `refusals` in order, then succeed.
const staleChartProperties = async (
  refusals: number[] = [412],
  fresh: string | null = '"v6"',
) => {
  const { get } = SupersetClient;
  const getSpy = jest
    .spyOn(SupersetClient, 'get')
    .mockImplementation((request: any) => {
      if (!request.endpoint?.startsWith('/api/v1/chart/318')) {
        return get(request);
      }
      const onOpen = request.endpoint.includes('?q=');
      const etag = onOpen ? '"v5"' : fresh;
      return get(request).then((r: any) => ({
        json: r.json,
        response: new Response('{}', etag ? { headers: { ETag: etag } } : {}),
      }));
    });
  const put = jest.spyOn(SupersetClient, 'put');
  refusals.forEach(status =>
    put.mockRejectedValueOnce(new Response('{}', { status })),
  );
  put.mockResolvedValue({
    json: { result: {}, old_version_uuid: 'v6', new_version_uuid: 'v7' },
  } as any);
  const props = createProps();
  const store = createStore({}, reducerIndex);
  render(<PropertiesModal {...props} />, { useRedux: true, store });
  await waitFor(() => expect(getSpy).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  return {
    props,
    put,
    dangerToasts: () =>
      store
        .getState()
        .messageToasts.filter(
          (toast: any) => toast.toastType === ToastType.Danger,
        ),
    ifMatches: () =>
      put.mock.calls.map(([req]: any) => req.headers?.['If-Match']),
    restore: () => [getSpy, put].forEach(spy => spy.mockRestore()),
  };
};

test('a properties save sends If-Match from the version the modal loaded', async () => {
  const { put, ifMatches, restore } = await staleChartProperties([]);

  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(ifMatches()).toEqual(['"v5"']);
  restore();
});

test('a refused properties save opens the stale-save modal', async () => {
  const { restore } = await staleChartProperties();

  expect(
    await screen.findByText('This chart was changed after you opened it'),
  ).toBeInTheDocument();
  restore();
});

test('Overwrite resends the properties with the version saved now', async () => {
  const { props, put, ifMatches, restore } = await staleChartProperties();
  await userEvent.click(
    await screen.findByRole('button', { name: 'Overwrite their changes' }),
  );

  await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
  expect(ifMatches()).toEqual(['"v5"', '"v6"']);
  await waitFor(() => expect(props.onSave).toHaveBeenCalled());
  restore();
});

test('an Overwrite that fails keeps the loaded version for the next save', async () => {
  const { put, ifMatches, restore } = await staleChartProperties([412, 500]);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Overwrite their changes' }),
  );
  await waitFor(() => expect(put).toHaveBeenCalledTimes(2));

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(put).toHaveBeenCalledTimes(3));
  expect(ifMatches()).toEqual(['"v5"', '"v6"', '"v5"']);
  restore();
});

test('an Overwrite whose fresh read has no ETag sends no PUT and shows an error', async () => {
  const { put, dangerToasts, restore } = await staleChartProperties(
    [412],
    null,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: 'Overwrite their changes' }),
  );

  await waitFor(() => expect(dangerToasts()).toHaveLength(1));
  expect(put).toHaveBeenCalledTimes(1);
  restore();
});
