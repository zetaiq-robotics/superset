# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
"""A chart PUT carrying a stale ``If-Match`` is refused instead of overwriting."""

from typing import Any

import pytest
from pytest_mock import MockerFixture
from sqlalchemy.orm.session import Session

from superset import db, security_manager


def _store_chart(mocker: MockerFixture) -> Any:
    """A real chart the request may edit, plus its stub live version."""
    from superset.models.slice import Slice
    from superset.versioning.api_helpers import EntityVersionInfo

    # ``full_api_access`` stops at the route decorators, so the row filter and
    # the editorship check still need a user the request does not have.
    mocker.patch.object(security_manager, "is_admin", return_value=True)
    mocker.patch.object(security_manager, "raise_for_editorship")
    # The command stamps ``last_saved_by = g.user``; the test request's
    # anonymous user is not a mapped row.
    mocker.patch("superset.commands.chart.update.g", user=None)
    Slice.metadata.create_all(db.session.get_bind())
    chart = Slice(
        slice_name="original",
        datasource_type="table",
        datasource_id=1,
        viz_type="table",
        params="{}",
    )
    db.session.add(chart)
    db.session.flush()
    version_info = mocker.patch(
        "superset.charts.api.current_entity_version_info",
        return_value=EntityVersionInfo(
            version=1,
            transaction_id=2,
            version_uuid="live",
            entity_uuid=chart.uuid,
        ),
    )
    return chart, version_info


def _stored_name(chart_id: int) -> str:
    from superset.models.slice import Slice

    db.session.expire_all()
    return db.session.query(Slice).get(chart_id).slice_name


def test_put_chart_rejects_stale_if_match(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A PUT carrying an ``If-Match`` from an older version is refused with 412."""
    chart, version_info = _store_chart(mocker)
    chart_id = chart.id

    response = client.put(
        f"/api/v1/chart/{chart_id}",
        json={"slice_name": "from a stale tab"},
        headers={"If-Match": '"old"'},
    )

    assert response.status_code == 412
    assert response.json == {
        "message": (
            "The chart was changed by another user or browser tab after you "
            "opened it. Reopen it to pick up the latest version, then reapply "
            "your changes."
        )
    }
    assert response.headers["ETag"] == '"live"'
    # A conditional write must ask for the locking validator read.
    assert version_info.call_args.kwargs["lock_for_stale_check"] is True
    assert _stored_name(chart_id) == "original"


@pytest.mark.parametrize("tag", ['"live"', '"live:zstd"'])
def test_put_chart_accepts_current_if_match(
    tag: str,
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """``If-Match`` equal to the live version (bare or compressed form) saves."""
    chart, _ = _store_chart(mocker)
    chart_id = chart.id

    response = client.put(
        f"/api/v1/chart/{chart_id}",
        json={"slice_name": "current tab"},
        headers={"If-Match": tag},
    )

    assert response.status_code == 200, response.get_data(as_text=True)
    assert _stored_name(chart_id) == "current tab"


def test_put_chart_without_if_match_still_saves(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """An unconditional PUT saves and takes no locks or locking validator read."""
    chart, version_info = _store_chart(mocker)
    chart_id = chart.id
    lock = mocker.patch("superset.charts.api.lock_entity_for_update")

    response = client.put(
        f"/api/v1/chart/{chart_id}",
        json={"slice_name": "plain save"},
    )

    assert response.status_code == 200, response.get_data(as_text=True)
    lock.assert_not_called()
    # First call is the pre-command read carrying the flag; the post-command
    # new_info read passes none.
    assert version_info.call_args_list[0].kwargs["lock_for_stale_check"] is False
    assert _stored_name(chart_id) == "plain save"


def test_chart_get_etag_for_unversioned_chart_is_unversioned_token(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A never-versioned chart still hands out a validator, with no suffix."""
    from superset.versioning.api_helpers import unversioned_entity_token

    chart, _ = _store_chart(mocker)
    mocker.patch("superset.versioning.api_helpers._capture_enabled", return_value=True)
    mocker.patch(
        "superset.versioning.api_helpers.VersionDAO.current_live_version_uuid",
        return_value=None,
    )

    response = client.get(f"/api/v1/chart/{chart.id}")

    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.headers["ETag"] == f'"{unversioned_entity_token(chart.uuid)}"'


def test_put_chart_on_unversioned_chart_reports_unversioned_token(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """The replaced version of a never-versioned chart is the GET's token."""
    from superset.versioning.api_helpers import (
        EntityVersionInfo,
        unversioned_entity_token,
    )

    chart, version_info = _store_chart(mocker)
    version_info.side_effect = [
        EntityVersionInfo(entity_uuid=chart.uuid),
        EntityVersionInfo(
            version=1, transaction_id=3, version_uuid="after", entity_uuid=chart.uuid
        ),
    ]

    response = client.put(f"/api/v1/chart/{chart.id}", json={"slice_name": "x"})

    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.json["old_version_uuid"] == unversioned_entity_token(chart.uuid)
    assert response.json["new_version_uuid"] == "after"
    assert response.headers["ETag"] == '"after"'


@pytest.mark.parametrize("case", ["not an editor", "missing"])
def test_put_chart_stale_if_match_without_edit_access_answers_as_without_it(
    case: str,
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A caller who cannot edit the chart gets the command's 403/404, never 412.

    Answering 412 (with the live ETag) first would tell anyone with the
    generic write permission that the chart exists and moved.
    """
    from unittest.mock import MagicMock

    from superset.exceptions import SupersetSecurityException

    chart, _ = _store_chart(mocker)
    # The guard rolls back to release its lock; keep the chart past that.
    db.session.commit()
    mocker.patch.object(
        security_manager,
        "raise_for_editorship",
        side_effect=SupersetSecurityException(MagicMock()),
    )
    chart_id = chart.id if case == "not an editor" else chart.id + 1000
    expected = 403 if case == "not an editor" else 404

    plain = client.put(f"/api/v1/chart/{chart_id}", json={"slice_name": "x"})
    stale = client.put(
        f"/api/v1/chart/{chart_id}",
        json={"slice_name": "x"},
        headers={"If-Match": '"old"'},
    )

    assert plain.status_code == stale.status_code == expected
    assert "ETag" not in stale.headers
