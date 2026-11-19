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
// Modified by ZetaIQ: the first Save of a dashboard not stored yet asks for a name and, through the
// `dashboard.save.folder` extension, a folder (docs/specs/2026-11-19-dashboard-save-paths-design.md §7.3).
import { useCallback, useState } from 'react';
import { t } from '@apache-superset/core/translation';
import { getExtensionsRegistry } from '@superset-ui/core';
import { Form, Input, Modal } from '@superset-ui/core/components';

export interface FirstSaveModalProps {
  show: boolean;
  /** The title typed in the header so far. */
  title: string;
  /** The folder the page was opened in, if any. */
  folder: string | null;
  onHide: () => void;
  onSave: (name: string, folder: string | null) => void;
}

const FirstSaveModal = ({
  show,
  title,
  folder,
  onHide,
  onSave,
}: FirstSaveModalProps) => {
  const Folder = getExtensionsRegistry().get('dashboard.save.folder');
  const [name, setName] = useState(title);
  const [path, setPath] = useState<{ value: string | null; valid: boolean }>(
    { value: folder, valid: false },
  );
  const onFolderChange = useCallback(
    (value: string | null, valid: boolean) => setPath({ value, valid }),
    [],
  );
  const ready = name.trim() !== '' && (!Folder || path.valid);

  return (
    <Modal
      show={show}
      onHide={onHide}
      title={t('Save dashboard')}
      primaryButtonName={t('Save')}
      disablePrimaryButton={!ready}
      onHandledPrimaryAction={() =>
        ready && onSave(name.trim(), Folder ? path.value : null)
      }
    >
      <Form layout="vertical">
        <Form.Item label={t('Name')} htmlFor="first-save-name">
          <Input
            id="first-save-name"
            aria-label={t('Name')}
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </Form.Item>
        {Folder && (
          <Folder mode="new" sourcePath={folder} onChange={onFolderChange} />
        )}
      </Form>
    </Modal>
  );
};

export default FirstSaveModal;
