import json
from pathlib import Path

from pynect_worker.schema import export_schema


def test_export_schema_writes_chanx_asyncapi(tmp_path: Path) -> None:
    output = tmp_path / "asyncapi.json"

    export_schema("tests.fixtures.catalog:app", output)

    schema = json.loads(output.read_text(encoding="utf-8"))
    assert schema["asyncapi"].startswith("3.")
    assert schema["channels"]["catalog"]["address"] == "/ws/catalog"
    assert "PingRequest" in schema["components"]["schemas"]
