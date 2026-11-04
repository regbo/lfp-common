"""Export a Chanx AsyncAPI document from a configured ASGI app."""

import json
import os
from pathlib import Path
from typing import Any

from chanx.fast_channels.views import generate_asyncapi_schema
from starlette.requests import Request

from pynect_worker._app import load_object
from pynect_worker.handlers import stream_operations


def export_schema(app_target: str, output: Path) -> None:
    """Generate AsyncAPI without starting an HTTP server."""
    app = load_object(app_target)
    request = Request(
        {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/",
            "raw_path": b"/",
            "root_path": "",
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 0),
            "server": ("localhost", 80),
            "state": {},
            "app": app,
        }
    )
    schema: dict[str, Any] = generate_asyncapi_schema(request=request, app=app)
    for operation_name, input_type_name in stream_operations():
        operation = schema.get("operations", {}).get(operation_name)
        if operation is None:
            continue
        if not any(
            _message_schema_name(schema, message.get("$ref")) == input_type_name
            for message in operation.get("messages", [])
        ):
            continue
        operation["x-pynect-stream"] = True
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)


def _message_schema_name(schema: dict[str, Any], message_ref: str | None) -> str | None:
    """Resolve an operation message reference to its Pydantic schema name."""
    if not message_ref:
        return None
    message_name = message_ref.rsplit("/", 1)[-1]
    message = schema.get("components", {}).get("messages", {}).get(message_name, {})
    payload_ref = message.get("payload", {}).get("$ref")
    return payload_ref.rsplit("/", 1)[-1] if payload_ref else None


def main() -> None:
    """Console entry point driven by the Node launcher environment."""
    app_target = os.environ.get("PYNECT_APP")
    output = os.environ.get("PYNECT_SCHEMA_PATH")
    if not app_target:
        raise RuntimeError("PYNECT_APP is required")
    if not output:
        raise RuntimeError("PYNECT_SCHEMA_PATH is required")
    export_schema(app_target, Path(output))
