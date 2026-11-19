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
import { useHistory } from 'react-router-dom';
import { EmptyState } from '@superset-ui/core/components';
import { t } from '@apache-superset/core/translation';
import type { UnavailableReason } from 'src/dashboard/live/classifyEvent';
import { RoutePaths } from 'src/views/routePaths';

const copy = (reason?: UnavailableReason) => {
  switch (reason) {
    case 'deleted':
      return [
        t('This dashboard was deleted.'),
        t('Someone who manages it can restore it from the archive.'),
      ];
    case 'access':
      return [
        t('You no longer have access to this dashboard.'),
        t('Ask its owner to share it with you again.'),
      ];
    default:
      return [
        t('This dashboard is no longer available to you.'),
        t('It may have been deleted or no longer shared with you.'),
      ];
  }
};

/**
 * The open dashboard was deleted or unshared (spec §7.7):
 * why, when known, and the way back to the list.
 */
export default function DashboardUnavailable({
  reason,
}: {
  reason?: UnavailableReason;
}) {
  const history = useHistory();
  const [title, description] = copy(reason);
  return (
    <EmptyState
      size="large"
      image="empty-dashboard.svg"
      title={title}
      description={description}
      buttonText={t('Back to dashboards')}
      buttonAction={() => history.push(RoutePaths.DASHBOARD_LIST)}
    />
  );
}
