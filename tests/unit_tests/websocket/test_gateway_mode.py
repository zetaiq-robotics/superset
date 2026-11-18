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
"""WEBSOCKET_AUTH: "cookie" (upstream) vs "gateway" (bearer token at the edge)."""

from unittest.mock import MagicMock, patch

import pytest

from superset.constants import CHANGE_ME_WEBSOCKET_JWT_SECRET
from superset.initialization import SupersetAppInitializer


def _initializer(auth: str | None, **extra: object) -> SupersetAppInitializer:
    init = object.__new__(SupersetAppInitializer)
    init.config = {
        "WEBSOCKET_ENABLE": True,
        "WEBSOCKET_JWT_SECRET": CHANGE_ME_WEBSOCKET_JWT_SECRET,
        **extra,
    }
    if auth is not None:
        init.config["WEBSOCKET_AUTH"] = auth
    app = MagicMock()
    app.debug = False
    app.config = {"TESTING": False}
    init.superset_app = app
    return init


def test_default_is_cookie() -> None:
    from superset import config

    assert config.WEBSOCKET_AUTH == "cookie"


def test_websocket_auth_reaches_the_browser() -> None:
    from superset.views.base import FRONTEND_CONF_KEYS

    assert "WEBSOCKET_AUTH" in FRONTEND_CONF_KEYS


def test_no_ws_cookie_is_set_in_gateway_mode() -> None:
    with patch("superset.websocket.channel.register_ws_channel_cookie") as register:
        _initializer("gateway").configure_websocket()
    register.assert_not_called()


@pytest.mark.parametrize("auth", ["cookie", None])
def test_ws_cookie_is_set_in_cookie_mode(auth: str | None) -> None:
    init = _initializer(auth)
    with patch("superset.websocket.channel.register_ws_channel_cookie") as register:
        init.configure_websocket()
    register.assert_called_once_with(init.superset_app)


def test_gateway_mode_skips_the_jwt_secret_check() -> None:
    with patch("superset.initialization.is_test", return_value=False):
        _initializer("gateway").check_websocket_secret()  # no raise


@pytest.mark.parametrize("auth", ["cookie", None])
def test_cookie_mode_still_refuses_the_default_secret(auth: str | None) -> None:
    with patch("superset.initialization.is_test", return_value=False):
        with pytest.raises(SystemExit):
            _initializer(auth).check_websocket_secret()


@pytest.mark.parametrize("auth", ["Gateway", "jwt", ""])
@pytest.mark.parametrize("enabled", [True, False])
def test_unknown_mode_refuses_to_start(auth: str, enabled: bool) -> None:
    # A typo must never fall back to a mode silently, not even in debug/test.
    init = _initializer(auth, WEBSOCKET_ENABLE=enabled)
    init.superset_app.debug = True
    with patch("superset.initialization.logger") as logger:
        with pytest.raises(SystemExit):
            init.check_websocket_secret()
    assert "WEBSOCKET_AUTH" in logger.error.call_args[0][0]
