import json
from pathlib import Path

from pynect.schema import export_schema


def test_export_schema_writes_chanx_asyncapi(tmp_path: Path) -> None:
    output = tmp_path / "asyncapi.json"

    export_schema("tests.fixtures.catalog:app", output)

    schema = json.loads(output.read_text(encoding="utf-8"))
    assert schema["asyncapi"].startswith("3.")
    assert schema["channels"]["catalog"]["address"] == "/ws/catalog"
    assert "PingRequest" in schema["components"]["schemas"]
    assert schema["operations"]["watch"]["x-pynect-stream"] is True
    assert len(schema["operations"]["watch"]["reply"]["messages"]) == 1
    assert schema["operations"]["sync_watch"]["x-pynect-stream"] is True
    assert len(schema["operations"]["sync_watch"]["reply"]["messages"]) == 1
    assert "x-pynect-stream" not in schema["operations"]["ping"]


def test_export_schema_wraps_a_bare_chanx_application(tmp_path: Path) -> None:
    output = tmp_path / "asyncapi.json"

    export_schema("tests.fixtures.catalog:bare_app", output)

    schema = json.loads(output.read_text(encoding="utf-8"))
    assert schema["channels"]["catalog"]["address"] == "/ws/catalog"
