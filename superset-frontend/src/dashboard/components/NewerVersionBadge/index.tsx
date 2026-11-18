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
import { Button, Label, Tooltip } from '@superset-ui/core/components';
import { t } from '@apache-superset/core/translation';

type Props = {
  /** newer saves heard since this editor's base */
  count: number;
  /** their authors, each once */
  names: string[];
  /** every save counted was a chart's: nobody to name, nothing stale */
  chartOnly?: boolean;
  /** offers "Discard my changes" / "Keep editing" again */
  onClick: () => void;
};

/** The header badge of an editor who chose "Keep editing" (spec §7.8). */
export default function NewerVersionBadge({
  count,
  names,
  chartOnly = false,
  onClick,
}: Props) {
  if (count < 1) return null;
  const label =
    count > 1 && names.length && !chartOnly
      ? t(
          'Newer version available (%s saves by %s)',
          count,
          new Intl.ListFormat(undefined, { type: 'conjunction' }).format(names),
        )
      : t('Newer version available');
  const badge = (
    <Button
      buttonSize="small"
      buttonStyle="secondary"
      onClick={onClick}
      data-test="newer-version-badge"
    >
      {label}
    </Button>
  );
  return chartOnly ? (
    <Tooltip title={t('A chart on this dashboard was changed.')}>
      {badge}
    </Tooltip>
  ) : (
    badge
  );
}

/**
 * Beside the title in view mode while a refresh waits for the viewer to
 * finish (spec §7.7). Says so once to assistive tech; does nothing on click.
 */
export function UpdateWaiting() {
  return (
    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
    <span role="status" data-test="update-waiting">
      <Tooltip
        title={t("This dashboard changed. It will refresh when you're done.")}
      >
        <Label type="info">{t('Update waiting')}</Label>
      </Tooltip>
    </span>
  );
}
