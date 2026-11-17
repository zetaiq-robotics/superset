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
import { useDispatch, useSelector } from 'react-redux';
import { Button, Modal } from '@superset-ui/core/components';
import { t } from '@apache-superset/core/translation';
import {
  saveDashboardRequest,
  setStaleSave,
  setUnsavedChanges,
} from 'src/dashboard/actions/dashboardState';
import { armUnsavedChangesPrompt } from 'src/dashboard/util/unsavedChangesPrompt';
import { DashboardState, RootState } from 'src/dashboard/types';
import {
  SAVE_TYPE_NEWDASHBOARD,
  SAVE_TYPE_OVERWRITE_CONFIRMED,
} from 'src/dashboard/util/constants';
import { StaleSummary } from 'src/dashboard/live/changeSummary';

type Props = {
  title: string;
  summary: StaleSummary;
  onDiscard: () => void;
  /** omitted when there is no copy to make */
  onCopy?: () => void;
  onOverwrite: () => void;
  onHide: () => void;
  saving?: boolean;
};

/** A full save was refused because someone else saved first. */
export function StaleSaveModal({
  title,
  summary,
  onDiscard,
  onCopy,
  onOverwrite,
  onHide,
  saving = false,
}: Props) {
  return (
    <Modal
      show
      title={title}
      onHide={onHide}
      footer={
        <>
          <Button buttonStyle="secondary" onClick={onDiscard}>
            {t('Discard my changes and reload')}
          </Button>
          {onCopy && (
            <Button buttonStyle="secondary" onClick={onCopy}>
              {t('Save as a copy')}
            </Button>
          )}
          <Button
            buttonStyle="danger"
            onClick={onOverwrite}
            loading={saving}
            disabled={saving}
          >
            {t('Overwrite their changes')}
          </Button>
        </>
      }
    >
      {summary && (
        <>
          <p>
            {t('Changed by %s at %s.', summary.changedBy, summary.changedAt)}
          </p>
          {summary.lines.map(line => (
            <p key={line}>{line}</p>
          ))}
        </>
      )}
    </Modal>
  );
}

const reloadWithoutEdits = () => {
  // the person chose to drop the edits: no "Leave site?" asking again
  armUnsavedChangesPrompt(false);
  const url = new URL(window.location.href);
  url.searchParams.delete('edit');
  window.location.assign(url);
};

/** The edit-mode Save's stale-save modal, opened by saveDashboardRequest. */
export default function DashboardStaleSave() {
  const dispatch = useDispatch();
  const staleSave = useSelector<RootState, DashboardState['staleSave']>(
    ({ dashboardState }) => dashboardState.staleSave,
  );
  const saving = useSelector<RootState, boolean>(
    ({ dashboardState }) => dashboardState.dashboardIsSaving,
  );
  if (!staleSave) return null;
  const { dashboardId, data, payload, summary } = staleSave;
  const close = () => dispatch(setStaleSave(undefined));

  return (
    <StaleSaveModal
      title={t('This dashboard was changed after you opened it')}
      summary={summary}
      saving={saving}
      onHide={close}
      onDiscard={() => {
        // before the reload: the dashboard's effect must not re-arm the prompt
        dispatch(setUnsavedChanges(false));
        reloadWithoutEdits();
      }}
      onCopy={
        data &&
        (() => {
          close();
          dispatch(
            saveDashboardRequest(
              {
                ...data,
                dashboard_title: `${data.dashboard_title} ${t('[copy]')}`,
                duplicate_slices: false,
              },
              dashboardId,
              SAVE_TYPE_NEWDASHBOARD,
            ),
          );
        })
      }
      onOverwrite={() =>
        // stays open until the save lands; a refused one refreshes it
        dispatch(
          saveDashboardRequest(
            payload,
            dashboardId,
            SAVE_TYPE_OVERWRITE_CONFIRMED,
          ),
        )
      }
    />
  );
}
