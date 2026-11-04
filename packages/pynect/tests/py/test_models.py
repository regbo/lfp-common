from __future__ import annotations

from pynect_worker.models import (
    DEFAULT_WEBSOCKET_FRAME_BYTES,
    PROTOCOL_VERSION,
    WEBSOCKET_SUBPROTOCOL,
    ServerOptions,
    WorkerOptions,
)
from pynect_worker.schema import schema_document


def test_models_publish_camel_case_json_schema() -> None:
    worker = WorkerOptions.model_json_schema(by_alias=True)
    server = ServerOptions.model_json_schema(by_alias=True)

    assert worker["properties"]["validatePydantic"]["default"] is True
    assert server["properties"]["maxFrameBytes"]["default"] == (DEFAULT_WEBSOCKET_FRAME_BYTES)


def test_protocol_metadata_is_emitted_with_the_models() -> None:
    protocol = schema_document()["x-pynect-protocol"]

    assert protocol["version"] == PROTOCOL_VERSION
    assert protocol["websocketSubprotocol"] == WEBSOCKET_SUBPROTOCOL
    assert "import" in protocol["operations"]


def test_server_defaults_are_loopback_and_default_deny() -> None:
    options = ServerOptions()

    assert options.host == "127.0.0.1"
    assert options.path == "/pynect"
    assert options.modules == {}
