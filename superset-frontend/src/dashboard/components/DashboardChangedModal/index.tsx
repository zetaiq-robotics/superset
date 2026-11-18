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
import { Button, Modal } from '@superset-ui/core/components';
import { t } from '@apache-superset/core/translation';
import { StaleSummary } from 'src/dashboard/live/changeSummary';

type Props = {
  show: boolean;
  /** who saved and when; null when the history could not be read */
  summary: StaleSummary;
  /** only charts changed (opened from the badge) */
  chartOnly?: boolean;
  onDiscard: () => void;
  onKeepEditing: () => void;
};

/** Someone saved while this editor has unsaved changes (spec §7.8). */
export default function DashboardChangedModal({
  show,
  summary,
  chartOnly = false,
  onDiscard,
  onKeepEditing,
}: Props) {
  return (
    <Modal
      show={show}
      title={t('Dashboard changed')}
      // closing is the safe choice: nothing of the editor's is touched
      onHide={onKeepEditing}
      footer={
        <>
          <Button buttonStyle="secondary" onClick={onDiscard}>
            {t('Discard my changes')}
          </Button>
          <Button buttonStyle="primary" onClick={onKeepEditing}>
            {t('Keep editing')}
          </Button>
        </>
      }
    >
      {chartOnly ? (
        // a chart's save: the editor's dashboard save is not refused
        <p>{t('A chart on this dashboard was changed.')}</p>
      ) : (
        <p>
          {summary
            ? t(
                '%s saved a newer version at %s.',
                summary.changedBy,
                summary.changedAt,
              )
            : t('Someone saved a newer version.')}{' '}
          {t('Your unsaved changes are based on the older one.')}
        </p>
      )}
    </Modal>
  );
}
