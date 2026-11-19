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
// Modified by ZetaIQ: the first Save of a dashboard not stored yet (save-paths spec §7.3).
import { getExtensionsRegistry } from '@superset-ui/core';
import type { DashboardSaveFolderProps } from '@superset-ui/core';
import { render, screen, userEvent } from 'spec/helpers/testing-library';
import FirstSaveModal from './FirstSaveModal';

afterEach(() =>
  getExtensionsRegistry().set('dashboard.save.folder', undefined),
);

test('Save waits for a valid folder, then sends the name and the folder', async () => {
  const seen: DashboardSaveFolderProps[] = [];
  getExtensionsRegistry().set('dashboard.save.folder', props => {
    seen.push(props);
    return (
      <button
        type="button"
        onClick={() => props.onChange("Sahil's Draft/Nav", true)}
      >
        pick folder
      </button>
    );
  });
  const onSave = jest.fn();
  render(
    <FirstSaveModal
      show
      title="My board"
      folder="Navigation"
      onHide={jest.fn()}
      onSave={onSave}
    />,
  );
  expect(seen[0]).toMatchObject({ mode: 'new', sourcePath: 'Navigation' });
  const save = screen.getByRole('button', { name: 'Save' });
  expect(save).toBeDisabled();
  await userEvent.click(screen.getByText('pick folder'));
  expect(save).toBeEnabled();
  await userEvent.click(save);
  expect(onSave).toHaveBeenCalledWith('My board', "Sahil's Draft/Nav");
});

test('without the folder extension the dialog saves with a name only', async () => {
  const onSave = jest.fn();
  render(
    <FirstSaveModal
      show
      title="Board"
      folder={null}
      onHide={jest.fn()}
      onSave={onSave}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(onSave).toHaveBeenCalledWith('Board', null);
});

test('an empty name cannot be saved', async () => {
  render(
    <FirstSaveModal
      show
      title="Board"
      folder={null}
      onHide={jest.fn()}
      onSave={jest.fn()}
    />,
  );
  await userEvent.clear(screen.getByRole('textbox', { name: 'Name' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});
