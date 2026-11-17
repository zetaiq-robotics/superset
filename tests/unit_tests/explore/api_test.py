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
# Modified by ZetaIQ: tests for the chart version in Explore and its form-data cache.

from typing import Any
from unittest.mock import patch

from superset.commands.temporary_cache.exceptions import (
    TemporaryCacheAccessDeniedError,
)


def test_explore_datasource_not_found(client: Any, full_api_access: None) -> None:
    # validating the payload for a dataset that doesn't exist
    # user should be expecting missing_datasource view
    response = client.get(
        "/api/v1/explore/?datasource_id=50000&datasource_type=table",
    )
    response.json["result"]["dataset"]["name"] == "[Missing Dataset]"  # noqa: B015
    assert response.status_code == 200


def test_temporary_cache_access_denied_echoes_exception_message(
    client: Any, full_api_access: None
) -> None:
    """The cached form data denial must report its own translatable message.

    ``check_access`` raises ``TemporaryCacheAccessDeniedError`` for chart
    denials as well as dataset denials, so the response cannot claim the
    datasource was the reason, and a hardcoded string would drop the
    ``lazy_gettext`` the exception carries.
    """
    with patch(
        "superset.explore.api.GetExploreCommand.run",
        side_effect=TemporaryCacheAccessDeniedError(),
    ):
        response = client.get("/api/v1/explore/?form_data_key=abc")

    assert response.status_code == 403
    assert response.json["message"] == str(TemporaryCacheAccessDeniedError.message)
    assert "datasource" not in response.json["message"].lower()


def test_temporary_cache_access_denied_omits_inert_access_flag(
    client: Any, full_api_access: None
) -> None:
    """No ``is_access_denial`` without the ``error_type``/``level`` to use it.

    ``ErrorMessageWithStackTrace`` dispatches on ``error_type``; a bare
    ``extra`` flag cannot reach ``DatasourceSecurityAccessErrorMessage`` and
    would only add a payload the frontend never reads.
    """
    with patch(
        "superset.explore.api.GetExploreCommand.run",
        side_effect=TemporaryCacheAccessDeniedError(),
    ):
        response = client.get("/api/v1/explore/?form_data_key=abc")

    assert "extra" not in response.json


def test_explore_includes_chart_version_uuid(
    session: Any, client: Any, full_api_access: None, mocker: Any
) -> None:
    """Explore hands out the saved chart's version token for ``If-Match``."""
    from superset import db, security_manager
    from superset.models.slice import Slice

    mocker.patch.object(security_manager, "is_admin", return_value=True)
    mocker.patch.object(security_manager, "raise_for_access")
    Slice.metadata.create_all(db.session.get_bind())
    chart = Slice(
        slice_name="saved",
        datasource_type="table",
        datasource_id=1,
        viz_type="table",
        params="{}",
    )
    db.session.add(chart)
    db.session.flush()
    token = mocker.patch(
        "superset.commands.explore.get.entity_concurrency_token",
        return_value="live",
    )

    response = client.get(f"/api/v1/explore/?slice_id={chart.id}")

    assert response.status_code == 200, response.get_data(as_text=True)
    assert response.json["result"]["slice"]["version_uuid"] == "live"
    assert token.call_args.args == (Slice, chart.id, chart.uuid)


def test_explore_without_a_saved_chart_has_no_slice(
    client: Any, full_api_access: None
) -> None:
    """An unsaved chart has no slice payload, so no version to report."""
    response = client.get(
        "/api/v1/explore/?datasource_id=50000&datasource_type=table",
    )

    assert response.status_code == 200
    assert response.json["result"]["slice"] is None


def _explore_tab(session: Any, mocker: Any) -> tuple[Any, Any, Any]:
    """A saved chart, a dict-backed form-data cache and a movable live version."""
    from superset import db, security_manager
    from superset.extensions import cache_manager
    from superset.models.slice import Slice
    from tests.unit_tests.explore.form_data_api_test import _DictCache

    mocker.patch.object(security_manager, "is_admin", return_value=True)
    mocker.patch.object(security_manager, "raise_for_access")
    mocker.patch.object(security_manager, "raise_for_editorship")
    mocker.patch("superset.commands.chart.update.g", user=None)
    for command in ("create", "update", "get"):
        mocker.patch(f"superset.commands.explore.form_data.{command}.check_access")
    for command in ("create", "update"):
        mocker.patch(
            f"superset.commands.explore.form_data.{command}.get_user_id",
            return_value=1,
        )
    mocker.patch.object(cache_manager, "_explore_form_data_cache", _DictCache())
    Slice.metadata.create_all(db.session.get_bind())
    chart = Slice(
        slice_name="saved",
        datasource_type="table",
        datasource_id=1,
        viz_type="table",
        params="{}",
    )
    db.session.add(chart)
    db.session.flush()
    live = {"version": "A"}
    for module in (
        "superset.commands.explore.get",
        "superset.commands.explore.form_data.create",
    ):
        mocker.patch(
            f"{module}.entity_concurrency_token",
            side_effect=lambda *_: live["version"],
            create=True,
        )
    return chart, live, cache_manager


def _form_data(chart: Any, **extra: Any) -> dict[str, Any]:
    from superset.utils import json

    return {
        "datasource_id": 1,
        "datasource_type": "table",
        "chart_id": chart.id,
        "form_data": json.dumps(
            {"slice_id": chart.id, "datasource": "1__table", "viz_type": "table"}
        ),
        **extra,
    }


def _restored_version(client: Any, chart: Any, key: str) -> str:
    response = client.get(f"/api/v1/explore/?form_data_key={key}&slice_id={chart.id}")
    assert response.status_code == 200, response.get_data(as_text=True)
    return response.json["result"]["slice"]["version_uuid"]


def test_restored_unsaved_edits_keep_the_version_they_started_from(
    session: Any, client: Any, full_api_access: None, mocker: Any
) -> None:
    """Reload after someone else saved: the base is the cached edits' version.

    Taking the live version instead would let the tab's next save overwrite
    the other save without a 412.
    """
    from superset.versioning.api_helpers import EntityVersionInfo

    chart, live, _ = _explore_tab(session, mocker)
    created = client.post("/api/v1/explore/form_data?tab_id=1", json=_form_data(chart))
    key = created.json["key"]
    # an edit to the cached form data does not move its version
    edited = client.put(
        f"/api/v1/explore/form_data/{key}?tab_id=1", json=_form_data(chart)
    )
    assert edited.status_code == 200, edited.get_data(as_text=True)
    live["version"] = "B"  # someone else saves the chart

    base = _restored_version(client, chart, key)

    assert base == "A"
    mocker.patch(
        "superset.charts.api.current_entity_version_info",
        return_value=EntityVersionInfo(
            version=2, transaction_id=3, version_uuid="B", entity_uuid=chart.uuid
        ),
    )
    save = client.put(
        f"/api/v1/chart/{chart.id}",
        json={"slice_name": "from the restored tab"},
        headers={"If-Match": f'"{base}"'},
    )
    assert save.status_code == 412


NEW_VERSION = "0b1c6a3e-2f7d-4c55-9a80-6c1b1f0e9d11"


def test_restore_after_the_tabs_own_save_has_the_new_version(
    session: Any, client: Any, full_api_access: None, mocker: Any
) -> None:
    """After its own overwrite the tab re-writes its form data with the new
    version (Explore re-creates the entry once a save lands), so a reload
    is not refused for the tab's own save."""
    chart, live, _ = _explore_tab(session, mocker)
    created = client.post("/api/v1/explore/form_data?tab_id=1", json=_form_data(chart))
    key = created.json["key"]
    live["version"] = NEW_VERSION  # this tab's own overwrite

    rewritten = client.post(
        "/api/v1/explore/form_data?tab_id=1",
        json=_form_data(chart, version_uuid=NEW_VERSION),
    )

    assert rewritten.json["key"] == key
    assert _restored_version(client, chart, key) == NEW_VERSION


def test_cache_entry_from_before_the_stored_version_restores_the_live_one(
    session: Any, client: Any, full_api_access: None, mocker: Any
) -> None:
    """Entries written before this change carry no version: use the live one."""
    chart, live, cache_manager = _explore_tab(session, mocker)
    created = client.post("/api/v1/explore/form_data?tab_id=1", json=_form_data(chart))
    key = created.json["key"]
    cache_manager.explore_form_data_cache.get(key).pop("version_uuid", None)
    live["version"] = "B"

    assert _restored_version(client, chart, key) == "B"
