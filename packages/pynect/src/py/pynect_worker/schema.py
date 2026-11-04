"""Emit the canonical Pynect JSON Schema for JavaScript code generation."""

from __future__ import annotations

import json
from typing import Any

from .models import (
    PROTOCOL_VERSION,
    WEBSOCKET_SUBPROTOCOL,
    CodegenRequest,
    MessageKind,
    Operation,
    ServerOptions,
    WireValueType,
    WorkerOptions,
)


def schema_document() -> dict[str, Any]:
    """Build the stable cross-language schema document."""

    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://nodepyx.dev/schemas/pynect.json",
        "title": "Pynect shared schema",
        "$defs": {
            "CodegenRequest": CodegenRequest.model_json_schema(by_alias=True),
            "WorkerOptions": WorkerOptions.model_json_schema(by_alias=True),
            "ServerOptions": ServerOptions.model_json_schema(by_alias=True),
        },
        "x-pynect-protocol": {
            "version": PROTOCOL_VERSION,
            "websocketSubprotocol": WEBSOCKET_SUBPROTOCOL,
            "messageKinds": [item.value for item in MessageKind],
            "operations": [item.value for item in Operation],
            "wireValueTypes": [item.value for item in WireValueType],
        },
    }


def main() -> None:
    """Write canonical JSON to stdout for a language-neutral generator."""

    print(json.dumps(schema_document(), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
