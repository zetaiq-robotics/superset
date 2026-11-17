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
