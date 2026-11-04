from types import SimpleNamespace

import pytest

from pynect_worker._app import load_object


def test_load_object_resolves_nested_attributes() -> None:
    assert load_object("pynect_worker._generated:metadata.PACKAGE_NAME") == "pynect-worker"


@pytest.mark.parametrize("target", ["", "module", ":object", "module:"])
def test_load_object_rejects_invalid_targets(target: str) -> None:
    with pytest.raises(ValueError, match="module:object"):
        load_object(target)


def test_namespace_fixture_is_importable() -> None:
    fixture = load_object("tests.fixtures.catalog:app")
    assert not isinstance(fixture, SimpleNamespace)
