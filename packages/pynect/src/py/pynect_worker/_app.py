"""Import configured ASGI application objects."""

from importlib import import_module
from typing import Any


def load_object(target: str) -> Any:
    """Load a dotted object from a ``module:object`` target."""
    module_name, separator, object_path = target.partition(":")
    if not separator or not module_name or not object_path:
        raise ValueError('ASGI app must use the form "module:object"')

    value: Any = import_module(module_name)
    for name in object_path.split("."):
        if not name.isidentifier():
            raise ValueError('ASGI app must use the form "module:object"')
        value = getattr(value, name)
    return value
