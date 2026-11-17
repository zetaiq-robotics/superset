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

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from pytest_mock import MockerFixture
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm.session import Session

from superset import db, security_manager
from superset.dashboards.schemas import DashboardGetResponseSchema
from superset.utils import json


@pytest.fixture
def mock_dashboard() -> MagicMock:
    dash = MagicMock()
    # Real Dashboard objects are not subscriptable. Without this, marshmallow's
    # get_value reads ``dash["changed_on"]`` (which a MagicMock happily returns
    # as another mock) instead of the attribute, and marshmallow 4's DateTime
    # field then fails serializing the mock via datetime.isoformat().
    dash.__getitem__.side_effect = TypeError
    dash.id = 1
    dash.slug = "test-slug"
    dash.url = "/superset/dashboard/test-slug/"
    dash.dashboard_title = "Test Dashboard"
    dash.thumbnail_url = "http://example.com/thumb.png"
    dash.published = True
    dash.css = ""
    dash.theme = None
    dash.json_metadata = "{}"
    dash.position_json = "{}"
    dash.certified_by = None
    dash.certification_details = None
    dash.changed_by_name = "admin"
    dash.changed_by = MagicMock(id=1, first_name="admin", last_name="user")
    dash.changed_on = None
    dash.changed_on_humanized = "2 days ago"
    dash.created_by = MagicMock(id=1, first_name="admin", last_name="user")
    dash.created_on_humanized = "5 days ago"
    dash.charts = []
    dash.editors = []
    dash.viewers = []
    dash.tags = []
    dash.custom_tags = []
    dash.is_managed_externally = False
    dash.uuid = None
    return dash


def test_schema_column_selection_excludes_thumbnail(
    mock_dashboard: MagicMock,
) -> None:
    schema = DashboardGetResponseSchema(only=["id", "dashboard_title"])
    result = schema.dump(mock_dashboard)
    assert "id" in result
    assert "dashboard_title" in result
    assert "thumbnail_url" not in result
    assert "slug" not in result


def test_schema_column_selection_with_data_key(
    mock_dashboard: MagicMock,
) -> None:
    """Fields with data_key should work when using the internal field name."""
    schema = DashboardGetResponseSchema(only=["id", "changed_on_humanized"])
    result = schema.dump(mock_dashboard)
    assert "id" in result
    assert "changed_on_delta_humanized" in result
    assert "dashboard_title" not in result


def test_schema_full_response_includes_thumbnail(
    mock_dashboard: MagicMock,
) -> None:
    schema = DashboardGetResponseSchema()
    result = schema.dump(mock_dashboard)
    assert "thumbnail_url" in result
    assert "id" in result
    assert "dashboard_title" in result


def test_data_key_mapping_logic() -> None:
    """The key_to_name mapping used in the API correctly maps data_key to field name."""
    schema = DashboardGetResponseSchema()
    key_to_name = {
        field.data_key or name: name for name, field in schema.fields.items()
    }
    # changed_on_delta_humanized is the data_key for changed_on_humanized
    assert key_to_name["changed_on_delta_humanized"] == "changed_on_humanized"
    assert key_to_name["created_on_delta_humanized"] == "created_on_humanized"
    # fields without data_key map to themselves
    assert key_to_name["id"] == "id"
    assert key_to_name["thumbnail_url"] == "thumbnail_url"


def test_schema_strips_sensitive_fields_for_guest_user(
    mock_dashboard: MagicMock,
) -> None:
    """Guest users should not see editors, viewers, or changed_by."""
    schema = DashboardGetResponseSchema()

    with patch("superset.dashboards.schemas.security_manager") as mock_sm:
        mock_sm.is_guest_user = MagicMock(return_value=True)
        result = schema.dump(mock_dashboard)

    assert "editors" not in result
    assert "viewers" not in result
    assert "changed_by_name" not in result
    assert "changed_by" not in result
    assert "id" in result
    assert "dashboard_title" in result


def test_schema_includes_all_fields_for_regular_user(
    mock_dashboard: MagicMock,
) -> None:
    """Regular users should see editors, viewers, and changed_by."""
    schema = DashboardGetResponseSchema()

    with patch("superset.dashboards.schemas.security_manager") as mock_sm:
        mock_sm.is_guest_user = MagicMock(return_value=False)
        result = schema.dump(mock_dashboard)

    assert "editors" in result
    assert "viewers" in result
    assert "changed_by_name" in result
    assert "changed_by" in result


ROOT = {"id": "ROOT_ID", "type": "ROOT", "children": ["GRID_ID"]}
GRID = {"id": "GRID_ID", "type": "GRID", "children": ["TABS-1"]}
TAB_1 = {"id": "TAB-1", "type": "TAB", "meta": {"text": "Kept"}, "children": []}


def _layout(tabs_children: list[str]) -> dict[str, Any]:
    return {
        "ROOT_ID": ROOT,
        "GRID_ID": GRID,
        "TABS-1": {"id": "TABS-1", "type": "TABS", "children": tabs_children},
        "TAB-1": TAB_1,
    }


def _store_dashboard(position_json: str) -> int:
    from superset.models.dashboard import Dashboard

    Dashboard.metadata.create_all(db.session.get_bind())
    dashboard = Dashboard(
        dashboard_title="broken layout",
        position_json=position_json,
        json_metadata="{}",
    )
    db.session.add(dashboard)
    db.session.flush()
    return dashboard.id


@pytest.mark.parametrize(
    "stored",
    [
        # A tab bar pointing at a tab the layout does not hold. Walking it is
        # what used to raise, so the dashboard could not be written again.
        pytest.param(_layout(["TAB-1", "TAB-2"]), id="dangling child"),
        # A layout that reaches a node it has already reached. Walking it used
        # to never finish, so the request hung instead of failing.
        pytest.param({"ROOT_ID": {**ROOT, "children": ["ROOT_ID"]}}, id="cycle"),
    ],
)
def test_put_repairs_a_stored_layout_that_cannot_be_walked(
    stored: dict[str, Any],
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A dashboard stored with an unwalkable layout can still be repaired.

    The layouts here are JSON-parseable, so they pass validation and reach the
    metadata database. Reading the tabs off them is what fails, and an update
    reads the stored tabs to find the deleted ones, so before this change the
    repair request itself failed and the dashboard stayed unwritable.
    """
    from superset.models.dashboard import Dashboard

    # ``full_api_access`` stops at the route decorators, so the row filter and
    # the editorship check still need a user the request does not have.
    mocker.patch.object(security_manager, "is_admin", return_value=True)
    mocker.patch.object(security_manager, "raise_for_editorship")

    dashboard_id = _store_dashboard(json.dumps(stored))
    repaired = json.dumps(_layout(["TAB-1"]))

    response = client.put(
        f"/api/v1/dashboard/{dashboard_id}",
        json={"position_json": repaired},
    )

    assert response.status_code == 200
    assert json.loads(
        db.session.query(Dashboard).get(dashboard_id).position_json
    ) == json.loads(repaired)


def _store_titled_dashboard(mocker: MockerFixture) -> Any:
    """A real dashboard the request may edit, plus its stub live version."""
    from superset.models.dashboard import Dashboard
    from superset.versioning.api_helpers import EntityVersionInfo

    # ``full_api_access`` stops at the route decorators, so the row filter and
    # the editorship check still need a user the request does not have.
    mocker.patch.object(security_manager, "is_admin", return_value=True)
    mocker.patch.object(security_manager, "raise_for_editorship")
    dashboard = db.session.query(Dashboard).get(_store_dashboard("{}"))
    version_info = mocker.patch(
        "superset.dashboards.api.current_entity_version_info",
        return_value=EntityVersionInfo(
            version=1,
            transaction_id=2,
            version_uuid="live",
            entity_uuid=dashboard.uuid,
        ),
    )
    return dashboard, version_info


def _stored_title(dashboard_id: int) -> str:
    from superset.models.dashboard import Dashboard

    db.session.expire_all()
    return db.session.query(Dashboard).get(dashboard_id).dashboard_title


def test_put_dashboard_rejects_stale_if_match(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A PUT carrying an ``If-Match`` from an older version is refused with 412."""
    dashboard, version_info = _store_titled_dashboard(mocker)
    dashboard_id = dashboard.id

    response = client.put(
        f"/api/v1/dashboard/{dashboard_id}",
        json={"dashboard_title": "from a stale tab"},
        headers={"If-Match": '"old"'},
    )

    assert response.status_code == 412
    assert response.json == {
        "message": (
            "The dashboard was changed by another user or browser tab after you "
            "opened it. Reopen it to pick up the latest version, then reapply "
            "your changes."
        )
    }
    assert response.headers["ETag"] == '"live"'
    # A conditional write must ask for the locking validator read.
    assert version_info.call_args.kwargs["lock_for_stale_check"] is True
    assert _stored_title(dashboard_id) == "broken layout"


@pytest.mark.parametrize("tag", ['"live"', '"live:zstd"'])
def test_put_dashboard_accepts_current_if_match(
    tag: str,
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """``If-Match`` equal to the live version (bare or compressed form) saves."""
    dashboard, _ = _store_titled_dashboard(mocker)
    dashboard_id = dashboard.id

    response = client.put(
        f"/api/v1/dashboard/{dashboard_id}",
        json={"dashboard_title": "current tab"},
        headers={"If-Match": tag},
    )

    assert response.status_code == 200, response.get_data(as_text=True)
    assert _stored_title(dashboard_id) == "current tab"


def test_put_dashboard_without_if_match_still_saves(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """An unconditional PUT saves and takes no locks or locking validator read."""
    dashboard, version_info = _store_titled_dashboard(mocker)
    dashboard_id = dashboard.id
    lock = mocker.patch("superset.dashboards.api.lock_entity_for_update")

    response = client.put(
        f"/api/v1/dashboard/{dashboard_id}",
        json={"dashboard_title": "plain save"},
    )

    assert response.status_code == 200, response.get_data(as_text=True)
    lock.assert_not_called()
    # First call is the pre-command read carrying the flag; the post-command
    # new_info read passes none.
    assert version_info.call_args_list[0].kwargs["lock_for_stale_check"] is False
    assert _stored_title(dashboard_id) == "plain save"


def _put_single_field(
    mocker: MockerFixture, client: Any, route: str, body: dict[str, Any]
) -> tuple[Any, Any]:
    """Run a single-field dashboard write against a before/after live version."""
    from superset.models.dashboard import Dashboard
    from superset.versioning.api_helpers import EntityVersionInfo

    dashboard, version_info = _store_titled_dashboard(mocker)
    version_info.side_effect = [
        EntityVersionInfo(
            version=1,
            transaction_id=2,
            version_uuid="before",
            entity_uuid=dashboard.uuid,
        ),
        EntityVersionInfo(
            version=2,
            transaction_id=3,
            version_uuid="after",
            entity_uuid=dashboard.uuid,
        ),
    ]
    lock = mocker.patch("superset.dashboards.api.lock_entity_for_update")
    order = MagicMock()
    order.attach_mock(lock, "lock")
    order.attach_mock(version_info, "read")

    response = client.put(
        f"/api/v1/dashboard/{dashboard.id}/{route}",
        json=body,
        # Reporting only: a stale If-Match must not stop these writes.
        headers={"If-Match": '"stale"'},
    )

    assert response.status_code == 200, response.get_data(as_text=True)
    # Before the command: row lock first, then the version read under it.
    assert [name for name, _, _ in order.mock_calls[:2]] == ["lock", "read"]
    assert lock.call_args.args[0] is Dashboard
    assert version_info.call_args_list[0].kwargs["lock_for_stale_check"] is True
    # After the command: the live version, looked up without a lock. The
    # route's pk arrives as a string; the lookup coerces it.
    after = version_info.call_args_list[1]
    assert after.args[0] is Dashboard
    assert int(after.args[1]) == dashboard.id
    assert after.args[2] == dashboard.uuid
    assert not after.kwargs.get("lock_for_stale_check")
    body = response.json
    assert body["old_version_uuid"] == "before"
    assert body["new_version_uuid"] == "after"
    assert body["old_version_uuid"] != body["new_version_uuid"]
    assert response.headers["ETag"] == f'"{body["new_version_uuid"]}"'
    return response, dashboard


def test_put_filters_returns_version_pair(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A native filter save reports the version it replaced and the new one."""
    _put_single_field(
        mocker,
        client,
        "filters",
        {"modified": [{"id": "NATIVE_FILTER-1", "name": "region"}]},
    )


def test_put_chart_customizations_returns_version_pair(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A chart customization save reports the version it replaced and the new one."""
    _put_single_field(
        mocker,
        client,
        "chart_customizations",
        {"modified": [{"id": "CHART_CUSTOMIZATION-1", "name": "group"}]},
    )


def test_put_colors_returns_version_pair(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A colour save reports the version it replaced and the new one."""
    _, dashboard = _put_single_field(
        mocker, client, "colors", {"color_scheme": "blueToGreen"}
    )
    db.session.expire_all()
    assert json.loads(dashboard.json_metadata)["color_scheme"] == "blueToGreen"


def _contention() -> OperationalError:
    return OperationalError("SELECT", None, Exception(1213, "Deadlock found"))


@pytest.mark.parametrize("lock_point", ["lock", "read"])
def test_put_filters_lock_contention_is_retryable_409(
    lock_point: str,
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A lost lock race before a small write is the retryable 409; no write."""
    dashboard, version_info = _store_titled_dashboard(mocker)
    lock = mocker.patch("superset.dashboards.api.lock_entity_for_update")
    {"lock": lock, "read": version_info}[lock_point].side_effect = _contention()
    command = mocker.patch(
        "superset.dashboards.api.UpdateDashboardNativeFiltersCommand"
    )

    response = client.put(
        f"/api/v1/dashboard/{dashboard.id}/filters",
        json={"modified": [{"id": "NATIVE_FILTER-1", "name": "region"}]},
    )

    assert response.status_code == 409, response.get_data(as_text=True)
    command.assert_not_called()


def test_put_filters_command_lock_contention_is_retryable_409(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A lock race lost inside the command maps to the same 409, not a 422."""
    from superset.commands.dashboard.exceptions import (
        DashboardNativeFiltersUpdateFailedError,
    )

    dashboard, _ = _store_titled_dashboard(mocker)
    mocker.patch("superset.dashboards.api.lock_entity_for_update")
    failed = DashboardNativeFiltersUpdateFailedError()
    failed.__cause__ = _contention()
    mocker.patch(
        "superset.dashboards.api.UpdateDashboardNativeFiltersCommand"
    ).return_value.run.side_effect = failed

    response = client.put(
        f"/api/v1/dashboard/{dashboard.id}/filters",
        json={"modified": [{"id": "NATIVE_FILTER-1", "name": "region"}]},
    )

    assert response.status_code == 409, response.get_data(as_text=True)


def _get_dashboard_etag(client: Any, dashboard_id: int, **headers: str) -> str:
    response = client.get(f"/api/v1/dashboard/{dashboard_id}", headers=headers)
    assert response.status_code == 200, response.get_data(as_text=True)
    return response.headers["ETag"].strip('"')


def test_dashboard_etag_changes_when_only_editors_change(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """An access-only change moves the GET tag; the version part stays put.

    Editors and viewers live outside the versioned row, so a client holding
    the old tag must still see it change, while ``If-Match`` (which compares
    only the version part) keeps passing.
    """
    from superset.subjects.models import Subject
    from superset.subjects.types import SubjectType

    dashboard, _ = _store_titled_dashboard(mocker)
    dashboard_id = dashboard.id
    mocker.patch(
        "superset.dashboards.api.entity_concurrency_token", return_value="live"
    )
    subject = Subject(label="editor", type=SubjectType.ROLE)
    db.session.add(subject)
    db.session.flush()

    tag_a = _get_dashboard_etag(client, dashboard_id)
    response = client.put(
        f"/api/v1/dashboard/{dashboard_id}", json={"editors": [subject.id]}
    )
    assert response.status_code == 200, response.get_data(as_text=True)
    db.session.expire_all()
    tag_b = _get_dashboard_etag(client, dashboard_id)

    assert tag_a != tag_b
    assert tag_a.split(":")[0] == tag_b.split(":")[0] == "live"


@pytest.mark.parametrize("compressed", [False, True])
def test_if_match_with_access_suffix_still_matches(
    compressed: bool,
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """The GET tag, with its access suffix (and any coding suffix), saves."""
    dashboard, _ = _store_titled_dashboard(mocker)
    dashboard_id = dashboard.id
    mocker.patch(
        "superset.dashboards.api.entity_concurrency_token", return_value="live"
    )
    if compressed:
        tag = _get_dashboard_etag(client, dashboard_id, **{"Accept-Encoding": "zstd"})
        # The compression layer appends the content coding to the tag.
        assert tag.startswith("live:") and tag.endswith(":zstd")
        assert tag.count(":") == 2
    else:
        tag = _get_dashboard_etag(client, dashboard_id)
        assert tag.startswith("live:") and tag.count(":") == 1

    response = client.put(
        f"/api/v1/dashboard/{dashboard_id}",
        json={"dashboard_title": "after reading the tag"},
        headers={"If-Match": f'"{tag}"'},
    )

    assert response.status_code == 200, response.get_data(as_text=True)
    assert _stored_title(dashboard_id) == "after reading the tag"


def _unversioned(mocker: MockerFixture) -> None:
    """Capture on, but the entity has no version rows yet."""
    mocker.patch(
        "superset.versioning.api_helpers._capture_enabled", return_value=True
    )
    mocker.patch(
        "superset.versioning.api_helpers.VersionDAO.current_live_version_uuid",
        return_value=None,
    )


def test_dashboard_get_etag_for_unversioned_dashboard_is_unversioned_token(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """A never-versioned dashboard still hands out a validator to replay."""
    from superset.versioning.api_helpers import unversioned_entity_token

    dashboard, _ = _store_titled_dashboard(mocker)
    _unversioned(mocker)

    tag = _get_dashboard_etag(client, dashboard.id)

    assert tag.split(":")[0] == unversioned_entity_token(dashboard.uuid)


def test_small_write_on_unversioned_dashboard_reports_unversioned_token(
    session: Session,
    client: Any,
    full_api_access: None,
    mocker: MockerFixture,
) -> None:
    """The replaced version of a never-versioned dashboard is the GET's token."""
    from superset.versioning.api_helpers import (
        EntityVersionInfo,
        unversioned_entity_token,
    )

    dashboard, version_info = _store_titled_dashboard(mocker)
    version_info.side_effect = [
        EntityVersionInfo(entity_uuid=dashboard.uuid),
        EntityVersionInfo(
            version=1,
            transaction_id=3,
            version_uuid="after",
            entity_uuid=dashboard.uuid,
        ),
    ]
    mocker.patch("superset.dashboards.api.lock_entity_for_update")

    response = client.put(
        f"/api/v1/dashboard/{dashboard.id}/colors",
        json={"color_scheme": "blueToGreen"},
    )

    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.json["old_version_uuid"] == unversioned_entity_token(
        dashboard.uuid
    )
    assert response.json["new_version_uuid"] == "after"
    assert response.headers["ETag"] == '"after"'
