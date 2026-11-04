"""Canonical Pynect protocol and configuration models."""

from __future__ import annotations

import enum
from pathlib import Path
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

PROTOCOL_VERSION = 2
WEBSOCKET_SUBPROTOCOL = f"pynect.v{PROTOCOL_VERSION}"
MAX_LOCAL_FRAME_BYTES = 256 * 1024 * 1024
DEFAULT_WEBSOCKET_FRAME_BYTES = 8 * 1024 * 1024
NonEmptyString = Annotated[str, Field(min_length=1)]


class CodegenRequest(BaseModel):
    """Validated internal request sent by the Node codegen command."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    bridge: dict[str, Any] = Field(default_factory=dict)
    class_name: NonEmptyString
    modules: Annotated[dict[NonEmptyString, NonEmptyString], Field(min_length=1)]
    out: Path
    root: Path

    @field_validator("root")
    @classmethod
    def resolve_root(cls, value: Path) -> Path:
        if not value.is_absolute():
            raise ValueError("must be absolute")
        return value.resolve()


class MessageKind(enum.StrEnum):
    """RPC envelope kinds shared with JavaScript."""

    CALLBACK = "callback"
    CALLBACK_RELEASE = "callback_release"
    CALLBACK_RESULT = "callback_result"
    HELLO = "hello"
    NOTIFY = "notify"
    REQUEST = "request"
    RESPONSE = "response"


class Operation(enum.StrEnum):
    """Operations supported by the Python object bridge."""

    CALL = "call"
    DIR = "dir"
    GET = "get"
    IMPORT = "import"
    ITER = "iter"
    NEXT = "next"
    RELEASE = "release"
    REPR = "repr"
    SET = "set"
    SHUTDOWN = "shutdown"
    VALUE = "value"


class WireValueType(enum.StrEnum):
    """Tagged non-MessagePack values supported by the wire codec."""

    CALLBACK = "callback"
    DATE = "date"
    DATETIME = "datetime"
    MAP = "map"
    REFERENCE = "reference"
    SET = "set"
    TIME = "time"
    UNDEFINED = "undefined"


class WorkerOptions(BaseModel):
    """Behavior shared by local IPC workers and remote sessions."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )

    validate_pydantic: bool = Field(
        default=True,
        title="Validate Pydantic",
        description="Validate annotated Python arguments with Pydantic.",
    )


class ServerOptions(WorkerOptions):
    """Loopback-first WebSocket server configuration."""

    host: str = Field(
        default="127.0.0.1",
        min_length=1,
        description="Interface on which the proxy-facing server listens.",
    )
    port: Annotated[int, Field(ge=0, le=65_535)] = Field(
        default=0,
        description="Listening port; zero asks the operating system to choose one.",
    )
    path: str = Field(
        default="/pynect",
        description="Absolute WebSocket URL path accepted by the server.",
    )
    modules: dict[str, str] = Field(
        default_factory=dict,
        description="Public module names mapped to importable Python module names.",
        json_schema_extra={"default": {}},
    )
    max_frame_bytes: Annotated[int, Field(gt=0, le=0xFFFF_FFFB)] = Field(
        default=DEFAULT_WEBSOCKET_FRAME_BYTES,
        title="Max Frame Bytes",
        description="Maximum MessagePack payload size for one RPC frame.",
    )

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        """Require a path-only absolute URL component."""

        if not value.startswith("/") or "?" in value or "#" in value:
            raise ValueError("must be an absolute URL path without query or fragment")
        return value
