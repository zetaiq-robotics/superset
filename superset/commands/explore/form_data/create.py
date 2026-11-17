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
# Modified by ZetaIQ: cached form data records the chart version it started from.
import logging

from flask import current_app as app, session
from sqlalchemy.exc import SQLAlchemyError

from superset.commands.base import BaseCommand
from superset.commands.explore.form_data.parameters import CommandParameters
from superset.commands.explore.form_data.state import TemporaryExploreState
from superset.commands.explore.form_data.utils import check_access
from superset.commands.temporary_cache.exceptions import TemporaryCacheCreateFailedError
from superset.extensions import cache_manager, db
from superset.key_value.utils import random_key
from superset.temporary_cache.utils import cache_key
from superset.utils.core import DatasourceType, get_user_id
from superset.utils.schema import validate_json
from superset.versioning.api_helpers import entity_concurrency_token

logger = logging.getLogger(__name__)


class CreateFormDataCommand(BaseCommand):
    def __init__(self, cmd_params: CommandParameters):
        self._cmd_params = cmd_params

    def _get_session_id(self) -> str | None:
        """Get session ID. Can be overridden in subclasses."""
        return session.get("_id")

    def run(self) -> str:
        self.validate()
        try:
            datasource_id = self._cmd_params.datasource_id
            datasource_type = self._cmd_params.datasource_type
            chart_id = self._cmd_params.chart_id
            tab_id = self._cmd_params.tab_id
            form_data = self._cmd_params.form_data
            check_access(datasource_id, chart_id, datasource_type)
            contextual_key = cache_key(
                self._get_session_id(), tab_id, datasource_id, chart_id, datasource_type
            )
            key = cache_manager.explore_form_data_cache.get(contextual_key)
            if not key or not tab_id:
                key = random_key()
            if form_data:
                state: TemporaryExploreState = {
                    "owner": get_user_id(),
                    "datasource_id": datasource_id,
                    "datasource_type": DatasourceType(datasource_type),
                    "chart_id": chart_id,
                    "form_data": form_data,
                    "version_uuid": self._base_version(chart_id),
                }
                timeout = app.config["EXPLORE_FORM_DATA_CACHE_CONFIG"].get(
                    "CACHE_DEFAULT_TIMEOUT"
                )
                cache_manager.explore_form_data_cache.set(key, state, timeout=timeout)
                cache_manager.explore_form_data_cache.set(
                    contextual_key, key, timeout=timeout
                )
            return key
        except SQLAlchemyError as ex:
            logger.exception("Error running create command")
            raise TemporaryCacheCreateFailedError() from ex

    def _base_version(self, chart_id: int | None) -> str | None:
        """The version these edits start from: the client's base, else live.

        Explore sends its base (the version it loaded, or the one its own
        save created); other callers send none and get the chart's version
        now.
        """
        if self._cmd_params.version_uuid or not chart_id:
            return self._cmd_params.version_uuid
        # pylint: disable=import-outside-toplevel
        from superset.models.slice import Slice

        slc = db.session.get(Slice, chart_id)
        return entity_concurrency_token(Slice, slc.id, slc.uuid) if slc else None

    def validate(self) -> None:
        if self._cmd_params.form_data:
            validate_json(self._cmd_params.form_data)
