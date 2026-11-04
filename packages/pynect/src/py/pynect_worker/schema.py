"""Export a Chanx AsyncAPI document from a configured ASGI app."""

import json
import os
from pathlib import Path
from typing import Any

from chanx.fast_channels.views import generate_asyncapi_schema
from starlette.requests import Request

from pynect_worker._app import load_object


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
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)


def main() -> None:
    """Console entry point driven by the Node launcher environment."""
    app_target = os.environ.get("PYNECT_APP")
    output = os.environ.get("PYNECT_SCHEMA_PATH")
    if not app_target:
        raise RuntimeError("PYNECT_APP is required")
    if not output:
        raise RuntimeError("PYNECT_SCHEMA_PATH is required")
    export_schema(app_target, Path(output))
