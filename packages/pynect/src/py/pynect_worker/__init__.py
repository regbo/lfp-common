"""Python worker and proxy-fronted WebSocket server for Pynect."""

from ._generated.metadata import PACKAGE_NAME, PACKAGE_VERSION
from .models import ServerOptions, WorkerOptions

__all__ = [
    "PACKAGE_NAME",
    "PACKAGE_VERSION",
    "ServerOptions",
    "WorkerOptions",
]
