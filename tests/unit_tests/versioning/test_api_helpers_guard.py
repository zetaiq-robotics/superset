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
"""The shared If-Match guard every entity PUT (dataset, chart, dashboard) runs."""

from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from flask import Flask, Response
from pytest_mock import MockerFixture
from sqlalchemy.exc import OperationalError

from superset.exceptions import SupersetSecurityException
from superset.utils import json
from superset.versioning.api_helpers import (
    EntityVersionInfo,
    guard_conditional_write,
    lock_entity_for_update,
)

STALE_MESSAGE = "The thing was changed by another user."


def _api() -> MagicMock:
    api = MagicMock()
    api.response.side_effect = lambda status, **body: Response(
        json.dumps(body), status=status, mimetype="application/json"
    )
    return api


def _live() -> EntityVersionInfo:
    return EntityVersionInfo(
        version=1, transaction_id=2, version_uuid="live", entity_uuid=uuid4()
    )


def _contention() -> OperationalError:
    return OperationalError("SELECT", None, Exception(1213, "Deadlock found"))


def _guard(
    app: Flask,
    if_match: str | None,
    *,
    lock: Any = None,
    read_version: Any = None,
) -> Any:
    headers = {"If-Match": if_match} if if_match else {}
    with app.test_request_context("/api/v1/chart/1", method="PUT", headers=headers):
        return guard_conditional_write(
            _api(),
            MagicMock(),
            1,
            noun="chart",
            stale_message=STALE_MESSAGE,
            lock=lock or MagicMock(),
            read_version=read_version or MagicMock(return_value=_live()),
        )


def test_without_if_match_takes_no_lock_and_returns_info(app: Flask) -> None:
    lock, read_version = MagicMock(), MagicMock(return_value=_live())

    result = _guard(app, None, lock=lock, read_version=read_version)

    assert result is read_version.return_value
    lock.assert_not_called()
    assert read_version.call_args.kwargs["lock_for_stale_check"] is False


def test_current_if_match_returns_info_holding_the_locked_entity(
    app: Flask,
) -> None:
    lock, read_version = MagicMock(), MagicMock(return_value=_live())

    result = _guard(app, '"live:zstd"', lock=lock, read_version=read_version)

    assert isinstance(result, EntityVersionInfo)
    assert result.locked_entity is lock.return_value
    assert read_version.call_args.kwargs["lock_for_stale_check"] is True


def test_stale_if_match_is_412_with_live_etag(
    app: Flask, mocker: MockerFixture
) -> None:
    lock = MagicMock()
    editorship = mocker.patch(
        "superset.versioning.api_helpers.security_manager.raise_for_editorship"
    )

    result = _guard(app, '"old"', lock=lock)

    assert result.status_code == 412
    assert result.headers["ETag"] == '"live"'
    assert result.json == {"message": STALE_MESSAGE}
    lock.assert_called_once()
    editorship.assert_called_once_with(lock.return_value)


@pytest.mark.parametrize("lock_point", ["lock", "read_version"])
def test_lock_contention_is_retryable_409(
    app: Flask, mocker: MockerFixture, lock_point: str
) -> None:
    rollback = mocker.patch("superset.versioning.api_helpers.db")
    failing = {lock_point: MagicMock(side_effect=_contention())}

    result = _guard(app, '"live"', **failing)

    assert result.status_code == 409
    assert result.json == {
        "message": "Another save is in progress for this chart. Retry the same request."
    }
    rollback.session.rollback.assert_called_once()


@pytest.mark.parametrize("if_match", [None, '"live"'])
def test_unrelated_or_unconditional_read_errors_propagate(
    app: Flask, if_match: str | None
) -> None:
    """Only a conditional save's lock race is a 409; anything else re-raises."""
    error = (
        _contention()
        if if_match is None
        else OperationalError("SELECT", None, Exception(2006, "server has gone away"))
    )

    with pytest.raises(OperationalError):
        _guard(app, if_match, read_version=MagicMock(side_effect=error))


def test_star_if_match_takes_the_lock_and_locked_read_and_never_412(
    app: Flask,
) -> None:
    """``If-Match: *`` (the published toggle) locks like any conditional save.

    The version it reports as replaced is then read under the lock, so no
    other save can land between that read and the write; ``*`` matches any
    version, so it is never refused.
    """
    lock, read_version = MagicMock(), MagicMock(return_value=_live())

    result = _guard(app, "*", lock=lock, read_version=read_version)

    assert isinstance(result, EntityVersionInfo)
    lock.assert_called_once()
    assert result.locked_entity is lock.return_value
    assert read_version.call_args.kwargs["lock_for_stale_check"] is True


@pytest.mark.parametrize("entity", ["not an editor", "missing"])
def test_stale_if_match_from_a_non_editor_is_left_to_the_command(
    app: Flask, mocker: MockerFixture, entity: str
) -> None:
    """No 412 (nor the live ETag) for an entity the caller cannot edit.

    The lock is released and the request goes on, so the update command
    answers 403/404 exactly as it does without ``If-Match``.
    """
    db = mocker.patch("superset.versioning.api_helpers.db")
    mocker.patch(
        "superset.versioning.api_helpers.security_manager.raise_for_editorship",
        side_effect=SupersetSecurityException(MagicMock()),
    )
    lock = MagicMock(return_value=None if entity == "missing" else MagicMock())

    result = _guard(app, '"old"', lock=lock)

    assert isinstance(result, EntityVersionInfo)
    assert result.locked_entity is None
    db.session.rollback.assert_called_once()


def test_lock_is_for_no_key_update_on_postgres(mocker: MockerFixture) -> None:
    """Postgres takes the row lock that does not block foreign-key checks."""
    from sqlalchemy.dialects import postgresql

    from superset.models.slice import Slice

    seen: dict[str, Any] = {}

    def one_or_none(query: Any) -> None:
        seen["sql"] = str(query.statement.compile(dialect=postgresql.dialect()))

    mocker.patch("sqlalchemy.orm.Query.one_or_none", one_or_none)

    lock_entity_for_update(Slice, 1)

    assert "FOR NO KEY UPDATE" in seen["sql"]
