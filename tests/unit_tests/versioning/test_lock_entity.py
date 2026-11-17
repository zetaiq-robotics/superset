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
# Modified by ZetaIQ: tests that the entity lock is one single-table SELECT on Postgres.
"""sc-120014: the conditional-write row lock must also refresh the entity.

Dialect-independent statement-shape guards for ``lock_entity_for_update``:
the lock must be taken as a full-entity ORM read carrying BOTH
``populate_existing()`` and ``with_for_update()`` -- dropping either flag
fails here on every backend. Why both flags matter is documented on the
helper itself; the behavioral two-transaction proof against a real database
lives in tests/integration_tests/versioning/conditional_write_lock_tests.py.
(The restore path has the same staleness class; a matching pin is proposed
in apache/superset#44015.)

These are deliberate shape pins on the exact query chain: an equivalent
refactor (a 2.0-style ``select()``, reordered chaining) should update the
pinned chain -- but never drop ``populate_existing`` or ``with_for_update``.
"""

from typing import Any, Callable
from unittest.mock import MagicMock

import pytest
from pytest_mock import MockerFixture

from superset.versioning.api_helpers import lock_entity_for_update


def _mock_db(mocker: MockerFixture) -> MagicMock:
    """Replace the module-level ``db`` with an explicit MagicMock, so
    ``mock.patch`` builds a plain sync mock rather than choosing the
    replacement type itself."""
    db = MagicMock()
    mocker.patch("superset.versioning.api_helpers.db", new=db)
    return db


def test_lock_is_a_populating_locking_read(mocker: MockerFixture) -> None:
    """The lock is a populating, locking ORM read that RETURNS the entity.

    The chain must carry populate_existing() AND with_for_update(), consume
    the result via one_or_none() (no exception for a missing row -- 404
    semantics stay with the update command's own lookup), and hand the
    entity back so the caller can hold a strong reference -- the identity
    map alone holds it only weakly.
    """
    db = _mock_db(mocker)
    model_cls = MagicMock()

    result = lock_entity_for_update(model_cls, 42)

    db.session.query.assert_called_once_with(model_cls)
    # lazyload("*"): no eager load may wrap the lock in a DISTINCT subquery
    db.session.query.return_value.options.assert_called_once()
    query = db.session.query.return_value.options.return_value
    query.populate_existing.assert_called_once_with()
    populated = query.populate_existing.return_value
    # Arity-only on purpose: with a MagicMock model the criterion
    # ``model_cls.id == 42`` is not introspectable, and a with-args assert
    # would be trivially true. The right-row behavior is pinned by the
    # integration tests on real backends.
    populated.filter.assert_called_once()
    filtered = populated.filter.return_value
    # key_share: FOR NO KEY UPDATE on Postgres (see lock_entity_for_update)
    filtered.with_for_update.assert_called_once_with(key_share=True)
    filtered.with_for_update.return_value.one_or_none.assert_called_once_with()
    assert result is filtered.with_for_update.return_value.one_or_none.return_value


def test_non_numeric_id_skips_the_lock(mocker: MockerFixture) -> None:
    """A non-numeric id never reaches SQL and returns None.

    The PUT route declares /<pk> as a string segment; a cast error here
    would pre-empt the command's 404.
    """
    db = _mock_db(mocker)

    result = lock_entity_for_update(MagicMock(), "not-a-pk")  # type: ignore[arg-type]

    assert result is None
    db.session.query.assert_not_called()


def test_missing_id_skips_the_lock(mocker: MockerFixture) -> None:
    db = _mock_db(mocker)

    lock_entity_for_update(MagicMock(), None)

    db.session.query.assert_not_called()


def _locking_sql_on_postgres(session: Any, entity: Any) -> list[str]:
    """Run the lock on a stored *entity*; return every ORM statement it
    emits, compiled for PostgreSQL -- the backend that rejects a row lock
    inside a ``DISTINCT`` subquery, which SQLite's no-op lock hides."""
    from sqlalchemy import event
    from sqlalchemy.dialects import postgresql

    entity.metadata.create_all(session.get_bind())
    session.add(entity)
    session.flush()
    model_cls, entity_id = type(entity), entity.id
    session.expunge_all()

    seen: list[str] = []

    def capture(state: Any) -> None:
        seen.append(str(state.statement.compile(dialect=postgresql.dialect())))

    event.listen(session, "do_orm_execute", capture)
    try:
        assert lock_entity_for_update(model_cls, entity_id) is not None
    finally:
        event.remove(session, "do_orm_execute", capture)
    return seen


def _dashboard() -> Any:
    from superset.models.dashboard import Dashboard

    return Dashboard(dashboard_title="d")


def _chart() -> Any:
    from superset.models.slice import Slice

    return Slice(
        slice_name="c",
        datasource_type="table",
        datasource_id=1,
        viz_type="table",
        params="{}",
    )


def _dataset() -> Any:
    from superset.connectors.sqla.models import SqlaTable
    from superset.models.core import Database

    return SqlaTable(
        table_name="t", database=Database(database_name="d", sqlalchemy_uri="sqlite://")
    )


@pytest.mark.parametrize(
    ("make", "table"),
    [(_dashboard, "dashboards"), (_chart, "slices"), (_dataset, "tables")],
)
def test_lock_is_one_single_table_select_on_postgres(
    session: Any, make: Callable[[], Any], table: str
) -> None:
    """The lock is exactly one ``SELECT ... FROM <table> ... FOR NO KEY UPDATE``.

    An eager relationship load (``Slice.table`` is ``lazy="subquery"``) makes
    SQLAlchemy re-issue the locking query as ``(SELECT DISTINCT ... FOR NO KEY
    UPDATE) AS anon_1``, which Postgres refuses: every chart PUT with
    ``If-Match`` was a 500. Relationships must load lazily, after the lock.
    """
    seen = _locking_sql_on_postgres(session, make())

    assert len(seen) == 1, "\n\n".join(seen)
    sql = seen[0]
    assert "FOR NO KEY UPDATE" in sql
    assert "DISTINCT" not in sql
    assert "anon_" not in sql
    assert f"\nFROM {table} \nWHERE {table}.id = " in sql
